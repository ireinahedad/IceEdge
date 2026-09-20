/**
 * settle-stuck-slips.ts — Débloquer les coupons figés en `pending`.
 *
 *   npm run settle:stuck                       → simulation (défaut)
 *   npm run settle:stuck -- --repair           → simulation, réparation des anciennes jambes comprise
 *   npm run settle:stuck -- --repair --apply   → écrit vraiment
 *   npm run settle:stuck -- --user <uuid>      → un seul joueur
 *
 * SIMULATION PAR DÉFAUT. Régler un coupon est irréversible : l'XP est appliquée
 * et `outcome` ne revient jamais à `pending`. Le script montre donc jambe par
 * jambe ce qu'il ferait, et n'écrit que sur `--apply`.
 *
 * ── Ce qu'il répare, et pourquoi ce n'est pas la même chose ─────────────────
 *
 * 1. LA RÉPARATION (`--repair`) — trois formes de jambe que le règlement ne
 *    peut pas lire, réécrites d'après leur libellé. La plus coûteuse : les
 *    tuiles « X in OT/SO » de Match Betting
 *    annonçaient `game_to_ot` + sélection `yes`, exactement comme la tuile
 *    « Goes to OT » d'à côté. Les deux paris sont indiscernables par leur
 *    marché seul, et c'est pour ça qu'aucun des deux n'a jamais été réglé.
 *
 *    Mais ils ne sont PAS indiscernables tout court : la jambe porte aussi son
 *    `marketLabel`, écrit à la prise du pari — « Toronto in OT/SO » contre
 *    « Goes to OT » — et son `subjectId`, qui est l'équipe. Les jambes dont le
 *    libellé finit par « in OT/SO » sont donc réécrites vers le marché qu'elles
 *    auraient dû porter (`ot_so_winner`, sélection = l'équipe), et elles se
 *    règlent alors pour de bon au lieu d'être annulées.
 *
 *    Réservé aux jambes dont le libellé tranche. Une jambe `game_to_ot` + `yes`
 *    au libellé ambigu est laissée telle quelle : elle sera réglée comme « le
 *    match va en prolongation », le sens de ce nom de marché.
 *
 * 2. LE RÈGLEMENT — une fois les jambes réparées, la passe ordinaire
 *    (`settlePendingSlips`) fait le reste. Le script ne duplique aucune règle :
 *    l'aperçu passe par `previewPendingSlips`, qui appelle les mêmes fonctions.
 *
 * ⚠️ `--apply` exige que la migration 037 soit passée (`npm run db:migrate:all`),
 * sinon l'issue `void` n'existe pas encore côté base.
 */

import 'dotenv/config';
import { pool } from '../src/db/connection';
import { previewPendingSlips, settlePendingSlips } from '../src/services/settlement.service';

