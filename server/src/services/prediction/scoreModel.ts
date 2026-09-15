/**
 * prediction/scoreModel.ts — primitives mathématiques (Log5, Poisson, loi
 * normale) et loi jointe des scores d'un match. Point d'entrée public :
 * `../predictionEngine.ts`.
 */

import { fetchTeams } from '../nhlApiClient';

// ── Math helpers ──────────────────────────────────────────────────────────────

/**
 * Log5 (Bill James): P(A beats B) given their independent win rates as fractions.
 * Handles edge cases where either rate is 0 or 1.
 */
export function log5(wA: number, wB: number): number {
  const d = wA + wB - 2 * wA * wB;
  if (d === 0) return 0.5;
  return (wA - wA * wB) / d;
}

/**
 * Poisson P(X > line) — supports half-integer lines (e.g. 2.5).
 * P(X > line) = 1 - P(X <= floor(line))
 */
export function poissonOver(lambda: number, line: number): number {
  const k = Math.floor(line);
  let cdf = 0;
  let term = Math.exp(-lambda);
  for (let i = 0; i <= k; i++) {
    cdf += term;
    term = (term * lambda) / (i + 1);
  }
  return Math.max(0.02, Math.min(0.98, 1 - cdf));
}

export function poissonUnder(lambda: number, line: number): number {
  return 1 - poissonOver(lambda, line);
}

/**
 * Écart-type du temps de jeu d'un joueur, en PART de sa moyenne.
 *
 * Le temps de jeu est une durée, pas un comptage : Poisson lui imposerait
 * σ = √λ, soit ±4,2 minutes autour d'une moyenne de 18 — bien plus que ce qu'on
 * observe. Un joueur tourne autour de son rôle d'un soir à l'autre, et l'écart
 * grandit avec les minutes (un premier trio varie plus en valeur absolue qu'un
 * quatrième), d'où une dispersion relative plutôt qu'absolue.
 */
export const TOI_REL_SD = 0.16;

/** Φ(z) — approximation d'Abramowitz & Stegun 26.2.17, erreur < 7,5e−8. */
export function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x    = Math.abs(z) / Math.SQRT2;
  const t    = 1 / (1 + 0.3275911 * x);
  const y    = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
                    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/** Clamp [3, 97] and return as integer percentage */
export function pct(p: number): number {
  return Math.round(Math.max(3, Math.min(97, p * 100)));
}

// ── Buts d'une équipe sur un match ────────────────────────────────────────────

/** Buts/match moyens d'une équipe NHL. */
export const LEAGUE_AVG_GPG = 3.05;

// ─────────────────────────────────────────────────────────────────────────────
// CALIBRATION — toutes les valeurs ci-dessous sont MESURÉES sur
// `ml/data/games_spine.csv`, tranche 2022-2025 (5 248 matchs, 10 496
// équipe-matchs), scores FINAUX (but de prolongation/fusillade inclus), le
// 2026-09-13. Aucune ne vient d'une estimation de mémoire.
//
// Elles ont remplacé trois constantes qui ne collaient pas aux données :
//
//   LEAGUE_BTTS_RATE      0.83  → 0.90   (mesuré 90.0 %)
//   LEAGUE_SHUTOUT_RATE   0.085 → 0.050  (mesuré 4.98 % par équipe-match)
//   GOALS_DISPERSION_K    6.5   → supprimé, cf. ci-dessous
//
// Pour refaire la mesure : compter sur `games_spine.csv` la part des matchs où
// `min(home_score, away_score) >= 1`, celle des équipe-matchs à 0 but, et la
// répartition de `abs(home_score - away_score)`.
// ─────────────────────────────────────────────────────────────────────────────

/** Taux de « les deux équipes marquent ». Mesuré : 90.0 %. */
export const LEAGUE_BTTS_RATE = 0.90;

/** Part des équipe-matchs terminés sans marquer. Mesuré : 4.98 %. */
export const LEAGUE_SHUTOUT_RATE = 0.050;

/**
 * Part des matchs non réglés en 60 minutes. 0.2204 est le taux observé sur la
 * tranche de test du modèle de score Python (`ml/models/score_report.json`),
 * qui est la seule source ici à distinguer nul réglementaire et score final —
 * `games_spine.csv` ne porte que le score final, où l'écart 0 n'existe pas.
 */
