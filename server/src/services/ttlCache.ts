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

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private store = new Map<string, Entry<T>>();
  private inflight = new Map<string, Promise<T>>();

  /**
   * @param ttlMs      durée de validité d'une entrée
   * @param maxEntries plafond du nombre de clés conservées (bornage mémoire)
   */
  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 100,
  ) {}

  /** Valeur fraîche pour cette clé, ou null. */
  get(key: string): T | null {
    const e = this.store.get(key);
    return e && e.expiresAt > Date.now() ? e.value : null;
  }

  /**
   * Dernière valeur connue, même expirée. Sert de filet de sécurité quand
   * l'upstream tombe ou que le quota est épuisé : mieux vaut servir une
   * donnée de quelques minutes qu'une page vide.
   */
  getStale(key: string): T | null {
    return this.store.get(key)?.value ?? null;
  }

  set(key: string, value: T): void {
    if (!this.store.has(key) && this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
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
   */
  async wrap(key: string, fn: () => Promise<T>): Promise<T> {
    const fresh = this.get(key);
    if (fresh !== null) return fresh;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const p = (async () => {
      const value = await fn();
      this.set(key, value);
      return value;
    })().finally(() => {
      this.inflight.delete(key);
    });

    this.inflight.set(key, p);
    return p;
  }
}
