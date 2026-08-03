/**
 * export-odds-log.ts — Exporte la table `odds_log` au format attendu par
 * `ml/python/fetch_data_v4.py`.
 *
 *   npm run odds:export                       → ../ml/data/odds_live_log.csv
 *   npm run odds:export -- /chemin/vers.csv   → chemin explicite
 *
 * Le journal des cotes vit en base depuis la migration 027 (le disque Railway
 * est éphémère, cf. `oddsLogger.service.ts`). Ce script est le pont vers le
 * pipeline ML, qui lui tourne sur une machine où le fichier persiste.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { exportOddsLogCsv } from '../src/services/oddsLogger.service';
import { pool } from '../src/db/connection';

async function main(): Promise<void> {
  const target = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, '..', '..', 'ml', 'data', 'odds_live_log.csv');

  const csv = await exportOddsLogCsv();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, csv);

  // −1 pour l'en-tête : ce qui compte est le nombre de matchs, et un fichier
  // « 1 ligne » qui n'est que l'en-tête doit se voir comme 0.
  const count = Math.max(0, csv.trim().split('\n').length - 1);
  console.log(`${count} lignes écrites → ${target}`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
