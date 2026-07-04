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
 * Supported markets: moneyline, total_goals (over/under), puck_line.
 * Player-prop markets need boxscore data and are left pending for now.
 */

import { pool } from '../db/connection';
import { fetchGameById } from './nhlApiClient';
import { applyXpDelta, xpForOutcome } from './slip.service';

type LegResult = 'win' | 'loss' | 'unknown';

// Small per-run cache so a slip with 5 legs on the same game fetches it once
type GameCache = Map<string, any | null>;

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

/** Decide a single leg from the final score. */
async function settleLeg(leg: any, cache: GameCache): Promise<LegResult> {
  if (!leg?.gameId || leg?.selectionValue == null) return 'unknown';

  const game = await getFinalGame(String(leg.gameId), cache);
  if (!game) return 'unknown';

  const hs = Number(game.homeTeam.score);
  const as = Number(game.awayTeam.score);
  const homeId = String(game.homeTeam.abbreviation ?? '').toLowerCase();
  const awayId = String(game.awayTeam.abbreviation ?? '').toLowerCase();
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
      return 'unknown'; // player props etc. — not auto-settled yet
  }
}

export interface SettlementSummary {
  checked:  number;
  settled:  number;
  wins:     number;
  losses:   number;
}

/**
 * Settle pending slips. If `userId` is given, only that user's slips.
 * Safe to call concurrently: the UPDATE is guarded by outcome = 'pending'.
 */
export async function settlePendingSlips(userId?: string, max = 100): Promise<SettlementSummary> {
  const params: unknown[] = [max];
  let where = `outcome = 'pending'`;
  if (userId) { where += ` AND user_id = $2`; params.push(userId); }

  const { rows: slips } = await pool.query(
    `SELECT id, user_id AS "userId", legs,
            combined_probability AS "combinedProbability"
     FROM bet_slips
     WHERE ${where}
     ORDER BY placed_at ASC
     LIMIT $1`,
    params,
  );

  const summary: SettlementSummary = { checked: slips.length, settled: 0, wins: 0, losses: 0 };
  const cache: GameCache = new Map();

  for (const slip of slips) {
    const legs: any[] = Array.isArray(slip.legs) ? slip.legs : [];
    if (legs.length === 0) continue;

    const results: LegResult[] = [];
    for (const leg of legs) results.push(await settleLeg(leg, cache));

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

    // Guard against double settlement (interval job + manual trigger)
    const upd = await pool.query(
      `UPDATE bet_slips
       SET outcome = $1, resolved_at = NOW(), xp_awarded = $2
       WHERE id = $3 AND outcome = 'pending'`,
      [outcome, xp, slip.id],
    );
    if (!upd.rowCount) continue;

    await applyXpDelta(slip.userId, xp);

    summary.settled++;
    if (outcome === 'win') summary.wins++;
    else summary.losses++;
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

async function checkFinishedGames(): Promise<void> {
  const gameIds = await pendingGameIds();
  if (gameIds.length === 0) return; // nothing pending → zero API calls

  let newlyFinal = false;
  for (const id of gameIds) {
    if (knownFinal.has(id)) { newlyFinal = true; continue; } // final but slip still pending → retry settle
    try {
      const g = await fetchGameById(id);
      if (g?.status === 'final') {
        knownFinal.add(id);
        newlyFinal = true;
      }
    } catch { /* API down / game not found — retry next tick */ }
  }

  if (newlyFinal) {
    const s = await settlePendingSlips(undefined, 200);
    if (s.settled > 0) {
      console.log(`[Settlement] ${s.settled}/${s.checked} slips settled (${s.wins}W/${s.losses}L)`);
    }
  }

  // Don't let the set grow forever across a long-running process
  if (knownFinal.size > 2000) knownFinal.clear();
}

/**
 * Background job — call once at server startup.
 * @param checkMs    how often to poll the status of games with pending slips (default 2 min)
 * @param fallbackMs full settlement pass as a safety net (default 60 min)
 */
export function startSettlementJob(checkMs = 2 * 60_000, fallbackMs = 60 * 60_000): void {
  const check = async () => {
    try { await checkFinishedGames(); }
    catch (err: any) { console.warn('[Settlement] check failed:', err.message); }
  };
  const fallback = async () => {
    try {
      const s = await settlePendingSlips(undefined, 200);
      if (s.settled > 0) {
        console.log(`[Settlement] (fallback) ${s.settled}/${s.checked} slips settled (${s.wins}W/${s.losses}L)`);
      }
    } catch (err: any) {
      console.warn('[Settlement] fallback failed:', err.message);
    }
  };

  // Catch-up pass shortly after boot (games may have finished while the
  // server was down), then event-driven checks + hourly fallback.
  setTimeout(fallback, 30_000).unref();
  setInterval(check, checkMs).unref();
  setInterval(fallback, fallbackMs).unref();
}
