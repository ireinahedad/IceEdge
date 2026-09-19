/**
 * Palier du banc B5 — UNE exécution froide de `best-bets` pour une taille de
 * ligue donnée (matchs, équipes, joueurs). Processus neuf : c'est le coût de
 * l'exécution qu'on mesure, pas celui d'un cache déjà chaud.
 */

import { boot, request } from './harness';
import * as upstream from './upstream';
import * as pgstub from './pgstub';
import { emit, envInt } from './spawn';

export async function main() {
  const teams = envInt('BENCH_TEAMS', 32);
  const games = envInt('BENCH_GAMES', 8);
  const players = envInt('BENCH_PLAYERS', 30);

  upstream.setLeague({ teams, games, players });
  upstream.setLatency({ nhl: 5, odds: 5, ml: 3 });

  const { base, metrics, close } = await boot({ sqlLatencyMs: 1 });

  upstream.reset(); pgstub.reset(); metrics.resetMetrics();

  const r = await request(base, '/api/predict/best-bets?limit=15');
  const c = upstream.counts();
  const snap = metrics.snapshotMetrics();

  let scanned = 0;
  let bets = 0;
  try {
    const body = JSON.parse(r.body);
    scanned = body?.meta?.scanned ?? 0;
    bets = body?.bets?.length ?? 0;
  } catch { /* corps illisible : les compteurs restent à 0, la ligne le montrera */ }

  emit({
    teams, games, players,
    status: r.status,
    ms: r.ms,
    scanned, bets,
    nhl: c['nhl-web'] + c['nhl-stats'] + c['nhl-search'],
    odds: c.odds,
    ml: c.ml,
    sql: pgstub.total(),
    appels: upstream.total(),
    gaspillage: upstream.total() - upstream.distinct(),
    mlMisses: snap.caches.mlPredictions?.misses ?? 0,
    mlDedup: snap.caches.mlPredictions?.dedup ?? 0,
  });

  await close();
}
