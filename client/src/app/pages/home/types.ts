// ─── Shared types & helpers for the landing page ─────────────────────────────

export interface DisplayGame {
  id: string;
  period?: string;
  time?: string;
  overUnder?: number;
  totalPct?: number;
  // bet365 decimal odds — only populated when VITE_ODDS_API_KEY is set
  bet365Home?: number;
  bet365Away?: number;
  team1: { id: string; abbr: string; name: string; score?: number; logo: string; winPct: number };
  team2: { id: string; abbr: string; name: string; score?: number; logo: string; winPct: number };
}

export interface TennisMatch {
  id: string;
  player1: { name: string; country: string; winPct: number; sets?: number[]; serving?: boolean; bet365Odds?: number };
  player2: { name: string; country: string; winPct: number; sets?: number[]; serving?: boolean; bet365Odds?: number };
  time: string; tournament: string; surface: string; surfaceIcon: string;
  isLive?: boolean; liveSet?: string;
}

export interface EvItem {
  id: string;
  logo: string;
  label: string;
  context: string;
  pct: number;   // model probability
  edge: number;  // model% − implied%
}

// ─── Edge detection helpers ───────────────────────────────────────────────────

/** Convert a bet365 decimal odd to the bookmaker's implied win probability (%) */
export function impliedPct(decimal: number): number {
  return Math.round(100 / decimal);
}

/**
 * Edge = our model's probability minus the bookmaker's implied probability.
 * Only meaningful when we have real bet365 odds.
 */
export function calcEdge(modelPct: number, decimal: number): number {
  return modelPct - impliedPct(decimal);
}
