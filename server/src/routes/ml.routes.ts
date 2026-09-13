import { Router, Request, Response } from "express";
import {
  predictMoneyline,
  predictPuckLine,
  predictTotalGoals,
  predictAnytimeGoal,
  predictFirstGoalScorer,
  predictLastGoalScorer,
  predictShotsOU,
  predictAssistsOU,
  predictPointsOU,
  predictPPPoint,
  predictPositionBasedProp,
  predictFutures,
  predictOvertimeWinner,
  predictAltPuckLine,
  predictRegulationResult,
  predictTeamToScore,
  predictBothTeamsScore,
  predictCleanSheet,
  predictTeamPPGoal,
  predictPenaltyKill,
  predictWinningMargin,
  predictGameToOvertime,
  predictHighestScoringPeriod,
  predictPeriodWinner,
  predictPeriodTotalGoals,
  buildRealFactors,
} from "../services/predictionEngine";
import { mlApiClient } from "../services/mlApiClient";
import { fetchGameById } from "../services/nhlApiClient";
import {
  buildGameFeatures,
  buildPlayerPropFeatures,
  buildTeamFuturesFeatures,
} from "../services/featureEngineering";
import { getBestBets } from "../services/bestBets.service";
import { combineParlayLegs } from "../services/parlay";
import type { ParlayLeg } from "../services/parlay";
import { isScoreDerivable, predictGameLegCorrelation } from "../services/predictionEngine";
import { logger } from "../logger";
import { sendError } from "../httpError";
import { validateBody } from "../middleware/validate.middleware";
import { predictLimiter } from "../middleware/rateLimit.middleware";
import {
  singlePredictionSchema,
  parlayPredictionSchema,
  predictFactorsSchema,
  playerPropSchema,
  predictFuturesSchema,
  predictMlSchema,
} from "../validation/schemas";

/**
 * Routeur de prédiction — PUBLIC À DESSEIN, et donc protégé en deux temps.
 *
 * Ces routes restent ouvertes sans compte : la landing affiche des probabilités
 * à un visiteur qui n'a rien signé, et c'est le produit. Ce qu'elles ne peuvent
 * pas se permettre, c'est de rester ouvertes SANS BORNES — une requête entrante
 * gratuite y déclenche des appels sortants vers l'API NHL et le service ML
 * Python.
 *
 *   1. `validateBody` refuse le corps hors bornes AVANT tout appel sortant
 *      (schémas dans `validation/schemas.ts`, avec le pourquoi de chaque borne).
 *   2. `predictLimiter` plafonne les deux routes qui construisent des variables
 *      et appellent le service Python (`/ml`, `/factors`) — les autres restent
 *      sous `apiLimiter`, parce que la landing peut en tirer ~32 d'un coup.
 *
 * Les gardes en début de handler (`legs array required`, `type and subjectId
 * are required`) sont désormais redondantes avec les schémas. Elles sont
 * conservées : elles ne coûtent rien et gardent le handler juste s'il est un
 * jour monté sans son middleware.
 */
const router = Router();

// GET /api/predict/best-bets
// Top individual bets across all markets (team + player props),
// ranked by prediction score. ML-first with rule fallback.
// Query: ?limit=15&source=ml|rules&days=3&players=15
router.get("/best-bets", async (req: Request, res: Response) => {
  try {
    const source = req.query.source === "rules" ? "rules" : "ml";
    const result = await getBestBets({
      limit:      req.query.limit   ? parseInt(String(req.query.limit), 10)   : undefined,
      days:       req.query.days    ? parseInt(String(req.query.days), 10)    : undefined,
      maxPlayers: req.query.players ? parseInt(String(req.query.players), 10) : undefined,
      source,
    });
    // Même TTL que le cache serveur : navigateur et CDN absorbent les
    // rechargements de la landing entre deux recalculs.
    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    res.json(result);
  } catch (err: any) {
    sendError(res, err, { context: '[predict/best-bets]', fallbackMessage: 'Best bets failed' });
  }
});

// --- Types ---

