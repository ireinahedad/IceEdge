/**
 * export-props-snapshots.ts — Exporte la série temporelle `props_snapshots`
 * au format lu par le ML.
 *
 *   npm run props:export                       → ../ml/data/props_snapshots_live.csv
 *   npm run props:export -- /chemin/vers.csv   → chemin explicite
 *
 * Il n'existe aucun backfill de props à protéger (The Odds API n'en vend pas
 * l'historique pour la LNH) : ce fichier EST toute la série, et il est réécrit
 * en entier à chaque export.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { exportPropsSnapshotsCsv } from '../src/services/propsLogger.service';
import { pool } from '../src/db/connection';

async function main(): Promise<void> {
  const target = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, '..', '..', 'ml', 'data', 'props_snapshots_live.csv');

  const csv = await exportPropsSnapshotsCsv();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, csv);

  const lines = csv.trim().split('\n').slice(1);
  const byMarket = new Map<string, number>();
  for (const l of lines) {
    const market = l.split(',')[7] ?? '?';
    byMarket.set(market, (byMarket.get(market) ?? 0) + 1);
  }
  console.log(`${lines.length} observations écrites → ${target}`);
  for (const [m, n] of [...byMarket].sort()) console.log(`   ${m} : ${n}`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
