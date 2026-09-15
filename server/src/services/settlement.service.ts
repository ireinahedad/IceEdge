/**
 * settlement.service.ts — Automatic bet settlement.
 *
 * Checks pending slips against real NHL results (official NHL API) and
 * resolves them automatically:
 *   - every leg must reference a finished game (legs carry `gameId` and
 *     `selectionValue`, stored at bet time)
 *   - any lost leg → the whole slip is a loss (parlay semantics)
 *   - all legs won → the slip is a win
 *   - unsupported markets or unfinished games → the slip stays pending
 *
 * XP is risk-based (see xpForOutcome in slip.service):
 *   win  → more XP the riskier the bet was
 *   loss → more XP lost the safer the bet was
 *   The loss penalty is proportional to the number of lost legs:
 *   winning every leg but one costs far less than losing them all.
 *
 * Supported markets:
 *   - Game markets: moneyline, total_goals (over/under), puck_line.
 *   - Player-prop markets (via boxscore, once the game is final): anytime_goal
 *     (respects the leg's line, e.g. "Over 1.5 goals"), shots_ou, assists_ou,
 *     points_ou, blocked_shots_ou, hits_ou, penalty_minutes_ou, time_on_ice_ou,
 *     goalie_saves_ou, goalie_win, goalie_shutout, faceoff_wins_ou (via
 *     play-by-play — a heavier fetch, kept separate from the boxscore ones).
 *   - Player-prop markets (via the landing endpoint's scoring summary — goal
 *     order + strength state, once the game is final): first_goal_scorer,
 *     last_goal_scorer, pp_point, pp_goal.
 *   - Team markets (via the same scoring summary): first_team_score,
 *     last_team_score, team_total_goals, team_pp_goals, clean_sheet,
 *     team_score_every_period.
 *   - both_teams_score (via the final score) — see the block for why the final
 *     score settles it correctly even after a shootout.
 *   - Period markets (via the same scoring summary): period1/2/3_winner,
 *     period1/2/3_total_goals, highest_scoring_period.
 *   Each leg needs gameId recorded at bet time, plus subjectId (player or
 *   team id) for the markets that need one.
 *
 * Deliberately left pending (not auto-settled): everything else — game_to_ot,
 * ot_winner, alt_puck_line, winning_margin, regulation_result,
 * total_penalties. Leaving a bet pending is always safer than guessing wrong.
 */

import { pool } from '../db/connection';
import {
  fetchGameById, fetchGameBoxscore, fetchGameScoringPlays, fetchGameFaceoffWins,
  type BoxscorePlayerStats, type ScoringGoal,
} from './nhlApiClient';
import { applyXpDelta, xpForOutcome } from './slip.service';
import { logger } from '../logger';
import { withJobLock } from './jobLock';
import { mapLimit } from './concurrency';

type LegResult = 'win' | 'loss' | 'unknown';

// Small per-run cache so a slip with 5 legs on the same game fetches it once
type GameCache     = Map<string, any | null>;
type BoxCache      = Map<string, Map<string, BoxscorePlayerStats> | null>;
type ScoringCache  = Map<string, ScoringGoal[] | null>;
type FaceoffCache  = Map<string, Map<string, number> | null>;

async function getFinalGame(gameId: string, cache: GameCache): Promise<any | null> {
  if (cache.has(gameId)) return cache.get(gameId);
  let game: any | null = null;
  try {
    const g = await fetchGameById(String(gameId));
    if (g?.status === 'final' && g.homeTeam?.score != null && g.awayTeam?.score != null) {
      game = g;
    }
  } catch { /* game not found / API down → stays unknown */ }
  cache.set(gameId, game);
  return game;
}

/** Boxscore stats for one player in one (final) game, or null if unavailable. */
async function getPlayerBox(
  gameId: string,
  playerId: string,
  gameCache: GameCache,
  boxCache: BoxCache,
): Promise<BoxscorePlayerStats | null> {
  const game = await getFinalGame(gameId, gameCache);
  if (!game) return null; // only trust the boxscore once the game is final

  if (!boxCache.has(gameId)) {
    let box: Map<string, BoxscorePlayerStats> | null = null;
    try { box = await fetchGameBoxscore(gameId); } catch { box = null; }
    boxCache.set(gameId, box);
  }
  return boxCache.get(gameId)?.get(String(playerId)) ?? null;
}

/** Chronological goal list for one (final) game, or null if unavailable. */
async function getScoringPlays(
  gameId: string,
  gameCache: GameCache,
  scoringCache: ScoringCache,
): Promise<ScoringGoal[] | null> {
  const game = await getFinalGame(gameId, gameCache);
  if (!game) return null; // only trust the scoring summary once the game is final

  if (!scoringCache.has(gameId)) {
    let goals: ScoringGoal[] | null = null;
    try { goals = await fetchGameScoringPlays(gameId); } catch { goals = null; }
    scoringCache.set(gameId, goals);
  }
  return scoringCache.get(gameId) ?? null;
}

