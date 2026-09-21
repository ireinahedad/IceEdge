/**
 * purge-stale-slips.ts — Supprimer les coupons jamais confirmés dont le match est passé.
 *
 *   npm run purge:stale                        → simulation (défaut)
 *   npm run purge:stale -- --apply             → supprime vraiment
 *   npm run purge:stale -- --user <uuid>       → un seul joueur
 *   npm run purge:stale -- --grace-h 12        → délai après la mise au jeu (défaut 12 h)
 *   npm run purge:stale -- --include-undated   → supprime AUSSI les coupons sans gameId
 *
 * POURQUOI. Remise à zéro avant la saison : les coupons restés en `pending`
 * alors que leurs matchs sont joués (bugs de règlement d'avant la migration
 * 037, présaison, deux matchs le même soir…) faussent les fiches et les
 * classements. On repart sur une base propre plutôt que de les régler après coup.
 *
 * CE QUI EST SUPPRIMÉ — un coupon `pending` dont CHAQUE jambe datée est passée :
 *   * match `final` selon l'API NHL, ou
 *   * mise au jeu il y a plus de `--grace-h` heures (match reporté, API muette).
 * Un parlay dont un seul match est encore à venir est GARDÉ.
 *
 * CE QUI EST GARDÉ, et listé :
 *   * coupons sans aucun `gameId` (futures / saison) — rien pour les dater ;
 *   * jambes dont l'API NHL n'a pas répondu — dans le doute, on ne supprime pas.
 *
 * SANS IMPACT XP : un coupon `pending` n'a jamais reçu d'XP (`xp_awarded = 0`,
 * l'XP n'est appliquée qu'au règlement). Les pièces jointes du chat sont des
 * instantanés sans clé étrangère : elles restent lisibles.
 *
 * IRRÉVERSIBLE côté base — les lignes supprimées sont donc d'abord écrites dans
 * `server/.purge-backups/purged-slips-<horodatage>.json` pour pouvoir les
 * réinsérer au besoin.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../src/db/connection';
import { fetchGameById } from '../src/services/nhlApiClient';

const APPLY   = process.argv.includes('--apply');
const argVal  = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const USER_ARG = argVal('--user');
const GRACE_MS = Number(argVal('--grace-h') ?? 12) * 3_600_000;
const INCLUDE_UNDATED = process.argv.includes('--include-undated');

type GameVerdict = { passed: boolean; label: string };

const gameCache = new Map<string, GameVerdict | null>();

/** `null` = API muette → on ne sait pas, donc on garde. */
async function gameVerdict(gameId: string): Promise<GameVerdict | null> {
  if (gameCache.has(gameId)) return gameCache.get(gameId)!;
  let v: GameVerdict | null = null;
  try {
    const g = await fetchGameById(gameId);
    const start = g?.startTimeUTC ? Date.parse(String(g.startTimeUTC)) : NaN;
    const label = `${g?.awayTeam?.abbreviation ?? '?'} @ `
                + `${g?.homeTeam?.abbreviation ?? '?'} `
                + `${g?.gameDate ?? String(g?.startTimeUTC ?? '').slice(0, 10)} [${g?.status ?? '?'}]`;
    const passed = g?.status === 'final'
                || (Number.isFinite(start) && Date.now() - start >= GRACE_MS);
    v = { passed, label };
  } catch { /* 404 / API down → inconnu */ }
  gameCache.set(gameId, v);
  return v;
}

async function main(): Promise<void> {
  console.log(APPLY ? '\n=== SUPPRESSION RÉELLE ===\n' : '\n=== SIMULATION (ajouter --apply pour supprimer) ===\n');

  const params: unknown[] = [];
  let where = `s.outcome = 'pending'`;
  if (USER_ARG) { where += ` AND s.user_id = $1`; params.push(USER_ARG); }

  const { rows } = await pool.query(
    `SELECT s.*, u.username
       FROM bet_slips s LEFT JOIN users u ON u.id = s.user_id
      WHERE ${where}
      ORDER BY s.placed_at`,
    params,
  );

  const toDelete: any[] = [];
  const undated: any[] = [];
  const unknown: any[] = [];
  let upcoming = 0;

  for (const slip of rows) {
    const legs: any[] = Array.isArray(slip.legs) ? slip.legs : [];
    const ids = [...new Set(legs.map((l) => l?.gameId).filter(Boolean).map(String))];
    if (ids.length === 0) {
      if (!INCLUDE_UNDATED) { undated.push(slip); continue; }
      toDelete.push(slip);
      console.log(`  ✂ ${slip.id}  ${String(slip.username ?? slip.user_id).padEnd(20)}  `
        + `placé ${new Date(slip.placed_at).toISOString().slice(0, 16)}  ${legs.length} jambe(s)  [sans gameId]`);
      for (const l of legs) console.log(`        ${l?.marketLabel ?? l?.marketType ?? '?'}`);
      continue;
    }

    const verdicts = await Promise.all(ids.map(gameVerdict));
    if (verdicts.some((v) => v === null)) { unknown.push(slip); continue; }
    if (!verdicts.every((v) => v!.passed)) { upcoming++; continue; }

    toDelete.push(slip);
    console.log(`  ✂ ${slip.id}  ${String(slip.username ?? slip.user_id).padEnd(20)}  `
      + `placé ${new Date(slip.placed_at).toISOString().slice(0, 16)}  ${legs.length} jambe(s)`);
    for (const v of verdicts) console.log(`        ${v!.label}`);
  }

  console.log(`\n— Total —`);
  console.log(`  à supprimer ${toDelete.length}  ·  match à venir (gardés) ${upcoming}`
    + `  ·  sans match (gardés) ${undated.length}  ·  API muette (gardés) ${unknown.length}`);
  for (const s of undated) console.log(`    sans gameId : ${s.id} (placé ${new Date(s.placed_at).toISOString().slice(0, 10)})`);
  for (const s of unknown) console.log(`    API muette  : ${s.id}`);

  if (toDelete.length === 0) { console.log('\nRien à supprimer.\n'); return; }
  if (!APPLY) { console.log('\nRien n\'a été supprimé. Relancer avec --apply.\n'); return; }

  // Sauvegarde AVANT toute écriture.
  const dir = path.join(__dirname, '..', '.purge-backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `purged-slips-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(toDelete, null, 2));
  console.log(`\nSauvegarde : ${file}`);

  // `outcome = 'pending'` dans le WHERE : si la passe de règlement a réglé un
  // coupon entre la lecture et maintenant, il n'est pas supprimé.
  const { rowCount } = await pool.query(
    `DELETE FROM bet_slips WHERE id = ANY($1::uuid[]) AND outcome = 'pending'`,
    [toDelete.map((s) => s.id)],
  );
  console.log(`Supprimés : ${rowCount} / ${toDelete.length}\n`);
}

main()
  .catch((err) => { console.error('[purge:stale]', err); process.exitCode = 1; })
  .finally(() => pool.end());
