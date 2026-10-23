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
import { getGameMlBundle, serializeBundle, mlBundleKey, type GameMlBundle } from "../services/gameMlBundle";
import { mapLimit } from "../services/concurrency";
import { predictPlayerFromModel } from "../services/prediction/playerModelPrediction";
import { fetchGameById } from "../services/nhlApiClient";
import { currentSeason } from "../services/nhl/core";
import {
  buildGameFeatures,
  buildPlayerPropFeatures,
  buildTeamFuturesFeatures,
} from "../services/featureEngineering";
import { getBestBets } from "../services/bestBets.service";
import { getCurrentValueBets } from "../services/valueBets.service";
import { authenticate, optionalAuthenticate, requirePro } from "../middleware/auth.middleware";
import { getBestParlays, gateBestParlays, getMoreParlays, gateMoreParlays } from "../services/bestParlays.service";
import { isPro } from "../services/subscription.service";
import { computeParlayProbability, normalizeMarket, type WireParlayLeg } from "../services/parlayProbability";
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
/**
 * Valeurs ADMISES pour les deux paramètres qui entrent dans la clé de cache de
 * `getBestBets` — donc les deux qui décident d'un recalcul complet.
 *
 * POURQUOI UNE LISTE BLANCHE ET PAS UN SIMPLE INTERVALLE. `normalizeOptions`
 * borne déjà `days` à 1-7 et `players` à 0-40, ce qui empêche une clé
 * arbitraire mais laisse quand même 7 × 41 = 287 clés joignables depuis l'URL,
 * chacune coûtant un calcul complet (banc `b8-clecache.ts` : `?days=1..7` →
 * 6 recalculs et 5 appels NHL pour 7 requêtes). Un intervalle borne la MÉMOIRE
 * du cache ; il ne borne pas le TRAVAIL qu'un appelant peut commander.
 *
 * Le client n'envoie aucun des deux — `BestBetsSection` appelle
 * `limit=30&source=ml`. Ces valeurs couvrent donc les usages réels et tout
 * l'espace utile, en ramenant le nombre de calculs distincts joignables à
 * 3 × 3 × 2 = 18.
 *
 * Une valeur hors liste est ramenée à la plus proche admise plutôt que refusée,
 * comme le fait déjà `normalizeOptions` pour `limit=70` → 50 : le comportement
 * reste cohérent, et aucune URL existante ne casse.
 */
const BEST_BETS_DAYS    = [1, 2, 3];
const BEST_BETS_PLAYERS = [0, 15, 30];

function plusProche(valeurs: number[], brut: unknown, dflt: number): number {
  const n = parseInt(String(brut), 10);
  if (!Number.isFinite(n)) return dflt;
  return valeurs.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a));
}

