/**
 * set-community-points.ts — fixe les points de membres de la communauté.
 *
 *   npm run set:community-points              → applique
 *   npm run set:community-points -- --dry-run → affiche avant/après, n'écrit rien
 *
 * Les « points » affichés (podium, classement) sont `performance_score`, et
 * `settlement.service` / `slip.service` le remettent égal à `xp` à chaque
 * règlement : on écrit donc xp ET performance_score (et le tier qui va avec),
 * sinon le prochain coupon réglé écraserait la valeur.
 */
import 'dotenv/config';
import { pool } from '../src/db/connection';

const TARGETS: Record<string, number> = {
  jamal: 3000,
  cestmimiquideadca: 2500,
  fatima: 1500,
};

const TIER_THRESHOLDS: [string, number][] = [['legend', 1500], ['sharp', 500], ['analyst', 100], ['rookie', 0]];
const tierFor = (xp: number) => TIER_THRESHOLDS.find(([, min]) => xp >= min)![0];

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const names = Object.keys(TARGETS);
  const { rows } = await pool.query(
    `SELECT u.id, lower(u.username) AS username, up.xp, up.performance_score, up.tier
       FROM users u JOIN user_profiles up ON up.user_id = u.id
      WHERE lower(u.username) = ANY($1)`,
    [names],
  );
  const missing = names.filter((n) => !rows.some((r) => r.username === n));
  if (missing.length) console.warn(`⚠ introuvable(s) : ${missing.join(', ')}`);

  for (const r of rows) {
    const pts = TARGETS[r.username];
    const tier = tierFor(pts);
    console.log(`${r.username}: ${r.performance_score} pts (${r.tier}) → ${pts} pts (${tier})`);
    if (!DRY_RUN) {
      await pool.query(
        `UPDATE user_profiles SET xp = $1, performance_score = $1, tier = $2 WHERE user_id = $3`,
        [pts, tier, r.id],
      );
    }
  }
  console.log(DRY_RUN ? 'Dry-run : rien écrit.' : '✓ Points mis à jour (le classement se rafraîchit en ≤ 60 s).');
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
