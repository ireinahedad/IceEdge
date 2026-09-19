/**
 * Palier du banc B1 — UNE requête HTTP froide sur UN endpoint, dans un
 * processus neuf. Compte ce que cette seule requête fait payer.
 */

import { boot, request } from './harness';
import * as upstream from './upstream';
import * as pgstub from './pgstub';
import { TOUS } from './endpoints';
import { emit, envInt } from './spawn';

export async function main() {
  const id = process.env.BENCH_EP!;
  const ep = TOUS.find((e) => e.id === id);
  if (!ep) throw new Error(`endpoint inconnu : ${id}`);

  upstream.setLeague({
    teams: envInt('BENCH_TEAMS', 32),
    games: envInt('BENCH_GAMES', 8),
    players: envInt('BENCH_PLAYERS', 30),
  });
  upstream.setLatency({ nhl: 15, odds: 15, ml: 8 });

  const { base, metrics, close } = await boot({ sqlLatencyMs: 1 });

  upstream.reset();
  pgstub.reset();
  metrics.resetMetrics();

  const r = await request(base, ep.path);
  const snap = metrics.snapshotMetrics();
  const c = upstream.counts();

  emit({
    id: ep.id,
    status: r.status,
    ms: r.ms,
    cacheControl: r.cacheControl,
    nhl: c['nhl-web'] + c['nhl-stats'] + c['nhl-search'],
    odds: c.odds,
    ml: c.ml,
    sql: pgstub.total(),
    appelsDistincts: upstream.distinct(),
    appels: upstream.total(),
    gaspillage: upstream.total() - upstream.distinct(),
    pires: upstream.topRepeats(3),
    caches: Object.fromEntries(
      Object.entries(snap.caches)
        .filter(([, v]) => v.hits + v.misses + v.dedup > 0)
        .map(([k, v]) => [k, { h: v.hits, m: v.misses, d: v.dedup }]),
    ),
    erreur: r.status >= 400 ? r.body.slice(0, 300) : null,
  });

  await close();
}