router.get("/best-bets", async (req: Request, res: Response) => {
  try {
    const source = req.query.source === "rules" ? "rules" : "ml";
    const result = await getBestBets({
      // `limit` reste libre : depuis le 2026-09-18 il n'entre plus dans la clé
      // de cache (il ne fait que tronquer une liste déjà calculée), donc il ne
      // commande aucun travail supplémentaire. Voir `bestBets.service.ts`.
      limit:      req.query.limit   ? parseInt(String(req.query.limit), 10)   : undefined,
      days:       req.query.days    !== undefined ? plusProche(BEST_BETS_DAYS,    req.query.days,    2)  : undefined,
      maxPlayers: req.query.players !== undefined ? plusProche(BEST_BETS_PLAYERS, req.query.players, 15) : undefined,
      // Jour choisi sur l'accueil ; borné par `normalizeDate` (sinon ignoré).
      date:       typeof req.query.date === "string" ? req.query.date : undefined,
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

// GET /api/predict/value-bets — réservé aux abonnés Pro.
//
// Le critère vit dans `valueBets.service.ts`, le même que l'alerte push :
// l'accueil ne calcule plus rien lui-même (décision du user, 2026-10-02). Le
// calcul est partagé entre visiteurs (cache 5 min), donc cette route ne
// commande aucun travail par appel — mais elle reste derrière `requirePro` :
// ce sont des données payantes, et `authenticate` seul ne vérifie pas l'abonnement.
router.get("/value-bets", authenticate, requirePro, async (_req: Request, res: Response) => {
  try {
    const bets = await getCurrentValueBets();
    res.set("Cache-Control", "private, no-store");
    res.json({ bets, meta: { generatedAt: new Date().toISOString() } });
  } catch (err: any) {
    sendError(res, err, { context: '[predict/value-bets]', fallbackMessage: 'Value bets failed' });
  }
});

// GET /api/predict/best-parlays — « Best Parlay » de l'accueil (2026-10-04).
//
// Ouverte à tous, comme best-bets : les deux premiers combinés sont gratuits.
// Les autres sont réservés aux Pro, et c'est ICI qu'on tranche — un
// non-abonné ne reçoit pour eux qu'une coquille sans jambes ni pourcentage
// (`gateBestParlays`). D'où `optionalAuthenticate` (un jeton présent mais
// expiré → 401, pour que `authedFetch` le rafraîchisse au lieu de rabattre un
// abonné sur la vue gratuite) et `isPro` lu en base, comme `requirePro`.
//
// Aucun travail par appel : les combinés sont construits sur le pool
// best-bets en cache et gardés tant qu'il ne change pas.
router.get("/best-parlays", optionalAuthenticate, async (req: Request, res: Response) => {
  try {
    let pro = false;
    if (req.user) {
      pro = req.user.role === "admin" || (await isPro(req.user.sub).catch(() => false));
    }
    const result = await getBestParlays(typeof req.query.date === "string" ? req.query.date : undefined);
    // La réponse dépend de l'abonnement : jamais en cache partagé.
    res.set("Cache-Control", "private, no-store");
    res.json(gateBestParlays(result, pro));
  } catch (err: any) {
    sendError(res, err, { context: '[predict/best-parlays]', fallbackMessage: 'Best parlays failed' });
  }
});

// GET /api/predict/more-parlays?date=AAAA-MM-JJ — page « Plus de parlays »
// (2026-10-11). En tête, les combinés de l'accueil (cotés) ; puis 2 à 8 jambes,
// même match / même équipe / même type / mélangés, cotes non requises.
// Réservée aux Pro (demande du user, 2026-10-11) : `requirePro` refuse les
// autres AVANT tout calcul, comme value-bets. `gateMoreParlays(…, true)` :
// un appelant qui passe ici est Pro.
router.get("/more-parlays", authenticate, requirePro, async (req: Request, res: Response) => {
  try {
    const result = await getMoreParlays(typeof req.query.date === "string" ? req.query.date : undefined);
    res.set("Cache-Control", "private, no-store");
    res.json(gateMoreParlays(result, true));
  } catch (err: any) {
    sendError(res, err, { context: '[predict/more-parlays]', fallbackMessage: 'More parlays failed' });
  }
});

// --- Types ---

type BetMarketType =
  | "moneyline" | "puck_line" | "total_goals" | "regulation_result"
  | "period1_winner" | "period2_winner" | "period3_winner"
  | "period1_total_goals" | "period2_total_goals" | "period3_total_goals"
  | "game_to_ot" | "both_teams_score" | "winning_margin"
  | "alt_puck_line" | "ot_winner" | "ot_so_winner"
  | "first_team_score" | "last_team_score" | "team_total_goals"
  | "team_pp_goals" | "team_penalty_kill" | "clean_sheet"
  | "highest_scoring_period" | "double_chance"
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
  "game_to_ot", "ot_so_winner", "both_teams_score", "winning_margin",
  "first_team_score", "team_total_goals", "highest_scoring_period", "double_chance",
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

// `normalizeMarket` a déménagé dans `services/parlayProbability.ts` (2026-10-04).

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

/**
 * Variantes de la page match que le moteur ML ne sait PAS encore chiffrer.
 *
 * Le moteur les recevait sans les distinguer de la variante de base, et
 * répondait donc pour une autre question :
 *  · puck line ±2.5 / ±3.5 — `predictPuckLine` ne connaît que ±1.5 ;
 *  · « les deux marquent 2+ / 3+ » — `predictBothTeamsScore` ne connaît que 1+ ;
 *  · « égalité après la période » — `predictPeriodWinner` ne cote qu'une équipe.
 *
 * « Je ne sais pas » (422 → « — » à l'écran) plutôt qu'un chiffre faux. Les
 * règles, elles, les chiffrent (`nhlPredictions.ts`).
 */
function mlUnsupportedVariant(market: string, body: PredictionRequest): boolean {
  if (market === "puck_line" && body.line != null && Math.abs(body.line) !== 1.5) return true;
  if (market === "both_teams_score" && body.line != null && body.line > 0.5) return true;
  if (/^period[123]_winner$/.test(market) && (body.selection ?? "").trim().toLowerCase() === "draw") return true;
  return false;
}

async function computeProbability(body: PredictionRequest): Promise<ProbabilityResult> {
  const { market } = normalizeMarket(body.marketType, body.selection ?? "over");
  if (mlUnsupportedVariant(market, body)) return { probability: null };
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
  /**
   * « Gagne en prolongation ou en fusillade », SANS condition — la tuile
   * `ml-home-ot` / `ml-away-ot` de Match Betting.
   *
   * À ne pas confondre avec `ot_winner` juste au-dessus, qui répond « qui
   * gagne SI le match va en prolongation » et vaut donc autour de 54 % sur une
   * affiche équilibrée. Celui-ci y ajoute la condition d'y aller, et vaut
   * autour de 15 %.
   *
   * P(gagne en OT/SO) = P(prolongation) × P(gagne | prolongation). Les deux
   * facteurs sortent des fonctions existantes : aucun modèle nouveau, et les
   * quatre tuiles de Match Betting continuent de partitionner, puisque les deux
   * moitiés OT somment exactement à P(prolongation).
   *
   * Les deux fonctions rendent des entiers 0–100, d'où la division.
   */
  if (market === "ot_so_winner") {
    if (!teamId) return unknown;
    const [toOt, winsOt] = await Promise.all([
      predictGameToOvertime(teamId, opponentId, isHome),
      predictOvertimeWinner(teamId, opponentId, isHome),
    ]);
    return plain(Math.round((toOt / 100) * (winsOt / 100) * 100));
  }
  if (market === "regulation_result") {
    if (!teamId) return unknown;
    return plain(await predictRegulationResult(teamId, opponentId, isHome));
  }
  /**
   * Double chance sur 60 minutes (2026-10-15). Sélection = une équipe (« elle
   * gagne en 60 OU égalité après 60 ») ou `no_draw` (« l'une des deux gagne en
   * 60 »). Recombinée depuis les deux marchés voisins, donc cohérente avec eux :
   * équipe = P(gagne en 60) + P(prolongation) ; pas de nul = 100 − P(prolongation).
   */
  if (market === "double_chance") {
    if (!teamId) return unknown;
    const toOt = await predictGameToOvertime(teamId, opponentId, isHome);
    if ((body.selection ?? "").trim().toLowerCase() === "no_draw") return plain(Math.max(3, Math.min(97, 100 - toOt)));
    const reg = await predictRegulationResult(teamId, opponentId, isHome);
    return plain(Math.max(3, Math.min(97, reg + toOt)));
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
    const { legs } = req.body as { legs: WireParlayLeg[] };

    if (!Array.isArray(legs) || legs.length === 0) {
      return res.status(400).json({ error: "legs array required" });
    }

    // Le calcul vit dans `parlayProbability.ts` depuis le 2026-10-04 (partagé
    // avec « Best Parlay ») ; la réponse est inchangée.
    const r = await computeParlayProbability(legs);
    res.json({
      /** Produit naïf des jambes — conservé pour comparaison. */
      combinedProbability: r.combinedProbability,
      /** Ce que le nom promet depuis toujours : corrélations comprises. */
      adjustedProbability: r.adjustedProbability,
      impossible: r.impossible,
      redundantLegs: r.redundantLegs,
      /** Nb de jambes dont la corrélation a réellement été calculée. */
      exactLegs: r.exactLegs,
      /** `true` = au moins un groupe est retombé sur l'indépendance. */
      assumesIndependence: r.assumesIndependence,
      legs: legs.map((l) => ({ marketType: l.marketType, probability: l.probability })),
    });
  } catch (err: any) {
    sendError(res, err, { context: '[predict/parlay]', fallbackMessage: 'Parlay failed' });
  }
});

// GET /api/predict/markets/game[/:id] — GET /api/predict/markets/player[/:id]
//
// Catalogue STATIQUE des types de marchés : il ne dépend ni du match ni du
// joueur. L'`:id` était obligatoire et ignoré, ce qui laissait croire à un
// catalogue par match (2026-10-05). Il devient optionnel — les anciennes URL
// répondent pareil — et la forme sans identifiant est la forme honnête.
router.get("/markets/game/:id?", (_req: Request, res: Response) => {
  res.json(GAME_MARKET_TYPES);
});

router.get("/markets/player/:id?", (_req: Request, res: Response) => {
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

/**
 * Longueur de la saison régulière, en matchs par équipe.
 *
 * La LNH est repassée à 84 matchs en 2026-27 (82 depuis 1995-96). Le « 82 »
 * codé en dur annonçait 2 matchs restants de trop peu à chaque joueur et
 * projetait une cadence sur une saison qui n'existe plus.
 * ⚠️ À revoir si la ligue change encore de format.
 */
const REGULAR_SEASON_GAMES = 84;

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
      //
      // ⚠️ En début de saison, `fetchPlayerById` rend les totaux de la saison
      // PRÉCÉDENTE tant que le joueur n'a pas joué (`pickSeasonRow`, daté par
      // `statsSeason`). Les lire ici faisait d'un joueur à 82 matchs l'an
      // dernier un joueur à « 2 matchs restants » cette saison. Un pari de
      // saison ne se projette que sur la saison en cours.
      const gp = player.statsSeason === currentSeason() ? (player.gamesPlayed ?? 0) : 0;
      if (gp < 1) {
        // Avant le premier match il n'y a pas de cadence à extrapoler. On tombe
        // à travers vers la réponse commune avec la valeur neutre (50) plutôt
        // que de dupliquer la forme de la réponse ici.
        betNote = `${player.name || playerName} has not played a game this season yet — no pace to project from.`;
      } else {
      const remaining = Math.max(0, REGULAR_SEASON_GAMES - gp);
      const current =
        propType === "goals"   ? player.goals   :
        propType === "points"  ? player.points  :
        propType === "assists" ? player.assists  : 0;

      const pace        = (current / gp) * REGULAR_SEASON_GAMES;
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
    const { type, subjectId, opponentId, propType, line, selection, isHome, gameId } = req.body as {
      type:        'game' | 'player' | 'team';
      subjectId:   string;
      opponentId?: string;
      propType?:   string;
      line?:       number;
      selection?:  string;
      isHome?:     boolean;
      gameId?:     string;
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
      // Le MODÈLE JOUEUR d'abord (cadence du paquet ML du match, binomiale
      // négative) : le même chiffre que les grilles de la page du match. La
      // Poisson de saison de `/predict/player` ne sert plus qu'en repli —
      // gardien, recrue inconnue du modèle, aucun match à venir, match en
      // cours. Voir `prediction/playerModelPrediction.ts`.
      result = await predictPlayerFromModel({
        playerId:  subjectId,
        propType:  propType ?? 'goals',
        line:      line ?? 0.5,
        selection: selection ?? 'over',
        gameId, opponentId, isHome,
      }).catch(() => null);
      if (!result) {
        const features = await buildPlayerPropFeatures(
          subjectId,
          propType ?? 'goals',
          line    ?? 0.5,
          selection ?? 'over'
        );
        result = await mlApiClient.predictPlayer(features);
      }
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

// GET /api/predict/summary?ids=2026020168,2026020169,…
//
// PERF_PLAN.md P1.1 (2026-10-23). Les trois chiffres que montrent l'accueil et
// le calendrier pour chaque match — victoire domicile, handicap −1.5 de chaque
// côté — pour plusieurs matchs en UNE requête. Ils lisaient le paquet complet de
// chaque match (~171 ko : taux de tous les joueurs, échelles de pénalités…) :
// un soir à 14 matchs, ~2,4 Mo de JSON et 14 requêtes sous `predictLimiter`.
// Ici : ~100 octets par match, lus dans les MÊMES paquets (cache serveur, direct
// compris) — aucun calcul nouveau. La page du match garde le paquet complet.
//
// Un match dont le paquet est indisponible vaut `null` (le client affiche « — ») ;
// la route ne rend 503 que si AUCUN ne répond.
const SUMMARY_MAX_IDS = 20;
const GAME_ID_RE = /^\d{6,12}$/;
type GameMlSummary = {
  homeWin: number | null; homeMinus: number | null; awayMinus: number | null;
  live?: { final: boolean; refreshMs?: number };
};
function summarize(b: GameMlBundle): GameMlSummary {
  const p = (k: string) => {
    const v = b.byKey[k]?.probability;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  return {
    homeWin:   p(mlBundleKey('moneyline', null, null, true)),
    homeMinus: p(mlBundleKey('puck_line', -1.5, null, true)),
    awayMinus: p(mlBundleKey('puck_line', -1.5, null, false)),
    ...(b.live ? { live: { final: b.live.final, ...(b.live.refreshMs ? { refreshMs: b.live.refreshMs } : {}) } } : {}),
  };
}
router.get('/summary', predictLimiter, async (req: Request, res: Response) => {
  const ids = [...new Set(String(req.query.ids ?? '').split(',').map(s => s.trim()).filter(Boolean))];
  if (ids.length === 0 || ids.length > SUMMARY_MAX_IDS || !ids.every(id => GAME_ID_RE.test(id))) {
    return res.status(400).json({ error: `ids: 1 à ${SUMMARY_MAX_IDS} identifiants de match, séparés par des virgules` });
  }
  // 4 calculs simultanés au plus, comme best-bets : un cache froid ne doit pas
  // envoyer 20 paquets d'un coup au service Python.
  const out = await mapLimit(ids, 4, async (id) => {
    try { return [id, summarize(await getGameMlBundle(id))] as const; }
    catch (err: any) {
      logger.warn({ err: err?.message, gameId: id }, '[predict/summary] paquet indisponible');
      return [id, null] as const;
    }
  });
  const games: Record<string, GameMlSummary | null> = Object.fromEntries(out);
  const values = Object.values(games);
  if (values.every(v => v === null)) return res.status(503).json({ error: 'ML service unavailable' });
  // Un match en cours : le navigateur revalide à chaque rappel (comme le paquet).
  // Sinon 2 min, le rythme du paquet d'avant-match.
  const liveRefresh = values.filter(v => v?.live && !v.live.final).map(v => v!.live!.refreshMs ?? 30_000);
  res.set('Cache-Control', liveRefresh.length
    ? `public, max-age=0, s-maxage=${Math.round(Math.min(...liveRefresh) / 1000)}`
    : 'public, max-age=120, stale-while-revalidate=600');
  res.json({ games });
});

// GET /api/predict/game/:gameId/bundle
//
// Les prédictions ML de TOUTES les tuiles d'un match, en une requête. Remplace,
// sur la page d'un match, les ~95 `POST /predict/ml` qu'y tirait le mode ML (et
// les 429 qui s'ensuivaient). Calcul mis en cache 10 min par match, pour tout
// le monde — voir `gameMlBundle.ts`. Même réponse pour tout visiteur : un cache
// partagé (CDN) peut la servir.
router.get('/game/:gameId/bundle', predictLimiter, async (req: Request, res: Response) => {
  const { gameId } = req.params;
  if (!/^\d{6,12}$/.test(gameId)) return res.status(400).json({ error: 'invalid gameId' });
  try {
    const bundle = await getGameMlBundle(gameId);
    // En direct, les chiffres suivent le score (recalculés toutes les 30 s, 10 s
    // en fin de match — `nhl/liveRefresh.ts`). Le NAVIGATEUR revalide à chaque
    // rappel (max-age=0 : sinon son cache, et surtout `stale-while-revalidate`,
    // ajoutaient un ou deux rappels de retard) ; l'ETag rend ce contrôle
    // presque gratuit (304). Un CDN garde la réponse au rythme du serveur.
    // Une fois le match terminé, les chiffres ne bougeront plus.
    const liveSec = Math.round((bundle.live?.refreshMs ?? 30_000) / 1000);
    res.set('Cache-Control', bundle.live?.final
      ? 'public, max-age=21600, stale-while-revalidate=43200'
      : bundle.live
        ? `public, max-age=0, s-maxage=${liveSec}`
        : 'public, max-age=120, stale-while-revalidate=600');
    // Corps sérialisé une fois par paquet (pas par requête), ETag compris :
    // Express répond 304 tout seul quand le client a déjà cette version.
    const { body, etag } = serializeBundle(bundle);
    res.set('ETag', etag);
    res.type('application/json').send(body);
  } catch (err: any) {
    if (err?.status === 404) return res.status(404).json({ error: 'Game not found' });
    // Service ML en panne, disjoncteur ouvert, ou match sans aucune donnée
    // (422 du service) : le client affiche « — » sur les tuiles.
    logger.warn({ err: err?.message, gameId }, '[predict/game/bundle] ML bundle unavailable');
    res.status(503).json({ error: 'ML service unavailable' });
  }
});

export default router;