export const LEAGUE_OT_RATE = 0.2204;

/**
 * P(une équipe de cadence λ marque exactement n buts) — POISSON.
 *
 * POURQUOI POISSON, ET POURQUOI PLUS DE BINOMIALE NÉGATIVE.
 *
 * Ce fichier portait `GOALS_DISPERSION_K = 6.5`, justifié ainsi : « à λ = 3.0,
 * Poisson prédit 5.0 % de blanchissages ; la NHL en observe ~8.5 % ». Les
 * 10 496 équipe-matchs de `games_spine.csv` disent autre chose :
 *
 *     moyenne 3.115    variance 3.050    variance/moyenne 0.979
 *     P(0 but) observé 4.98 %    Poisson 4.44 %    NB(k=6.5) 7.85 %
 *
 * Les buts d'une équipe sur un match sont donc LÉGÈREMENT SOUS-dispersés par
 * rapport à Poisson, pas sur-dispersés — le contraire de la prémisse. La
 * binomiale négative gonflait les blanchissages de moitié, ce qui tirait « les
 * deux marquent » à 85 % contre 90 % observés et « blanchissage » d'autant.
 *
 * Poisson colle aux marges à moins d'un demi-point partout. Ce qu'elle ne
 * capture pas, c'est la relation ENTRE les deux scores : voir MARGIN_TILT.
 */
export const MAX_GOALS = 15;

export function goalsPmf(lambda: number): number[] {
  const lam = Math.max(0.05, lambda);
  const pmf: number[] = new Array(MAX_GOALS + 1);
  pmf[0] = Math.exp(-lam);
  for (let n = 1; n <= MAX_GOALS; n++) pmf[n] = (pmf[n - 1] * lam) / n;

  // La queue au-delà de MAX_GOALS est négligeable mais pas nulle : on la reverse
  // sur le dernier seau pour que la somme fasse 1 et que les seaux d'écart ne
  // fuient pas.
  const total = pmf.reduce((s, p) => s + p, 0);
  pmf[MAX_GOALS] += 1 - total;
  return pmf;
}

/**
 * Élargissement des écarts — l'unique paramètre qui relie les deux scores.
 *
 * LE FAIT À EXPLIQUER : les marges de chaque équipe sont quasi-poissoniennes,
 * mais les ÉCARTS sont bien plus larges que ce que donnerait l'indépendance.
 * Sur la même tranche, en repartant de deux Poisson indépendantes :
 *
 *     écart de 3+ buts     modèle indépendant 29.7 %     observé 40.5 %
 *
 * Deux scores poissoniens mais des écarts trop larges, c'est la signature
 * d'une CORRÉLATION NÉGATIVE entre les deux : l'équipe qui domine marque
 * beaucoup ET étouffe l'autre (effets de score, filet désert, gardien retiré).
 * Aucune loi produit de deux marges indépendantes ne peut représenter ça —
 * c'est pour cette raison, et non par sur-dispersion, que l'ancienne binomiale
 * négative « marchait » sur les écarts : elle élargissait les deux marges pour
 * élargir l'écart, en cassant les marges au passage.
 *
 * On incline donc la loi jointe elle-même :
 *
 *     M(h, a) ∝ P(h) · P(a) · exp(θ · |h − a|)      pour h ≠ a
 *
 * θ = 0 redonne l'indépendance. θ = 0.25 est ajusté sur la répartition observée
 * des écarts. La diagonale est laissée hors de l'inclinaison : le taux de nuls
 * réglementaires est un observable distinct, calé séparément par TIE_INFLATION.
 *
 * Deux paramètres pour deux quantités mesurées, et pas un de plus. Contrôle
 * indépendant : le modèle de score Python a appris un `tau_margin`
 * (`ml/models/score_report.json`) qui remonte les écarts de 0 et de 3+ et
 * déprime ceux de 1 et 2 — exactement la forme que θ et TIE_INFLATION
 * produisent ici, ajustée séparément et sur d'autres données.
 */
const MARGIN_TILT = 0.25;

