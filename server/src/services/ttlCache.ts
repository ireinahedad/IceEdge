/**
 * ttlCache.ts
 * ------------------------------------------------------------------
 * Cache mémoire générique à TTL, avec dédoublonnage des appels en vol
 * (protection anti-stampede) — extrait du pattern déjà utilisé par
 * `nhlApiClient.ts` et `oddsClient.ts`, généralisé pour être réutilisable
 * par les routes.
 *
 * Deux garanties importantes :
 *
 *  1. Anti-stampede : N requêtes concurrentes sur une clé froide ne
 *     déclenchent qu'UNE seule exécution de `fn` ; les N−1 autres attendent
 *     la même promesse. Indispensable après chaque redéploiement, où tous
 *     les caches mémoire repartent à zéro et où le trafic arrive d'un coup.
 *
 *  2. Bornage mémoire : le nombre d'entrées est plafonné (`maxEntries`).
 *     Les clés dérivent parfois d'entrées utilisateur ; sans plafond, un
 *     appelant hostile pourrait faire grossir la Map indéfiniment (DoS
 *     mémoire). Éviction FIFO de la plus ancienne entrée insérée.
 *
 * Process unique / mémoire locale : en cas de scale horizontal, chaque
 * instance a son propre cache (le coût upstream est multiplié par le nombre
 * d'instances, pas par le nombre de visiteurs — ce qui reste borné).
 */

import { registerCache, CacheStats, CacheStatsSource } from '../metrics';

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> implements CacheStatsSource {
  private store = new Map<string, Entry<T>>();
  private inflight = new Map<string, Promise<T>>();

  // Compteurs d'observabilité. `misses` est le chiffre qui compte : c'est le
  // nombre d'exécutions RÉELLES, donc d'appels upstream et de CPU dépensé. Les
  // critères des tests de charge de l'audit portent dessus (« ≤ 5 exécutions
  // de getBestBets », « 1 seule exécution après redémarrage »).
  private hits = 0;
  private misses = 0;
  private dedups = 0;
  private evictions = 0;

  /**
   * @param ttlMs      durée de validité par défaut d'une entrée
   * @param maxEntries plafond du nombre de clés conservées (bornage mémoire)
   * @param cacheName  nom sous lequel remonter les compteurs dans
   *                   `/api/dev/metrics`. Omis (cas par défaut) → le cache
   *                   fonctionne normalement mais reste hors du registre : les
   *                   caches créés à la volée, notamment dans les tests, ne
   *                   polluent pas les métriques et ne sont pas retenus par une
   *                   référence globale.
   */
  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 100,
    readonly cacheName: string = '',
  ) {
    if (cacheName) registerCache(this);
  }

  /**
   * Lecture SANS compteur.
   *
   * Publique parce qu'un appelant a parfois besoin de savoir si la valeur est
   * déjà là AVANT de décider d'appeler `wrap` (le client ML consulte le cache
   * avant son disjoncteur). Passer par `get` dans ce cas compterait le même
   * accès deux fois, et `misses` — qui est le nombre d'exécutions RÉELLES, donc
   * le critère des tests de charge — serait faux d'un facteur deux.
   */
  peekFresh(key: string): T | null {
    const e = this.store.get(key);
    return e && e.expiresAt > Date.now() ? e.value : null;
  }

  /** Valeur fraîche pour cette clé, ou null. */
  get(key: string): T | null {
    const value = this.peekFresh(key);
    if (value === null) this.misses += 1;
    else this.hits += 1;
    return value;
  }

  stats(): CacheStats {
    return {
      hits:       this.hits,
      misses:     this.misses,
      dedup:      this.dedups,
      evictions:  this.evictions,
      size:       this.store.size,
      maxEntries: this.maxEntries,
    };
  }

  /** Remet les compteurs à zéro SANS toucher au contenu (cf. `resetMetrics`). */
  resetStats(): void {
    this.hits = this.misses = this.dedups = this.evictions = 0;
  }

  /**
   * Dernière valeur connue, même expirée. Sert de filet de sécurité quand
   * l'upstream tombe ou que le quota est épuisé : mieux vaut servir une
   * donnée de quelques minutes qu'une page vide.
   */
  getStale(key: string): T | null {
    return this.store.get(key)?.value ?? null;
  }

  /**
   * `ttlMs` permet de surcharger la durée par défaut entrée par entrée : les
   * clients d'API n'ont pas un TTL unique (un match terminé se garde 6 h, un
   * match en direct 30 s). Sans cette surcharge, il faudrait une instance de
   * cache par durée — donc un plafond mémoire par instance, beaucoup plus
   * difficile à raisonner qu'un seul plafond partagé.
   */
  set(key: string, value: T, ttlMs: number = this.ttlMs): void {
    if (!this.store.has(key) && this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next();
      if (!oldest.done) {
        this.store.delete(oldest.value);
        this.evictions += 1;
      }
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /**
   * Oublie une clé. Pour les caches dont la donnée source peut changer sur
   * ACTION (un abonnement qui passe Pro) et non seulement avec le temps : sans
   * invalidation explicite, l'utilisateur qui vient de payer attendrait le TTL.
   *
   * N'annule pas un appel en vol : celui-ci reposera sa valeur en cache en
   * terminant. C'est voulu — l'interrompre laisserait ses appelants sans
   * réponse, et l'écriture qui suit une invalidation est déjà visible en base
   * pour l'appel suivant.
   */
  delete(key: string): void {
    this.store.delete(key);
  }

  /** Vide le cache (tests / invalidation manuelle). */
  clear(): void {
    this.store.clear();
    this.inflight.clear();
  }

  /**
   * Retourne la valeur en cache si elle est fraîche ; sinon exécute `fn` une
   * seule fois, même si plusieurs appels concurrents arrivent sur la même clé.
   *
   * Si `fn` rejette, rien n'est mis en cache et l'erreur est propagée à tous
   * les appelants en attente (l'appelant décide de retomber sur `getStale`).
   *
   * `ttlMs` peut dépendre de la valeur calculée (fonction) : un match en direct
   * se garde 30 s, mais 10 s en fin de match, ce qu'on ne sait qu'après calcul.
   */
  async wrap(key: string, fn: () => Promise<T>, ttlMs?: number | ((value: T) => number)): Promise<T> {
    // `peekFresh` et non `get` : les trois issues sont comptées explicitement ici,
    // sinon un rattachement à un appel en vol serait compté comme une exécution
    // — l'inverse exact de ce que le test S3 cherche à prouver.
    const fresh = this.peekFresh(key);
    if (fresh !== null) { this.hits += 1; return fresh; }

    const pending = this.inflight.get(key);
    if (pending) { this.dedups += 1; return pending; }

    this.misses += 1;

    const p = (async () => {
      const value = await fn();
      this.set(key, value, typeof ttlMs === 'function' ? ttlMs(value) : ttlMs);
      return value;
    })().finally(() => {
      this.inflight.delete(key);
    });

    this.inflight.set(key, p);
    return p;
  }
}
