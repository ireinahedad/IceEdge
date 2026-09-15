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
  'both_teams_score', 'clean_sheet', 'game_to_ot', 'winning_margin',
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
    case 'puck_line':          return yes(margin >= 2);
    case 'alt_puck_line':      return margin >= 3;
    case 'regulation_result':  return margin > 0 && !o.ot;
    case 'game_to_ot':         return yes(o.ot);
    case 'both_teams_score':   return yes(o.home >= 1 && o.away >= 1);
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

export async function predictGameLegCorrelation(
  homeId: string,
  awayId: string,
  legs: GameParlayLeg[]
): Promise<GameParlayCorrelation | null> {
  if (legs.length === 0) return { factor: 1, joint: 1, independent: 1 };

  const d = await scoreDistribution(homeId, awayId);
  if (!d) return null;

  const pHomeOT = pWinsOvertime(d, true);
  let joint = 0;
  const marginals = new Array(legs.length).fill(0);

  /** Ajoute une issue finale et son poids aux compteurs. */
  const tally = (o: FinalOutcome, w: number) => {
    if (w <= 0) return;
    let all = true;
    for (let i = 0; i < legs.length; i++) {
      if (legWins(legs[i], o)) marginals[i] += w;
      else all = false;
    }
    if (all) joint += w;
  };

  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const cell = d.M[h][a];
      if (cell <= 0) continue;
      if (h !== a) {
        tally({ home: h, away: a, ot: false }, cell);
      } else {
        tally({ home: h + 1, away: a, ot: true }, cell * pHomeOT);
        tally({ home: h, away: a + 1, ot: true }, cell * (1 - pHomeOT));
      }
    }
  }

  const independent = marginals.reduce((acc, m) => acc * m, 1);
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