/** Loi jointe brute : Poisson × Poisson inclinée par MARGIN_TILT, normalisée. */
function rawJoint(lambdaSubject: number, lambdaOpponent: number): number[][] {
  const ps = goalsPmf(lambdaSubject);
  const po = goalsPmf(lambdaOpponent);

  const M: number[][] = [];
  let total = 0;
  for (let s = 0; s <= MAX_GOALS; s++) {
    M[s] = new Array(MAX_GOALS + 1);
    for (let o = 0; o <= MAX_GOALS; o++) {
      const d = Math.abs(s - o);
      const v = ps[s] * po[o] * (d === 0 ? 1 : Math.exp(MARGIN_TILT * d));
      M[s][o] = v;
      total += v;
    }
  }
  for (let s = 0; s <= MAX_GOALS; s++) {
    for (let o = 0; o <= MAX_GOALS; o++) M[s][o] /= total;
  }
  return M;
}

/** Masse de la diagonale (nul réglementaire) d'une loi jointe brute. */
function diagonalMass(M: number[][]): number {
  let tie = 0;
  for (let n = 0; n <= MAX_GOALS; n++) tie += M[n][n];
  return tie;
}

/**
 * Facteur d'inflation des nuls réglementaires.
 *
 * L'inclinaison MARGIN_TILT pousse mécaniquement de la masse hors de la
 * diagonale ; l'indépendance en laissait déjà trop peu. Ce facteur ramène
 * l'affiche MOYENNE sur le taux observé, et les autres affiches suivent :
 * un duel fermé passe au-dessus, un match ouvert en dessous.
 *
 * Calculé au chargement plutôt qu'écrit en dur : si LEAGUE_AVG_GPG,
 * MARGIN_TILT ou LEAGUE_OT_RATE bougent, la calibration suit.
 */
const TIE_INFLATION =
  LEAGUE_OT_RATE / diagonalMass(rawJoint(LEAGUE_AVG_GPG, LEAGUE_AVG_GPG));

/**
 * Loi jointe des scores pour une affiche, APRÈS inclinaison et calibration des
 * nuls. Tout ce qui suit — « les deux marquent », blanchissage, écart de
 * victoire, prolongation — se lit sur cette seule matrice, pour qu'aucun couple
 * de marchés ne puisse se contredire.
 *
 * C'était un vrai risque, pas une précaution théorique : « blanchissage » et
 * « les deux marquent » se calculaient par deux chemins différents, et le
 * service Python a toujours le défaut — sur BOS–SJS il annonce 92 % pour « les
 * deux marquent » (donc au plus 8 % de matchs avec une équipe blanchie) ET 10 %
 * pour « blanchissage adverse », ce qui est impossible.
 *
 * Retourne `null` quand une des deux cadences manque (intersaison, présaison,
 * équipe inconnue) : l'appelant doit alors servir un taux de ligue plutôt qu'un
 * chiffre dérivé de valeurs par défaut.
 */
interface ScoreDistribution {
  /** M[s][o] = P(le sujet marque s, l'adversaire o) en 60 minutes. */
  M: number[][];
  /** Masse de nul réglementaire, calibrée. */
  tie: number;
  lambdaSubject:  number;
  lambdaOpponent: number;
}

/** P(le sujet marque exactement n buts), marge de la loi jointe. */
export function subjectMargin(d: ScoreDistribution, n: number): number {
  let p = 0;
  for (let o = 0; o <= MAX_GOALS; o++) p += d.M[n][o];
  return p;
}

/** P(l'adversaire marque exactement n buts), marge de la loi jointe. */
export function opponentMargin(d: ScoreDistribution, n: number): number {
  let p = 0;
  for (let s = 0; s <= MAX_GOALS; s++) p += d.M[s][n];
  return p;
}

/**
 * « Sujet » et non « domicile » à dessein : l'UI interroge chaque marché du
 * point de vue d'une équipe (`gml` envoie le domicile, `gmla` l'extérieur), et
 * c'est `isHome` qui dit de quel côté de la glace se trouve ce sujet. Traiter le
 * premier argument comme le domicile inverserait tous les marchés demandés
 * depuis la tuile « extérieur ».
 */