type BetMarketType =
  | "moneyline" | "puck_line" | "total_goals" | "regulation_result"
  | "period1_winner" | "period2_winner" | "period3_winner"
  | "period1_total_goals" | "period2_total_goals" | "period3_total_goals"
  | "game_to_ot" | "both_teams_score" | "winning_margin"
  | "alt_puck_line" | "ot_winner"
  | "first_team_score" | "last_team_score" | "team_total_goals"
  | "team_pp_goals" | "team_penalty_kill" | "clean_sheet"
  | "highest_scoring_period"
  // ML-vocab aliases sent by the stats page (mapped to canonical markets)
  | "total_goals_over" | "total_goals_under" | "pp_goal" | "penalty_kill"
  | "anytime_goal" | "first_goal_scorer" | "shots_ou" | "assists_ou"
  | "points_ou" | "pp_point" | "goalie_saves_ou" | "penalty_minutes_ou"
  | "blocked_shots_ou" | "time_on_ice_ou" | "faceoff_wins_ou" | "hits_ou";

interface PredictionRequest {
  marketType: BetMarketType;
  gameId?: string;
  teamId?: string;
  opponentId?: string;
  playerId?: string;
  playerName?: string;
  selection?: string;
  line?: number;
  isHome?: boolean;
  seasonContext?: Record<string, unknown>;
}

// --- Helpers ---

function probToOddsLabel(pct: number): string {
  const p = Math.max(5, Math.min(95, pct)) / 100;
  if (p >= 0.5) return `-${Math.round((p / (1 - p)) * 100)}`;
  return `+${Math.round(((1 - p) / p) * 100)}`;
}

const GAME_MARKET_TYPES: BetMarketType[] = [
  "moneyline", "puck_line", "total_goals", "regulation_result",
  "period1_winner", "period2_winner", "period3_winner",
  "game_to_ot", "both_teams_score", "winning_margin",
  "first_team_score", "team_total_goals", "highest_scoring_period",
];

const PLAYER_MARKET_TYPES: BetMarketType[] = [
  "anytime_goal", "first_goal_scorer", "shots_ou", "assists_ou",
  "points_ou", "pp_point", "goalie_saves_ou", "penalty_minutes_ou",
  "blocked_shots_ou", "time_on_ice_ou", "faceoff_wins_ou", "hits_ou",
];

// --- Core prediction dispatcher ---

/**
 * Marchés BINAIRES servis sous UN SEUL `marketType` : le moteur ne sait calculer
 * que le côté « oui », et les deux tuiles de l'UI (Oui / Non) envoyaient donc la
 * même requête et recevaient le même pourcentage — d'où « les deux marquent
 * 90 % » ET « les deux ne marquent pas 90 % » sur Blues–Stars du 19 sept. 2026.
 *
 * Le côté arrive maintenant dans `selection`, et le complément est pris ici.
 *
 * Les marchés dont le côté est DÉJÀ dans le nom (`total_goals_over` /
 * `total_goals_under`) n'ont rien à faire dans cette liste : ils seraient
 * inversés deux fois. Idem pour les marchés d'équipe, où `selection` porte une
 * abréviation ("STL") et jamais un « no ».
 */
const BINARY_MARKETS = new Set([
  "both_teams_score",
  "clean_sheet",
  "game_to_ot",
  "puck_line",
  "team_pp_goals",
  "team_penalty_kill",
]);

/** Jetons qui désignent le côté négatif d'un marché binaire. */
const NEGATIVE_SELECTIONS = new Set(["no", "non", "false", "0"]);

function isNegativeSide(market: string, selection: string | undefined): boolean {
  if (!BINARY_MARKETS.has(market)) return false;
  return NEGATIVE_SELECTIONS.has((selection ?? "").trim().toLowerCase());
}

/**
 * Normalise ML-vocabulary aliases (sent by the stats page) into the canonical
 * { marketType, selection } used by the prediction engine. This is what keeps
 * the coupon and the stats page in sync: both funnel into the same markets.
 */
function normalizeMarket(
  marketType: string,
  selection: string
): { market: string; selection: string } {
  switch (marketType) {
    case "total_goals_over":  return { market: "total_goals", selection: "over" };
    case "total_goals_under": return { market: "total_goals", selection: "under" };
    case "pp_goal":           return { market: "team_pp_goals", selection };
    case "penalty_kill":      return { market: "team_penalty_kill", selection };
    default:                  return { market: marketType, selection };
  }
}

