/**
 * prediction/gameParlay.ts — probabilité exacte de plusieurs jambes d'un même
 * match, lue sur la loi jointe des scores. Point d'entrée public :
 * `../predictionEngine.ts`.
 */

import { MAX_GOALS, pWinsOvertime, scoreDistribution } from './scoreModel';
import { parseMarginBucket } from './marginPeriods';

// ── Coupon : probabilité EXACTE de plusieurs jambes d'un même match ──────────
//
// POURQUOI CE BLOC EXISTE. `services/parlay.ts` règle les relations LOGIQUES
// entre jambes — incompatibilité, doublon, implication — sans avoir besoin
// d'aucune donnée. Ce qu'il ne peut pas faire, c'est chiffrer une corrélation :
// « le domicile gagne » et « plus de 5,5 buts » ne s'excluent ni ne s'impliquent,
// mais ils ne sont pas indépendants pour autant. Les multiplier sous-estime le
// coupon, parce qu'une équipe qui gagne a souvent marqué.
//
// Or ce fichier possède déjà la seule chose qui permet de répondre exactement :
// la loi jointe des scores. Il suffit d'énumérer ses cases et de compter celles
// où TOUTES les jambes passent. Pas de coefficient de corrélation à estimer —
// la corrélation est une conséquence de la distribution, pas un paramètre.

/** Une issue possible du match, score FINAL (but de prolongation compris). */
interface FinalOutcome {
  home: number;
  away: number;
  /** Le match s'est-il poursuivi au-delà de 60 minutes ? */
  ot: boolean;
}

/**
 * Jambe évaluable sur le score final. `subjectIsHome` dit de quel côté porte la
 * sélection : sans lui, « gagne » ne désigne personne.
 */
export interface GameParlayLeg {
  market:        string;
  selection?:    string;
  line?:         number;
  subjectIsHome: boolean;
}

/**
 * Marchés entièrement déterminés par le score final.
 *
 * `ot_winner` n'y est PAS : il est conditionnel à une prolongation, et les
 * books l'annulent quand le match se règle en 60 minutes. Le traiter comme une
 * condition ordinaire changerait la nature du pari. Les marchés de période, de
 * buteur et les props joueur n'y sont pas non plus — le score final ne les
 * décide pas.
 */
const SCORE_DERIVABLE = new Set([
  'moneyline', 'puck_line', 'alt_puck_line', 'regulation_result',
  'total_goals', 'total_goals_over', 'total_goals_under', 'team_total_goals',
  'both_teams_score', 'clean_sheet', 'game_to_ot', 'ot_so_winner', 'winning_margin',
  'correct_score',
]);

export function isScoreDerivable(market: string): boolean {
  return SCORE_DERIVABLE.has(market);
}

const NEG_TOKENS = new Set(['no', 'non', 'false', '0']);

/** La jambe est-elle gagnante sur CETTE issue ? */
function legWins(leg: GameParlayLeg, o: FinalOutcome): boolean {
  const sel  = (leg.selection ?? '').trim().toLowerCase();
  const isNo = NEG_TOKENS.has(sel);

  // Buts du sujet et de son adversaire, quel que soit le côté qu'il occupe.
  const mine  = leg.subjectIsHome ? o.home : o.away;
  const yours = leg.subjectIsHome ? o.away : o.home;
  const margin = mine - yours;
  const total  = o.home + o.away;

  const yes = (v: boolean) => (isNo ? !v : v);

  switch (leg.market) {
    case 'moneyline':          return margin > 0;
    // La ligne est le handicap du sujet (−1.5, −2.5, −3.5 ; −1.5 par défaut,
    // comme au règlement). « +x » est déclaré comme le « −x » adverse, côté non.
    case 'puck_line':          return yes(margin + (leg.line ?? -1.5) > 0);
    case 'alt_puck_line':      return margin >= 3;
    case 'regulation_result':  return margin > 0 && !o.ot;
    case 'game_to_ot':         return yes(o.ot);
    /**
     * « Gagne en OT/SO » — inconditionnel, contrairement à `ot_winner` qui n'est
     * pas dans cette liste. Les deux conditions se lisent directement sur
     * l'issue : le match est allé au-delà de 60 minutes, ET le sujet l'a gagné.
     *
     * C'est bien ce qui rend celui-ci dérivable du score final alors que
     * `ot_winner` ne l'est pas : `ot_winner` est annulé quand le match se règle
     * en 60 minutes, donc l'issue ne suffit pas à dire s'il est gagné, perdu ou
     * sans objet. Ici, pas de prolongation = perdu, tout simplement.
     */
    case 'ot_so_winner':       return o.ot && margin > 0;
    // Seuil 1+ par défaut ; `line` 1.5 / 2.5 pour « les deux marquent 2+ / 3+ ».
    case 'both_teams_score':   return yes(o.home > (leg.line ?? 0.5) && o.away > (leg.line ?? 0.5));
    /** Score exact, ordre domicile–visiteur ; `home_other` = domicile gagne avec 5+. */
    case 'correct_score': {
      const m = /^(\d{1,2})-(\d{1,2})$/.exec(sel);
      if (m) return o.home === Number(m[1]) && o.away === Number(m[2]);
      if (sel === 'home_other') return o.home > o.away && o.home >= 5;
      if (sel === 'away_other') return o.away > o.home && o.away >= 5;
      return false;
    }
    case 'clean_sheet':        return yes(yours === 0);

    case 'total_goals_over':   return total > (leg.line ?? 5.5);
    case 'total_goals_under':  return total < (leg.line ?? 5.5);
    case 'total_goals':
      return sel === 'under' ? total < (leg.line ?? 5.5) : total > (leg.line ?? 5.5);

    case 'team_total_goals':
      return sel === 'under' ? mine < (leg.line ?? 2.5) : mine > (leg.line ?? 2.5);

    case 'winning_margin': {
      const bucket = parseMarginBucket(leg.selection, leg.subjectIsHome);
      if (!bucket) return false;
      const size = Math.abs(margin);
      switch (bucket) {
        case 'win_1':      return margin ===  1;
        case 'win_2':      return margin ===  2;
        case 'win_3plus':  return margin >=  3;
        case 'lose_1':     return margin === -1;
        case 'lose_2':     return margin === -2;
        case 'lose_3plus': return margin <= -3;
        case 'win_2plus':  return margin >=  2;
        case 'lose_2plus': return margin <= -2;
        default:           return size === 0 ? false : false;
      }
    }

    default:
      return false;
  }
}