const APPLY     = process.argv.includes('--apply');
// `--repair-ot` reste accepté : c'est le nom sous lequel la réparation a été
// introduite, avant qu'elle ne couvre trois formes au lieu d'une.
const REPAIR    = process.argv.includes('--repair') || process.argv.includes('--repair-ot');
const USER_ARG  = (() => {
  const i = process.argv.indexOf('--user');
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

/**
 * Réparations des jambes ANCIENNES, décidées d'après leur libellé.
 *
 * Toutes suivent le même principe : le pari a été enregistré avec un marché ou
 * une sélection que le règlement ne peut pas lire, mais `marketLabel` — écrit à
 * la prise du pari — dit sans ambiguïté de quoi il s'agit. On réécrit donc la
 * forme machine à partir de la forme humaine, une seule fois, et sous les yeux
 * de la personne qui lance le script.
 *
 * Aucune de ces règles ne vit dans `settlement.service.ts` : le règlement reste
 * strict, et une heuristique de libellé n'a rien à faire dans un chemin qui
 * tourne toutes les deux minutes sur des paris en cours.
 */
interface Repair {
  nom:   string;
  porte: (leg: any) => boolean;
  fixe:  (leg: any) => any;
}

const REPAIRS: Repair[] = [
  {
    // « Toronto in OT/SO » annonçait `game_to_ot` + `yes`, exactement comme la
    // tuile « Goes to OT » d'à côté. Indiscernables par leur marché seul — mais
    // pas par leur libellé, ni par leur sujet, qui est l'équipe.
    nom: 'tuiles « in OT/SO » → ot_so_winner',
    porte: (l) => l?.marketType === 'game_to_ot'
                && /\bin OT\/SO\s*$/i.test(String(l?.marketLabel ?? ''))
                && !!l?.subjectId,
    fixe: (l) => ({ ...l, marketType: 'ot_so_winner', selectionValue: String(l.subjectId) }),
  },
  {
    // Les tuiles de buts par période partaient sans sélection : `selectionValue`
    // recevait alors l'abréviation de l'équipe, illisible des deux côtés.
    nom: 'buts par période → over / under',
    porte: (l) => /^period[123]_total_goals$/.test(String(l?.marketType ?? ''))
                && !['over', 'under'].includes(String(l?.selectionValue ?? '').toLowerCase())
                && /^(over|under)\b/i.test(String(l?.marketLabel ?? '')),
    fixe: (l) => ({
      ...l,
      selectionValue: /^over/i.test(String(l.marketLabel)) ? 'over' : 'under',
    }),
  },
  {
    // `TOR_by_3+` n'est aucun des deux vocabulaires que `parseMarginBucket`
    // connaît. Le côté se relit sur `isHome`, le seau sur la taille.
    nom: 'écart de victoire « ABBR_by_N » → home_/away_',
    porte: (l) => l?.marketType === 'winning_margin'
                && /^[a-z]{2,4}_by_/i.test(String(l?.selectionValue ?? '')),
    fixe: (l) => {
      const size = String(l.selectionValue).replace(/^[a-z]{2,4}_by_/i, '').toLowerCase();
      const côté = l?.isHome === false ? 'away' : 'home';
      return { ...l, selectionValue: `${côté}_${size === '3+' ? '3plus' : size}` };
    },
  },
];

const MARK: Record<string, string> = {
  win: '✅ gagnée', loss: '❌ perdue', void: '⊘  annulée', unknown: '…  indécise',
};

/**
 * Réécrit les jambes « X in OT/SO » vers `ot_so_winner`.
 *
 * Ne touche QUE les coupons encore en attente : un coupon déjà réglé l'a été
 * sur d'autres jambes, et réécrire son détail après coup changerait l'histoire
 * d'un pari sans changer son issue.
 */
async function repairLegs(userId?: string): Promise<{ slips: number; legs: number }> {
  const params: unknown[] = [];
  let where = `outcome = 'pending' AND jsonb_typeof(legs) = 'array'`;
  if (userId) { where += ` AND user_id = $1`; params.push(userId); }

  const { rows } = await pool.query(
    `SELECT id, legs FROM bet_slips WHERE ${where}`, params,
  );

  let slips = 0, legs = 0;
  for (const row of rows) {
    const list: any[] = Array.isArray(row.legs) ? row.legs : [];
    let touched = false;
    const applied: string[] = [];
    const next = list.map((leg) => {
      const r = REPAIRS.find((x) => x.porte(leg));
      if (!r) return leg;
      touched = true;
      legs++;
      applied.push(`${leg?.marketLabel ?? leg?.marketType} → ${r.nom}`);
      return r.fixe(leg);
    });
    if (!touched) continue;
    slips++;
    console.log(`  ${row.id} — ${list.length} jambe(s)`);
    for (const a of applied) console.log(`      ${a}`);
    if (APPLY) {
      // `outcome = 'pending'` dans le WHERE : si la passe périodique a réglé ce
      // coupon entre la lecture et l'écriture, on ne récrit pas son détail.
      await pool.query(
        `UPDATE bet_slips SET legs = $1::jsonb WHERE id = $2 AND outcome = 'pending'`,
        [JSON.stringify(next), row.id],
      );
    }
  }
  return { slips, legs };
}

async function main(): Promise<void> {
  console.log(APPLY ? '\n=== ÉCRITURE RÉELLE ===\n' : '\n=== SIMULATION (ajouter --apply pour écrire) ===\n');

  if (REPAIR) {
    console.log('— Réparation des jambes à la forme illisible —');
    const r = await repairLegs(USER_ARG);
    console.log(r.slips === 0
      ? '  aucune jambe à réparer\n'
      : `  ${r.legs} jambe(s) sur ${r.slips} coupon(s)\n`);
  }

  console.log('— Coupons en attente, et ce que la passe en ferait —');
  const preview = await previewPendingSlips(USER_ARG);
  if (preview.length === 0) console.log('  aucun coupon en attente');

  const tally: Record<string, number> = { win: 0, loss: 0, void: 0, pending: 0 };
  for (const slip of preview) {
    const verdict = slip.outcome ?? 'pending';
    tally[verdict]++;
    // On n'imprime que ce qui BOUGE : un coupon qui reste en attente parce que
    // son match est ce soir n'apprend rien à personne.
    if (!slip.outcome) continue;
    console.log(`\n  ${slip.id}  (${slip.placedAt.slice(0, 10)})  →  ${verdict.toUpperCase()}`);
    for (const leg of slip.legs) {
      console.log(`      ${MARK[leg.result] ?? leg.result}  ${leg.label}`);
      console.log(`                  ${leg.marketType} / ${leg.selectionValue ?? '—'} / match ${leg.gameId ?? '—'}`);
    }
  }

  console.log(`\n— Total —\n  gagnés ${tally.win}  ·  perdus ${tally.loss}  ·  annulés ${tally.void}  ·  toujours en attente ${tally.pending}`);

  if (!APPLY) {
    console.log('\nRien n\'a été écrit. Relancer avec --apply pour régler ces coupons.\n');
    return;
  }

  const summary = await settlePendingSlips(USER_ARG, { budgetMs: 10 * 60_000 });
  console.log(`\nPasse terminée : ${summary.settled} réglé(s) sur ${summary.checked} examiné(s) `
    + `(${summary.wins} gagnés, ${summary.losses} perdus, ${summary.voided} annulés)`
    + `${summary.exhausted ? '' : ' — INTERROMPUE, il en reste'}\n`);
}

main()
  .catch((err) => { console.error('[settle:stuck]', err); process.exitCode = 1; })
  .finally(() => pool.end());