/**
 * Resolve a game-based request into concrete team/opponent/home-ice values.
 * The coupon sends { gameId, selection: <teamAbbr> } with no teamId; the stats
 * page sends { teamId, opponentId, isHome } directly. Both must end up equal.
 */
async function resolveSubjects(body: PredictionRequest): Promise<{
  teamId?: string;
  opponentId?: string;
  isHome: boolean;
  selection: string;
}> {
  let teamId     = body.teamId;
  let opponentId = body.opponentId;
  let isHome     = body.isHome ?? true;
  let selection  = body.selection ?? "over";

  if (body.gameId) {
    try {
      const game = await fetchGameById(body.gameId);
      const home = game?.homeTeam?.id ?? game?.homeTeam?.abbreviation;
      const away = game?.awayTeam?.id ?? game?.awayTeam?.abbreviation;
      const sel  = selection?.toLowerCase();
      // selection is a team abbreviation → that team is the subject
      if (sel && (sel === String(home).toLowerCase() || sel === String(away).toLowerCase())) {
        const selIsHome = sel === String(home).toLowerCase();
        teamId     = selIsHome ? home : away;
        opponentId = selIsHome ? away : home;
        isHome     = selIsHome;
      } else if (!teamId) {
        // over/under & game-level markets: default to the home side as anchor
        teamId     = home;
        opponentId = away;
        isHome     = true;
      }
    } catch {
      /* fall back to whatever the body provided */
    }
  }

  return { teamId, opponentId, isHome, selection };
}

/**
 * Mises en garde qu'un marché peut porter AVEC son chiffre. Elles ne sont pas
 * cosmétiques : chacune dit une limite que l'utilisateur ne peut pas deviner en
 * regardant un pourcentage, et que la version précédente de ce fichier taisait.
 *
 *  - `league_average`         : moyenne de ligue par position, pas une
 *                               prédiction sur ce joueur (mises en échec, tirs
 *                               bloqués, temps de jeu, mises au jeu, pénalités).
 *  - `shared_with_first_goal` : « dernier buteur » partage l'estimateur de
 *                               « premier buteur » — même valeur, à dessein.
 *  - `period_symmetric`       : « période la plus prolifique » suppose les trois
 *                               périodes équivalentes, faute de données par
 *                               période.
 */
export type PredictionCaveat =
  | "league_average"
  | "shared_with_first_goal"
  | "period_symmetric";

/**
 * Résultat d'un calcul de probabilité.
 *
 * `probability: null` veut dire « ce moteur ne sait pas calculer ce marché avec
 * ce qu'on lui a donné » — et c'est une réponse valide, pas un échec à masquer.
 * Elle remplace les constantes que ce fichier servait pour `winning_margin`,
 * `game_to_ot` et `highest_scoring_period` : un chiffre faux qui a l'air juste
 * est pire que pas de chiffre du tout, et cette règle vaut ici autant que dans
 * `predictionApiService.ts` côté client.
 */
export interface ProbabilityResult {
  probability: number | null;
  caveat?: PredictionCaveat;
}

