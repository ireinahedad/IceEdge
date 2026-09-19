/**
 * Palier du banc B3 — N requêtes SIMULTANÉES sur un cache froid, processus neuf.
 *
 * `BENCH_BREAK=1` neutralise la déduplication en vol de `TtlCache.wrap` : c'est
 * le contrôle négatif. Un banc qui ne sait pas échouer ne prouve rien.
 */

import { boot, request, burst, summarise } from './harness';
import * as upstream from './upstream';
import * as pgstub from './pgstub';
import { TOUS } from './endpoints';
import { emit, envInt } from './spawn';

export async function main() {
  const ep = TOUS.find((e) => e.id === process.env.BENCH_EP);
  if (!ep) throw new Error(`endpoint inconnu : ${process.env.BENCH_EP}`);
  const n = envInt('BENCH_N', 100);
  const casse = process.env.BENCH_BREAK === '1';

  upstream.setLeague({ teams: 32, games: 8, players: 30 });
  // Latence amont volontairement NON nulle : la fenêtre de course n'existe
  // qu'entre le départ du premier appel et son retour. À 0 ms, le premier
  // appelant aurait fini avant que le deuxième ne lise le cache, et le banc
  // conclurait que tout va bien sans avoir rien exercé.
  upstream.setLatency({ nhl: 150, odds: 150, ml: 50 });

  const { base, metrics, close } = await boot({ sqlLatencyMs: 2 });

  if (casse) {
    // Contrôle négatif : `wrap` exécute `fn` à chaque appel, sans cache ni
    // rattachement en vol. C'est exactement l'état du code avant la correction
    // de la ligne Z de l'audit.
    const { TtlCache } = await import('../../server/src/services/ttlCache');
    (TtlCache as any).prototype.wrap = async function (_k: string, fn: () => Promise<any>) {
      return fn();
    };
  }

  upstream.reset();
  pgstub.reset();
  metrics.resetMetrics();

  const replies = await burst(n, () => request(base, ep.path));
  const snap = metrics.snapshotMetrics();
  const c = upstream.counts();

  emit({
    id: ep.id,
    n,
    casse,
    ...summarise(replies),
    nhl: c['nhl-web'] + c['nhl-stats'] + c['nhl-search'],
    odds: c.odds,
    ml: c.ml,
    sql: pgstub.total(),
    appels: upstream.total(),
    appelsDistincts: upstream.distinct(),
    caches: Object.fromEntries(
      Object.entries(snap.caches)
        .filter(([, v]) => v.hits + v.misses + v.dedup > 0)
        .map(([k, v]) => [k, { h: v.hits, m: v.misses, d: v.dedup }]),
    ),
  });

  await close();
}