/** Faceoff win counts by player for one (final) game, or null if unavailable. */
async function getFaceoffWins(
  gameId: string,
  gameCache: GameCache,
  faceoffCache: FaceoffCache,
): Promise<Map<string, number> | null> {
  const game = await getFinalGame(gameId, gameCache);
  if (!game) return null; // only trust play-by-play once the game is final

  if (!faceoffCache.has(gameId)) {
    let wins: Map<string, number> | null = null;
    try { wins = await fetchGameFaceoffWins(gameId); } catch { wins = null; }
    faceoffCache.set(gameId, wins);
  }
  return faceoffCache.get(gameId) ?? null;
}

/**
 * Goals scored per team, per regulation period (index 0 = P1, 1 = P2, 2 = P3).
 * OT/SO goals are excluded — period1/2/3 markets only cover regulation.
 */
function periodGoalCounts(goals: ScoringGoal[]): { home: number[]; away: number[] } {
  const home = [0, 0, 0];
  const away = [0, 0, 0];
  for (const g of goals) {
    if (g.periodType !== 'REG' || g.periodNumber < 1 || g.periodNumber > 3) continue;
    (g.isHome ? home : away)[g.periodNumber - 1]++;
  }
  return { home, away };
}

const PLAYER_STAT_MARKETS: Record<string, keyof BoxscorePlayerStats> = {
  shots_ou:           'shots',
  assists_ou:         'assists',
  points_ou:          'points',
  blocked_shots_ou:   'blockedShots',
  hits_ou:            'hits',
  penalty_minutes_ou: 'pim',
  time_on_ice_ou:     'toi',
};

/** Abréviations des deux équipes d'un match, en minuscules (forme de `selectionValue`). */
function teamIds(game: any): { homeId: string; awayId: string } {
  return {
    homeId: String(game.homeTeam.abbreviation ?? '').toLowerCase(),
    awayId: String(game.awayTeam.abbreviation ?? '').toLowerCase(),
  };
}

/**
 * Match terminé + équipe choisie par la jambe. `null` si le match n'est pas
 * fini ou si `selectionValue` ne désigne aucune des deux équipes.
 */
async function teamPick(
  leg: any, cache: GameCache,
): Promise<{ game: any; homeId: string; awayId: string; sel: string } | null> {
  const game = await getFinalGame(String(leg.gameId), cache);
  if (!game) return null;
  const { homeId, awayId } = teamIds(game);
  const sel = String(leg.selectionValue).toLowerCase();
  if (sel !== homeId && sel !== awayId) return null;
  return { game, homeId, awayId, sel };
}

