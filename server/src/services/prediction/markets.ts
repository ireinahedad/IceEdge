/**
 * prediction/markets.ts — moneyline, totaux, puck line, props joueur et
 * marchés d'équipe. Point d'entrée public : `../predictionEngine.ts`.
 */

import { fetchPlayerById } from '../nhlApiClient';
import {
  LEAGUE_AVG_GPG,
  LEAGUE_BTTS_RATE,
  LEAGUE_SHUTOUT_RATE,
  MAX_GOALS,
  TOI_REL_SD,
  expectedGoals,
  getTeam,
  log5,
  normalCdf,
  opponentMargin,
  pWinsOvertime,
  pct,
  poissonOver,
  poissonUnder,
  scoreDistribution,
  subjectMargin,
} from './scoreModel';

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