/**
 * Avantage de la glace, en PART DE CADENCE DE BUTS.
 *
 * MESURÉ, pas posé : sur `ml/data/games_spine.csv`, saisons 2021-2025, le
 * domicile marque 3,2316 buts par match et le visiteur 3,0102. Appliquer un
 * facteur `f` à l'attaque du domicile et son inverse à celle du visiteur met un
 * rapport `f²` entre les deux cadences, d'où f = √(3,2316 / 3,0102) = 1,036.
 *
 * Un ajustement INDÉPENDANT tombe sur la même valeur : en cherchant le facteur
 * qui minimise la log-perte du pronostic de vainqueur sur 9 829 matchs hors
 * échantillon, l'optimum des saisons récentes est 1,02–1,04. Le nombre est donc
 * confirmé par deux chemins qui ne partagent rien.
 *
 * L'avantage de la glace RECULE en NHL : ajusté sur 2008-2025 il vaut 1,046,
 * sur les cinq dernières saisons 1,036. On prend le récent — c'est un pronostic,
 * pas de l'histoire. Pour refaire la mesure : rapport des buts domicile/visiteur
 * sur les saisons récentes du spine, racine carrée.
 *
 * Avant, la loi jointe n'avait AUCUN avantage de la glace : sur une affiche
 * parfaitement équilibrée elle donnait 49,7 % au domicile, là où la NHL en
 * observe 54,3 %. Cinq points d'erreur systématique sur tous les marchés qui en
 * dérivent.
 */
const HOME_ICE_GOAL_FACTOR = 1.036;

/**
 * Part du moneyline qui vient du modèle de score, le reste venant de Log5.
 *
 * POURQUOI UN MÉLANGE, ET POURQUOI 0,5. Les deux modèles répondaient à la même
 * question et se contredisaient : Log5 lit le POURCENTAGE DE VICTOIRES, la loi
 * jointe lit les CADENCES DE BUTS. Sur une affiche où deux équipes gagnent
 * autant mais marquent différemment, ils nommaient un favori différent — dans
 * 12,4 % des matchs mesurés, avec un écart médian de 4,6 points.
 *
 * Départager les deux était tentant. Les données refusent : sur 9 829 matchs
 * hors échantillon (ajustement sur les saisons antérieures uniquement, saison
 * par saison), Log5 sort à 0,68292 de log-perte et le modèle de score à
 * 0,68392. Log5 gagne 7 saisons sur 10, le modèle de score 3. Aucun ne domine.
 *
 * Leur MOYENNE, elle, bat les deux : 0,68065. C'est la signature de deux
 * modèles dont les erreurs ne sont pas corrélées — chacun voit ce que l'autre
 * ignore. Le pourcentage de victoires porte le gardien, les unités spéciales,
 * le jeu serré ; les cadences de buts portent la qualité du jeu et donnent une
 * loi jointe cohérente. Le poids optimal mesuré est exactement 0,50, et la
 * courbe est plate autour (0,4 → 0,68068 ; 0,6 → 0,68084) : ce n'est pas un
 * réglage sur le fil.
 *
 * RE-MESURÉ après `GOAL_RATE_SHRINK`, parce qu'un modèle de score contracté est
 * moins extrême et peut donc porter plus de poids : l'optimum glisse vers
 * 0,6–0,7 (0,5 → 0,67227 ; 0,6 → 0,67171 ; 0,7 → 0,67160). Le gain est de
 * 0,0007 sur 9 829 matchs — l'ordre de grandeur du bruit entre deux saisons.
 * On garde 0,50 : déplacer un second réglage pour ça, c'est ajuster le bruit.
 */
const MONEYLINE_SCORE_WEIGHT = 0.5;

/** P(le sujet gagne) lue sur une matrice jointe et sa masse de nuls. */
function winProbFrom(M: number[][], tie: number, ls: number, lo: number, isHome: boolean): number {
  let reg = 0;
  for (let s = 0; s <= MAX_GOALS; s++) {
    for (let o = 0; o < s; o++) reg += M[s][o];
  }
  return reg + tie * otWinShare(ls, lo, isHome);
}