/** Decide a single leg from the final score (or, for player/team props, the boxscore / scoring summary). */
async function settleLeg(
  leg: any, cache: GameCache, boxCache: BoxCache, scoringCache: ScoringCache, faceoffCache: FaceoffCache,
): Promise<LegResult> {
  if (!leg?.gameId || leg?.selectionValue == null) return 'unknown';

  if (leg.marketType === 'faceoff_wins_ou') {
    if (!leg.subjectId) return 'unknown';
    const line = Number(leg.line);
    if (!Number.isFinite(line)) return 'unknown';
    const wins = await getFaceoffWins(String(leg.gameId), cache, faceoffCache);
    if (!wins) return 'unknown';
    const value = wins.get(String(leg.subjectId)) ?? 0;
    const sel = String(leg.selectionValue).toLowerCase();
    if (value === line) return 'unknown'; // push
    if (sel === 'over')  return value > line ? 'win' : 'loss';
    if (sel === 'under') return value < line ? 'win' : 'loss';
    return 'unknown';
  }

  if (leg.marketType === 'anytime_goal') {
    if (!leg.subjectId) return 'unknown';
    // Line defaults to 0.5 ("scores at least once"), but also generalizes to
    // "Over 1.5" etc. — the client sets an explicit line for those.
    const line = Number.isFinite(Number(leg.line)) ? Number(leg.line) : 0.5;
    const stats = await getPlayerBox(String(leg.gameId), String(leg.subjectId), cache, boxCache);
    if (!stats) return 'unknown';
    return stats.goals > line ? 'win' : 'loss';
  }

  if (leg.marketType === 'goalie_win') {
    if (!leg.subjectId) return 'unknown';
    const stats = await getPlayerBox(String(leg.gameId), String(leg.subjectId), cache, boxCache);
    if (!stats || !stats.decision) return 'unknown';
    return stats.decision.toUpperCase() === 'W' ? 'win' : 'loss';
  }

  if (leg.marketType === 'goalie_shutout') {
    if (!leg.subjectId) return 'unknown';
    const stats = await getPlayerBox(String(leg.gameId), String(leg.subjectId), cache, boxCache);
    if (!stats || stats.goalsAgainst == null) return 'unknown';
    return stats.goalsAgainst === 0 ? 'win' : 'loss';
  }

  if (leg.marketType === 'goalie_saves_ou') {
    if (!leg.subjectId) return 'unknown';
    const line = Number(leg.line);
    if (!Number.isFinite(line)) return 'unknown';
    const stats = await getPlayerBox(String(leg.gameId), String(leg.subjectId), cache, boxCache);
    if (!stats || stats.saves == null) return 'unknown';
    const sel = String(leg.selectionValue).toLowerCase();
    if (stats.saves === line) return 'unknown'; // push
    if (sel === 'over')  return stats.saves > line ? 'win' : 'loss';
    if (sel === 'under') return stats.saves < line ? 'win' : 'loss';
    return 'unknown';
  }

  if (leg.marketType === 'first_goal_scorer' || leg.marketType === 'last_goal_scorer') {
    if (!leg.subjectId) return 'unknown';
    const goals = await getScoringPlays(String(leg.gameId), cache, scoringCache);
    if (!goals) return 'unknown';
    if (goals.length === 0) return 'unknown'; // no goals scored (rare 0-0 → SO game) — can't verify either way
    const target = leg.marketType === 'first_goal_scorer' ? goals[0] : goals[goals.length - 1];
    return target.playerId === String(leg.subjectId) ? 'win' : 'loss';
  }

  if (leg.marketType === 'pp_point' || leg.marketType === 'pp_goal') {
    if (!leg.subjectId) return 'unknown';
    const goals = await getScoringPlays(String(leg.gameId), cache, scoringCache);
    if (!goals) return 'unknown';
    const subjectId = String(leg.subjectId);
    const involved = goals.some((g) => {
      if (g.strength !== 'pp') return false;
      if (leg.marketType === 'pp_goal') return g.playerId === subjectId; // scorer only
      return g.playerId === subjectId || g.assistPlayerIds.includes(subjectId); // scorer or assist
    });
    return involved ? 'win' : 'loss';
  }

  // ── Team markets ──────────────────────────────────────────────────────────
  if (leg.marketType === 'first_team_score' || leg.marketType === 'last_team_score') {
    const pick = await teamPick(leg, cache);
    if (!pick) return 'unknown';
    const { homeId, awayId, sel } = pick;
    const goals = await getScoringPlays(String(leg.gameId), cache, scoringCache);
    if (!goals) return 'unknown';
    if (goals.length === 0) return 'unknown'; // no goals scored at all — can't verify either way
    const target = leg.marketType === 'first_team_score' ? goals[0] : goals[goals.length - 1];
    const winner = target.isHome ? homeId : awayId;
    return sel === winner ? 'win' : 'loss';
  }

  if (leg.marketType === 'team_total_goals' || leg.marketType === 'team_pp_goals') {
    const game = await getFinalGame(String(leg.gameId), cache);
    if (!game) return 'unknown';
    const { homeId, awayId } = teamIds(game);
    const teamId = String(leg.subjectId ?? '').toLowerCase();
    if (teamId !== homeId && teamId !== awayId) return 'unknown';
    const line = Number(leg.line);
    if (!Number.isFinite(line)) return 'unknown';
    const sel = String(leg.selectionValue).toLowerCase();

    let value: number;
    if (leg.marketType === 'team_total_goals') {
      value = Number(teamId === homeId ? game.homeTeam.score : game.awayTeam.score);
    } else {
      const goals = await getScoringPlays(String(leg.gameId), cache, scoringCache);
      if (!goals) return 'unknown';
      const isHomeTeam = teamId === homeId;
      value = goals.filter((g) => g.strength === 'pp' && g.isHome === isHomeTeam).length;
    }
    if (!Number.isFinite(value)) return 'unknown';
    if (value === line) return 'unknown'; // push
    if (sel === 'over')  return value > line ? 'win' : 'loss';
    if (sel === 'under') return value < line ? 'win' : 'loss';
    return 'unknown';
  }

  if (leg.marketType === 'clean_sheet') {
    const pick = await teamPick(leg, cache);
    if (!pick) return 'unknown';
    const { game, homeId, sel } = pick;
    const opponentScore = Number(sel === homeId ? game.awayTeam.score : game.homeTeam.score);
    if (!Number.isFinite(opponentScore)) return 'unknown';
    return opponentScore === 0 ? 'win' : 'loss';
  }

  if (leg.marketType === 'both_teams_score') {
    const game = await getFinalGame(String(leg.gameId), cache);
    if (!game) return 'unknown';

    // Le côté du pari. Jusqu'au correctif BTTS de sept. 2026, `selectionValue`
    // portait l'abréviation de l'équipe à domicile pour les DEUX tuiles (le
    // côté n'existait pas) : ces paris-là sont indécidables et doivent rester
    // en attente. D'où la comparaison stricte à 'yes' / 'no' — un défaut par
    // « tout ce qui n'est pas no vaut yes » réglerait d'anciens paris à pile ou
    // face.
    const sel = String(leg.selectionValue ?? '').toLowerCase();
    if (sel !== 'yes' && sel !== 'no') return 'unknown';

    const homeScore = Number(game.homeTeam?.score);
    const awayScore = Number(game.awayTeam?.score);
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return 'unknown';

    // POURQUOI LE SCORE FINAL SUFFIT, TIRS DE BARRAGE COMPRIS.
    //
    // Les bookmakers règlent BTTS prolongation incluse mais fusillade exclue, et
    // le but de fusillade est justement un but comptable, pas un vrai but. Or
    // il ne peut CHANGER la réponse dans aucun cas :
    //
    //   · fusillade ⇒ égalité après prolongation, donc score k–k ;
    //   · si k ≥ 1, les deux équipes ont déjà marqué → « oui » dans tous les cas ;
    //   · si k = 0, la fusillade donne 1–0 → une équipe reste à zéro → « non ».
    //
    // Le score final et la règle « hors fusillade » donnent donc toujours le
    // même verdict, et on peut se passer du détail des buts.
    const bothScored = homeScore > 0 && awayScore > 0;
    return (sel === 'yes') === bothScored ? 'win' : 'loss';
  }

  if (leg.marketType === 'team_score_every_period') {
    const pick = await teamPick(leg, cache);
    if (!pick) return 'unknown';
    const { homeId, sel } = pick;
    const goals = await getScoringPlays(String(leg.gameId), cache, scoringCache);
    if (!goals) return 'unknown';
    const { home, away } = periodGoalCounts(goals);
    const counts = sel === homeId ? home : away;
    return counts.every((c) => c >= 1) ? 'win' : 'loss';
  }

  // ── Period markets ────────────────────────────────────────────────────────
  const periodWinnerMatch = /^period([123])_winner$/.exec(String(leg.marketType));
  if (periodWinnerMatch) {
    const n = Number(periodWinnerMatch[1]);
    const pick = await teamPick(leg, cache);
    if (!pick) return 'unknown';
    const { homeId, awayId, sel } = pick;
    const goals = await getScoringPlays(String(leg.gameId), cache, scoringCache);
    if (!goals) return 'unknown';
    const { home, away } = periodGoalCounts(goals);
    const homeCum = home.slice(0, n).reduce((a, b) => a + b, 0);
    const awayCum = away.slice(0, n).reduce((a, b) => a + b, 0);
    if (homeCum === awayCum) return 'unknown'; // tied through this period — push
    const winner = homeCum > awayCum ? homeId : awayId;
    return sel === winner ? 'win' : 'loss';
  }

  const periodTotalMatch = /^period([123])_total_goals$/.exec(String(leg.marketType));
  if (periodTotalMatch) {
    const n = Number(periodTotalMatch[1]);
    const line = Number(leg.line);
    if (!Number.isFinite(line)) return 'unknown';
    const goals = await getScoringPlays(String(leg.gameId), cache, scoringCache);
    if (!goals) return 'unknown';
    const { home, away } = periodGoalCounts(goals);
    const total = home[n - 1] + away[n - 1];
    const sel = String(leg.selectionValue).toLowerCase();
    if (total === line) return 'unknown'; // push
    if (sel === 'over')  return total > line ? 'win' : 'loss';
    if (sel === 'under') return total < line ? 'win' : 'loss';
    return 'unknown';
  }

  if (leg.marketType === 'highest_scoring_period') {
    const goals = await getScoringPlays(String(leg.gameId), cache, scoringCache);
    if (!goals) return 'unknown';
    const { home, away } = periodGoalCounts(goals);
    const totals = [0, 1, 2].map((i) => home[i] + away[i]);
    const max = Math.max(...totals);
    const leaders = totals.reduce<number[]>((acc, v, i) => (v === max ? [...acc, i] : acc), []);
    if (leaders.length !== 1 || max === 0) return 'unknown'; // tie for highest, or no goals at all
    const sel = String(leg.selectionValue).toLowerCase();
    return sel === `p${leaders[0] + 1}` ? 'win' : 'loss';
  }

  const statKey = PLAYER_STAT_MARKETS[leg.marketType as string];
  if (statKey) {
    if (!leg.subjectId) return 'unknown';
    const line = Number(leg.line);
    if (!Number.isFinite(line)) return 'unknown';
    const stats = await getPlayerBox(String(leg.gameId), String(leg.subjectId), cache, boxCache);
    if (!stats) return 'unknown';
    const value = stats[statKey];
    if (typeof value !== 'number') return 'unknown';
    const sel = String(leg.selectionValue).toLowerCase();
    if (value === line) return 'unknown'; // push (rare -- lines are usually X.5)
    if (sel === 'over')  return value > line ? 'win' : 'loss';
    if (sel === 'under') return value < line ? 'win' : 'loss';
    return 'unknown';
  }

  const game = await getFinalGame(String(leg.gameId), cache);
  if (!game) return 'unknown';

  const hs = Number(game.homeTeam.score);
  const as = Number(game.awayTeam.score);
  const { homeId, awayId } = teamIds(game);
  const sel = String(leg.selectionValue).toLowerCase();

  switch (leg.marketType) {
    case 'moneyline': {
      if (sel !== homeId && sel !== awayId) return 'unknown';
      if (hs === as) return 'unknown'; // no ties in the NHL, safety only
      const winner = hs > as ? homeId : awayId;
      return sel === winner ? 'win' : 'loss';
    }

    case 'total_goals': {
      const line = Number(leg.line);
      if (!Number.isFinite(line)) return 'unknown';
      const total = hs + as;
      if (total === line) return 'unknown'; // push → leave pending
      if (sel === 'over')  return total > line ? 'win' : 'loss';
      if (sel === 'under') return total < line ? 'win' : 'loss';
      return 'unknown';
    }

    case 'puck_line': {
      const line = Number(leg.line);
      if (!Number.isFinite(line)) return 'unknown';
      if (sel !== homeId && sel !== awayId) return 'unknown';
      const teamScore = sel === homeId ? hs : as;
      const oppScore  = sel === homeId ? as : hs;
      const adjusted  = teamScore + line;
      if (adjusted === oppScore) return 'unknown'; // push
      return adjusted > oppScore ? 'win' : 'loss';
    }

    default:
      return 'unknown'; // game_to_ot, winning_margin, etc. — not auto-settled yet
  }
}

