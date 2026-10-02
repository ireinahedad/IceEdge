/**
 * metrics.ts — compteurs d'observabilité, destinés d'abord aux tests de charge.
 *
 * POURQUOI CE MODULE EXISTE
 *
 * Les critères de réussite des scénarios de charge de l'audit ne portent pas sur
 * ce que voit le client, mais sur ce que le serveur émet et recalcule :
 *
 *   S1 — « ≤ 2 appels Odds API sur toute la durée du test »
 *        « ≤ 5 exécutions complètes de getBestBets »
 *   S3 — « 1 seule exécution » après un redémarrage, 300 requêtes concurrentes
 *   S5 — le RSS doit se stabiliser sur un plateau
 *   S7 — appels par API externe sur 24 h, extrapolés à 30 jours
 *
 * Aucun de ces chiffres n'est observable depuis k6, qui ne voit que la façade
 * HTTP : un endpoint peut répondre 200 en 40 ms à 500 utilisateurs virtuels en
 * ayant appelé l'upstream 500 fois (facture) ou 1 fois (cache). De l'extérieur,
 * c'est indiscernable. C'est précisément la différence que ces tests doivent
 * mesurer, d'où ces compteurs.
 *
 * COÛT — quelques incréments d'entiers par appel sortant et par lecture de
 * cache. Négligeable devant un aller-retour réseau, donc actif en permanence
 * plutôt que derrière un drapeau : un compteur qu'il faut penser à activer est
 * un compteur éteint le jour où l'incident arrive.
 *
 * EXPOSITION — la lecture passe par `/api/dev/metrics`, qui est authentifiée,
 * réservée au rôle admin, et dont le routeur n'est même pas monté en production
 * sans `ENABLE_DEV_ROUTES=true`. Ces chiffres décrivent la consommation interne
 * (volumes upstream, efficacité des caches) : rien de secret, mais rien qui ait
 * à être public non plus.
 */

import { monitorEventLoopDelay } from 'perf_hooks';

// ── Appels sortants ─────────────────────────────────────────────────────────

/** Dépendances externes facturées ou limitées en quota. */
export type UpstreamTarget =
  | 'odds'      // The Odds API — quota mensuel strict, la plus chère à gaspiller
  | 'nhl'       // api-web.nhle.com — gratuite mais rate-limitée de fait
  | 'ml'        // service Python interne — 2 workers, c'est lui qui sature en premier
  | 'llm'       // GitHub Models / OpenAI — facturé au token
  | 'moneypuck'; // CSV de saison MoneyPuck (Corsi/Fenwick) — gratuit, à ne pas marteler

export interface UpstreamStats {
  /** Appels réellement émis (un hit de cache n'en émet aucun). */
  calls:  number;
  /** Appels terminés en erreur ou en timeout. */
  errors: number;
  /** Latence cumulée, pour en déduire une moyenne. */
  totalMs: number;
  /** Pire latence observée — c'est elle qui remplit le pool, pas la moyenne. */
  maxMs:  number;
}

const TARGETS: UpstreamTarget[] = ['odds', 'nhl', 'ml', 'llm', 'moneypuck'];

const upstream = new Map<UpstreamTarget, UpstreamStats>();

function blankUpstream(): UpstreamStats {
  return { calls: 0, errors: 0, totalMs: 0, maxMs: 0 };
}

for (const t of TARGETS) upstream.set(t, blankUpstream());

/**
 * Enregistre un appel sortant TERMINÉ.
 *
 * À appeler au point d'étranglement de chaque client (`fetchNHL`, `mlPost`,
 * `rapidGet`…), jamais chez l'appelant : posé au bon endroit, il est impossible
 * d'ajouter un appel upstream sans être compté, ce qui est tout l'intérêt.
 */
export function recordUpstream(target: UpstreamTarget, ms: number, ok: boolean): void {
  const s = upstream.get(target);
  if (!s) return;
  s.calls  += 1;
  s.totalMs += ms;
  if (ms > s.maxMs) s.maxMs = ms;
  if (!ok) s.errors += 1;
}

/**
 * Enveloppe une promesse d'appel sortant : mesure la durée, compte le succès ou
 * l'échec, et laisse l'erreur remonter inchangée.
 */
export async function timeUpstream<T>(target: UpstreamTarget, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const out = await fn();
    recordUpstream(target, Date.now() - started, true);
    return out;
  } catch (err) {
    recordUpstream(target, Date.now() - started, false);
    throw err;
  }
}

// ── Caches ──────────────────────────────────────────────────────────────────

export interface CacheStats {
  /** Servi depuis le cache — aucun travail, aucun appel sortant. */
  hits:      number;
  /** Clé froide ou expirée : le calcul a réellement eu lieu. C'EST la métrique
   *  des critères S1 et S3 (« ≤ 5 exécutions », « 1 seule exécution »). */
  misses:    number;
  /** Requêtes concurrentes rattachées à un calcul déjà en vol. Un `dedup` élevé
   *  avec `misses` à 1 est exactement ce que S3 doit démontrer. */
  dedup:     number;
  /** Entrées supprimées parce que le plafond était atteint. Durablement > 0 =
   *  le plafond est trop bas, le cache se vide lui-même. */
  evictions: number;
  /** Occupation courante, à comparer à `maxEntries`. */
  size:      number;
  maxEntries: number;
}

export interface CacheStatsSource {
  readonly cacheName: string;
  stats(): CacheStats;
  resetStats(): void;
}

const caches: CacheStatsSource[] = [];

/**
 * Déclare un cache nommé auprès du registre. Appelé par `TtlCache` quand on lui
 * donne un nom ; les caches anonymes restent invisibles ici, ce qui permet de
 * n'exposer que ceux qui pilotent une décision.
 */
