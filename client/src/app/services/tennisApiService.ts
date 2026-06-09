/**
 * tennisApiService.ts
 * Client-side wrapper for the tennis proxy routes on our Express server.
 * Server routes: GET /api/tennis/live  &  GET /api/tennis/fixtures
 */

const BASE = `${import.meta.env.VITE_NHL_API_URL?.replace("/api/nhl", "") ?? "http://localhost:3001"}/api/tennis`;

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
    country: string;      // flag emoji
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

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`Tennis API ${res.status}`);
  return res.json() as Promise<T>;
}

export const tennisApiService = {
  getLiveMatches: (): Promise<TennisApiMatch[]> =>
    get<TennisApiMatch[]>("/live"),

  getFixtures: (date?: Date): Promise<TennisApiMatch[]> => {
    const q = date ? `?date=${date.toISOString().split("T")[0]}` : "";
    return get<TennisApiMatch[]>(`/fixtures${q}`);
  },
};
