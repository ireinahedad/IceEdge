/**
 * predictionEngine.ts
 * Real probability estimates using live NHL Stats API data.
 *
 * Team markets  → Log5 formula (win% from standings)
 * Player props  → Poisson distribution (per-game rates from player stats)
 * Futures       → Standings-rank-based prior
 */
import { fetchTeams, fetchPlayerById } from './nhlApiClient';

// ── Math helpers ──────────────────────────────────────────────────────────────

/**
 * Log5 (Bill James): P(A beats B) given their independent win rates as fractions.
 * Handles edge cases where either rate is 0 or 1.
 */
function log5(wA: number, wB: number): number {
  const d = wA + wB - 2 * wA * wB;
  if (d === 0) return 0.5;
  return (wA - wA * wB) / d;
}

/**
 * Poisson P(X > line) — supports half-integer lines (e.g. 2.5).
 * P(X > line) = 1 - P(X <= floor(line))
 */
function poissonOver(lambda: number, line: number): number {
  const k = Math.floor(line);
  let cdf = 0;
  let term = Math.exp(-lambda);
  for (let i = 0; i <= k; i++) {
    cdf += term;
    term = (term * lambda) / (i + 1);
  }
  return Math.max(0.02, Math.min(0.98, 1 - cdf));
}

function poissonUnder(lambda: number, line: number): number {
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
const TOI_REL_SD = 0.16;

/** Φ(z) — approximation d'Abramowitz & Stegun 26.2.17, erreur < 7,5e−8. */
function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x    = Math.abs(z) / Math.SQRT2;
  const t    = 1 / (1 + 0.3275911 * x);
  const y    = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
                    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/** Clamp [3, 97] and return as integer percentage */
function pct(p: number): number {
  return Math.round(Math.max(3, Math.min(97, p * 100)));
}

// ── Buts d'une équipe sur un match ────────────────────────────────────────────

/** Buts/match moyens d'une équipe NHL. */
const LEAGUE_AVG_GPG = 3.05;

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
const LEAGUE_BTTS_RATE = 0.90;

/** Part des équipe-matchs terminés sans marquer. Mesuré : 4.98 %. */
const LEAGUE_SHUTOUT_RATE = 0.050;

/**
 * Part des matchs non réglés en 60 minutes. 0.2204 est le taux observé sur la
 * tranche de test du modèle de score Python (`ml/models/score_report.json`),
 * qui est la seule source ici à distinguer nul réglementaire et score final —
 * `games_spine.csv` ne porte que le score final, où l'écart 0 n'existe pas.
 */
const LEAGUE_OT_RATE = 0.2204;

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
const MAX_GOALS = 15;

function goalsPmf(lambda: number): number[] {
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
function subjectMargin(d: ScoreDistribution, n: number): number {
  let p = 0;
  for (let o = 0; o <= MAX_GOALS; o++) p += d.M[n][o];
  return p;
}

/** P(l'adversaire marque exactement n buts), marge de la loi jointe. */
function opponentMargin(d: ScoreDistribution, n: number): number {
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
async function scoreDistribution(
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

function pWinsOvertime(d: ScoreDistribution, isHome: boolean): number {
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
function expectedGoals(attack: any | null, defense: any | null): number | null {
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

// ── Moneyline & game markets ──────────────────────────────────────────────────

/**
 * Moneyline — P(le sujet gagne).
 *
 * SE LIT SUR LA LOI JOINTE, et c'est tout l'objet du changement. Ce fichier
 * portait deux réponses concurrentes à cette question : cette fonction
 * (Log5 sur le pourcentage de victoires, +3 points pour la glace) et la
 * distribution des scores dont dérivent « les deux marquent », le blanchissage,
 * l'écart de victoire et la prolongation. Elles nommaient un favori DIFFÉRENT
 * dans 12,4 % des matchs, avec un écart médian de 4,6 points — un coupon
 * pouvait contredire les tuiles dont il était fait.
 *
 * `scoreDistribution` porte désormais le mélange des deux (cf.
 * MONEYLINE_SCORE_WEIGHT, mesuré meilleur que l'un comme l'autre) et toute la
 * loi est étirée pour le refléter. Lire le moneyline dessus garantit la
 * cohérence par construction : il n'y a plus deux modèles à réconcilier, il y
 * en a un.
 *
 * Sans cadences exploitables (intersaison, présaison, équipe inconnue), on
 * retombe sur Log5 seul — le pourcentage de victoires est alors la seule chose
 * qu'on ait.
 */
export async function predictMoneyline(
  teamId: string,
  opponentId?: string,
  isHome = true
): Promise<number> {
  const d = await scoreDistribution(teamId, opponentId, isHome);
  if (d) {
    let reg = 0;
    for (let s = 0; s <= MAX_GOALS; s++) {
      for (let o = 0; o < s; o++) reg += d.M[s][o];
    }
    return pct(reg + d.tie * pWinsOvertime(d, isHome));
  }

  // Repli : Log5 seul.
  const [team, opp] = await Promise.all([
    getTeam(teamId),
    opponentId ? getTeam(opponentId) : null,
  ]);
  // `?? 50` et non `|| 50` : une équipe réellement à 0 % de victoires doit
  // rester à 0. `fetchTeams` renvoie `null` (et non 0) quand aucun match n'a
  // été joué, ce qui est précisément ce que `??` rattrape.
  const wA = (team?.winPct ?? 50) / 100;
  const wB = (opp?.winPct  ?? 50) / 100;
  let p = log5(wA, wB);
  p = isHome ? Math.min(0.95, p + 0.03) : Math.max(0.05, p - 0.03);
  return pct(p);
}

/**
 * Over/Under du total de buts.
 *
 * La cadence de chaque équipe tient compte de la DÉFENSE d'en face
 * (`expectedGoals` = attaque × défense adverse / moyenne de ligue). L'ancienne
 * version sommait les deux seules attaques : la meilleure attaque de la ligue
 * face au meilleur gardien et la même face à la pire défense produisaient le
 * MÊME total attendu. C'est la correction déjà appliquée à « les deux
 * marquent » et au blanchissage ; ce marché était le dernier à additionner des
 * attaques dans le vide.
 *
 * Sans statistiques exploitables, on retombe sur la moyenne de ligue par
 * équipe plutôt que sur un 3.0 rond sorti de nulle part.
 */
export async function predictTotalGoals(
  line: number,
  selection: string,
  teamId?: string,
  opponentId?: string
): Promise<number> {
  const [team, opp] = await Promise.all([
    teamId     ? getTeam(teamId)     : null,
    opponentId ? getTeam(opponentId) : null,
  ]);

  const lambda = (expectedGoals(team, opp) ?? LEAGUE_AVG_GPG)
               + (expectedGoals(opp, team) ?? LEAGUE_AVG_GPG);

  return pct(
    selection === 'over'
      ? poissonOver(lambda, line)
      : poissonUnder(lambda, line)
  );
}

/**
 * Puck line (-1.5): rough adjustment on moneyline.
 * In practice: favourite covers -1.5 roughly 55–65% as often as they win outright.
 * We apply a 0.60 multiplier to the moneyline probability.
 */
export async function predictPuckLine(
  teamId: string,
  opponentId?: string,
  isHome = true
): Promise<number> {
  const ml = await predictMoneyline(teamId, opponentId, isHome);
  return Math.max(5, Math.round(ml * 0.62));
}

// ── Player prop markets ───────────────────────────────────────────────────────

/** Anytime goal scorer: P(X >= 1) = 1 - e^(-λ) where λ = goals/game */
export async function predictAnytimeGoal(playerId: string): Promise<number> {
  const player = await fetchPlayerById(playerId);
  const lambda =
    player.gamesPlayed > 0
      ? player.goals / player.gamesPlayed
      : 0.25; // league avg forward
  return pct(1 - Math.exp(-lambda));
}

// ── Premier / dernier buteur ──────────────────────────────────────────────────

/**
 * Part de la cadence du match qui revient à ce joueur :
 *   λ_joueur / (λ_équipe + λ_adverse)
 *
 * C'est la probabilité qu'un but QUELCONQUE du match soit inscrit par lui. Elle
 * remplace l'ancien `anytime / 4.5`, dont le diviseur constant ignorait à la
 * fois l'équipe du joueur et l'affiche : un attaquant d'une équipe qui marque
 * 3,6 buts par match et le même dans une équipe à 2,4 sortaient identiques.
 *
 * Sans adversaire connu (le coupon n'envoie que `playerId` sur ces marchés), la
 * cadence adverse vaut la moyenne de ligue — une hypothèse explicite, pas une
 * valeur par défaut silencieuse.
 */
async function goalShare(playerId: string, opponentId?: string): Promise<number | null> {
  const player = await fetchPlayerById(playerId);
  const gp = player?.gamesPlayed ?? 0;
  if (gp < 1) return null;

  const lambdaPlayer = player.goals / gp;

  const [team, opp] = await Promise.all([
    player.teamAbbr ? getTeam(player.teamAbbr) : null,
    opponentId      ? getTeam(opponentId)      : null,
  ]);

  const lambdaTeam = expectedGoals(team, opp) ?? team?.goalsForPerGame ?? LEAGUE_AVG_GPG;
  const lambdaOpp  = expectedGoals(opp, team) ?? opp?.goalsForPerGame  ?? LEAGUE_AVG_GPG;

  const total = lambdaTeam + lambdaOpp;
  if (!total || total <= 0) return null;
  return Math.max(0, Math.min(1, lambdaPlayer / total));
}

/**
 * Premier buteur du match.
 *
 * P(le premier but est de lui) = P(au moins un but dans le match) × sa part de
 * cadence. Le premier facteur vaut 1 en NHL — un 0–0 final n'existe pas, la
 * prolongation tranche — donc la part de cadence est la réponse.
 */
export async function predictFirstGoalScorer(
  playerId: string,
  opponentId?: string
): Promise<number | null> {
  const share = await goalShare(playerId, opponentId);
  if (share === null) return null;
  return pct(share);
}

/**
 * Dernier buteur du match.
 *
 * ⚠️ CE MODÈLE NE DISTINGUE PAS le dernier buteur du premier, et c'est un choix
 * assumé, pas l'alias silencieux qu'il remplace (`last_goal_scorer` appelait
 * littéralement `predictFirstGoalScorer` dans le routeur, sans que rien ne le
 * dise à l'écran).
 *
 * Sous une loi de comptage sans mémoire, chaque but du match a la même chance
 * d'être inscrit par un joueur donné — le premier comme le dernier. Les deux
 * marchés ont donc réellement la MÊME valeur sous ce modèle.
 *
 * Ce qui les sépare dans la vraie vie est l'effet du score en fin de match — le
 * filet désert surtout, qui concentre une part notable des derniers buts sur
 * les joueurs envoyés protéger une avance. L'application n'a aucune donnée de
 * filet désert ni de temps de jeu par situation ; inventer un coefficient pour
 * écarter artificiellement les deux chiffres serait exactement la faute qu'on
 * corrige ailleurs dans ce fichier.
 *
 * Le routeur remonte donc ce chiffre AVEC la mise en garde
 * `shared_with_first_goal`, pour que l'interface puisse dire que les deux
 * marchés partagent un estimateur au lieu de laisser croire à deux mesures
 * indépendantes.
 */
export async function predictLastGoalScorer(
  playerId: string,
  opponentId?: string
): Promise<number | null> {
  return predictFirstGoalScorer(playerId, opponentId);
}

/** Shots on goal O/U using real shots/game */
export async function predictShotsOU(
  playerId: string,
  line: number,
  selection: string
): Promise<number> {
  const player = await fetchPlayerById(playerId);
  const lambda =
    player.gamesPlayed > 0 ? player.shots / player.gamesPlayed : 2.5;
  return pct(
    selection === 'over'
      ? poissonOver(lambda, line)
      : poissonUnder(lambda, line)
  );
}

/** Assists O/U using real assists/game */
export async function predictAssistsOU(
  playerId: string,
  line: number,
  selection: string
): Promise<number> {
  const player = await fetchPlayerById(playerId);
  const lambda =
    player.gamesPlayed > 0 ? player.assists / player.gamesPlayed : 0.3;
  return pct(
    selection === 'over'
      ? poissonOver(lambda, line)
      : poissonUnder(lambda, line)
  );
}

/** Points O/U using real points/game */
export async function predictPointsOU(
  playerId: string,
  line: number,
  selection: string
): Promise<number> {
  const player = await fetchPlayerById(playerId);
  const lambda =
    player.gamesPlayed > 0 ? player.points / player.gamesPlayed : 0.55;
  return pct(
    selection === 'over'
      ? poissonOver(lambda, line)
      : poissonUnder(lambda, line)
  );
}

/**
 * PP points: uses real ppPoints/game
 * Line is typically 0.5 (will they get at least 1 PP point?)
 */
export async function predictPPPoint(playerId: string): Promise<number> {
  const player = await fetchPlayerById(playerId);
  const lambda =
    player.gamesPlayed > 0 ? player.ppPoints / player.gamesPlayed : 0.15;
  return pct(1 - Math.exp(-lambda)); // P(at least 1)
}

/**
 * Arrêts d'un gardien, à partir de SES statistiques.
 *
 * `fetchPlayerById` remonte déjà `shotsAgainst` et `goalsAgainst` de la saison
 * en cours pour les gardiens : λ = (tirs subis − buts encaissés) / matchs, soit
 * les arrêts réellement effectués par CE gardien, par match. C'est ce que
 * `predictPositionBasedProp` servait avec λ = 26 pour tout le monde, du
 * partant d'une équipe assiégée à celui qui voit 22 tirs par soir.
 *
 * Retourne `null` quand le joueur n'a pas de saison exploitable (pas encore
 * joué, ou skater sans statistiques de gardien) : l'appelant décide alors s'il
 * sert un repli explicitement étiqueté ou rien du tout.
 */
export async function predictGoalieSaves(
  playerId: string,
  line: number,
  selection: string
): Promise<number | null> {
  let player: any = null;
  try { player = await fetchPlayerById(playerId); } catch { return null; }

  const gp = player?.gamesPlayed ?? 0;
  const sa = player?.shotsAgainst;
  const ga = player?.goalsAgainst;
  if (gp < 1 || sa == null || ga == null || sa <= 0) return null;

  const saves = Math.max(0, sa - ga);
  const lambda = saves / gp;
  if (lambda <= 0) return null;

  return pct(
    selection === 'over'
      ? poissonOver(lambda, line)
      : poissonUnder(lambda, line)
  );
}

/**
 * Marchés dont l'API NHL utilisée ici ne donne AUCUNE statistique par joueur :
 * mises en échec, tirs bloqués, temps de jeu, mises au jeu, minutes de pénalité.
 *
 * Le point de départ (`v1/player/{id}/landing`) ne renvoie que buts, passes,
 * points, tirs, +/−, points en avantage numérique — et les colonnes de gardien.
 * Rien de ce qui suit n'en sort.
 *
 * Ce qui est servi ici est donc une MOYENNE DE LIGUE PAR POSITION, pas une
 * prédiction sur ce joueur : deux ailiers de la même équipe reçoivent le même
 * chiffre, et c'est irréductible tant qu'aucune source par joueur n'est
 * branchée. La fonction retourne le drapeau `playerSpecific: false` avec la
 * valeur ; le routeur le remonte et l'interface l'affiche, pour que la tuile
 * dise ce qu'elle est au lieu de se présenter comme une prédiction par joueur.
 *
 * Le drapeau est le CONTRAT : quiconque branche un jour une vraie source pour
 * l'un de ces marchés doit le passer à `true` pour ce marché, et pas seulement
 * changer la valeur.
 */
export interface PositionPropEstimate {
  probability: number;
  /** `false` : dérivé d'une moyenne de ligue par position, pas des stats du joueur. */
  playerSpecific: boolean;
}

export async function predictPositionBasedProp(
  playerId: string,
  propType: string,
  line: number,
  selection: string
): Promise<PositionPropEstimate | null> {
  // Les arrêts ont, eux, une vraie source par joueur depuis que les colonnes de
  // gardien sont remontées. Ils ne passent plus par les constantes.
  if (propType === 'goalie_saves_ou') {
    const p = await predictGoalieSaves(playerId, line, selection);
    return p === null ? null : { probability: p, playerSpecific: true };
  }

  let player: any = null;
  try { player = await fetchPlayerById(playerId); } catch { /* moyennes de ligue */ }

  const gp  = player?.gamesPlayed ?? 0;
  const pos = player?.position ?? 'F';
  const isD = pos === 'D';

  // ── Ce qui EST par joueur ──────────────────────────────────────────────────
  // Minutes de pénalité et temps de jeu moyen viennent de la même réponse
  // `seasonTotals` que buts/passes/tirs ; `fetchPlayerById` les mappe désormais.
  if (gp >= 1 && propType === 'penalty_minutes_ou' && player?.penaltyMinutes != null) {
    const lambda = player.penaltyMinutes / gp;
    if (lambda > 0) {
      return {
        probability: pct(
          selection === 'over' ? poissonOver(lambda, line) : poissonUnder(lambda, line)
        ),
        playerSpecific: true,
      };
    }
  }

  if (gp >= 1 && propType === 'time_on_ice_ou' && player?.avgToi > 0) {
    // Le temps de jeu n'est pas un comptage : c'est une durée, plutôt symétrique
    // d'un match à l'autre. Une loi de Poisson à λ = 18 minutes en écraserait la
    // dispersion (elle impose σ = √λ ≈ 4,2 min, bien trop large) ; on la modélise
    // en normale autour de la moyenne du joueur, avec un écart-type
    // proportionnel — les grosses minutes varient plus en valeur absolue que les
    // petites, et la part relative est stable d'un rôle à l'autre.
    const mu    = player.avgToi;
    const sigma = Math.max(1.2, mu * TOI_REL_SD);
    const z     = (line - mu) / sigma;
    const pOver = 1 - normalCdf(z);
    return {
      probability: pct(selection === 'over' ? pOver : 1 - pOver),
      playerSpecific: true,
    };
  }

  // ── Ce qui ne l'est PAS ────────────────────────────────────────────────────
  // Cadences par match, par position (moyennes NHL publiques).
  const LEAGUE_AVERAGES: Record<string, number> = {
    hits_ou:            isD ? 2.0 : 2.3,
    blocked_shots_ou:   isD ? 1.6 : 0.4,
    time_on_ice_ou:     isD ? 22  : 16,   // minutes — joueur sans saison jouée
    faceoff_wins_ou:    pos === 'C' ? 10 : 2,
    penalty_minutes_ou: 0.4,
  };

  const lambda = LEAGUE_AVERAGES[propType];
  // Marché inconnu : on ne sait pas, et un λ de 3,0 sorti de nulle part serait
  // un chiffre inventé de plus.
  if (lambda == null) return null;

  return {
    probability: pct(
      selection === 'over'
        ? poissonOver(lambda, line)
        : poissonUnder(lambda, line)
    ),
    playerSpecific: false,
  };
}

// ── Additional game / team markets ────────────────────────────────────────────

/**
 * `ot_winner` — qui gagne SI le match va en prolongation.
 *
 * Le marché suppose déjà qu'on est en prolongation : le moneyline n'y a pas sa
 * place. L'ancienne formule était `min(92, moneyline + 14)`, qui donnait 92 % à
 * un favori à 78 % pour la phase du match où l'écart de niveau compte le moins.
 * Elle POUSSAIT le favori là où les données le ramènent vers 50 %.
 *
 * Sans cadences exploitables, 50 % — c'est la meilleure réponse possible pour
 * un marché dont le modèle ajusté dit qu'il est presque un pile ou face.
 * (Anciennement `predictDoubleChance` : ce nom venait d'un marché « domicile ou
 * nul » retiré depuis, les nuls n'existant pas en NHL.)
 */
export async function predictOvertimeWinner(
  teamId: string,
  opponentId?: string,
  isHome = true
): Promise<number> {
  const d = await scoreDistribution(teamId, opponentId, isHome);
  if (!d) return 50;
  return pct(pWinsOvertime(d, isHome));
}

/** Alternate puck line (+1.5 underdog covers): moneyline boosted ~18pts. */
export async function predictAltPuckLine(
  teamId: string,
  opponentId?: string,
  isHome = true
): Promise<number> {
  const ml = await predictMoneyline(teamId, opponentId, isHome);
  return Math.min(95, ml + 18);
}

/** Regulation result (win in 60): moneyline haircut for the OT possibility. */
export async function predictRegulationResult(
  teamId: string,
  opponentId?: string,
  isHome = true
): Promise<number> {
  const ml = await predictMoneyline(teamId, opponentId, isHome);
  return Math.max(5, Math.round(ml * 0.87));
}

/** First / last team to score: correlated with overall win probability. */
export async function predictTeamToScore(
  teamId: string,
  opponentId?: string,
  isHome = true
): Promise<number> {
  const ml = await predictMoneyline(teamId, opponentId, isHome);
  // Scoring first tracks winning but is closer to a coin-flip; compress toward 50.
  return Math.round(50 + (ml - 50) * 0.6);
}

/**
 * Les deux équipes marquent : P(chaque camp inscrit ≥1 but).
 *
 * Trois choses que la version d'origine ne faisait pas :
 *
 *  1. **La cadence tient compte de l'adversaire.** On croisait la seule attaque
 *     de chaque équipe ; une attaque médiocre face à une défense poreuse et la
 *     même face au meilleur gardien de la ligue donnaient le même chiffre.
 *  2. **Le calcul se lit sur la loi jointe**, pas sur le produit de deux marges.
 *     C'est ce qui garantit que ce marché et « blanchissage » ne peuvent pas se
 *     contredire — voir `ScoreDistribution`.
 *  3. **Les marges sont poissoniennes**, pas binomiales négatives. La version
 *     précédente gonflait les blanchissages de moitié et sortait ~85 % là où
 *     les données en donnent 90.0 %.
 *
 * Sans stats exploitables (intersaison, présaison, équipe inconnue), on sert le
 * taux de ligue plutôt qu'un nombre dérivé de λ = 3.0 par défaut : c'est le
 * même aveu d'ignorance, mais avec la bonne valeur.
 *
 * La prolongation ne change rien : un 0–0 après 60 minutes finit 1–0, donc une
 * équipe reste blanchie dans tous les cas.
 */
export async function predictBothTeamsScore(
  teamId?: string,
  opponentId?: string,
  isHome = true
): Promise<number> {
  const d = await scoreDistribution(teamId, opponentId, isHome);
  if (!d) return pct(LEAGUE_BTTS_RATE);

  // Inclusion-exclusion sur la première ligne et la première colonne :
  //   P(les deux marquent) = 1 − P(sujet 0) − P(adversaire 0) + P(0–0)
  const pSubjectBlank  = subjectMargin(d, 0);
  const pOpponentBlank = opponentMargin(d, 0);
  return pct(1 - pSubjectBlank - pOpponentBlank + d.M[0][0]);
}

/**
 * Blanchissage : P(l'adversaire ne marque pas).
 *
 * Lu sur la MÊME matrice que « les deux marquent », donc nécessairement
 * cohérent avec lui : P(adversaire blanchi) ne peut pas dépasser
 * P(quelqu'un est blanchi) = 1 − BTTS. Le service Python viole encore cette
 * inégalité (cf. `ScoreDistribution`).
 */
export async function predictCleanSheet(
  teamId?: string,
  opponentId?: string,
  isHome = true
): Promise<number> {
  const d = await scoreDistribution(teamId, opponentId, isHome);
  if (!d) return pct(LEAGUE_SHUTOUT_RATE);
  return pct(opponentMargin(d, 0));
}

/**
 * Avantages numériques obtenus par une équipe sur un match, en moyenne NHL.
 *
 * Même valeur que `nhlPredictions.ts`, volontairement : les deux moteurs
 * répondent aux mêmes deux marchés et ne doivent pas se contredire sur le même
 * match. `nhlPredictions` avait déjà les bonnes formules ; ce fichier ne les
 * avait pas.
 */
const PP_OPPORTUNITIES = 3.1;

/**
 * L'équipe marque AU MOINS UN but en avantage numérique.
 *
 * PP% est un taux PAR OCCASION, pas une probabilité par match. Sur ~3,1
 * occasions :
 *
 *     P(au moins un) = 1 − e^(−3.1 × PP%)
 *
 * `ppPct * 1.8` donnait 36 % à une équipe à 20 % de réussite, là où le calcul
 * en donne 46 % — dix points sous la définition même du marché, et le
 * multiplicateur 1,8 ne correspondait à aucune quantité.
 */
export async function predictTeamPPGoal(teamId?: string): Promise<number> {
  const team = teamId ? await getTeam(teamId) : null;
  const ppPct = team?.ppPct ?? 20;
  return pct(1 - Math.exp(-PP_OPPORTUNITIES * (ppPct / 100)));
}

/**
 * L'équipe tue TOUTES ses pénalités du match.
 *
 * Même confusion en sens inverse : tuer une pénalité à 80 % ne veut pas dire
 * tuer la soirée à 80 %. Il faut réussir les ~3,1 fois :
 *
 *     P(toutes tuées) = PK% ^ 3.1
 *
 * Soit 48 % pour une équipe à 80 %, pas les 72 % que rendait `pkPct * 0.9`.
 * L'ancienne formule était monotone dans le bon sens mais décrivait une seule
 * pénalité, alors que le libellé de la tuile dit « toutes ».
 */
export async function predictPenaltyKill(teamId?: string): Promise<number> {
  const team = teamId ? await getTeam(teamId) : null;
  const pkPct = team?.pkPct ?? 80;
  return pct(Math.pow(pkPct / 100, PP_OPPORTUNITIES));
}

// ── Écart de victoire ─────────────────────────────────────────────────────────

/**
 * Seaux d'écart proposés par l'UI, du point de vue du SUJET.
 *   `win_1`     — le sujet gagne par exactement 1 but
 *   `win_2`     — par exactement 2
 *   `win_3plus` — par 3 ou plus
 *   `lose_*`    — les mêmes trois, côté adverse
 */
export type MarginBucket = 'win_1' | 'win_2' | 'win_3plus' | 'lose_1' | 'lose_2' | 'lose_3plus';

/**
 * Ce que l'UI peut DEMANDER : les six seaux disjoints, plus les deux seaux
 * ouverts « par 2 ou plus » que `betMarkets.ts` propose et qui sont la somme de
 * deux d'entre eux.
 */
export type MarginSelection = MarginBucket | 'win_2plus' | 'lose_2plus';

/**
 * Parse le `selection` d'un marché d'écart. L'UI a deux vocabulaires :
 *   - les tuiles de `gameMarkets.tsx` envoient l'écart seul ("1", "2", "3+"),
 *     le CÔTÉ étant porté par le sujet de la requête (`gml` = domicile,
 *     `gmla` = extérieur) ;
 *   - `betMarkets.ts` envoie un couple explicite ("home_1", "away_2plus").
 * Les deux doivent tomber sur le même seau, sinon le coupon et la page de
 * prédiction affichent deux chiffres pour le même pari.
 */
export function parseMarginBucket(
  selection: string | undefined,
  isHome: boolean
): MarginSelection | null {
  const s = (selection ?? '').trim().toLowerCase().replace(/[\s-]/g, '_');
  if (!s) return null;

  // Côté explicite : "home_1", "away_2plus", "away_3+"…
  const sided = /^(home|away)_(.+)$/.exec(s);
  let sizeToken = s;
  let subjectWins = true;
  if (sided) {
    const sideIsHome = sided[1] === 'home';
    // Le seau est nommé du point de vue du terrain, la réponse du point de vue
    // du sujet : ils coïncident seulement si le sujet est de ce côté-là.
    subjectWins = sideIsHome === isHome;
    sizeToken   = sided[2];
  }

  const size =
    /^(1|by_1|exactly_1)$/.test(sizeToken)                 ? 1 :
    /^(2|by_2|exactly_2)$/.test(sizeToken)                 ? 2 :
    /^(3|3\+|3plus|by_3|by_3\+|3_plus|2plus|2\+)$/.test(sizeToken) ? 3 : null;
  if (size === null) return null;

  // "2plus" de `betMarkets.ts` veut dire « 2 buts ou plus », pas « 3 ou plus » :
  // on le traite comme le seau ouvert, mais à partir de 2.
  if (/^(2plus|2\+)$/.test(sizeToken)) return subjectWins ? 'win_2plus' : 'lose_2plus';

  const name = size === 3 ? '3plus' : String(size);
  return (subjectWins ? `win_${name}` : `lose_${name}`) as MarginSelection;
}

/**
 * Probabilité de chaque seau d'écart, du point de vue du sujet.
 *
 * Deux choses que la constante `12` ne pouvait pas faire :
 *
 *  1. **Les six seaux sont calculés ensemble et somment à 1.** Six tuiles à 12 %
 *     totalisaient 72 % pour une partition EXHAUSTIVE des issues — il n'existe
 *     pas de match sans vainqueur en NHL, donc ces six cases couvrent tout.
 *  2. **La prolongation est traitée.** Un match nul après 60 minutes se termine
 *     toujours 1–0 en prolongation ou aux tirs de barrage : toute la masse de
 *     l'écart 0 bascule sur « par 1 », répartie par `pWinsOvertime`. C'est ce
 *     qui fait de « par 1 » l'écart le plus fréquent du hockey, et aucun modèle
 *     qui l'ignore ne peut retrouver la forme réelle de la distribution.
 */
export async function predictMarginDistribution(
  teamId?: string,
  opponentId?: string,
  isHome = true
): Promise<Record<MarginBucket, number> | null> {
  const d = await scoreDistribution(teamId, opponentId, isHome);
  if (!d) return null;

  const acc: Record<MarginBucket, number> = {
    win_1: 0, win_2: 0, win_3plus: 0, lose_1: 0, lose_2: 0, lose_3plus: 0,
  };

  // La matrice porte déjà l'inclinaison des écarts ET la calibration des nuls :
  // il ne reste qu'à ranger ses cellules dans les seaux.
  for (let s = 0; s <= MAX_GOALS; s++) {
    for (let o = 0; o <= MAX_GOALS; o++) {
      const p = d.M[s][o];
      if (p <= 0) continue;
      const diff = s - o;
      if (diff === 0) continue;          // traité juste après, via la prolongation
      const size = Math.abs(diff);
      const side = diff > 0 ? 'win' : 'lose';
      const key  = (size === 1 ? `${side}_1` : size === 2 ? `${side}_2` : `${side}_3plus`) as MarginBucket;
      acc[key] += p;
    }
  }

  // 60 minutes nulles → un seul but d'écart, pour l'un ou pour l'autre.
  const pOT = pWinsOvertime(d, isHome);
  acc.win_1  += d.tie * pOT;
  acc.lose_1 += d.tie * (1 - pOT);

  return acc;
}

/**
 * Écart de victoire pour UN seau. Retourne le taux de ligue du seau quand les
 * cadences manquent (intersaison, présaison) plutôt qu'un chiffre dérivé de
 * valeurs par défaut, et `null` quand le seau demandé n'a pas pu être lu — le
 * routeur doit alors dire qu'il ne sait pas, pas servir une constante.
 */
export async function predictWinningMargin(
  teamId?: string,
  opponentId?: string,
  isHome = true,
  selection?: string
): Promise<number | null> {
  const bucket = parseMarginBucket(selection, isHome);
  if (!bucket) return null;

  const dist = await predictMarginDistribution(teamId, opponentId, isHome);
  if (!dist) return null;

  // Seaux ouverts « par 2 ou plus » de `betMarkets.ts`.
  if (bucket === 'win_2plus')  return pct(dist.win_2  + dist.win_3plus);
  if (bucket === 'lose_2plus') return pct(dist.lose_2 + dist.lose_3plus);

  return pct(dist[bucket]);
}

// ── Prolongation ──────────────────────────────────────────────────────────────

/**
 * P(le match va en prolongation) = P(égalité après 60 minutes).
 *
 * Remplace la constante 24 du routeur, qui donnait le même chiffre à un duel de
 * deux défenses verrouillées (où l'égalité est fréquente) et à une affiche
 * ouverte entre la meilleure attaque et la pire défense de la ligue.
 *
 * La diagonale de la loi jointe, recalibrée par TIE_INFLATION : deux équipes de
 * cadence proche et basse se retrouvent à égalité bien plus souvent que le
 * contraire.
 *
 * Sans cadence exploitable (intersaison, présaison, équipe inconnue), sert le
 * taux de ligue — même aveu d'ignorance qu'ailleurs dans ce fichier, mais avec
 * la bonne valeur.
 */
export async function predictGameToOvertime(
  teamId?: string,
  opponentId?: string,
  isHome = true
): Promise<number> {
  const d = await scoreDistribution(teamId, opponentId, isHome);
  if (!d) return pct(LEAGUE_OT_RATE);
  return pct(d.tie);
}

// ── Période la plus prolifique ────────────────────────────────────────────────

/** Périodes proposées par le marché, plus l'égalité que les books cotent aussi. */
export type PeriodSelection = 'P1' | 'P2' | 'P3' | 'tie';

function parsePeriodSelection(selection: string | undefined): PeriodSelection | null {
  const s = (selection ?? '').trim().toLowerCase();
  if (/^(p1|1|1st|period1|first)$/.test(s))  return 'P1';
  if (/^(p2|2|2nd|period2|second)$/.test(s)) return 'P2';
  if (/^(p3|3|3rd|period3|third)$/.test(s))  return 'P3';
  if (/^(tie|tied|draw|equal)$/.test(s))     return 'tie';
  return null;
}

/**
 * P(la période demandée est la plus prolifique du match).
 *
 * Remplace la constante 38, qui avait deux défauts distincts : elle ignorait
 * l'affiche, et les trois périodes totalisaient 114 % pour trois issues qui
 * s'excluent.
 *
 * Le modèle répartit la cadence du match en trois tiers ÉGAUX et compare les
 * trois tirages. C'est délibérément conservateur : la NHL marque un peu plus au
 * 3e (fatigue, filets déserts, jeu ouvert par le score), mais l'application n'a
 * aucune donnée par période, et inventer un coefficient d'asymétrie
 * reproduirait exactement le problème qu'on corrige. Le modèle dit donc ce
 * qu'il sait — l'égalité y est fréquente, et c'est vrai — et ce biais est à
 * lever le jour où les statistiques par période sont branchées.
 *
 * Retourne `null` pour une sélection illisible : le routeur doit dire qu'il ne
 * sait pas, pas servir une constante.
 */
export async function predictHighestScoringPeriod(
  teamId?: string,
  opponentId?: string,
  selection?: string,
  isHome = true
): Promise<number | null> {
  const want = parsePeriodSelection(selection);
  if (!want) return null;

  const d = await scoreDistribution(teamId, opponentId, isHome);
  const combined = d
    ? d.lambdaSubject + d.lambdaOpponent
    : LEAGUE_AVG_GPG * 2;

  // Buts d'UNE période : un tiers de la cadence du match. La dispersion reste
  // celle du fichier, pour que ce marché et les totaux par période partagent la
  // même loi.
  const pmf = goalsPmf(combined / 3);

  // Les trois périodes sont i.i.d. sous ce modèle : P(Pk strictement max) est la
  // même pour les trois, et le reste est la masse d'égalité au sommet. On somme
  // explicitement plutôt que de poser (1 − tie)/3, pour que le calcul reste
  // juste si les cadences par période deviennent un jour distinctes.
  let strictMax = 0;
  for (let n = 0; n <= MAX_GOALS; n++) {
    let below = 0;
    for (let m = 0; m < n; m++) below += pmf[m];
    strictMax += pmf[n] * below * below;   // les DEUX autres périodes sous n
  }

  if (want === 'tie') return pct(1 - 3 * strictMax);
  return pct(strictMax);
}

/** Period winner: dampened moneyline (single period is noisier than full game). */
export async function predictPeriodWinner(
  teamId: string,
  opponentId?: string,
  isHome = true
): Promise<number> {
  const ml = await predictMoneyline(teamId, opponentId, isHome);
  return Math.max(20, Math.round(50 + (ml - 50) * 0.55));
}

/**
 * Part des buts d'un match inscrite dans chaque période.
 *
 * Les trois périodes ne se valent PAS : la première est la plus prudente, la
 * deuxième la plus ouverte (changements longs, l'équipe en défense est coincée
 * dans sa zone). `nhlPredictions.ts` connaît déjà cette répartition et la
 * nomme `PERIOD_DIST` — mêmes valeurs ici, volontairement, pour que les deux
 * moteurs ne donnent pas deux totaux différents pour la même période.
 *
 * Diviser par 3 rendait P1, P2 et P3 STRICTEMENT identiques : trois tuiles, un
 * seul chiffre, et le 2e sous-évalué de 10 % relatifs.
 */
const PERIOD_SHARE = [0.305, 0.365, 0.330] as const;

/**
 * O/U des buts d'UNE période.
 *
 * `period` est l'indice 1-3. L'appelant DOIT le fournir : sans lui il n'y a pas
 * de question posée, seulement trois tuiles qui se ressemblent.
 */
export async function predictPeriodTotalGoals(
  line: number,
  selection: string,
  teamId?: string,
  opponentId?: string,
  period: 1 | 2 | 3 = 1
): Promise<number> {
  const [team, opp] = await Promise.all([
    teamId     ? getTeam(teamId)     : null,
    opponentId ? getTeam(opponentId) : null,
  ]);
  // Même cadence que le total du match — défense adverse comprise.
  const combined = (expectedGoals(team, opp) ?? LEAGUE_AVG_GPG)
                 + (expectedGoals(opp, team) ?? LEAGUE_AVG_GPG);
  const lambda   = combined * PERIOD_SHARE[period - 1];
  return pct(
    selection === 'under'
      ? poissonUnder(lambda, line)
      : poissonOver(lambda, line)
  );
}

// ── Futures ───────────────────────────────────────────────────────────────────

/**
 * Futures probability derived from conference standings rank.
 * propType: 'cup' | 'conf' | 'playoff'
 */
export async function predictFutures(
  teamId: string,
  propType: string
): Promise<number> {
  const teams = await fetchTeams();
  const team  = teams.find(
    (t: any) =>
      t.id?.toLowerCase() === teamId.toLowerCase() ||
      t.abbreviation?.toLowerCase() === teamId.toLowerCase()
  );
  if (!team) return 20;

  const conf = teams
    .filter((t: any) => t.conference === team.conference)
    .sort((a: any, b: any) => b.points - a.points);

  const rank = conf.findIndex((t: any) => t.id === team.id) + 1;

  if (propType === 'cup') {
    // Historical Cup win rates by regular-season rank (rough priors)
    if (rank === 1) return 28;
    if (rank <= 3)  return 18;
    if (rank <= 8)  return 10;
    return 4;
  }

  if (propType === 'conf') {
    if (rank <= 2)  return 35;
    if (rank <= 4)  return 22;
    if (rank <= 8)  return 12;
    return 5;
  }

  // playoff berth
  if (rank <= 3)  return 92;
  if (rank <= 8)  return 72;
  if (rank <= 11) return 38;
  return 12;
}

// ── Factor breakdown ──────────────────────────────────────────────────────────

/**
 * Builds a real factor breakdown for the UI.
 * type: 'team' | 'player'
 */
export async function buildRealFactors(
  type: string,
  id: string,
  probability: number
): Promise<any[]> {
  try {
    if (type === 'team') {
      const team = await getTeam(id);
      if (!team) throw new Error('not found');

      // Saison pas commencée : les taux valent `null` depuis `fetchTeams`, et
      // les lire donnerait « Win rate: null% » et un différentiel NaN à l'écran.
      // On dit ce qu'on sait — rien — plutôt que d'afficher des cases vides
      // remplies de valeurs par défaut.
      if ((team.gamesPlayed ?? 0) < 1) {
        return [
          { icon: '📅', label: 'Season not started — no team stats yet', delta: 0 },
          { icon: '📊', label: 'Estimate based on league averages', delta: 0 },
        ];
      }

      const gfDiff = team.goalsForPerGame - team.goalsAgainstPerGame;

      return [
        {
          icon: '📊',
          label: `Win rate: ${team.winPct}% (${team.wins}W-${team.losses}L-${team.otLosses}OTL)`,
          delta: team.winPct >= 58 ? 12 : team.winPct >= 52 ? 5 : team.winPct >= 48 ? 0 : -6,
        },
        {
          icon: '🏒',
          label: `Goal diff: ${gfDiff >= 0 ? '+' : ''}${gfDiff.toFixed(2)}/game`,
          delta: gfDiff >= 0.4 ? 8 : gfDiff >= 0 ? 2 : -5,
        },
        {
          icon: '📈',
          label: `Streak: ${team.streak || 'even'} · ${team.homeRecord} home`,
          delta: team.streak?.startsWith('W') ? 6 : team.streak?.startsWith('L') ? -5 : 0,
        },
        {
          icon: '⚡',
          label: `PP ${team.ppPct}% · PK ${team.pkPct}%`,
          delta: team.ppPct >= 22 ? 5 : team.ppPct >= 18 ? 1 : -3,
        },
      ];
    }

    // player type
    const player = await fetchPlayerById(id);
    const gpg    = player.gamesPlayed > 0 ? player.goals   / player.gamesPlayed : 0;
    const apg    = player.gamesPlayed > 0 ? player.assists / player.gamesPlayed : 0;
    const ppg    = player.gamesPlayed > 0 ? player.points  / player.gamesPlayed : 0;
    const spg    = player.gamesPlayed > 0 ? player.shots   / player.gamesPlayed : 0;

    return [
      {
        icon: '🎯',
        label: `Goals/game: ${gpg.toFixed(2)} (${player.goals} total)`,
        delta: gpg >= 0.5 ? 12 : gpg >= 0.3 ? 5 : -3,
      },
      {
        icon: '🏒',
        label: `Points/game: ${ppg.toFixed(2)} (${player.points} pts)`,
        delta: ppg >= 0.9 ? 10 : ppg >= 0.6 ? 4 : -2,
      },
      {
        icon: '📊',
        label: `Shots/game: ${spg.toFixed(1)} · Shot%: ${player.shotPct}%`,
        delta: spg >= 3.5 ? 6 : spg >= 2.5 ? 2 : -2,
      },
      {
        icon: '⚡',
        label: `PP points: ${player.ppPoints} · Assists: ${player.assists}`,
        delta: player.ppPoints >= 20 ? 5 : 0,
      },
    ];
  } catch {
    return [
      { icon: '📊', label: `${type} analysis`, delta: probability >= 55 ? 8 : -5 },
      { icon: '📈', label: 'Recent form', delta: 3 },
      { icon: '🏒', label: 'Matchup context', delta: 0 },
    ];
  }
}

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