export interface SettlementSummary {
  checked:  number;
  settled:  number;
  wins:     number;
  losses:   number;
  /** Faux quand la passe s'est arrêtée sur son plafond ou son budget temps —
   *  il reste donc des tickets réglables. Une valeur durablement fausse est LE
   *  signal que la file se remplit plus vite qu'elle ne se vide. */
  exhausted: boolean;
}

export interface SettleOptions {
  /** Plafond de tickets EXAMINÉS sur la passe (pas par lot). */
  max?: number;
  /** Budget temps de la passe. Doit rester sous le TTL du bail du job appelant. */
  budgetMs?: number;
  /** Taille d'un lot lu en base. */
  batch?: number;
}

/** Lot lu en base par aller-retour. 100 : assez pour amortir la latence, assez
 *  peu pour que le budget temps soit vérifié souvent. */
const SETTLE_BATCH = Number(process.env.SETTLEMENT_BATCH) || 100;
/** Plafond par défaut. Ce n'est plus lui qui borne la passe en pratique — le
 *  budget temps le fait — mais il empêche une boucle infinie si la pagination
 *  n'avance pas. */
const SETTLE_MAX_DEFAULT = Number(process.env.SETTLEMENT_MAX_SLIPS) || 5_000;
const SETTLE_BUDGET_DEFAULT_MS = Number(process.env.SETTLEMENT_BUDGET_MS) || 2 * 60_000;
/** Jambes d'un même ticket traitées en parallèle. Petit : les jambes partagent
 *  les caches de passe et, en dessous, `fetchNHL` déduplique déjà les appels en
 *  vol — au-delà de quelques unités on n'achète plus de latence, on ne fait
 *  qu'élargir les rafales vers l'API NHL. */
