/**
 * nhl/gameEvents.ts — feuille de match, buts marqués et mises au jeu d'un match
 * terminé (utilisés pour régler les paris). Point d'entrée public : `../nhlApiClient.ts`.
 */

import { USE_MOCK, fetchNHL, getCached, parseToiMinutes, setCached } from './core';

// --- Boxscore (per-player final stats, used for player-prop settlement) ---

export interface BoxscorePlayerStats {
  playerId:      string;
  goals:         number;
  assists:       number;
  points:        number;
  shots:         number;
  hits:          number;
  blockedShots:  number;
  pim:           number;
  /** Minutes on ice (decimal), parsed from the "MM:SS" boxscore string. */
  toi:           number;
  /** Goalie only — undefined for skaters. */
  saves?:        number;
  shotsAgainst?: number;
  goalsAgainst?: number;
  decision?:     string; // 'W' | 'L' | 'O'
}

function numOrUndefined(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Parses NHL's "27/30" saves/shots-against string into { saves, shotsAgainst }. */
function parseSavesString(s: unknown): { saves?: number; shotsAgainst?: number } {
  if (typeof s !== 'string' || !s.includes('/')) return {};
  const [a, b] = s.split('/').map((x) => Number(x.trim()));
  return { saves: Number.isFinite(a) ? a : undefined, shotsAgainst: Number.isFinite(b) ? b : undefined };
}

function normalizeSkater(p: any): BoxscorePlayerStats {
  const goals   = numOrUndefined(p.goals)   ?? 0;
  const assists = numOrUndefined(p.assists) ?? 0;
  return {
    playerId:     String(p.playerId ?? p.id),
    goals,
    assists,
    points:       numOrUndefined(p.points) ?? (goals + assists),
    shots:        numOrUndefined(p.sog ?? p.shots ?? p.shotsOnGoal) ?? 0,
    hits:         numOrUndefined(p.hits) ?? 0,
    blockedShots: numOrUndefined(p.blockedShots ?? p.blockedShotsAgainst) ?? 0,
    pim:          numOrUndefined(p.pim ?? p.penaltyMinutes) ?? 0,
    toi:          parseToiMinutes(p.toi),
  };
}

function normalizeGoalie(p: any): BoxscorePlayerStats {
  const parsed = parseSavesString(p.saveShotsAgainst);
  return {
    playerId:     String(p.playerId ?? p.id),
    goals:        numOrUndefined(p.goals)   ?? 0,
    assists:      numOrUndefined(p.assists) ?? 0,
    points:       numOrUndefined(p.points)  ?? 0,
    shots:        0,
    hits:         0,
    blockedShots: 0,
    pim:          numOrUndefined(p.pim ?? p.penaltyMinutes) ?? 0,
    toi:          parseToiMinutes(p.toi),
    saves:        numOrUndefined(p.saves) ?? parsed.saves,
    shotsAgainst: numOrUndefined(p.shotsAgainst) ?? parsed.shotsAgainst,
    goalsAgainst: numOrUndefined(p.goalsAgainst),
    decision:     typeof p.decision === 'string' ? p.decision : undefined,
  };
}

/**
 * Fetches the final boxscore for a game and returns a Map of playerId → stats,
 * for both rosters combined. Returns null if the boxscore can't be fetched or
 * parsed — callers must treat that as "can't settle yet", never as zero stats.
 */
export async function fetchGameBoxscore(gameId: string): Promise<Map<string, BoxscorePlayerStats> | null> {
  if (USE_MOCK) return null; // no boxscore data in mock mode — player props stay pending

  const cacheKey = `box:${gameId}`;
  const cached = getCached<Map<string, BoxscorePlayerStats>>(cacheKey);
  if (cached) return cached;

  let data: any;
  try {
    data = await fetchNHL<any>(`v1/gamecenter/${gameId}/boxscore`);
  } catch {
    return null;
  }

  const stats = data?.playerByGameStats;
  if (!stats) return null;

  const out = new Map<string, BoxscorePlayerStats>();
  try {
    for (const side of [stats.awayTeam, stats.homeTeam]) {
      if (!side) continue;
      for (const p of [...(side.forwards ?? []), ...(side.defense ?? [])]) {
        const s = normalizeSkater(p);
        out.set(s.playerId, s);
      }
      for (const p of side.goalies ?? []) {
        const s = normalizeGoalie(p);
        out.set(s.playerId, s);
      }
    }
  } catch {
    return null; // unexpected shape → don't guess, let settlement stay pending
  }

  if (out.size === 0) return null;
  // Final boxscores never change — cache for a long time.
  setCached(cacheKey, out, 6 * 60 * 60_000);
  return out;
}

// --- Scoring plays (goal order + strength state, used for first/last goal
// scorer and power-play point settlement) -----------------------------------

export interface ScoringGoal {
  playerId:        string;
  assistPlayerIds: string[];
  /** 'ev' | 'pp' | 'sh' — power-play/shorthanded/even-strength. */
  strength:        string;
  /** True if the home team scored this goal. */
  isHome:          boolean;
  periodNumber:    number;
  periodType:      string; // 'REG' | 'OT' | 'SO'
  /** Seconds elapsed within the period — used to order goals within a period. */
  elapsedSeconds:  number;
}

function parseTimeToSeconds(s: unknown): number {
  if (typeof s !== 'string' || !s.includes(':')) return 0;
  const [m, sec] = s.split(':').map((x) => Number(x.trim()));
  if (!Number.isFinite(m) || !Number.isFinite(sec)) return 0;
  return m * 60 + sec;
}

/**
 * Fetches the final game's scoring summary (goal-by-goal, in chronological
 * order, with strength state) via the landing endpoint. Returns null if it
 * can't be fetched or parsed — callers must treat that as "can't settle yet".
 * Shootout goals are excluded (they aren't "goals" for scorer/PP props).
 */
export async function fetchGameScoringPlays(gameId: string): Promise<ScoringGoal[] | null> {
  if (USE_MOCK) return null; // no scoring-play data in mock mode

  const cacheKey = `scoring:${gameId}`;
  const cached = getCached<ScoringGoal[]>(cacheKey);
  if (cached) return cached;

  let data: any;
  try {
    data = await fetchNHL<any>(`v1/gamecenter/${gameId}/landing`);
  } catch {
    return null;
  }

  const periods = data?.summary?.scoring;
  if (!Array.isArray(periods)) return null;

  const out: ScoringGoal[] = [];
  try {
    for (const period of periods) {
      const periodType = String(period?.periodDescriptor?.periodType ?? '');
      if (periodType === 'SO') continue; // shootout attempts aren't "goals"
      const periodNumber = Number(period?.periodDescriptor?.number ?? 0);
      for (const g of period?.goals ?? []) {
        if (g?.playerId == null) continue;
        if (typeof g.isHome !== 'boolean') throw new Error('unexpected goal shape'); // caught below → null
        out.push({
          playerId:        String(g.playerId),
          assistPlayerIds: (g.assists ?? []).map((a: any) => String(a.playerId)).filter(Boolean),
          strength:        String(g.strength ?? 'ev').toLowerCase(),
          isHome:          g.isHome,
          periodNumber,
          periodType,
          elapsedSeconds:  parseTimeToSeconds(g.timeInPeriod),
        });
      }
    }
  } catch {
    return null; // unexpected shape → don't guess, let settlement stay pending
  }

  // Chronological order: by period, then by elapsed time within the period.
  out.sort((a, b) => a.periodNumber - b.periodNumber || a.elapsedSeconds - b.elapsedSeconds);

  // Final games' scoring never changes — cache for a long time.
  setCached(cacheKey, out, 6 * 60 * 60_000);
  return out;
}

// --- Faceoff wins (play-by-play) --------------------------------------------
// The boxscore only exposes a faceoff *percentage* per player, not a raw win
// count, so "Over/Under N faceoff wins" can't be settled from it. The full
// play-by-play feed lists every individual faceoff event with a winner, so we
// tally those instead. This is a heavier fetch than the boxscore (the full
// event log for the game), which is exactly why this market was left for
// later rather than shipped with the others.

/**
 * Fetches the final game's play-by-play log and tallies faceoff wins per
 * player. Returns null if it can't be fetched or parsed.
 */
export async function fetchGameFaceoffWins(gameId: string): Promise<Map<string, number> | null> {
  if (USE_MOCK) return null; // no play-by-play data in mock mode

  const cacheKey = `faceoffs:${gameId}`;
  const cached = getCached<Map<string, number>>(cacheKey);
  if (cached) return cached;

  let data: any;
  try {
    data = await fetchNHL<any>(`v1/gamecenter/${gameId}/play-by-play`);
  } catch {
    return null;
  }

  const plays = data?.plays;
  if (!Array.isArray(plays)) return null;

  const out = new Map<string, number>();
  try {
    for (const play of plays) {
      if (play?.typeDescKey !== 'faceoff') continue;
      const winnerId = play?.details?.winningPlayerId;
      if (winnerId == null) continue;
      const key = String(winnerId);
      out.set(key, (out.get(key) ?? 0) + 1);
    }
  } catch {
    return null; // unexpected shape → don't guess, let settlement stay pending
  }

  // Final games' play-by-play never changes — cache for a long time.
  setCached(cacheKey, out, 6 * 60 * 60_000);
  return out;
}
