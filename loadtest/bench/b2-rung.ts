/** Palier du banc B2 — R requêtes séquentielles sur un endpoint, processus neuf. */

import { boot, request, sleep } from './harness';
import * as upstream from './upstream';
import * as pgstub from './pgstub';
import { TOUS } from './endpoints';
import { emit, envInt } from './spawn';

export async function main() {
  const ep = TOUS.find((e) => e.id === process.env.BENCH_EP);
  if (!ep) throw new Error(`endpoint inconnu : ${process.env.BENCH_EP}`);
  const repeats = envInt('BENCH_REPEATS', 20);

  upstream.setLeague({ teams: 32, games: 8, players: 30 });
  upstream.setLatency({ nhl: 10, odds: 10, ml: 5 });

  const { base, close } = await boot({ sqlLatencyMs: 1 });

  const parAppel: number[] = [];
  const sqlParAppel: number[] = [];
  const statuts: number[] = [];
  let cacheControl: string | null = null;

  for (let i = 0; i < repeats; i++) {
    upstream.reset();
    pgstub.reset();
    const r = await request(base, ep.path);
    parAppel.push(upstream.total());
    sqlParAppel.push(pgstub.total());
    statuts.push(r.status);
    if (i === 0) cacheControl = r.cacheControl;
    // Assez court pour rester DANS le TTL le plus serré du chemin (30 s pour
    // les matchs en direct) : on mesure le cache, pas son expiration.
    await sleep(15);
  }

  emit({
    id: ep.id,
    repeats,
    cacheControl,
    premier: parAppel[0],
    suivants: parAppel.slice(1).reduce((a, b) => a + b, 0),
    sqlPremier: sqlParAppel[0],
    sqlSuivants: sqlParAppel.slice(1).reduce((a, b) => a + b, 0),
    parAppel,
    erreurs: statuts.filter((s) => s >= 400).length,
  });

  await close();
}