const LEG_CONCURRENCY = Number(process.env.SETTLEMENT_LEG_CONCURRENCY) || 4;

/**
 * Settle pending slips. If `userId` is given, only that user's slips.
 * Safe to call concurrently: the UPDATE is guarded by outcome = 'pending'.
 *
 * PAGINATION (audit, ligne H) — la passe boucle jusqu'à épuisement de la file
 * plutôt que de s'arrêter à 100 ou 200 tickets. Avec l'ancien plafond fixe, une
 * soirée à 2 000 tickets se vidait à 200/heure : des utilisateurs attendaient
 * des JOURS le règlement de leur pari alors que le résultat était connu.
 *
 * La pagination est par CURSEUR `(placed_at, id)` et non par `OFFSET`. Un ticket
 * examiné mais non réglable — marché non auto-réglé, match pas encore final —
 * reste `pending` : une seconde requête `LIMIT` sans curseur renverrait
 * exactement les mêmes lignes, et la boucle tournerait sur place indéfiniment.
 *
 * Les quatre caches sont créés UNE fois pour toute la passe : régler 300 tickets
 * portant sur les 10 mêmes matchs coûte 10 récupérations, pas 300. C'est
 * l'essentiel du bénéfice du « regroupement par match » de l'audit, sans en
 * réorganiser la boucle.
 */
