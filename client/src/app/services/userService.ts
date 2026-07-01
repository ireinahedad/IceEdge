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
    updates: Partial<Pick<UserProfile, 'displayName' | 'bio' | 'favoriteTeam' | 'isPublic' | 'openaiApiKey'>>
  ): Promise<UserProfile> =>
    patch<UserProfile>('/users/me', updates),

  uploadAvatar: async (file: File): Promise<string> => {
    // Convert file to base64 data URI
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const res = await authedFetch('/users/me/avatar', {
      method: 'POST',
      body: JSON.stringify({ avatarDataUrl: dataUrl }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error?: string }).error ?? `API ${res.status}`);
    }
    const { avatarUrl } = await res.json() as { avatarUrl: string };
    return avatarUrl;
  },

  // ---- Chat -----------------------------------------------
  getChatRooms: (): Promise<ChatRoom[]> =>
    get<ChatRoom[]>('/chat/rooms'),

  getChatMessages: (roomId: string): Promise<import('../types/user').ChatMessage[]> =>
    get<import('../types/user').ChatMessage[]>(`/chat/rooms/${roomId}/messages`),

  sendChatMessage: (roomId: string, text: string, replyTo?: { username: string; text: string }): Promise<import('../types/user').ChatMessage> =>
    post<import('../types/user').ChatMessage>(`/chat/rooms/${roomId}/messages`, { text, replyTo }),

  createRoom: (name: string, icon: string, description: string): Promise<ChatRoom> =>
    post<ChatRoom>('/chat/rooms', { name, icon, description }),

  addReaction: (roomId: string, messageId: string, emoji: string): Promise<void> =>
    post<void>(`/chat/rooms/${roomId}/messages/${messageId}/reactions`, { emoji }),
};