/** Applique la calibration des nuls à une matrice brute, en place. */
function calibrateTies(M: number[][]): number {
  const raw     = diagonalMass(M);
  const tie     = Math.max(0, Math.min(0.60, raw * TIE_INFLATION));
  const rescale = raw >= 1 ? 0 : (1 - tie) / (1 - raw);
  const k       = raw > 0 ? tie / raw : 0;
  for (let sc = 0; sc <= MAX_GOALS; sc++) {
    for (let oc = 0; oc <= MAX_GOALS; oc++) {
      M[sc][oc] *= sc === oc ? k : rescale;
    }
  }
  return tie;
}

/**
 * TOUJOURS construite du point de vue du DOMICILE, quel que soit le camp qui
 * pose la question. C'est la seule façon d'avoir une loi par match plutôt qu'une
 * par tuile : deux constructions séparées, une par camp, ne sont complémentaires
 * que tant que rien ne les brise — et deux choses les brisent, l'écrêtage des
 * cadences à [0,8 ; 5,5] et la dichotomie de l'étape 3, qui ne convergent pas au
 * même endroit sur une affiche déséquilibrée. On mesurait alors 103 % pour les
 * deux camps d'un même match sur `ot_winner`. Voir `scoreDistribution`, qui
 * retourne la vue du sujet en transposant celle-ci.
 *
 * TROIS ÉTAPES, et la troisième est celle qui règle la contradiction :
 *
 *  1. cadences attaque × défense adverse, avec l'avantage de la glace ;
 *  2. loi jointe inclinée, nuls calibrés ;
 *  3. la loi est ensuite ÉTIRÉE pour que le vainqueur qu'elle prédit soit
 *     exactement celui du moneyline mélangé.
 *
 * L'étape 3 est ce qui fait qu'un coupon ne peut plus contredire les tuiles
 * dont il est composé. Sans elle, « les deux marquent », « blanchissage »,
 * « écart de victoire » et le moneyline racontaient trois histoires : les trois
 * premiers venaient des buts, le dernier du pourcentage de victoires. On garde
 * la meilleure estimation du vainqueur ET une seule distribution pour tout le
 * reste.
 */
async function homeScoreDistribution(
  homeId?: string,
  awayId?: string
): Promise<ScoreDistribution | null> {
  const [team, opp] = await Promise.all([
    homeId ? getTeam(homeId) : null,
    awayId ? getTeam(awayId) : null,
  ]);

  const baseS = expectedGoals(team, opp);
  const baseO = expectedGoals(opp, team);
  if (baseS === null || baseO === null) return null;

  // 1. Avantage de la glace sur les cadences.
  const ls = Math.max(0.8, Math.min(5.5, baseS * HOME_ICE_GOAL_FACTOR));
  const lo = Math.max(0.8, Math.min(5.5, baseO / HOME_ICE_GOAL_FACTOR));

  // 2. Ce que la loi jointe dit du vainqueur, avant tout étirement.
  const M0   = rawJoint(ls, lo);
  const tie0 = calibrateTies(M0);
  const pScore = winProbFrom(M0, tie0, ls, lo, true);

  // 3. Cible : moyenne du modèle de score et de Log5 (cf. MONEYLINE_SCORE_WEIGHT).
  //    Sans pourcentage de victoires exploitable, le modèle de score reste seul.
  const wS = team?.winPct, wO = opp?.winPct;
  let target = pScore;
  if (typeof wS === 'number' && typeof wO === 'number') {
    const pLog5 = Math.min(0.95, log5(wS / 100, wO / 100) + 0.03);
    target = MONEYLINE_SCORE_WEIGHT * pScore + (1 - MONEYLINE_SCORE_WEIGHT) * pLog5;
  }

  // Étirement : on cherche le facteur `g` tel que la loi inclinée prédise
  // exactement `target`. P(victoire) croît avec `g`, donc une dichotomie suffit.
  const tilted = (g: number) => {
    const a = Math.max(0.8, Math.min(5.5, ls * g));
    const b = Math.max(0.8, Math.min(5.5, lo / g));
    const Mx = rawJoint(a, b);
    const t  = calibrateTies(Mx);
    return { M: Mx, tie: t, ls: a, lo: b, p: winProbFrom(Mx, t, a, b, true) };
  };

  let loG = 0.5, hiG = 2.0, best = tilted(1);
  if (Math.abs(best.p - target) > 1e-4) {
    for (let i = 0; i < 40; i++) {
      const mid = (loG + hiG) / 2;
      best = tilted(mid);
      if (best.p < target) loG = mid; else hiG = mid;
    }
  }

  return { M: best.M, tie: best.tie, lambdaSubject: best.ls, lambdaOpponent: best.lo };
}

