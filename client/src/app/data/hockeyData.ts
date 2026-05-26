/**
 * hockeyData.ts
 *
 * Static data has been removed — all teams, games, and players
 * are now fetched from the backend via nhlApiService.
 *
 * Use:
 *   nhlApiService.getAllTeams()       → teams
 *   nhlApiService.getGamesByDate()    → games
 *   nhlApiService.getAllPlayers()     → players with stats
 *   nhlApiService.getStandings()      → standings
 */

// ─── Types (kept for components that import them) ─────────────────────────────

export type Team = {
  id: string;
  name: string;
  abbr: string;
  emoji?: string;
  conf: string;
  record?: string;
  pts: number;
  winPct: number;
  homeRecord?: string;
  awayRecord?: string;
  streak?: string;
  ppPct?: number;
  pkPct?: number;
  goalsFor?: number;
  goalsAgainst?: number;
  color?: string;
};

export type Game = {
  id: string;
  date: string;
  time: string;
  status: string;
  team1Id: string;
  team2Id: string;
  odds1?: number;
  odds2?: number;
  overUnder?: number;
  venue?: string;
  winPct1?: number;
  winPct2?: number;
};

export type Player = {
  id: string;
  name: string;
  teamId: string;
  position: string;
  number?: number;
  goals: number;
  assists: number;
  points: number;
  plusMinus?: number;
  shots?: number;
  shotPct?: number;
  ppPoints?: number;
  gamesPlayed?: number;
  lastFive?: number[];
  winImpact?: number;
};

// ─── Empty exports — components should use nhlApiService instead ──────────────

export const teams:   Team[]   = [];
export const games:   Game[]   = [];
export const players: Player[] = [];

export const lastNGamesOptions = [5, 10, 20, 30];

export const getTeamById   = (id: string): Team   | undefined => teams.find(t => t.id === id);
export const getGameById   = (id: string): Game   | undefined => games.find(g => g.id === id);
export const getPlayerById = (id: string): Player | undefined => players.find(p => p.id === id);

export const getTeamLastNGames = (teamId: string, n: number) => {
  const team = getTeamById(teamId);
  if (!team) return null;
  const wins   = Math.round(n * ((team.winPct ?? 50) / 100));
  const losses = n - wins;
  return {
    wins,
    losses,
    goalsFor:     +((team.goalsFor ?? 3) * n).toFixed(1),
    goalsAgainst: +((team.goalsAgainst ?? 3) * n).toFixed(1),
  };
};
