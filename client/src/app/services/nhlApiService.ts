/**
 * NHL API Service
 * Base URL: VITE_NHL_API_URL = http://localhost:3001/api/nhl
 */

import type {
  NHLGame,
  NHLTeamInfo,
  NHLTeamStats,
  NHLPlayerInfo,
  NHLPlayerStats,
  NHLStandings,
} from '../types/bet';

declare global {
  interface ImportMetaEnv {
    readonly VITE_NHL_API_URL: string;
    readonly VITE_PROFILE_API_URL: string;
    readonly VITE_PREDICTION_API_URL: string;
  }
}

const BASE_URL = import.meta.env.VITE_NHL_API_URL || '';

async function get<T>(path: string): Promise<T> {
  if (!BASE_URL) throw new Error('VITE_NHL_API_URL is not configured');
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`NHL API ${res.status}: ${msg}`);
  }
  return res.json() as Promise<T>;
}

export const nhlApiService = {
  getGamesByDate: (date?: string): Promise<NHLGame[]> => {
    const d = date || new Date().toISOString().split('T')[0];
    return get<NHLGame[]>(`/games?date=${d}`);
  },

  getLiveGames: (): Promise<NHLGame[]> =>
    get<NHLGame[]>('/games/live'),

  getGame: (gameId: string): Promise<NHLGame> =>
    get<NHLGame>(`/games/${gameId}`),

  getAllTeams: (): Promise<NHLTeamInfo[]> =>
    get<NHLTeamInfo[]>('/teams'),

  getTeamStats: (teamId: string): Promise<NHLTeamStats> =>
    get<NHLTeamStats>(`/teams/${teamId}/stats`),

  getTeamLastNGamesStats: (teamId: string, n: number): Promise<NHLTeamStats> =>
    get<NHLTeamStats>(`/teams/${teamId}/last/${n}`),

  searchPlayers: (query: string): Promise<NHLPlayerInfo[]> =>
    get<NHLPlayerInfo[]>(`/players/search?q=${encodeURIComponent(query)}`),

  getAllPlayers: (): Promise<NHLPlayerInfo[]> =>
    get<NHLPlayerInfo[]>('/players'),

  getPlayer: (playerId: string): Promise<NHLPlayerInfo> =>
    get<NHLPlayerInfo>(`/players/${playerId}`),

  getPlayerStats: (playerId: string): Promise<NHLPlayerStats> =>
    get<NHLPlayerStats>(`/players/${playerId}/stats`),

  getStandings: (): Promise<NHLStandings[]> =>
    get<NHLStandings[]>('/standings'),
};
