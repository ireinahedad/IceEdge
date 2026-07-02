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
  ChatRoomMember,
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
  if (res.status === 204) return undefined as T;
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

// ---- Image compression -------------------------------------------------------

// Server limit is 2_800_000 chars — keep a safety margin
const MAX_DATA_URL_LENGTH = 2_500_000;
const MAX_DIMENSION = 1024; // px — plenty for an avatar

/**
 * Compresses an image data URL so it fits under MAX_DATA_URL_LENGTH.
 * Downscales to MAX_DIMENSION, then lowers JPEG quality step by step.
 * Keeps the image usable rather than rejecting it.
 */
async function compressImageDataUrl(dataUrl: string): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not read image'));
    image.src = dataUrl;
  });

  let maxDim = MAX_DIMENSION;

  // Try decreasing quality, then decreasing size if still too big
  for (let attempt = 0; attempt < 4; attempt++) {
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas not supported');
    // White background: JPEG has no transparency (PNG sources)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    for (const quality of [0.85, 0.7, 0.55, 0.4]) {
      const out = canvas.toDataURL('image/jpeg', quality);
      if (out.length <= MAX_DATA_URL_LENGTH) return out;
    }

    maxDim = Math.round(maxDim / 2); // still too big → halve dimensions and retry
  }

  throw new Error('Image could not be compressed enough — please choose a smaller one');
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

  searchUsers: (q: string): Promise<LeaderboardEntry[]> =>
    get<LeaderboardEntry[]>(`/users/search?q=${encodeURIComponent(q)}`),

  getUserSlips: (userId: string): Promise<unknown[]> =>
    get<unknown[]>(`/users/${userId}/slips`),

  updateProfile: (
    updates: Partial<Pick<UserProfile, 'username' | 'displayName' | 'bio' | 'favoriteTeam' | 'isPublic' | 'showSlips' | 'openaiApiKey' | 'avatar' | 'avatarUrl'>>
  ): Promise<UserProfile> =>
    patch<UserProfile>('/users/me', updates),

  uploadAvatar: async (file: File): Promise<string> => {
    // Convert file to base64 data URI
    let dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    // Server rejects data URLs > ~2.8M chars (~2 MB binary).
    // If too large, compress instead of failing: downscale + lower JPEG quality.
    if (dataUrl.length > MAX_DATA_URL_LENGTH) {
      dataUrl = await compressImageDataUrl(dataUrl);
    }

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

  getRoomMessages: (roomId: string): Promise<ChatMessage[]> =>
    get<ChatMessage[]>(`/chat/rooms/${roomId}/messages`),

  sendMessage: (
    roomId: string,
    payload: { text: string; tag?: string; replyTo?: { username: string; text: string } },
  ): Promise<ChatMessage> =>
    post<ChatMessage>(`/chat/rooms/${roomId}/messages`, payload),

  createRoom: (payload: { name: string; icon: string; description: string; isPrivate?: boolean }): Promise<ChatRoom> =>
    post<ChatRoom>('/chat/rooms', payload),

  lookupRoomByCode: (code: string): Promise<ChatRoom> =>
    get<ChatRoom>(`/chat/rooms/lookup?code=${encodeURIComponent(code)}`),

  joinRoomByCode: (code: string): Promise<ChatRoom> =>
    post<ChatRoom>('/chat/rooms/join', { code }),

  joinRoom: (roomId: string): Promise<ChatRoom> =>
    post<ChatRoom>(`/chat/rooms/${roomId}/join`, {}),

  leaveRoom: async (roomId: string): Promise<void> => {
    const res = await authedFetch(`/chat/rooms/${roomId}/leave`, { method: 'POST', body: JSON.stringify({}) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error?: string }).error ?? `API ${res.status}`);
    }
  },

  pinRoom: (roomId: string, pinned: boolean): Promise<ChatRoom> =>
    post<ChatRoom>(`/chat/rooms/${roomId}/pin`, { pinned }),

  getRoomMembers: (roomId: string): Promise<ChatRoomMember[]> =>
    get<ChatRoomMember[]>(`/chat/rooms/${roomId}/members`),

  kickMember: async (roomId: string, userId: string): Promise<void> => {
    const res = await authedFetch(`/chat/rooms/${roomId}/members/${userId}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error?: string }).error ?? `API ${res.status}`);
    }
  },

  setMemberRole: (roomId: string, userId: string, role: 'admin' | 'member'): Promise<unknown> =>
    post(`/chat/rooms/${roomId}/members/${userId}/role`, { role }),

  deleteRoom: async (roomId: string): Promise<void> => {
    const res = await authedFetch(`/chat/rooms/${roomId}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error?: string }).error ?? `API ${res.status}`);
    }
  },

  toggleReaction: (roomId: string, messageId: string, emoji: string): Promise<unknown> =>
    post(`/chat/rooms/${roomId}/messages/${messageId}/reactions`, { emoji }),
};
