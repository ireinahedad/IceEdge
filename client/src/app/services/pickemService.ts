/**
 * pickemService.ts — pick'em (NEWS_CONSENSUS_PLAN.md, F3, session A).
 *
 *   GET  /api/pickem/today    public : tous les matchs du jour (section du chat)
 *   GET  /api/pickem/leaderboard?week=current|previous  public : classement hebdo
 *   GET  /api/pickem/:gameId  public (avec mon vote si connecté)
 *   POST /api/pickem/:gameId  connecté, { team }
 *
 * Lecture : échec → null (la carte ne s'affiche pas, comme le fil de nouvelles).
 * Vote : l'erreur remonte avec son `code` (GAME_STARTED, BAD_TEAM…).
 */

import { authedFetch } from './authService';

export interface PickemSide { team: string; votes: number; pct: number | null }

export interface PickemState {
  gameId: string;
  home: PickemSide;
  away: PickemSide;
  total: number;
  enough: boolean;
  minVotes: number;
  locked: boolean;
  startsAt: string | null;
  myVote: string | null;
}

export interface PickemDayGame extends PickemState {
  status: string;
  homeScore: number | null;
  awayScore: number | null;
  /** Match fini : l'équipe gagnante. */
  winner: string | null;
}

export interface PickemDay { date: string; games: PickemDayGame[] }

/** Tous les matchs du jour avec leurs votes. Échec → null (la section ne s'affiche pas). */
export async function fetchPickemDay(signal?: AbortSignal): Promise<PickemDay | null> {
  try {
    const res = await authedFetch('/pickem/today', { signal });
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body?.games) ? (body as PickemDay) : null;
  } catch {
    return null;
  }
}

export interface PickemRankedRow {
  userId: string; username: string; displayName: string | null;
  avatar: string | null; avatarUrl: string | null;
  picks: number; wins: number; rank: number; pct: number;
}
export interface PickemRate { games: number; wins: number; pct: number | null }
export interface PickemLeaderboard {
  weekStart: string;
  weekEnd: string;
  minPicks: number;
  ranked: PickemRankedRow[];
  rankedCount: number;
  me: { rank: number | null; picks: number; wins: number; pct: number | null } | null;
  model: PickemRate;
  crowd: PickemRate;
}

/** Classement de la semaine (lundi → dimanche, heure de l'Est). Échec → null. */
export async function fetchPickemLeaderboard(week: 'current' | 'previous', signal?: AbortSignal): Promise<PickemLeaderboard | null> {
  try {
    const res = await authedFetch(`/pickem/leaderboard?week=${week}`, { signal });
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body?.ranked) ? (body as PickemLeaderboard) : null;
  } catch {
    return null;
  }
}

export class PickemError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

export async function fetchPickem(gameId: string, signal?: AbortSignal): Promise<PickemState | null> {
  try {
    const res = await authedFetch(`/pickem/${encodeURIComponent(gameId)}`, { signal });
    if (!res.ok) return null;
    return (await res.json()) as PickemState;
  } catch {
    return null;
  }
}

export async function castPickem(gameId: string, team: string): Promise<PickemState> {
  const res = await authedFetch(`/pickem/${encodeURIComponent(gameId)}`, {
    method: 'POST',
    body: JSON.stringify({ team }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new PickemError(body?.error ?? 'pickem failed', res.status, body?.code);
  return body as PickemState;
}
