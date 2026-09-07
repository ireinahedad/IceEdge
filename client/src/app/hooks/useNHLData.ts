/**
 * useNHLData
 * Fetches teams, games and players from the API and normalises
 * them into the flat shape that the existing components expect.
 *
 * Game-date fallback: today → tomorrow → next 7 days
 */

import { useState, useEffect } from 'react';
import { nhlApiService } from '../services/nhlApiService';
import { nhlLogoUrl } from '../data/teamEmoji';

// ─── Normalised shapes (what the UI components consume) ───────────────────────

export interface UITeam {
  id: string;       // abbreviation lowercase, e.g. "bos"
  name: string;
  abbr: string;
  logo: string;     // official NHL logo URL (SVG)
  conf: string;     // "East" | "West"
  record: string;   // "48-22-8"
  pts: number;
  /** `null` = le backend ne l'a pas fourni. Jamais 50 par défaut. */
  winPct: number | null;
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
  /** Probabilités du modèle/moteur de règles. `null` = non fournies. */
  winPct1: number | null;
  winPct2: number | null;
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
    logo:         t.abbreviation ? nhlLogoUrl(t.abbreviation) : '🏒',
    conf:         t.conference === 'Eastern' ? 'East' : 'West',
    record:       `${t.wins ?? 0}-${t.losses ?? 0}-${t.otLosses ?? 0}`,
    pts:          t.points ?? 0,
    winPct:       t.winPct == null ? null : Math.round(Number(t.winPct)),
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
    winPct1:   g.homeWinPct ?? null,
    winPct2:   g.awayWinPct ?? null,
  };
}

function toUIPlayer(p: any): UIPlayer {
  return {
    id:          String(p.id),
    name:        p.name ?? p.fullName,
    teamId:      p.teamAbbr?.toLowerCase() ?? (p.teamId ? String(p.teamId) : ''),
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

/** Shift a YYYY-MM-DD string by `days` days. */
function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

interface NHLData {
  teams:       UITeam[];
  games:       UIGame[];
  players:     UIPlayer[];
  /** Human-readable label: "Aujourd'hui" | "Demain" | "Cette semaine" */
  gamesLabel:  string;
  loading:     boolean;
  error:       string | null;
  /**
   * Rejoue les trois appels. Rien d'autre ne relance ce hook : son effet est
   * monté une fois pour toute la vie de la page, donc sans ça un échec réseau
   * restait à l'écran jusqu'à un rechargement complet de l'application.
   */
  reload:      () => void;
  getTeamById:   (id: string) => UITeam | undefined;
  getGameById:   (id: string) => UIGame | undefined;
  getPlayerById: (id: string) => UIPlayer | undefined;
}

export function useNHLData(): NHLData {
  const [teams,      setTeams]      = useState<UITeam[]>([]);
  const [games,      setGames]      = useState<UIGame[]>([]);
  const [gamesLabel, setGamesLabel] = useState<string>("Aujourd'hui");
  const [players,    setPlayers]    = useState<UIPlayer[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);
  const [reloadKey,  setReloadKey]  = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);

    const today = new Date().toISOString().split('T')[0];

    async function fetchGamesWithFallback(): Promise<{ games: UIGame[]; label: string }> {
      // 1 — Today
      try {
        const raw = await nhlApiService.getGamesByDate(today);
        if (raw.length > 0) return { games: raw.map(toUIGame), label: "Aujourd'hui" };
      } catch { /* fall through */ }

      // 2 — Tomorrow
      try {
        const raw = await nhlApiService.getGamesByDate(shiftDate(today, 1));
        if (raw.length > 0) return { games: raw.map(toUIGame), label: "Demain" };
      } catch { /* fall through */ }

      // 3 — Next 7 days (days +2 to +7)
      try {
        const weekRaw = await Promise.all(
          [2, 3, 4, 5, 6, 7].map(n =>
            nhlApiService.getGamesByDate(shiftDate(today, n)).catch(() => [] as any[])
          )
        );
        const combined = weekRaw.flat().map(toUIGame);
        if (combined.length > 0) return { games: combined, label: "Cette semaine" };
      } catch { /* fall through */ }

      return { games: [], label: "Aucun match" };
    }

    Promise.all([
      nhlApiService.getAllTeams(),
      fetchGamesWithFallback(),
      nhlApiService.getAllPlayers(),
    ])
      .then(([rawTeams, { games: uiGames, label }, rawPlayers]) => {
        if (!alive) return;
        setTeams(rawTeams.map(toUITeam));
        setGames(uiGames);
        setGamesLabel(label);
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
  }, [reloadKey]);

  const getTeamById   = (id: string) => teams.find(t => t.id === id);
  const getGameById   = (id: string) => games.find(g => g.id === id);
  const getPlayerById = (id: string) => players.find(p => p.id === id);

  const reload = () => setReloadKey(k => k + 1);

  return { teams, games, players, gamesLabel, loading, error, reload, getTeamById, getGameById, getPlayerById };
}
