/**
 * useNHLData
 * Fetches teams, games (today) and players from the API and normalises
 * them into the flat shape that the existing components expect.
 */

import { useState, useEffect } from 'react';
import { nhlApiService } from '../services/nhlApiService';

// ─── Normalised shapes (what the UI components consume) ───────────────────────

export interface UITeam {
  id: string;       // abbreviation lowercase, e.g. "bos"
  name: string;
  abbr: string;
  logo: string;     // emoji
  conf: string;     // "East" | "West"
  record: string;   // "48-22-8"
  pts: number;
  winPct: number;
  homeRecord: string;
  awayRecord: string;
  streak: string;
  ppPct: number;
  pkPct: number;
  goalsFor: number;
  goalsAgainst: number;
  color: string;
}

export interface UIGame {
  id: string;
  date: string;       // "Apr 27"
  time: string;       // "7:00 PM ET"
  status: string;
  team1Id: string;    // home, abbr lowercase
  team2Id: string;    // away, abbr lowercase
  odds1?: number;
  odds2?: number;
  overUnder?: number;
  venue?: string;
  winPct1: number;
  winPct2: number;
}

export interface UIPlayer {
  id: string;
  name: string;
  teamId: string;     // abbr lowercase
  position: string;
  number: number;
  goals: number;
  assists: number;
  points: number;
  plusMinus: number;
  shots: number;
  shotPct: number;
  ppPoints: number;
  gamesPlayed: number;
  lastFive: number[];
  winImpact: number;
}

// ─── Transform helpers ────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  // "2026-04-27" → "Apr 27"
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function toUITeam(t: any): UITeam {
  return {
    id:           t.abbreviation?.toLowerCase() ?? String(t.id),
    name:         t.name,
    abbr:         t.abbreviation,
    logo:         t.emoji ?? '🏒',
    conf:         t.conference === 'Eastern' ? 'East' : 'West',
    record:       `${t.wins ?? 0}-${t.losses ?? 0}-${t.otLosses ?? 0}`,
    pts:          t.points ?? 0,
    winPct:       Math.round(Number(t.winPct ?? 50)),
    homeRecord:   t.homeRecord ?? '',
    awayRecord:   t.awayRecord ?? '',
    streak:       t.streak ?? '',
    ppPct:        Number(t.ppPct ?? 0),
    pkPct:        Number(t.pkPct ?? 0),
    goalsFor:     Number(t.goalsFor ?? 0),
    goalsAgainst: Number(t.goalsAgainst ?? 0),
    color:        t.color ?? '#86d1ea',
  };
}

function toUIGame(g: any): UIGame {
  return {
    id:        g.id,
    date:      formatDate(g.gameDate),
    time:      g.startTime,
    status:    g.status,
    team1Id:   g.homeTeam?.abbreviation?.toLowerCase() ?? '',
    team2Id:   g.awayTeam?.abbreviation?.toLowerCase() ?? '',
    odds1:     g.homeTeam?.odds,
    odds2:     g.awayTeam?.odds,
    overUnder: g.overUnder ? Number(g.overUnder) : undefined,
    venue:     g.venue,
    winPct1:   g.homeWinPct ?? 50,
    winPct2:   g.awayWinPct ?? 50,
  };
}

function toUIPlayer(p: any): UIPlayer {
  return {
    id:          String(p.id),
    name:        p.name ?? p.fullName,
    teamId:      p.teamId ?? p.teamAbbr?.toLowerCase() ?? '',
    position:    p.position,
    number:      p.number ?? p.jerseyNumber ?? 0,
    goals:       p.goals ?? 0,
    assists:     p.assists ?? 0,
    points:      p.points ?? 0,
    plusMinus:   p.plusMinus ?? 0,
    shots:       p.shots ?? 0,
    shotPct:     Number(p.shotPct ?? p.shootingPct ?? 0),
    ppPoints:    p.ppPoints ?? 0,
    gamesPlayed: p.gamesPlayed ?? 0,
    lastFive:    p.lastFive ?? [],
    winImpact:   p.winImpact ?? 0,
  };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

interface NHLData {
  teams:   UITeam[];
  games:   UIGame[];
  players: UIPlayer[];
  loading: boolean;
  error:   string | null;
  /** Lookup helpers built from the fetched data */
  getTeamById:   (id: string) => UITeam | undefined;
  getGameById:   (id: string) => UIGame | undefined;
  getPlayerById: (id: string) => UIPlayer | undefined;
}

export function useNHLData(): NHLData {
  const [teams,   setTeams]   = useState<UITeam[]>([]);
  const [games,   setGames]   = useState<UIGame[]>([]);
  const [players, setPlayers] = useState<UIPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);

    const today = new Date().toISOString().split('T')[0];

    Promise.all([
      nhlApiService.getAllTeams(),
      nhlApiService.getGamesByDate(today),
      nhlApiService.getAllPlayers(),
    ])
      .then(([rawTeams, rawGames, rawPlayers]) => {
        if (!alive) return;
        setTeams(rawTeams.map(toUITeam));
        setGames(rawGames.map(toUIGame));
        setPlayers(rawPlayers.map(toUIPlayer));
        setError(null);
      })
      .catch((err) => {
        if (!alive) return;
        setError(err.message ?? 'Failed to load NHL data');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => { alive = false; };
  }, []);

  const getTeamById   = (id: string) => teams.find(t => t.id === id);
  const getGameById   = (id: string) => games.find(g => g.id === id);
  const getPlayerById = (id: string) => players.find(p => p.id === id);

  return { teams, games, players, loading, error, getTeamById, getGameById, getPlayerById };
}
