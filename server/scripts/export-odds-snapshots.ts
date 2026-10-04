/**
 * export-odds-snapshots.ts — Exporte la série temporelle `odds_snapshots`
 * (tous les livres collectés, dont les livres parallèles comme BET99) au format
 * de `ml/data/odds_snapshots_hist.csv`.
 *
 *   npm run odds:export-snapshots                       → ../ml/data/odds_snapshots_live.csv
 *   npm run odds:export-snapshots -- /chemin/vers.csv   → chemin explicite
 *
 * Fichier SÉPARÉ du backfill (`odds_snapshots_hist.csv`, payé, irremplaçable) :
 * l'export le réécrit en entier à chaque fois sans jamais toucher au backfill.
 * `backtest_walkforward.py` lit les deux.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { exportOddsSnapshotsCsv } from '../src/services/oddsLogger.service';
import { pool } from '../src/db/connection';

async function main(): Promise<void> {
  const target = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, '..', '..', 'ml', 'data', 'odds_snapshots_live.csv');

  const csv = await exportOddsSnapshotsCsv();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, csv);

  const lines = csv.trim().split('\n').slice(1);
  const bySource = new Map<string, number>();
  for (const l of lines) {
    const src = l.slice(l.lastIndexOf(',') + 1);
    bySource.set(src, (bySource.get(src) ?? 0) + 1);
  }
  console.log(`${lines.length} observations écrites → ${target}`);
  for (const [src, n] of [...bySource].sort()) console.log(`   ${src} : ${n}`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