async function computeProbability(body: PredictionRequest): Promise<ProbabilityResult> {
  const { market } = normalizeMarket(body.marketType, body.selection ?? "over");
  // Le côté « non » est le complément exact du côté « oui » : aucun de ces
  // marchés n'admet de push (pas de demi-issue), donc P(non) = 100 − P(oui).
  if (isNegativeSide(market, body.selection)) {
    const yes = await computeProbability({ ...body, selection: "yes" });
    if (yes.probability === null) return yes;
    return { ...yes, probability: Math.max(3, Math.min(97, 100 - yes.probability)) };
  }
  const line = body.line ?? 0.5;
  const { teamId, opponentId, isHome, selection } = await resolveSubjects({
    ...body,
    selection: normalizeMarket(body.marketType, body.selection ?? "over").selection,
  });
  const playerId = body.playerId;

  /** Sucre : une probabilité sans mise en garde. */
  const plain = (p: number): ProbabilityResult => ({ probability: p });
  /** Sucre : « je ne sais pas », qui est une réponse et pas un plantage. */
  const unknown: ProbabilityResult = { probability: null };

  // ── Game / team markets ──────────────────────────────────────────────────
  if (market === "moneyline") {
    if (!teamId) return unknown;
    return plain(await predictMoneyline(teamId, opponentId, isHome));
  }
  if (market === "first_team_score" || market === "last_team_score") {
    if (!teamId) return unknown;
    return plain(await predictTeamToScore(teamId, opponentId, isHome));
  }
  if (market === "puck_line") {
    if (!teamId) return unknown;
    return plain(await predictPuckLine(teamId, opponentId, isHome));
  }
  if (market === "alt_puck_line") {
    if (!teamId) return unknown;
    return plain(await predictAltPuckLine(teamId, opponentId, isHome));
  }
  if (market === "ot_winner") {
    if (!teamId) return unknown;
    return plain(await predictOvertimeWinner(teamId, opponentId, isHome));
  }
  if (market === "regulation_result") {
    if (!teamId) return unknown;
    return plain(await predictRegulationResult(teamId, opponentId, isHome));
  }
  if (market === "total_goals" || market === "team_total_goals") {
    return plain(await predictTotalGoals(line, selection, teamId, opponentId));
  }
  if (
    market === "period1_total_goals" ||
    market === "period2_total_goals" ||
    market === "period3_total_goals"
  ) {
    // La période était perdue ici : les trois marchés appelaient la même
    // fonction sans dire de laquelle il s'agissait, et recevaient donc le même
    // chiffre. Le numéro est dans le nom du marché — il suffisait de le lire.
    const period = Number(market[6]) as 1 | 2 | 3;
    return plain(await predictPeriodTotalGoals(line, selection, teamId, opponentId, period));
  }
  if (
    market === "period1_winner" ||
    market === "period2_winner" ||
    market === "period3_winner"
  ) {
    if (!teamId) return unknown;
    return plain(await predictPeriodWinner(teamId, opponentId, isHome));
  }
  if (market === "both_teams_score")   return plain(await predictBothTeamsScore(teamId, opponentId, isHome));
  if (market === "clean_sheet")        return plain(await predictCleanSheet(teamId, opponentId, isHome));
  if (market === "team_pp_goals")      return plain(await predictTeamPPGoal(teamId));
  if (market === "team_penalty_kill")  return plain(await predictPenaltyKill(teamId));

  // `selection` porte le SEAU d'écart ("1", "2", "3+", ou "home_1"/"away_2plus"
  // selon le vocabulaire de l'appelant). Sans lui, les six tuiles d'écart
  // posaient la même question et recevaient la même constante — six fois 12 %
  // pour une partition exhaustive qui totalisait 72 %.
  if (market === "winning_margin") {
    const p = await predictWinningMargin(teamId, opponentId, isHome, body.selection);
    return p === null ? unknown : plain(p);
  }

  if (market === "game_to_ot") {
    return plain(await predictGameToOvertime(teamId, opponentId, isHome));
  }

  if (market === "highest_scoring_period") {
    const p = await predictHighestScoringPeriod(teamId, opponentId, body.selection, isHome);
    return p === null ? unknown : { probability: p, caveat: "period_symmetric" };
  }

  // ── Player markets ─────────────────────────────────────────────────────────
  if (!playerId) return unknown;

  if (market === "anytime_goal")  return plain(await predictAnytimeGoal(playerId));
  if (market === "shots_ou")      return plain(await predictShotsOU(playerId, line, selection));
  if (market === "assists_ou")    return plain(await predictAssistsOU(playerId, line, selection));
  if (market === "points_ou")     return plain(await predictPointsOU(playerId, line, selection));
  if (market === "pp_point")      return plain(await predictPPPoint(playerId));

  if (market === "first_goal_scorer") {
    const p = await predictFirstGoalScorer(playerId, opponentId);
    return p === null ? unknown : plain(p);
  }

  // Même estimateur que le premier buteur, et le dire : voir le commentaire de
  // `predictLastGoalScorer`. Ce qui était un alias muet dans ce fichier est
  // maintenant un appel distinct qui remonte sa mise en garde.
  if (market === "last_goal_scorer") {
    const p = await predictLastGoalScorer(playerId, opponentId);
    return p === null ? unknown : { probability: p, caveat: "shared_with_first_goal" };
  }

  if (
    market === "hits_ou" ||
    market === "blocked_shots_ou" ||
    market === "time_on_ice_ou" ||
    market === "faceoff_wins_ou" ||
    market === "penalty_minutes_ou" ||
    market === "goalie_saves_ou"
  ) {
    const est = await predictPositionBasedProp(playerId, market, line, selection);
    if (!est) return unknown;
    return est.playerSpecific
      ? plain(est.probability)
      : { probability: est.probability, caveat: "league_average" };
  }

  // Marché inconnu du moteur. L'ancien `return 50` en faisait un pari à pile ou
  // face parfaitement présentable à l'écran ; c'est simplement une question à
  // laquelle ce moteur ne répond pas.
  return unknown;
}

