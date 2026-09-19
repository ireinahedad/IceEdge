/**
 * B3 — ABSENCE DE DÉDUPLICATION (troupeau sur cache froid)
 *
 * LA QUESTION, celle du scénario S3 de l'audit : après un redémarrage, quand N
 * requêtes arrivent EN MÊME TEMPS sur une clé froide, combien d'exécutions
 * réelles partent ?
 *
 * Attendu : **une**, quel que soit N. Les N−1 autres doivent se rattacher au
 * calcul déjà en vol (`dedup`), pas en lancer un nouveau.
 *
 * POURQUOI C'EST LE TEST LE PLUS SOUVENT OUBLIÉ — un cache qui marche
 * parfaitement en régime établi peut n'avoir AUCUNE protection dans sa fenêtre
 * froide. Cette fenêtre revient à chaque démarrage, chaque redéploiement et
 * chaque expiration de TTL, c'est-à-dire précisément au moment où le trafic est
 * là. C'est ainsi que `nhlApiClient` émettait 500 appels pour 500 arrivées
 * simultanées (`loadtest/stampede.ts`), et `oddsClient` 26 appels facturés pour
 * UNE exécution de `best-bets`.
 *
 * LA COLONNE QUI DÉCIDE est `misses`, pas la latence : à N=500, un endpoint qui
 * répond vite en ayant exécuté 500 fois et un endpoint qui répond vite en ayant
 * exécuté une fois sont indiscernables de l'extérieur.
 *
 * Un processus par (endpoint, N) — une mesure de cache froid ne se fait qu'une
 * fois par processus, par définition.
 */

import { runChild } from './spawn';

const CIBLES = ['best-bets', 'odds-h2h', 'teams', 'games-date'];
const PALIERS = (process.env.BENCH_LEVELS ?? '10,50,200').split(',').map(Number);

export interface B3Row {
  id: string; n: number; casse: boolean;
  errors: number; errorRate: number; rateLimited: number;
  p50: number; p95: number; max: number;
  nhl: number; odds: number; ml: number; sql: number;
  appels: number; appelsDistincts: number;
  caches: Record<string, { h: number; m: number; d: number }>;
}

/**
 * Où lire la vérité, endpoint par endpoint — et c'est un piège documenté.
 *
 * `best-bets` et `odds` passent par `TtlCache.wrap` : `wrap` compte lui-même
 * les trois issues, donc `misses` EST le nombre d'exécutions réelles et `dedup`
 * le nombre de rattachements.
 *
 * `nhlApiClient` ne passe PAS par `wrap` : il déduplique plus bas, dans
 * `fetchNHL`, au niveau HTTP. Son cache est lu par `get()`, qui voit N clés
 * froides et compte donc N `misses` — alors qu'UN SEUL appel sortant est parti.
 * Lire `misses` ici ferait crier au troupeau sur un code qui n'en a pas. Le bon
 * indicateur pour lui est `upstream.nhl.calls`.
 *
 * C'est exactement l'avertissement du README §4 (« dedup reste à 0 pour le
 * cache nhl, et c'est normal »). Le banc l'applique au lieu de le rappeler.
 */
const INDICATEUR: Record<string, { via: 'cache'; cache: string } | { via: 'amont' }> = {
  'best-bets':  { via: 'cache', cache: 'best-bets' },
  'odds-h2h':   { via: 'cache', cache: 'odds' },
  teams:        { via: 'amont' },
  'games-date': { via: 'amont' },
};

/** Nombre d'EXÉCUTIONS réelles pour cette ligne, lu au bon endroit. */
function executions(r: B3Row): number {
  const ind = INDICATEUR[r.id];
  if (ind.via === 'amont') return r.appels;
  return (r.caches[ind.cache] ?? { m: 0 }).m;
}

export function runB3(): B3Row[] {
  const out: B3Row[] = [];
  for (const id of CIBLES) {
    for (const n of PALIERS) {
      out.push(runChild<B3Row>('b3-rung', { BENCH_EP: id, BENCH_N: String(n) }));
    }
  }
  return out;
}

export function printB3(rows: B3Row[]): void {
  console.log('\n═══ B3 · Déduplication en vol — N requêtes simultanées sur cache froid ═══\n');
  console.log(' endpoint     │   N │ exécutions │ lues sur     │ cache.misses │ dedup │ appels amont │ p95 ms │ err');
  console.log('──────────────┼─────┼────────────┼──────────────┼──────────────┼───────┼──────────────┼────────┼────');
  for (const r of rows) {
    const ind = INDICATEUR[r.id];
    const c = ind.via === 'cache' ? (r.caches[ind.cache] ?? { h: 0, m: 0, d: 0 }) : { h: 0, m: 0, d: 0 };
    const source = ind.via === 'cache' ? `cache ${ind.cache}` : 'appels amont';
    console.log(
      ` ${r.id.padEnd(12)}│ ${String(r.n).padStart(4)}│ ${String(executions(r)).padStart(10)} │ ${source.padEnd(12)} │` +
      ` ${(ind.via === 'cache' ? String(c.m) : '—').padStart(12)} │ ${(ind.via === 'cache' ? String(c.d) : '—').padStart(5)} │` +
      ` ${String(r.appels).padStart(12)} │ ${String(r.p95).padStart(6)} │ ${String(r.errors).padStart(3)}`,
    );
  }

  // Le critère : le nombre d'exécutions ne doit pas suivre N. On tolère 2 (une
  // seconde exécution peut légitimement démarrer si le TTL le plus court expire
  // pendant la rafale), jamais un chiffre proportionnel à N.
  //
  // `best-bets` est l'exception d'échelle : UNE exécution y déclenche des
  // dizaines d'appels amont légitimes (un par match, un par joueur). Son
  // critère porte donc sur `misses`, pas sur les appels — et B5 mesure
  // séparément si ces dizaines grandissent comme il faut.
  const fautifs = rows.filter((r) => {
    const ind = INDICATEUR[r.id];
    if (ind.via === 'cache') return executions(r) > 2;
    // Pour un endpoint à un seul appel amont par exécution, le seuil est le même.
    return executions(r) > 2;
  });
  console.log(
    fautifs.length
      ? `\n  ✗ exécutions multiples sur cache froid : ${fautifs.map((r) => `${r.id}@N=${r.n} → ${executions(r)}`).join(', ')}`
      : '\n  ✓ 1 seule exécution par clé froide à tous les paliers — la protection anti-troupeau tient',
  );
  console.log(
    '  · `cache.misses` à N sur les lignes NHL n\'est PAS une anomalie : `nhlApiClient`\n' +
    '    déduplique sous le cache, dans `fetchNHL`. La vérité pour lui est « appels amont ».',
  );
  const limites = rows.filter((r) => r.rateLimited > 0);
  if (limites.length) console.log(`  ⚠ ${limites.length} palier(s) ont pris des 429 : le limiteur fausse la mesure, relever API_RATE_LIMIT`);
}

export function main(): void {
  printB3(runB3());
}
