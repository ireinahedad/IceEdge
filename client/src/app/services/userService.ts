/**
 * Profile / User API Service
 * All requests are authenticated via authedFetch (JWT Bearer + auto-refresh).
 *
 * Endpoints:
 *   GET   /api/users/me                         -> UserProfile
 *   GET   /api/users/me/bets                    -> BetRecord[]
 *   GET   /api/users/me/stats                   -> UserBettingStats
 *   PATCH /api/users/me                         -> UserProfile
 *   GET   /api/leaderboard                      -> LeaderboardEntry[]
 *   GET   /api/chat/rooms                       -> ChatRoom[]
 *   GET   /api/chat/rooms/:roomId/messages      -> ChatMessage[]
 *   POST  /api/chat/rooms/:roomId/messages      -> ChatMessage
 *   POST  /api/chat/rooms                       -> ChatRoom
 *   POST  /api/chat/rooms/:roomId/messages/:id/reactions
 */

import type {
  UserProfile,
  UserBettingStats,
  BetRecord,
  LeaderboardEntry,
  ChatRoom,
  ChatMessage,
} from '../types/user';

import { authedFetch } from './authService';

// ---- HTTP helpers (authenticated) ------------------------------------------

async function get<T>(path: string): Promise<T> {
  const res = await authedFetch(path);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? `API ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await authedFetch(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? `API ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await authedFetch(path, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? `API ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ---- Service ----------------------------------------------------------------

export const profileApiService = {
  getProfile: (): Promise<UserProfile> =>
    get<UserProfile>('/users/me'),

  getBetHistory: (): Promise<BetRecord[]> =>
    get<BetRecord[]>('/users/me/bets'),

  getBettingStats: (): Promise<UserBettingStats> =>
    get<UserBettingStats>('/users/me/stats'),

  getLeaderboard: (): Promise<LeaderboardEntry[]> =>
    get<LeaderboardEntry[]>('/leaderboard'),

  updateProfile: (
    updates: Partial<Pick<UserProfile, 'displayName' | 'bio' | 'favoriteTeam' | 'isPublic'>>
  ): Promise<UserProfile> =>
    patch<UserProfile>('/users/me', updates),

  // ---- Chat -----------------------------------------------------------------

  getChatRooms: (): Promise<ChatRoom[]> =>
    get<ChatRoom[]>('/chat/rooms'),

  getRoomMessages: (roomId: string): Promise<ChatMessage[]> =>
    get<ChatMessage[]>(`/chat/rooms/${roomId}/messages`),

  sendMessage: (
    roomId: string,
    payload: { text: string; tag?: 'pick' | 'analysis' | 'hot'; replyTo?: { username: string; text: string } }
  ): Promise<ChatMessage> =>
    post<ChatMessage>(`/chat/rooms/${roomId}/messages`, payload),

  createRoom: (payload: { name: string; icon: string; description: string }): Promise<ChatRoom> =>
    post<ChatRoom>('/chat/rooms', payload),

  toggleReaction: (roomId: string, messageId: string, emoji: string): Promise<void> =>
    post(`/chat/rooms/${roomId}/messages/${messageId}/reactions`, { emoji }),
};