// --- Routes ---

// POST /api/predict/single
router.post("/single", validateBody(singlePredictionSchema), async (req: Request, res: Response) => {
  try {
    const body = req.body as PredictionRequest;
    const { probability, caveat } = await computeProbability(body);

    // Le moteur ne sait pas répondre à ce marché avec ce corps. On le DIT, avec
    // un statut que `predictionApiService` transforme déjà en
    // `PredictionUnavailableError` côté client, donc en état « indisponible » à
    // l'écran. C'est le point de toute cette route : ne jamais rendre un
    // chiffre qu'on n'a pas calculé.
    if (probability === null) {
      return res.status(422).json({
        error: "no_estimate",
        marketType: body.marketType,
        message: "No estimate available for this market with the data provided",
      });
    }

    const confidence =
      probability >= 70 ? "very_high" :
      probability >= 60 ? "high"      :
      probability >= 50 ? "medium"    :
      probability >= 40 ? "low"       : "very_low";

    const factorType = body.playerId ? "player" : "team";
    const factorId   = body.playerId ?? body.teamId ?? "";
    const factors    = factorId
      ? await buildRealFactors(factorType, factorId, probability)
      : [];

    res.json({
      probability,
      confidence,
      factors,
      // Mise en garde à afficher AVEC le chiffre quand il y en a une : moyenne
      // de ligue, estimateur partagé, périodes supposées équivalentes. Absente
      // quand le chiffre est une vraie prédiction sur ce sujet.
      ...(caveat ? { caveat } : {}),
      oddsLabel: probToOddsLabel(probability),
      modelVersion: "nhl-stats-v1.0",
      generatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    sendError(res, err, { context: '[predict/single]', fallbackMessage: 'Prediction failed' });
  }
});

// POST /api/predict/parlay
//
// DEUX ÉTAGES, et c'est la structure qui compte.
//
//  1. `combineParlayLegs` règle ce qui est LOGIQUE — incompatibilité, doublon,
//     implication — sans lire la moindre donnée, et pour tous les marchés.
//  2. Ce qu'il en reste est groupé PAR MATCH. Les jambes lisibles sur le score
//     final passent par la loi jointe (`predictExactGameParlay`) : leur
//     corrélation n'est plus supposée, elle est calculée.
//
// Entre matchs différents, on multiplie — là, l'indépendance est vraie.
// Les jambes qu'aucun des deux étages ne couvre (périodes, buteurs, props)
// restent multipliées conditionnellement, et `assumesIndependence` le dit.
router.post("/parlay", validateBody(parlayPredictionSchema), async (req: Request, res: Response) => {
  try {
    type WireLeg = ParlayLeg & { teamId?: string; opponentId?: string; isHome?: boolean };
    const { legs } = req.body as { legs: WireLeg[] };

    if (!Array.isArray(legs) || legs.length === 0) {
      return res.status(400).json({ error: "legs array required" });
    }

    const naive = legs.reduce((acc, l) => acc * (l.probability / 100), 1) * 100;

    // ── Étage 1 : relations logiques ─────────────────────────────────────────
    const logical = combineParlayLegs(legs);
    if (logical.impossible) {
      return res.json({
        combinedProbability: Math.round(naive * 10) / 10,
        adjustedProbability: 0,
        impossible: true,
        redundantLegs: logical.redundantLegs,
        exactLegs: 0,
        assumesIndependence: false,
        legs: legs.map((l) => ({ marketType: l.marketType, probability: l.probability })),
      });
    }
    if (!Number.isFinite(logical.probability)) {
      return res.json({
        combinedProbability: null, adjustedProbability: null,
        impossible: false, redundantLegs: logical.redundantLegs,
        exactLegs: 0, assumesIndependence: false,
        legs: legs.map((l) => ({ marketType: l.marketType, probability: l.probability })),
      });
    }

    // ── Étage 2 : corrélation réelle, match par match ────────────────────────
    const byGame = new Map<string, WireLeg[]>();
    logical.legs.forEach((l, i) => {
      // Une jambe sans match ne peut être corrélée à rien : groupe à elle seule.
      const key = l.gameId ? `g:${l.gameId}` : `solo:${i}`;
      const bucket = byGame.get(key);
      if (bucket) bucket.push(l); else byGame.set(key, [l]);
    });

    let joint = 1;
    let exactLegs = 0;
    let assumesIndependence = false;

    for (const group of byGame.values()) {
      const derivable = group.filter(l => isScoreDerivable(
        normalizeMarket(l.marketType, l.selection ?? "").market));
      const others = group.filter(l => !derivable.includes(l));

      // Marchés que le score final ne décide pas : produit conditionnel.
      for (const l of others) joint *= l.probability / 100;
      if (others.length > 0 && group.length > 1) assumesIndependence = true;

      if (derivable.length === 0) continue;
      if (derivable.length === 1) { joint *= derivable[0].probability / 100; continue; }

      // Le match est décrit par la première jambe qui porte ses deux équipes.
      const anchor = derivable.find(l => l.teamId && l.opponentId);
      const anchorIsHome = anchor?.isHome !== false;
      const homeId = anchor ? (anchorIsHome ? anchor.teamId : anchor.opponentId) : undefined;
      const awayId = anchor ? (anchorIsHome ? anchor.opponentId : anchor.teamId) : undefined;

      if (!homeId || !awayId) {
        // Sans les équipes, pas de loi jointe. On multiplie et on le DIT.
        for (const l of derivable) joint *= l.probability / 100;
        assumesIndependence = true;
        continue;
      }

      const corr = await predictGameLegCorrelation(homeId, awayId, derivable.map(l => {
        const { market, selection } = normalizeMarket(l.marketType, l.selection ?? "");
        return { market, selection, line: l.line, subjectIsHome: l.isHome !== false };
      }));

      // Le produit des probabilités AFFICHÉES reste la base : ce sont elles que
      // l'utilisateur voit sur les tuiles. La loi jointe ne fournit que le
      // facteur de corrélation, sans dimension — voir
      // `predictGameLegCorrelation` pour pourquoi on ne sert pas sa
      // probabilité brute.
      const shown = derivable.reduce((acc, l) => acc * (l.probability / 100), 1);

      if (corr === null) {
        // Pas de cadences exploitables : on ne fabrique pas une corrélation.
        joint *= shown;
        assumesIndependence = true;
      } else {
        joint *= shown * corr.factor;
        exactLegs += derivable.length;
      }
    }

    res.json({
      /** Produit naïf des jambes — conservé pour comparaison. */
      combinedProbability: Math.round(naive * 10) / 10,
      /** Ce que le nom promet depuis toujours : corrélations comprises. */
      adjustedProbability: Math.round(joint * 1000) / 10,
      impossible: false,
      redundantLegs: logical.redundantLegs,
      /** Nb de jambes dont la corrélation a réellement été calculée. */
      exactLegs,
      /** `true` = au moins un groupe est retombé sur l'indépendance. */
      assumesIndependence,
      legs: legs.map((l) => ({ marketType: l.marketType, probability: l.probability })),
    });
  } catch (err: any) {
    sendError(res, err, { context: '[predict/parlay]', fallbackMessage: 'Parlay failed' });
  }
});

// GET /api/predict/markets/game/:id
router.get("/markets/game/:id", (_req: Request, res: Response) => {
  res.json(GAME_MARKET_TYPES);
});

// GET /api/predict/markets/player/:id
router.get("/markets/player/:id", (_req: Request, res: Response) => {
  res.json(PLAYER_MARKET_TYPES);
});

// POST /api/predict/factors
router.post("/factors", predictLimiter, validateBody(predictFactorsSchema), async (req: Request, res: Response) => {
  try {
    const { type, id, context = {} } = req.body as {
      type: string;
      id: string;
      context?: Record<string, unknown>;
    };

    const fallbackPct = (context.fallbackPct as number) ?? 50;
    const factors     = await buildRealFactors(type, id, fallbackPct);
    const deltaSum    = factors.reduce((s, f) => s + (f.delta ?? 0), 0);
    const finalPct    = Math.round(Math.max(3, Math.min(97, 50 + deltaSum)));

    res.json({ basePct: 50, factors, finalPct });
  } catch (err: any) {
    sendError(res, err, { context: '[predict/factors]', fallbackMessage: 'Factors failed' });
  }
});

// POST /api/predict/player-prop  (season-long prop)
router.post("/player-prop", validateBody(playerPropSchema), async (req: Request, res: Response) => {
  try {
    const { playerName, propType, line, playerId } = req.body as {
      playerName: string;
      propType: "goals" | "points" | "assists" | "award";
      line: number;
      playerId?: string;
    };

    let probability = 50;
    let factors: any[] = [];
    let betNote = `${playerName} season prop estimate.`;

    if (playerId) {
      const { fetchPlayerById } = await import("../services/nhlApiClient");
      const player = await fetchPlayerById(playerId);

      // `player.gamesPlayed || 1` faisait passer un joueur à 0 match pour un
      // joueur à 1 match sans point : `currentRate` tombait à 0, aucun seuil ne
      // matchait et la route servait un « 28 % » qui n'était dérivé de rien.
      // Avant le premier match il n'y a pas de cadence à extrapoler — on laisse
      // la valeur neutre et on le dit dans la note.
      const gp = player.gamesPlayed ?? 0;
      if (gp < 1) {
        // Avant le premier match il n'y a pas de cadence à extrapoler. On tombe
        // à travers vers la réponse commune avec la valeur neutre (50) plutôt
        // que de dupliquer la forme de la réponse ici.
        betNote = `${player.name || playerName} has not played a game this season yet — no pace to project from.`;
      } else {
      const remaining = Math.max(0, 82 - gp);
      const current =
        propType === "goals"   ? player.goals   :
        propType === "points"  ? player.points  :
        propType === "assists" ? player.assists  : 0;

      const pace        = (current / gp) * 82;
      const needed      = line - current;
      const currentRate = current / gp;
      const rateNeeded  = remaining > 0 ? needed / remaining : Infinity;

      probability =
        needed <= 0                      ? 95 :
        rateNeeded <= currentRate * 0.85 ? 75 :
        rateNeeded <= currentRate        ? 62 :
        rateNeeded <= currentRate * 1.15 ? 45 : 28;

      probability = Math.max(3, Math.min(97, probability));

      factors = [
        { icon: "chart", label: `Season pace: ${pace.toFixed(0)} (line: ${line})`, delta: pace >= line ? 12 : -8 },
        { icon: "calendar", label: `${remaining} games remaining, needs ${needed} more`, delta: remaining >= 20 ? 5 : remaining >= 10 ? 2 : -3 },
        { icon: "trending", label: `Averaging ${currentRate.toFixed(2)}/game`, delta: currentRate >= rateNeeded ? 6 : -4 },
      ];
      betNote = `${player.name || playerName} needs ${needed} more ${propType} in ${remaining} games (pace: ${pace.toFixed(0)}).`;
      }
    }

    res.json({
      probability,
      oddsLabel: probToOddsLabel(probability),
      factors,
      betNote,
    });
  } catch (err: any) {
    sendError(res, err, { context: '[predict/player-prop]', fallbackMessage: 'Player prop failed' });
  }
});

// POST /api/predict/futures
router.post("/futures", validateBody(predictFuturesSchema), async (req: Request, res: Response) => {
  try {
    const { teamName, teamId, propType } = req.body as {
      teamName: string;
      teamId?: string;
      propType: "cup" | "conf" | "playoff";
    };

    const id          = teamId ?? teamName;
    const probability = await predictFutures(id, propType);

    res.json({
      probability,
      oddsLabel: probToOddsLabel(probability),
      factors: [
        { icon: "standings", label: `${teamName} standings rank`, delta: probability >= 20 ? 8 : -4 },
      ],
      betNote: `${teamName} ${propType} probability based on current standings.`,
    });
  } catch (err: any) {
    sendError(res, err, { context: '[predict/futures]', fallbackMessage: 'Futures failed' });
  }
});

// ── ML service proxy ──────────────────────────────────────────────────────────
//
// POST /api/predict/ml
// Builds feature vector from NHL API data, POSTs it to the Python ML service,
// and returns the ML response. Falls back to null (frontend handles gracefully).
//
// Body: { type, subjectId, opponentId?, propType?, line?, selection? }

router.post('/ml', predictLimiter, validateBody(predictMlSchema), async (req: Request, res: Response) => {
  try {
    const { type, subjectId, opponentId, propType, line, selection, isHome } = req.body as {
      type:        'game' | 'player' | 'team';
      subjectId:   string;
      opponentId?: string;
      propType?:   string;
      line?:       number;
      selection?:  string;
      isHome?:     boolean;
    };

    if (!type || !subjectId) {
      return res.status(400).json({ error: 'type and subjectId are required' });
    }

    let result;

    if (type === 'game') {
      const marketType = propType ?? 'moneyline';

      // `buildGameFeatures(homeId, awayId, …)` prend bien le DOMICILE en
      // premier : c'est son aréna qui fixe l'altitude, le voyage et l'avantage
      // de la glace. On lui passait `subjectId`, or la tuile « extérieur »
      // envoie l'équipe VISITEUSE comme sujet — le service Python calculait
      // donc « P(le visiteur gagne chez lui) ». Les deux tuiles moneyline d'un
      // même match totalisaient 109–112 % au lieu de 100 %.
      //
      // Le match est décrit correctement ici, et `subject_is_home` dit de quel
      // côté est la question. Défaut `true` : les appels qui ne portent pas
      // `isHome` gardent le comportement d'avant pour la tuile domicile, qui
      // était le seul correct.
      const subjectIsHome = isHome !== false;
      const homeId = subjectIsHome ? subjectId : (opponentId ?? subjectId);
      const awayId = subjectIsHome ? (opponentId ?? subjectId) : subjectId;

      const features = await buildGameFeatures(
        homeId, awayId, marketType, line,
        { selection, subjectIsHome },
      );
      result = await mlApiClient.predictGame(features);
    } else if (type === 'player') {
      const features = await buildPlayerPropFeatures(
        subjectId,
        propType ?? 'goals',
        line    ?? 0.5,
        selection ?? 'over'
      );
      result = await mlApiClient.predictPlayer(features);
    } else if (type === 'team') {
      const features = await buildTeamFuturesFeatures(subjectId, propType ?? 'moneyline');
      result = await mlApiClient.predictTeam(features);
    } else {
      return res.status(400).json({ error: `Unknown type: ${type}` });
    }

    res.json(result);
  } catch (err: any) {
    // ML service may be down — return 503 so frontend can silently hide the section.
    //
    // `detail: err.message` a été retiré : il portait l'adresse du service
    // Python (« fetch failed for http://ml-internal:8000/predict/game ») droit
    // dans le corps d'une réponse publique. Le client ne s'en servait pas — il
    // masque simplement la section sur un 503 — et le message complet part
    // maintenant dans les journaux, où il sert vraiment.
    logger.warn({ err: err.message }, '[predict/ml] ML service unavailable');
    res.status(503).json({ error: 'ML service unavailable' });
  }
});

export default router;