export function registerCache(source: CacheStatsSource): void {
  caches.push(source);
}

// ── Event loop ──────────────────────────────────────────────────────────────

/**
 * Retard de l'event loop. C'est le critère central de S2 : la latence des
 * routes de LECTURE ne doit pas se dégrader pendant une vague de connexions.
 * Un p99 qui grimpe ici pendant que le CPU reste bas désigne un travail
 * synchrone qui bloque le process (hachage, `JSON.parse` d'un gros corps,
 * sérialisation d'une réponse volumineuse) — invisible autrement.
 *
 * ⚠️ LA RÉSOLUTION EST LE PLANCHER DE MESURE, et c'est tout l'enjeu de ce
 * réglage. `monitorEventLoopDelay` échantillonne toutes les `resolution` ms :
 * un retard plus court que l'intervalle d'échantillonnage ne peut pas
 * apparaître, et la valeur AU REPOS est donc toujours ≈ `resolution`.
 *
 * Ce module était réglé à 20 ms. Mesuré (banc `loadtest/bench/b9-eventloop.ts`,
 * 2026-09-18), en bloquant délibérément le process 30 à 60 ms par tour de
 * boucle :
 *
 *     resolution 20 ms → repos p99 22,7  |  BLOQUÉ p99 27,7   → ×1,2
 *     resolution  5 ms → repos p99  6,9  |  BLOQUÉ p99 13,8   → ×2,0
 *     resolution  1 ms → repos p99  2,0  |  BLOQUÉ p99  8,4   → ×4,2
 *
 * À 20 ms, un process RÉELLEMENT bloqué ne se distinguait du repos que d'un
 * facteur 1,2 : dans le bruit. Le critère du scénario S2 de l'audit —
 * « `eventLoop.p99Ms` ne doit pas grimper pendant une vague de connexions » —
 * était donc impossible à rater, ce qui n'est pas la même chose qu'un critère
 * tenu. C'est aussi ce qui a fait lire « mean 30,5 / p99 34,4 » comme un event
 * loop chargé sur le tir du 2026-08-03 : c'était surtout le plancher.
 *
 * `resolution: 1` — le coût est un timer libuv interne, négligeable, et sans
 * commune mesure avec celui d'un blocage qu'on ne verrait pas.
 */
/** Résolution effective, EXPORTÉE : le banc `b9-eventloop.ts` la lit pour dire
 *  si le réglage en vigueur sépare un blocage du repos, au lieu de comparer à
 *  une valeur codée en dur qui se périmerait au premier changement ici. */
export const EVENT_LOOP_RESOLUTION_MS = Number(process.env.EVENT_LOOP_RESOLUTION_MS) || 1;

const loopDelay = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
loopDelay.enable();

export interface EventLoopStats {
  meanMs: number;
  p50Ms:  number;
  p99Ms:  number;
  maxMs:  number;
}

function eventLoopStats(): EventLoopStats {
  const toMs = (ns: number) => Math.round((ns / 1e6) * 100) / 100;
  return {
    meanMs: toMs(loopDelay.mean),
    p50Ms:  toMs(loopDelay.percentile(50)),
    p99Ms:  toMs(loopDelay.percentile(99)),
    maxMs:  toMs(loopDelay.max),
  };
}

// ── Instantané ──────────────────────────────────────────────────────────────

export interface MetricsSnapshot {
  /** Début de la fenêtre de mesure (dernier `resetMetrics`, ou le démarrage). */
  since:      string;
  windowMs:   number;
  uptimeMs:   number;
  upstream:   Record<UpstreamTarget, UpstreamStats & { avgMs: number }>;
  caches:     Record<string, CacheStats & { hitRate: number }>;
  eventLoop:  EventLoopStats;
  memory:     { rssMb: number; heapUsedMb: number; heapTotalMb: number };
}

let since = Date.now();

export function snapshotMetrics(): MetricsSnapshot {
  const now = Date.now();
  const mem = process.memoryUsage();
  const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

  const up = {} as MetricsSnapshot['upstream'];
  for (const [target, s] of upstream) {
    up[target] = { ...s, avgMs: s.calls ? Math.round(s.totalMs / s.calls) : 0 };
  }

  const cacheStats: MetricsSnapshot['caches'] = {};
  for (const c of caches) {
    const s = c.stats();
    const lookups = s.hits + s.misses + s.dedup;
    cacheStats[c.cacheName] = {
      ...s,
      hitRate: lookups ? Math.round((s.hits / lookups) * 1000) / 1000 : 0,
    };
  }

  return {
    since:     new Date(since).toISOString(),
    windowMs:  now - since,
    uptimeMs:  Math.round(process.uptime() * 1000),
    upstream:  up,
    caches:    cacheStats,
    eventLoop: eventLoopStats(),
    memory:    { rssMb: mb(mem.rss), heapUsedMb: mb(mem.heapUsed), heapTotalMb: mb(mem.heapTotal) },
  };
}

/**
 * Remet les COMPTEURS à zéro et ouvre une nouvelle fenêtre de mesure.
 *
 * Ne vide PAS le contenu des caches : à appeler juste avant un tir de charge
 * pour que les chiffres ne portent que sur lui. Pour mesurer un démarrage à
 * froid (S3), c'est le service qu'il faut redémarrer — pas ce bouton, qui
 * laisserait les caches chauds et donnerait un faux « 0 exécution ».
 */
export function resetMetrics(): void {
  for (const t of TARGETS) upstream.set(t, blankUpstream());
  for (const c of caches) c.resetStats();
  loopDelay.reset();
  since = Date.now();
}
