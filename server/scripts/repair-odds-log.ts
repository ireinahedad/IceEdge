/**
 * repair-odds-log.ts — Reconstruit l'ouverture et la clôture d'`odds_log` à
 * partir d'`odds_snapshots`, avec les règles du collecteur corrigé le
 * 2026-10-12 (livre de collecte, jour du match, avant la mise au jeu, paire
 * plausible). Voir `src/services/oddsLogRepair.ts` pour le pourquoi.
 *
 *   npm run odds:repair                         → ESSAI À BLANC (rien n'est écrit)
 *   npm run odds:repair -- --since 2026-08-01   → autre date de départ
 *   npm run odds:repair -- --apply              → écrit, dans UNE transaction
 *
 * Par défaut on ne regarde que la saison 2026-27 (depuis le 2026-08-01) : c'est
 * la seule collectée par ce code. L'historique SBRO et le backfill The Odds API
 * vivent dans `ml/data/odds.csv`, pas dans `odds_log`, et ne sont pas touchés.
 *
 * Ce que le script ne fait PAS : supprimer des lignes (un match sans prix
 * valide garde sa ligne, prix à NULL) ni toucher `odds_snapshots` (la série
 * archivée reste telle quelle ; ses lecteurs filtrent déjà sur la mise au jeu).
 *
 * Ensuite, côté ML : `npm run odds:export` puis, dans ml/python,
 * `python fetch_data_v4.py --only odds --from-local` et `python build_dataset.py`.
 */

import 'dotenv/config';
import { pool } from '../src/db/connection';
import { ODDS_COLLECT_BOOKMAKERS } from '../src/services/oddsClient';
import { rebuildPrices, diffPrices, PRICE_COLUMNS, type SnapshotRow } from '../src/services/oddsLogRepair';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const since = arg('--since') ?? '2026-08-01';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error(`--since invalide : ${since}`);
  const books = ODDS_COLLECT_BOOKMAKERS.split(',').map((b) => b.trim()).filter(Boolean);

  const { rows: logRows } = await pool.query(
    `SELECT to_char(game_date, 'YYYY-MM-DD') AS game_date, home_team, away_team,
            ${PRICE_COLUMNS.join(', ')}
       FROM odds_log WHERE game_date >= $1::date
      ORDER BY game_date, home_team`, [since]);
  const { rows: snapRows } = await pool.query(
    `SELECT to_char(game_date, 'YYYY-MM-DD') AS game_date, home_team, away_team,
            observed_at, commence_time, bookmaker,
            home_ml, away_ml, total, total_over, total_under,
            puck_line_home, pl_home_price, pl_away_price
       FROM odds_snapshots WHERE game_date >= $1::date`, [since]);

  const byGame = new Map<string, SnapshotRow[]>();
  for (const s of snapRows as SnapshotRow[]) {
    const k = `${s.game_date}|${s.home_team}|${s.away_team}`;
    if (!byGame.has(k)) byGame.set(k, []);
    byGame.get(k)!.push(s);
  }

  const changes: { key: string; cols: string[]; set: Record<string, number | null>; before: any }[] = [];
  let nulledMl = 0;
  for (const r of logRows) {
    const key = `${r.game_date}|${r.home_team}|${r.away_team}`;
    const rebuilt = rebuildPrices(byGame.get(key) ?? [], books);
    const cols = diffPrices(r, rebuilt);
    if (!cols.length) continue;
    if (r.home_ml_close != null && rebuilt.home_ml_close == null) nulledMl += 1;
    changes.push({ key, cols, set: Object.fromEntries(cols.map((c) => [c, rebuilt[c]])), before: r });
  }

  console.log(`odds_log depuis ${since} : ${logRows.length} matchs, ${snapRows.length} snapshots, `
    + `livre(s) de collecte : ${books.join(', ')}`);
  console.log(`→ ${changes.length} matchs à corriger, dont ${nulledMl} dont le moneyline passe à NULL `
    + `(aucune observation valide le jour du match).`);
  const fmt = (v: unknown) => (v == null ? '—' : Number(v).toFixed(2));
  for (const c of changes) {
    const b = c.before;
    const s = { ...b, ...c.set };
    console.log(`  ${c.key.padEnd(20)} ML ouv ${fmt(b.home_ml_open)}/${fmt(b.away_ml_open)} → ${fmt(s.home_ml_open)}/${fmt(s.away_ml_open)}`
      + `   clô ${fmt(b.home_ml_close)}/${fmt(b.away_ml_close)} → ${fmt(s.home_ml_close)}/${fmt(s.away_ml_close)}`
      + `   (${c.cols.length} colonnes)`);
  }

  if (!apply) {
    console.log('\nEssai à blanc : rien n\'a été écrit. Relancer avec --apply pour appliquer.');
    return;
  }
  if (!changes.length) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of changes) {
      const [date, home, away] = c.key.split('|');
      const cols = Object.keys(c.set);
      await client.query(
        `UPDATE odds_log SET ${cols.map((col, i) => `${col} = $${i + 4}`).join(', ')}, updated_at = NOW()
          WHERE game_date = $1::date AND home_team = $2 AND away_team = $3`,
        [date, home, away, ...cols.map((col) => c.set[col])]);
    }
    await client.query('COMMIT');
    console.log(`\n✅ ${changes.length} lignes d'odds_log corrigées.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