export async function settlePendingSlips(userId?: string, opts: SettleOptions = {}): Promise<SettlementSummary> {
  const max      = opts.max      ?? SETTLE_MAX_DEFAULT;
  const budgetMs = opts.budgetMs ?? SETTLE_BUDGET_DEFAULT_MS;
  const batch    = Math.max(1, opts.batch ?? SETTLE_BATCH);
  const deadline = Date.now() + budgetMs;

  const summary: SettlementSummary = { checked: 0, settled: 0, wins: 0, losses: 0, exhausted: true };
  const cache: GameCache = new Map();
  const boxCache: BoxCache = new Map();
  const scoringCache: ScoringCache = new Map();
  const faceoffCache: FaceoffCache = new Map();

  // Curseur de pagination : dernier (placed_at, id) examiné.
  let cursorAt: string | null = null;
  let cursorId: string | null = null;

  while (summary.checked < max) {
    const limit = Math.min(batch, max - summary.checked);
    const params: unknown[] = [limit];
    let where = `outcome = 'pending'`;
    if (userId)   { where += ` AND user_id = $${params.length + 1}`; params.push(userId); }
    if (cursorAt) {
      where += ` AND (placed_at, id) > ($${params.length + 1}::timestamptz, $${params.length + 2}::uuid)`;
      params.push(cursorAt, cursorId);
    }

    const { rows: slips } = await pool.query(
      `SELECT id, user_id AS "userId", legs, placed_at AS "placedAt",
              combined_probability AS "combinedProbability"
       FROM bet_slips
       WHERE ${where}
       ORDER BY placed_at ASC, id ASC
       LIMIT $1`,
      params,
    );
    if (slips.length === 0) break;   // file vide → `exhausted` reste vrai

    for (const slip of slips) {
      summary.checked++;
      cursorAt = slip.placedAt instanceof Date ? slip.placedAt.toISOString() : String(slip.placedAt);
      cursorId = String(slip.id);

      const legs: any[] = Array.isArray(slip.legs) ? slip.legs : [];
      if (legs.length === 0) continue;

      // Jambes en parallèle borné : un ticket de 6 jambes sur 6 matchs
      // différents prenait 6 allers-retours NHL en série.
      const results: LegResult[] = await mapLimit(legs, LEG_CONCURRENCY,
        (leg) => settleLeg(leg, cache, boxCache, scoringCache, faceoffCache));

      // Parlay semantics: one lost leg loses the slip;
      // a win requires EVERY leg to be settled and won.
      let outcome: 'win' | 'loss' | null = null;
      if (results.includes('loss')) outcome = 'loss';
      else if (results.length > 0 && results.every((r) => r === 'win')) outcome = 'win';
      if (!outcome) continue; // stays pending

      let xp: number;
      if (outcome === 'win') {
        xp = xpForOutcome('win', slip.combinedProbability);
      } else {
        // Loss penalty scales with HOW MANY legs were lost:
        // losing 1 leg out of 4 costs a quarter of the full penalty,
        // losing them all costs the full risk-based penalty.
        const lostLegs = results.filter((r) => r === 'loss').length;
        const fullPenalty = Math.abs(xpForOutcome('loss', slip.combinedProbability));
        xp = -Math.max(3, Math.round(fullPenalty * (lostLegs / legs.length)));
      }

      // Résultat de CHAQUE jambe, conservé.
      //
      // `results` était calculé puis jeté : seul l'`outcome` global du ticket
      // survivait. La page joueur doit pouvoir montrer QUELLE jambe a fait
      // tomber un parlay — l'information la plus recherchée en ouvrant un
      // ticket perdu — et la recalculer à l'affichage voudrait dire rejouer les
      // appels NHL à chaque consultation.
      //
      // Fusionné dans le même UPDATE que l'`outcome`, jamais dans un second :
      // c'est le `WHERE outcome = 'pending'` qui rend le règlement idempotent
      // face au job périodique ET au déclenchement manuel. Une écriture séparée
      // sortirait de cette garde et pourrait laisser un ticket réglé sans son
      // détail.
      const settledLegs = legs.map((leg, i) => ({ ...leg, result: results[i] ?? 'unknown' }));

      // Guard against double settlement (interval job + manual trigger)
      const upd = await pool.query(
        `UPDATE bet_slips
         SET outcome = $1, resolved_at = NOW(), xp_awarded = $2, legs = $3::jsonb
         WHERE id = $4 AND outcome = 'pending'`,
        [outcome, xp, JSON.stringify(settledLegs), slip.id],
      );
      if (!upd.rowCount) continue;

      await applyXpDelta(slip.userId, xp);

      summary.settled++;
      if (outcome === 'win') summary.wins++;
      else summary.losses++;
    }

    // Budget vérifié entre deux lots, jamais au milieu : un ticket entamé va
    // toujours à son terme, sinon on paierait ses appels NHL sans écrire le
    // résultat.
    if (Date.now() >= deadline) { summary.exhausted = false; break; }
    if (slips.length < limit)   break;                  // dernier lot → file vide
  }

  if (summary.checked >= max) summary.exhausted = false;
  if (!summary.exhausted) {
    logger.warn(summary, '[Settlement] passe interrompue (budget ou plafond) — des tickets restent en attente');
  }
  return summary;
}