/**
 * Facteur de CORRÉLATION entre plusieurs jambes d'un même match.
 *
 * POURQUOI UN FACTEUR ET NON UNE PROBABILITÉ. On pourrait renvoyer directement
 * P(toutes gagnent) lue sur la loi jointe. Ce serait une erreur : la loi jointe
 * est construite sur les CADENCES DE BUTS, alors que les probabilités affichées
 * sur les tuiles viennent d'autres modèles — `predictMoneyline` part du
 * pourcentage de victoires (Log5), pas des buts. Sur une affiche où les deux
 * équipes gagnent autant mais marquent différemment, la loi jointe donne 67 %
 * au domicile là où la tuile affiche 53 %. Servir le premier chiffre ferait
 * qu'un coupon contredirait les tuiles dont il est composé — exactement la
 * classe de bug qu'on passe ce fichier à corriger.
 *
 * On extrait donc de la loi jointe la SEULE chose dont elle est la meilleure
 * source, et qui est sans dimension :
 *
 *     facteur = P(toutes gagnent) / ∏ P(chaque jambe gagne)
 *
 * les deux termes étant lus sur la MÊME distribution. Le facteur vaut 1 pour
 * des jambes indépendantes, plus de 1 quand elles se renforcent (« le domicile
 * gagne » et « plus de 5,5 buts » : une équipe qui gagne a souvent marqué),
 * moins de 1 quand elles se gênent, et 0 quand elles s'excluent. L'appelant
 * l'applique au produit des probabilités AFFICHÉES, qui restent la référence
 * pour les marges.
 *
 * LA PROLONGATION. Une case de la diagonale est un nul RÉGLEMENTAIRE, pas un
 * score final : le match s'y termine par un but de plus pour l'un des camps.
 * Chaque case nulle est donc éclatée en deux issues, pondérées par le modèle de
 * prolongation ajusté. C'est ce qui permet à « va en prolongation » et « gagne
 * en 60 minutes » de cohabiter correctement dans un même coupon.
 *
 * Retourne `null` sans cadences exploitables — l'appelant retombe alors sur le
 * produit plutôt que sur un chiffre inventé.
 */
export interface GameParlayCorrelation {
  /** Multiplicateur à appliquer au produit des probabilités affichées. */
  factor: number;
  /** P(toutes gagnent) selon la loi jointe — diagnostic. */
  joint: number;
  /** ∏ P(chaque jambe) selon la MÊME loi — diagnostic. */
  independent: number;
}

// ── Jambe JOUEUR dans la loi jointe (piste 2, 2026-10-15) ────────────────────
//
// « X marque » n'est pas décidé par le score final, mais il en DÉPEND : sachant
// que son équipe a marqué n buts, X en a inscrit au moins un avec la
// probabilité 1 − (1 − s)^n, où s est sa part des buts de l'équipe. Une jambe
// joueur entre donc dans la loi jointe comme un POIDS par case, pas comme un
// indicateur — et sa corrélation avec « son équipe gagne », « plus de 5,5 »,
// « −1,5 »… sort de la grille, comme pour les jambes d'équipe.
//
// Mesuré avant d'être branché (ml/python/explore_players/joint.py, règle posée
// avant le run, 189 000 joueur-matchs hors échantillon 2022-23 → 2025-26) :
// contre le produit (ce que faisait le coupon), log-perte sur les 4 issues
// meilleure en validation ET en test pour « marque + gagne » (z 27 en test),
// « 1+ point + gagne » (z 39), « marque + plus de 5,5 » (z 22), « marque +
// gagne par 2 » (z 26), « marque + l'adversaire gagne » (z 28) — avec cette
// même grille Poisson et cette même part μ / E[N]. Observé : P(marque ET
// gagne) = 1,33 × le produit ; la grille dit 1,28.
//
// Ce qui n'est PAS branché, faute de gain mesuré : deux joueurs du même match
// (deux coéquipiers qui marquent : lift observé 1,02, rien à gagner), et les
// seuils au-delà de 1 (2+ buts, 2+ points), jamais mesurés. Une seule jambe
// joueur par match entre donc dans la grille ; les autres restent au produit.

