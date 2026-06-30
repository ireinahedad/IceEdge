/**
 * featureEngineering.ts
 * Converts raw NHL API data into structured feature vectors
 * ready to POST to the Python ML service.
 */
import { fetchTeams, fetchPlayerById } from './nhlApiClient';

// ── Feature types (mirror Python Pydantic models) ─────────────────────────────

export interface GameFeatures {
  home_win_pct:        number;   // 0–1
  away_win_pct:        number;
  home_goals_for_pg:   number;
  away_goals_for_pg:   number;
  home_goals_against_pg: number;
  away_goals_against_pg: number;
  home_pp_pct:         number;   // %
  away_pp_pct:         number;
  home_pk_pct:         number;
  away_pk_pct:         number;
  home_last10_win_pct: number;   // 0–1 (from streak/last10 if available)
  away_last10_win_pct: number;
  market_type:         string;   // "moneyline" | "puck_line" | "total_goals_over" | "total_goals_under"
  line?:               number;   // for total goals markets
}

export interface PlayerPropFeatures {
  goals_per_game:   number;
  assists_per_game: number;
  points_per_game:  number;
  shots_per_game:   number;
  games_played:     number;
  line:             number;
  prop_type:        string;  // "goals" | "assists" | "points" | "shots" | "pp_point"
  selection:        string;  // "over" | "under"
}

export interface TeamFuturesFeatures {
  win_pct:          number;   // 0–100
  goals_for_pg:     number;
  goals_against_pg: number;
  pp_pct:           number;
  pk_pct:           number;
  conference_rank:  number;   // 1–16
  prop_type:        string;   // "cup" | "conf" | "playoff"
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function getTeam(id: string): Promise<any | null> {
  const teams = await fetchTeams();
  const norm = id.toLowerCase();
  return (
    teams.find(
      (t: any) =>
        t.id?.toLowerCase() === norm ||
        t.abbreviation?.toLowerCase() === norm
    ) ?? null
  );
}

/** Parse last-10 string like "7-2-1" → win% */
function parseLastTen(last10: string | undefined): number {
  if (!last10) return 0.5;
  const [w, , ] = last10.split('-').map(Number);
  return isNaN(w) ? 0.5 : Math.min(1, w / 10);
}

// ── Public builders ───────────────────────────────────────────────────────────

export async function buildGameFeatures(
  homeId: string,
  awayId: string,
  marketType: string = 'moneyline',
  line?: number
): Promise<GameFeatures> {
  const [home, away] = await Promise.all([getTeam(homeId), getTeam(awayId)]);

  return {
    home_win_pct:          ((home?.winPct          || 50) / 100),
    away_win_pct:          ((away?.winPct          || 50) / 100),
    home_goals_for_pg:     home?.goalsForPerGame  || 3.0,
    away_goals_for_pg:     away?.goalsForPerGame  || 3.0,
    home_goals_against_pg: home?.goalsAgainstPerGame || 3.0,
    away_goals_against_pg: away?.goalsAgainstPerGame || 3.0,
    home_pp_pct:           home?.ppPct || 20,
    away_pp_pct:           away?.ppPct || 20,
    home_pk_pct:           home?.pkPct || 80,
    away_pk_pct:           away?.pkPct || 80,
    home_last10_win_pct:   parseLastTen(home?.last10),
    away_last10_win_pct:   parseLastTen(away?.last10),
    market_type:           marketType,
    line,
  };
}

export async function buildPlayerPropFeatures(
  playerId: string,
  propType: string,
  line: number,
  selection: string = 'over'
): Promise<PlayerPropFeatures> {
  const player = await fetchPlayerById(playerId);
  const gp = Math.max(player.gamesPlayed ?? 1, 1);

  return {
    goals_per_game:   (player.goals   ?? 0) / gp,
    assists_per_game: (player.assists  ?? 0) / gp,
    points_per_game:  (player.points   ?? 0) / gp,
    shots_per_game:   (player.shots    ?? 0) / gp,
    games_played:     gp,
    line,
    prop_type: propType,
    selection,
  };
}

export async function buildTeamFuturesFeatures(
  teamId: string,
  propType: string
): Promise<TeamFuturesFeatures> {
  const [team, allTeams] = await Promise.all([getTeam(teamId), fetchTeams()]);

  const confTeams: any[] = allTeams
    .filter((t: any) => t.conference === (team?.conference ?? 'Eastern'))
    .sort((a: any, b: any) => (b.points ?? 0) - (a.points ?? 0));

  const rank =
    confTeams.findIndex(
      (t: any) => t.id?.toLowerCase() === (team?.id ?? '').toLowerCase()
    ) + 1 || 8;

  return {
    win_pct:          team?.winPct          || 50,
    goals_for_pg:     team?.goalsForPerGame || 3.0,
    goals_against_pg: team?.goalsAgainstPerGame || 3.0,
    pp_pct:           team?.ppPct || 20,
    pk_pct:           team?.pkPct || 80,
    conference_rank:  rank,
    prop_type:        propType,
  };
}