/** La même loi vue d'en face : on échange les deux axes, rien d'autre. */
function transposeDistribution(d: ScoreDistribution): ScoreDistribution {
  const M: number[][] = [];
  for (let s = 0; s <= MAX_GOALS; s++) {
    const row = new Array<number>(MAX_GOALS + 1);
    for (let o = 0; o <= MAX_GOALS; o++) row[o] = d.M[o][s];
    M.push(row);
  }
  return {
    M,
    tie: d.tie,
    lambdaSubject:  d.lambdaOpponent,
    lambdaOpponent: d.lambdaSubject,
  };
}

/**
 * La loi jointe du match, vue par le SUJET.
 *
 * « Sujet » et non « domicile » à dessein : l'UI interroge chaque marché du
 * point de vue d'une équipe (`gml` envoie le domicile, `gmla` l'extérieur), et
 * c'est `isHome` qui dit de quel côté de la glace se trouve ce sujet.
 *
 * UNE SEULE loi est calculée par match — celle du domicile — et la vue du
 * visiteur en est la transposée EXACTE. Conséquence recherchée : les deux tuiles
 * d'un même marché somment à 100 par construction, et non par chance. La version
 * précédente reconstruisait tout depuis le camp du sujet ; les deux
 * reconstructions divergeaient dès que l'écrêtage des cadences mordait d'un
 * côté seulement, et `ot_winner` sortait 103 % à deux.
 */
export async function scoreDistribution(
  teamId?: string,
  opponentId?: string,
  isHome = true
): Promise<ScoreDistribution | null> {
  const d = isHome
    ? await homeScoreDistribution(teamId, opponentId)
    : await homeScoreDistribution(opponentId, teamId);
  if (!d) return null;
  return isHome ? d : transposeDistribution(d);
}

/**
 * P(le sujet gagne la prolongation | 60 minutes nulles).
 *
 * Coefficients AJUSTÉS, pas supposés : ce sont ceux du modèle de score Python
 * (`ml/models/score_report.json → p_ot_model`), une logistique sur l'écart de
 * cadence, entraînée sur 3 427 prolongations réelles.
 *
 *     P(domicile gagne l'OT) = σ(0.264466 · (λ_dom − λ_ext) − 0.06097)
 *
 * CE QUE LES CHIFFRES DISENT. Le rapport d'entraînement donne log-loss 0.69142
 * pour ce modèle contre 0.69315 pour une pièce truquée à 50 % : l'écart est
 * minuscule, et c'est LE résultat. La prolongation à 3 contre 3 puis les tirs
 * de barrage sont très proches du pile ou face, quelle que soit la différence
 * de niveau. Une équipe avec un but par match d'avance ne gagne l'OT que
 * 55 % du temps.
 *
 * C'est pour ça que l'ancien `moneyline + 14` était intenable : il donnait 92 %
 * à un favori à 78 %, pour la phase du match où l'écart de talent compte le
 * MOINS. Le modèle Python lui-même, avec son heuristique
 * `0.52 + win_diff · 0.28`, monte encore à 69 % — trop haut aussi, et cette
 * fonction-ci est maintenant la référence des deux.
 */
const OT_WINNER_FIT = { slope: 0.264466, intercept: -0.06097 };

function otWinShare(lambdaSubject: number, lambdaOpponent: number, isHome: boolean): number {
  // Le modèle est orienté « domicile moins extérieur ». Quand le sujet est le
  // visiteur, on évalue pour le domicile et on prend le complément — inverser
  // le signe de l'écart ne suffirait pas, l'ordonnée à l'origine n'est pas
  // symétrique.
  const deltaHomeMinusAway = isHome
    ? lambdaSubject - lambdaOpponent
    : lambdaOpponent - lambdaSubject;

  const z = OT_WINNER_FIT.slope * deltaHomeMinusAway + OT_WINNER_FIT.intercept;
  const pHome = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
  return isHome ? pHome : 1 - pHome;
}

export function pWinsOvertime(d: ScoreDistribution, isHome: boolean): number {
  return otWinShare(d.lambdaSubject, d.lambdaOpponent, isHome);
}