/**
 * Part des prolongations tranchées par un BUT (le reste : fusillade). Un but de
 * fusillade compte au score final mais à aucun joueur. Mesuré sur 1 849
 * prolongations 2015-16 → 2021-22 (3 c. 3) : 64,9 %.
 */
export const OT_GOAL_SHARE = 0.649;

/** La jambe joueur posée sur la grille : son côté, et sa cadence pour ce match. */
export interface GamePlayerLeg {
  /** Le joueur est-il dans l'équipe à domicile ? */
  isHome: boolean;
  /**
   * Cadence par match de l'événement (buts pour « marque », points pour
   * « 1+ point »). La jambe passe si le joueur en a au moins un.
   */
  rate: number;
}

export async function predictGameLegCorrelation(
  homeId: string,
  awayId: string,
  legs: GameParlayLeg[],
  player?: GamePlayerLeg,
): Promise<GameParlayCorrelation | null> {
  if (legs.length === 0 && !player) return { factor: 1, joint: 1, independent: 1 };

  const d = await scoreDistribution(homeId, awayId);
  if (!d) return null;

  const pHomeOT = pWinsOvertime(d, true);
  const q = OT_GOAL_SHARE;

  // Issues finales, avec les buts COMPTABLES de l'équipe du joueur (sans le but
  // de fusillade). Un nul réglementaire k-k se termine par un but de plus pour
  // un camp : en prolongation (q, compté pour ses joueurs) ou en fusillade.
  const outcomes: Array<{ o: FinalOutcome; own: number; w: number }> = [];
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const cell = d.M[h][a];
      if (cell <= 0) continue;
      const own = player?.isHome === false ? a : h;
      if (h !== a) {
        outcomes.push({ o: { home: h, away: a, ot: false }, own, w: cell });
      } else {
        const homeWin = { home: h + 1, away: a, ot: true };
        const awayWin = { home: h, away: a + 1, ot: true };
        const mineWins = player?.isHome !== false;   // sans joueur : sans effet
        outcomes.push({ o: homeWin, own: own + (mineWins ? 1 : 0), w: cell * pHomeOT * q });
        outcomes.push({ o: homeWin, own, w: cell * pHomeOT * (1 - q) });
        outcomes.push({ o: awayWin, own: own + (mineWins ? 0 : 1), w: cell * (1 - pHomeOT) * q });
        outcomes.push({ o: awayWin, own, w: cell * (1 - pHomeOT) * (1 - q) });
      }
    }
  }

  // Part du joueur : sa cadence rapportée aux buts comptables attendus de son
  // équipe sur CETTE grille (même échelle que les cases qu'on va lire).
  let share = 0;
  if (player) {
    const expected = outcomes.reduce((acc, x) => acc + x.w * x.own, 0);
    if (!(player.rate > 0) || !(expected > 0)) return null;
    share = Math.min(0.99, player.rate / expected);
  }

  let joint = 0;
  const marginals = new Array(legs.length).fill(0);
  let playerMarginal = 0;

  for (const { o, own, w } of outcomes) {
    if (w <= 0) continue;
    let all = true;
    for (let i = 0; i < legs.length; i++) {
      if (legWins(legs[i], o)) marginals[i] += w;
      else all = false;
    }
    // Sans joueur, le poids de la jambe joueur vaut 1 : rien ne change.
    const px = player ? 1 - Math.pow(1 - share, own) : 1;
    playerMarginal += w * px;
    if (all) joint += w * px;
  }

  const independent = marginals.reduce((acc, m) => acc * m, 1) * (player ? playerMarginal : 1);
  // Une marge nulle rendrait le facteur infini : dans ce cas la loi jointe dit
  // que la jambe ne peut pas passer, et le produit vaut déjà 0.
  const factor = independent > 0 ? joint / independent : 0;

  return { factor, joint, independent };
}

/**
 * P(toutes les jambes gagnent) selon la seule loi jointe.
 *
 * Utile aux tests et au diagnostic — la route, elle, passe par
 * `predictGameLegCorrelation` pour rester cohérente avec les tuiles.
 */
export async function predictExactGameParlay(
  homeId: string,
  awayId: string,
  legs: GameParlayLeg[]
): Promise<number | null> {
  const r = await predictGameLegCorrelation(homeId, awayId, legs);
  return r === null ? null : r.joint;
}
