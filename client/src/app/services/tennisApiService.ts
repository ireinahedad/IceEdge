/**
 * tennisApiService.ts
 * Client-side wrapper for the tennis proxy routes on our Express server.
 * Routes: /api/tennis/live | /fixtures | /rankings/:tour | /tournaments
 */

const BASE = `${(import.meta.env.VITE_NHL_API_URL as string | undefined)?.replace("/api/nhl", "") ?? "http://localhost:3001"}/api/tennis`;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TennisApiMatch {
  id: string;
  tournament: string;
  surface: string;
  surfaceIcon: string;
  isLive: boolean;
  liveSet?: string;
  scheduledIso?: string;
  player1: {
    id: string;
    name: string;
    country: string;
    countryCode: string;
    sets?: number[];
    serving?: boolean;
  };
  player2: {
    id: string;
    name: string;
    country: string;
    countryCode: string;
    sets?: number[];
    serving?: boolean;
  };
}

export interface TennisRankingEntry {
  pos: number;
  points: number;
  player: {
    id: string;
    name: string;
    country: string;
    countryCode: string;
  };
}

export interface TennisTournamentInfo {
  id: string;
  name: string;
  surface: string;
  surfaceIcon: string;
  location?: string;
  prize?: string;
  startDate?: string;
  endDate?: string;
  season?: number;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    // Surface the actual error body from the server/RapidAPI
    const body = await res.json().catch(() => null);
    const msg = body?.error ?? `Tennis API ${res.status}`;
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export const tennisApiService = {
  getLiveMatches: (): Promise<TennisApiMatch[]> =>
    get<TennisApiMatch[]>("/live"),

  getFixtures: (date?: Date): Promise<TennisApiMatch[]> => {
    const q = date ? `?date=${date.toISOString().split("T")[0]}` : "";
    return get<TennisApiMatch[]>(`/fixtures${q}`);
  },

  getRankings: (tour: "ATP" | "WTA"): Promise<TennisRankingEntry[]> =>
    get<TennisRankingEntry[]>(`/rankings/${tour}`),

  getTournaments: (year?: number): Promise<TennisTournamentInfo[]> => {
    const q = year ? `?year=${year}` : "";
    return get<TennisTournamentInfo[]>(`/tournaments${q}`);
  },
};