// ── Event-driven background job ──────────────────────────────────────────────
//
// Instead of blindly re-settling every N minutes, the job watches the games
// actually referenced by pending slips and settles as soon as one turns FINAL:
//   1. cheap SQL: collect distinct gameIds from pending slips (no API call
//      when there is nothing pending)
//   2. poll only those games' status
//   3. when a game newly becomes final → run settlePendingSlips
// A slow fallback pass still runs hourly as a safety net (e.g. games that
// finished while the check was failing, or player-prop slips).

/** Distinct gameIds referenced by pending slips. */
async function pendingGameIds(): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT leg->>'gameId' AS "gameId"
     FROM bet_slips, jsonb_array_elements(legs) AS leg
     WHERE outcome = 'pending' AND leg->>'gameId' IS NOT NULL`,
  );
  return rows.map((r: any) => String(r.gameId));
}

// Games we already know are final — no need to re-poll or re-trigger for them.
const knownFinal = new Set<string>();

/** What one check pass observed — drives when the scheduler should wake next. */
interface CheckResult {
  /** Any slip is still pending (open bets exist). */
  pending: boolean;
  /** A referenced game has started (or its start time is unknown) and isn't
   *  final yet → poll fast until it settles. */
  live: boolean;
  /** ms until the earliest *future* pending game starts, or null if none are
   *  in the future (all live/unknown, or nothing pending). */
  soonestStartMs: number | null;
}

async function checkFinishedGames(): Promise<CheckResult> {
  const gameIds = await pendingGameIds();
  if (gameIds.length === 0) {
    return { pending: false, live: false, soonestStartMs: null }; // zero API calls
  }

  const now = Date.now();
  let newlyFinal = false;
  let live = false;
  let soonestStartMs: number | null = null;

  for (const id of gameIds) {
    if (knownFinal.has(id)) { newlyFinal = true; continue; } // final but slip still pending → retry settle
    try {
      const g = await fetchGameById(id);
      if (g?.status === 'final') {
        knownFinal.add(id);
        newlyFinal = true;
        continue;
      }
      // Not final → is it live/imminent, or still in the future?
      const startMs = g?.startTimeUTC ? new Date(g.startTimeUTC).getTime() : NaN;
      if (!Number.isFinite(startMs) || startMs <= now) {
        live = true; // started (awaiting final) or unknown start → poll fast
      } else {
        const until = startMs - now;
        soonestStartMs = soonestStartMs == null ? until : Math.min(soonestStartMs, until);
      }
    } catch {
      live = true; // API down / game not found → be safe, keep polling fast
    }
  }

  if (newlyFinal) {
    // Budget sous le TTL du bail `settlement-check` (5 min), en laissant de la
    // marge pour les appels NHL déjà faits ci-dessus. Ce qui ne rentre pas est
    // repris au tour suivant : la file n'est jamais perdue, seulement étalée.
    await settlePendingSlips(undefined, { budgetMs: 3 * 60_000 });
  }

  // Don't let the set grow forever across a long-running process
  if (knownFinal.size > 2000) knownFinal.clear();

  return { pending: true, live, soonestStartMs };
}

// ── Event-driven scheduler ───────────────────────────────────────────────────
//
// The check no longer polls on a fixed clock. It reschedules itself based on
// what's actually pending, so a serverless Postgres (e.g. Neon) can scale its
// compute to zero while nothing is happening:
//   - nothing pending          → sleep `idleMs` (long)
//   - a game is live/imminent  → poll every `activeMs` (fast) until it settles
//   - all pending games future → sleep until `preRollMs` before the earliest
//                                start (capped at `maxSleepMs`)
// A newly placed bet calls notifySlipPlaced() to wake the job immediately so it
// can re-plan its horizon instead of waiting out a long sleep.

const minToMs = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n * 60_000 : fallback;
};

let checkTimer: NodeJS.Timeout | null = null;
let activeMs   = 2 * 60_000;
let idleMs     = 15 * 60_000;
let preRollMs  = 2 * 60_000;
const maxSleepMs = 6 * 60 * 60_000; // safety re-check horizon (schedule changes, missed kicks)

/** Delay (ms) until the next check, from what the last pass observed. */
function nextDelay(r: CheckResult): number {
  if (!r.pending) return idleMs;                 // no open bets → let the DB sleep
  if (r.live) return activeMs;                    // a game is on → poll fast
  if (r.soonestStartMs != null) {                 // all pending games are upcoming
    const wake = r.soonestStartMs - preRollMs;
    return Math.min(Math.max(wake, activeMs), maxSleepMs);
  }
  return activeMs;                                // pending but timing unknown → be safe
}

function armCheck(delay: number): void {
  if (checkTimer) clearTimeout(checkTimer);
  checkTimer = setTimeout(runCheck, delay);
  checkTimer.unref();
}

/**
 * TTL des baux. Le check est court (quelques requêtes + appels NHL) ; la passe
 * de rattrapage boucle jusqu'à épuisement de la file, d'où un TTL bien plus
 * large. Ces valeurs majorent la durée observée, elles ne la mesurent pas :
 * elles sont là pour qu'une instance TUÉE ne bloque pas le job indéfiniment, pas
 * pour interrompre un job lent.
 *
 * Chaque TTL doit rester STRICTEMENT supérieur au budget temps passé à
 * `settlePendingSlips` par le job correspondant (3 min sous un bail de 5,
 * 10 min sous un bail de 15) : c'est le budget qui arrête la passe, jamais le
 * bail — sinon une deuxième instance reprendrait le travail pendant que la
 * première l'exécute encore.
 */
const CHECK_LOCK_TTL_MS    = 5 * 60_000;
const FALLBACK_LOCK_TTL_MS = 15 * 60_000;

/**
 * Un tour de check, sous verrou.
 *
 * Le verrou n'est pas ce qui protège de la double-comptabilisation — c'est
 * l'`UPDATE … WHERE outcome = 'pending'` de `settleLeg` qui le fait, et il reste
 * la vraie ligne de défense. Le verrou évite le travail redondant : N instances
 * qui interrogent l'API NHL pour les mêmes matchs, N fois.
 *
 * Quand une autre instance détient le bail, on se replanifie quand même — à la
 * cadence active, pas à la cadence longue : si l'instance détentrice meurt, on
 * doit pouvoir reprendre la main en quelques minutes plutôt qu'au prochain
 * réveil lointain. Le coût d'un tour perdu est d'un seul INSERT.
 */
async function runCheck(): Promise<void> {
  let delay = activeMs;
  try {
    const outcome = await withJobLock('settlement-check', CHECK_LOCK_TTL_MS, checkFinishedGames);
    if (outcome.ran) delay = nextDelay(outcome.result);
  } catch (err: any) {
    logger.warn({ err: err.message }, '[Settlement] check failed'); // retry at active cadence
  }
  armCheck(delay);
}

/**
 * Wake the settlement check now (debounced to a few seconds) so a freshly
 * placed bet re-plans the wake horizon instead of waiting out a long idle
 * sleep. No-op if the job hasn't been started (e.g. tests).
 */
export function notifySlipPlaced(): void {
  if (checkTimer) armCheck(5_000);
}

/**
 * Background job — call once at server startup.
 *
 * Cadence knobs (env, minutes):
 *   - SETTLEMENT_POLL_MIN       fast interval while a game is live (default 2)
 *   - SETTLEMENT_IDLE_POLL_MIN  interval while nothing is pending (default 15 in
 *                               production, else same as active)
 *   - SETTLEMENT_PREROLL_MIN    how early before a game's start to begin polling (default 2)
 *   - SETTLEMENT_FALLBACK_MIN   safety-net full settlement pass (default 60)
 * To restore a plain fixed poll every 5 min, set SETTLEMENT_POLL_MIN=5 and
 * SETTLEMENT_IDLE_POLL_MIN=5.
 */
export function startSettlementJob(): void {
  activeMs  = minToMs(process.env.SETTLEMENT_POLL_MIN, 2 * 60_000);
  const idleDefault = process.env.NODE_ENV === 'production' ? 15 * 60_000 : activeMs;
  idleMs    = minToMs(process.env.SETTLEMENT_IDLE_POLL_MIN, idleDefault);
  preRollMs = minToMs(process.env.SETTLEMENT_PREROLL_MIN, 2 * 60_000);
  const fallbackMs = minToMs(process.env.SETTLEMENT_FALLBACK_MIN, 60 * 60_000);

  const fallback = async () => {
    try {
      await withJobLock('settlement-fallback', FALLBACK_LOCK_TTL_MS,
        () => settlePendingSlips(undefined, { budgetMs: 10 * 60_000 }));
    } catch (err: any) {
      logger.warn({ err: err.message }, '[Settlement] fallback failed');
    }
  };

  // Catch-up pass shortly after boot (games may have finished while the server
  // was down), then event-driven checks + periodic fallback safety net.
  setTimeout(fallback, 30_000).unref();
  armCheck(activeMs);
  setInterval(fallback, fallbackMs).unref();
}
