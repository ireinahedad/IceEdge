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
 *   GET   /api/chat/rooms/:roomId/messages      -> { messages, avatars } (merged here into ChatMessage[])
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

// ---- Avatar resizing ---------------------------------------------------------

// An avatar is never displayed larger than a few dozen pixels. A 256×256 WebP
// weighs ~20 kB (~27 kB once base64-encoded) and covers 2× DPI screens.
//
// This is not just a bandwidth nicety: the data URI is stored as-is in Postgres
// (user_profiles.avatar_url) and echoed back in chat and leaderboard payloads.
// Every kilobyte accepted here is paid for in database storage AND in egress, on
// every single read. Resizing here is what keeps that cost flat.
const AVATAR_SIZE = 256; // px (square, center-cropped)

// Server rejects data URIs over 400_000 chars — this is only a safety net,
// the encoder below lands an order of magnitude below it.
const MAX_DATA_URL_LENGTH = 380_000;

// Beyond this the file is almost certainly not a photo a user meant to pick.
// Guards against decoding a huge image in the tab (the browser allocates
// width × height × 4 bytes regardless of the compressed size).
const MAX_INPUT_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Decodes a File into an <img>.
 *
 * Uses an object URL rather than FileReader: reading a 10 MB photo as a data
 * URI would first materialise a ~13 MB base64 string in memory, only to throw
 * it away after decoding.
 */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload  = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
    image.src = url;
  });
}

/**
 * Renders any image file into a square AVATAR_SIZE data URI.
 *
 * Center-crops to a square first (avoids the squashing a plain drawImage
 * stretch would produce on non-square sources), then encodes as WebP — falling
 * back to JPEG on browsers whose canvas doesn't support it. Quality is lowered
 * step by step in the unlikely event the result still exceeds the server limit.
 */
async function resizeAvatar(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Please choose an image file');
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error('Image is too large — please choose one under 20 MB');
  }

  const img = await loadImage(file);

  const side = Math.min(img.width, img.height);
  if (!side) throw new Error('Could not read image');
  const sx = Math.round((img.width  - side) / 2);
  const sy = Math.round((img.height - side) / 2);

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = AVATAR_SIZE;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not supported');
  // White background: neither JPEG nor a flattened WebP carries transparency.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
  ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);

  // toDataURL silently falls back to PNG when a format is unsupported, so the
  // prefix is what tells us whether WebP actually happened.
  const webpSupported = canvas.toDataURL('image/webp', 0.8).startsWith('data:image/webp');
  const mime = webpSupported ? 'image/webp' : 'image/jpeg';

  for (const quality of [0.8, 0.65, 0.5]) {
    const out = canvas.toDataURL(mime, quality);
    if (out.length <= MAX_DATA_URL_LENGTH) return out;
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
    updates: Partial<Pick<UserProfile, 'username' | 'displayName' | 'bio' | 'favoriteTeam' | 'isPublic' | 'showSlips' | 'notifyValueBets' | 'valueBetMinEvPct' | 'openaiApiKey' | 'ruleWeights' | 'avatar' | 'avatarUrl'>>
  ): Promise<UserProfile> =>
    patch<UserProfile>('/users/me', updates),

  uploadAvatar: async (file: File): Promise<string> => {
    // Always resize — never upload the original. Even a "small" phone photo is
    // 2-4 MB, and it would be stored in Postgres and re-sent on every chat and
    // leaderboard read. 256×256 WebP is ~20 kB and visually identical at the
    // sizes an avatar is actually displayed.
    const dataUrl = await resizeAvatar(file);

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

  /**
   * Room history.
   *
   * The server sends `{ messages, avatars }` rather than repeating `avatarUrl`
   * on all 100 messages — an avatar belongs to the author, not to the message,
   * and duplicating it made the response size grow with how chatty each person
   * is. We re-attach it here so callers keep receiving plain ChatMessage[] and
   * nothing downstream (hook, MessageBubble) has to change.
   */
  getRoomMessages: async (roomId: string): Promise<ChatMessage[]> => {
    const { messages, avatars } = await get<{
      messages: ChatMessage[];
      avatars: Record<string, string>;
    }>(`/chat/rooms/${roomId}/messages`);

    return messages.map((m) => ({
      ...m,
      avatarUrl: (m.userId && avatars[m.userId]) || null,
    }));
  },

  sendMessage: (
    roomId: string,
    payload: { text: string; tag?: string; replyTo?: { username: string; text: string } },
  ): Promise<ChatMessage> =>
    post<ChatMessage>(`/chat/rooms/${roomId}/messages`, payload),

  createRoom: (payload: { name: string; icon: string; description: string; isPrivate?: boolean; color?: string }): Promise<ChatRoom> =>
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

  deleteMessage: async (roomId: string, messageId: string): Promise<void> => {
    const res = await authedFetch(`/chat/rooms/${roomId}/messages/${messageId}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error?: string }).error ?? `API ${res.status}`);
    }
  },
};