/**
 * Contraction des cadences vers la moyenne de ligue.
 *
 * POURQUOI. « Buts pour par match » n'est pas la cadence d'une équipe : c'est
 * une ESTIMATION bruitée de cette cadence, sur 20 ou 40 matchs. Les prendre au
 * pied de la lettre et les MULTIPLIER (attaque × défense adverse) empile deux
 * bruits, et le modèle sortait des affiches bien plus déséquilibrées que la
 * réalité.
 *
 * CE QUE LES DONNÉES DISENT. Sur `games_spine.csv`, tranches d'écart de cadence
 * croissant, part des matchs finissant à UN but d'écart — le seul reflet du nul
 * réglementaire que le spine porte, puisqu'une prolongation finit toujours 1–0 :
 *
 *     |λ_dom − λ_ext|   observé   modèle (sans contraction)
 *         0,00–0,12      45,3 %      44,8 %
 *         0,53–0,71      44,7 %      42,3 %
 *         1,27–4,29      40,9 %      30,1 %   ← 11 points d'écart
 *
 * Les affiches équilibrées tombaient juste, les déséquilibrées pas du tout.
 *
 * COMMENT LA VALEUR EST FIXÉE. `gf' = L + k·(gf − L)` sur chaque cadence, k
 * ajusté sur les saisons 2008–2015 et évalué sur 2016+ (9 829 matchs jamais vus,
 * log-loss) :
 *
 *     k        vainqueur   6 seaux d'écart   total > 5,5
 *     0,25      0,67214        1,72316         0,68627
 *     0,35      0,67227        1,72350         0,68531   ← retenu
 *     0,50      0,67274        1,72441         0,68493
 *     1,00      0,68076        1,73850         0,69333   ← avant
 *
 * k = 1 (l'ancien comportement) est le PIRE des trois marchés. Les optima ne
 * coïncident pas exactement — 0,25 pour le vainqueur, 0,25–0,35 pour les écarts,
 * 0,45 pour les totaux — et 0,35 est la seule valeur à moins de 0,0005 des
 * trois.
 *
 * QUATRE VÉRIFICATIONS INDÉPENDANTES, toutes dans le même sens (2016+) :
 *
 *                            k = 1,00   k = 0,35   observé
 *     les deux marquent        86,7 %     88,3 %    89,0 %
 *     visiteur blanchi          7,5 %      6,7 %     6,4 %
 *     domicile blanchi          6,2 %      5,3 %     4,7 %
 *
 * Aucune de ces trois n'entre dans l'ajustement de k : elles le corroborent.
 */
const GOAL_RATE_SHRINK = 0.35;

const shrink = (rate: number) =>
  LEAGUE_AVG_GPG + GOAL_RATE_SHRINK * (rate - LEAGUE_AVG_GPG);

/**
 * Cadence de buts attendue d'une équipe FACE À CET ADVERSAIRE : son attaque
 * pondérée par la défense d'en face, ramenée à l'échelle de la ligue.
 * Retourne `null` quand une des deux stats manque ou qu'aucun match n'a encore
 * été joué (intersaison, présaison) — l'appelant doit alors servir le prior de
 * ligue plutôt qu'un chiffre fabriqué à partir de valeurs par défaut.
 */
export function expectedGoals(attack: any | null, defense: any | null): number | null {
  const gf = attack?.goalsForPerGame;
  const ga = defense?.goalsAgainstPerGame;
  const gpA = attack?.gamesPlayed  ?? 0;
  const gpD = defense?.gamesPlayed ?? 0;
  if (!gf || !ga || gf <= 0 || ga <= 0 || gpA < 1 || gpD < 1) return null;
  return Math.max(0.8, Math.min(5.5, (shrink(gf) * shrink(ga)) / LEAGUE_AVG_GPG));
}

// ── Team lookup ───────────────────────────────────────────────────────────────

export async function getTeam(id: string): Promise<any | null> {
  const teams = await fetchTeams();
  const norm = id.toLowerCase();
  return (
    teams.find(
      (t: any) =>
        t.id?.toLowerCase() === norm ||
        t.abbreviation?.toLowerCase() === norm
    ) ?? null
  );
}
