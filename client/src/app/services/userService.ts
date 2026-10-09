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
  PlayerSummary,
  PublicSlip,
  BlockedUser,
  ModerationQueueItem,
  ReportReason,
} from '../types/user';

import { authedFetch } from './authService';
import { tokenStore, onSessionCleared } from './tokenStore';

// ---- HTTP helpers (authenticated) ------------------------------------------

/** Transforme une réponse non-OK en `Error` portant le message du serveur. */
async function throwIfNotOk(res: Response): Promise<void> {
  if (res.ok) return;
  const err = await res.json().catch(() => ({ error: res.statusText }));
  throw new Error((err as { error?: string }).error ?? `API ${res.status}`);
}

async function get<T>(path: string): Promise<T> {
  const res = await authedFetch(path);
  await throwIfNotOk(res);
  return res.json() as Promise<T>;
}

/**
 * Erreur d'API qui conserve le code HTTP.
 *
 * Le `get` ci-dessus aplatit tout en `Error(message)`, ce qui suffit tant qu'un
 * échec ne veut dire qu'une chose. La page joueur, elle, doit distinguer trois
 * refus qui n'appellent pas la même réaction : 402 « il faut être Pro »,
 * 403 « ce joueur masque ses coupons », 404 « ce joueur n'existe pas ». Les
 * différencier sur le texte du message serait fragile et intraduisible.
 */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Lecture PARTAGÉE : les appels identiques lancés à moins de `SHARED_GET_TTL_MS`
 * d'écart n'en font qu'un.
 *
 * Mesuré le 2026-09-16 : `/users/me` partait deux fois sur `/league` et
 * `/profile` (AuthContext + la page), `/chat/rooms` deux fois sur `/league`
 * (badge de non-lus de LeaguePage + ChatTab). Tous `no-store`, donc tous en base.
 *
 * - On partage le TEXTE de la réponse et chaque appelant fait son propre
 *   `JSON.parse` : personne ne reçoit un objet qu'un autre écran pourrait muter.
 * - La clé contient le jeton : un changement de compte ne relit jamais le
 *   profil du précédent. `onSessionCleared` vide tout en plus.
 * - Toute écriture de ce service (POST/PATCH/DELETE) vide le cache : après
 *   « rejoindre un salon » ou « changer d'avatar », la relecture est fraîche.
 * - Un échec n'est pas gardé.
 *
 * Délai court exprès : il ne sert qu'à fusionner les lectures d'un même
 * chargement d'écran, pas à servir des données datées.
 */
const SHARED_GET_TTL_MS = 3_000;
const sharedGets = new Map<string, { at: number; text: Promise<string> }>();
function invalidateSharedGets(): void { sharedGets.clear(); }
onSessionCleared(invalidateSharedGets);

async function getShared<T>(path: string): Promise<T> {
  const token = await tokenStore.getAccess();
  const key = `${token ?? ''}|${path}`;
  const hit = sharedGets.get(key);
  if (hit && Date.now() - hit.at < SHARED_GET_TTL_MS) return JSON.parse(await hit.text) as T;

  const entry = {
    at: Date.now(),
    text: (async () => {
      const res = await authedFetch(path);
      await throwIfNotOk(res);
      return res.text();
    })(),
  };
  entry.text.catch(() => { if (sharedGets.get(key) === entry) sharedGets.delete(key); });
  sharedGets.set(key, entry);
  return JSON.parse(await entry.text) as T;
}

async function getOrThrow<T>(path: string): Promise<T> {
  const res = await authedFetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string; code?: string };
    throw new ApiError(body.error ?? `API ${res.status}`, res.status, body.code);
  }
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  invalidateSharedGets();
  const res = await authedFetch(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  await throwIfNotOk(res);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** DELETE authentifié. */
async function del(path: string): Promise<void> {
  invalidateSharedGets();
  const res = await authedFetch(path, { method: 'DELETE' });
  await throwIfNotOk(res);
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  invalidateSharedGets();
  const res = await authedFetch(path, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  await throwIfNotOk(res);
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

/** Méthode de reconfirmation exigée avant la suppression du compte. */
export type ReauthMethod = 'password' | 'code';

/**
 * Suppression de compte, en deux temps (voir `server/src/routes/user.routes.ts`).
 * Les échecs sont des `ApiError` : l'écran distingue « mauvais mot de passe »
 * (403 REAUTH_FAILED), « mauvais code » (400) et « Stripe indisponible » (502)
 * par le code, pas par le texte anglais du serveur.
 */
async function sendOrThrow<T>(path: string, init: RequestInit): Promise<T> {
  invalidateSharedGets();
  const res = await authedFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string; code?: string };
    throw new ApiError(body.error ?? `API ${res.status}`, res.status, body.code);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const accountApiService = {
  /** Ouvre la suppression ; pour un compte Google, le code part par courriel. */
  startDeletion: (): Promise<{ method: ReauthMethod }> =>
    sendOrThrow('/users/me/deletion', { method: 'POST', body: '{}' }),

  /** Définitif. Le compte, ses coupons, ses messages et sa clé IA disparaissent. */
  deleteAccount: (proof: { password: string } | { code: string }): Promise<void> =>
    sendOrThrow('/users/me', { method: 'DELETE', body: JSON.stringify(proof) }),
};

export const profileApiService = {
  getProfile: (): Promise<UserProfile> =>
    getShared<UserProfile>('/users/me'),

  getBetHistory: (): Promise<BetRecord[]> =>
    get<BetRecord[]>('/users/me/bets'),

  getBettingStats: (): Promise<UserBettingStats> =>
    get<UserBettingStats>('/users/me/stats'),

  getLeaderboard: (): Promise<LeaderboardEntry[]> =>
    get<LeaderboardEntry[]>('/leaderboard'),

  searchUsers: (q: string): Promise<LeaderboardEntry[]> =>
    get<LeaderboardEntry[]>(`/users/search?q=${encodeURIComponent(q)}`),

  /** En-tête de la page joueur. Lève une ApiError 402/403/404. */
  getPlayerSummary: (userId: string): Promise<PlayerSummary> =>
    getOrThrow<PlayerSummary>(`/users/${userId}/summary`),

  /**
   * Coupons d'un joueur. Lève une ApiError 402/403/404.
   * Les coupons verrouillés reviennent avec `legs: null` — le serveur ne les
   * envoie pas tant que le match n'a pas commencé.
   */
  getPlayerSlips: (userId: string, limit = 25): Promise<PublicSlip[]> =>
    getOrThrow<PublicSlip[]>(`/users/${userId}/slips?limit=${limit}`),

  /**
   * `openaiApiKey` est en ÉCRITURE SEULE : il ne fait pas partie de
   * `UserProfile` (le serveur ne renvoie que `hasOpenaiKey`), mais il reste
   * acceptable en écriture — `null` efface la clé enregistrée.
   *
   * ⚠️ Ne l'envoie que si l'utilisateur a réellement saisi une nouvelle clé, ou
   * demandé son retrait. L'inclure systématiquement dans un enregistrement de
   * profil effacerait la clé stockée à chaque changement de bio, puisque le
   * champ du formulaire est vide au chargement.
   */
  updateProfile: (
    updates: Partial<Pick<UserProfile, 'username' | 'displayName' | 'bio' | 'favoriteTeam' | 'isPublic' | 'showSlips' | 'notifyValueBets' | 'valueBetMinEvPct' | 'ruleWeights' | 'avatar' | 'avatarUrl'>>
      & { openaiApiKey?: string | null }
  ): Promise<UserProfile> =>
    patch<UserProfile>('/users/me', updates),

  uploadAvatar: async (file: File): Promise<string> => {
    // Always resize — never upload the original. Even a "small" phone photo is
    // 2-4 MB, and it would be stored in Postgres and re-sent on every chat and
    // leaderboard read. 256×256 WebP is ~20 kB and visually identical at the
    // sizes an avatar is actually displayed.
    const dataUrl = await resizeAvatar(file);
    invalidateSharedGets();

    const res = await authedFetch('/users/me/avatar', {
      method: 'POST',
      body: JSON.stringify({ avatarDataUrl: dataUrl }),
    });
    await throwIfNotOk(res);
    const { avatarUrl } = await res.json() as { avatarUrl: string };
    return avatarUrl;
  },

  // ---- Chat -----------------------------------------------
  getChatRooms: (): Promise<ChatRoom[]> =>
    getShared<ChatRoom[]>('/chat/rooms'),

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
    // `slipId` seulement : la carte du coupon est reconstruite par le serveur
    // depuis la base, filtrée sur le propriétaire. Envoyer son contenu d'ici ne
    // servirait qu'à permettre de le fabriquer.
    payload: { text: string; tag?: string; replyTo?: { username: string; text: string }; slipId?: string },
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
    invalidateSharedGets();
    const res = await authedFetch(`/chat/rooms/${roomId}/leave`, { method: 'POST', body: JSON.stringify({}) });
    await throwIfNotOk(res);
  },

  pinRoom: (roomId: string, pinned: boolean): Promise<ChatRoom> =>
    post<ChatRoom>(`/chat/rooms/${roomId}/pin`, { pinned }),

  getRoomMembers: (roomId: string): Promise<ChatRoomMember[]> =>
    get<ChatRoomMember[]>(`/chat/rooms/${roomId}/members`),

  kickMember: (roomId: string, userId: string): Promise<void> =>
    del(`/chat/rooms/${roomId}/members/${userId}`),

  setMemberRole: (roomId: string, userId: string, role: 'admin' | 'member'): Promise<unknown> =>
    post(`/chat/rooms/${roomId}/members/${userId}/role`, { role }),

  deleteRoom: (roomId: string): Promise<void> =>
    del(`/chat/rooms/${roomId}`),

  toggleReaction: (roomId: string, messageId: string, emoji: string): Promise<unknown> =>
    post(`/chat/rooms/${roomId}/messages/${messageId}/reactions`, { emoji }),

  deleteMessage: (roomId: string, messageId: string): Promise<void> =>
    del(`/chat/rooms/${roomId}/messages/${messageId}`),

  // ── Modération — PRE_IOS_PLAN.md R4 ───────────────────────────────────────

  /**
   * Signaler un message. Le chemin est imbriqué sous le salon (R4.2c) : le
   * serveur s'en sert pour vérifier que l'appelant peut LIRE ce salon avant de
   * toucher au message.
   *
   * `alreadyReported` n'est pas une erreur — signaler deux fois rend 201 aussi.
   * `hidden` dit si ce signalement est celui qui a fait basculer le masquage
   * automatique, ce qui permet de retirer le message de l'écran tout de suite.
   */
  reportMessage: (
    roomId: string,
    messageId: string,
    payload: { reason: ReportReason; note?: string },
  ): Promise<{ alreadyReported: boolean; hidden: boolean }> =>
    post(`/chat/rooms/${roomId}/messages/${messageId}/report`, payload),

  /** Les gens que J'AI bloqués. Jamais ceux qui m'ont bloqué (R4.2e). */
  getBlockedUsers: (): Promise<BlockedUser[]> =>
    get<BlockedUser[]>('/users/me/blocks'),

  /** Idempotent côté serveur : bloquer deux fois ne casse rien. */
  blockUser: (userId: string): Promise<void> =>
    post(`/users/${userId}/block`, {}),

  /** Idempotent et silencieux : débloquer ce qui ne l'est pas rend 204. */
  unblockUser: (userId: string): Promise<void> =>
    del(`/users/${userId}/block`),

  // ── File de modération, admin uniquement (R4.2h) ──────────────────────────

  getModerationQueue: (): Promise<{ reports: ModerationQueueItem[] }> =>
    get<{ reports: ModerationQueueItem[] }>('/dev/reports'),

  // ── Profit des Best Bets, admin uniquement (/dev/profit) ──────────────────

  /** Best bets journalisés d'une période (jours NHL inclus). Règle au passage ceux dont le match est fini. */
  getBestBetsProfit: (from: string, to: string): Promise<BestBetsProfitResponse> =>
    get<BestBetsProfitResponse>(`/dev/best-bets-profit?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),

  /**
   * Trancher. `actioned` masque le message, `dismissed` retire un masquage
   * AUTOMATIQUE (jamais celui qu'un admin a posé). La décision porte sur le
   * message : tous ses signalements ouverts sont tranchés ensemble.
   */
  reviewReport: (
    reportId: number,
    status: 'actioned' | 'dismissed',
  ): Promise<{ messageId: string; status: string; reportsUpdated: number; hidden: boolean }> =>
    post(`/dev/reports/${reportId}`, { status }),
};

// ---- /dev/profit -------------------------------------------------------------

/** Une ligne de `best_bet_log` (serveur : `bestBetLog.service.ts`). */
export interface BestBetLogRow {
  id:           number;
  betId:        string;
  gameId:       string;
  gameDate:     string;
  startTimeUTC: string | null;
  homeTeam:     string | null;
  awayTeam:     string | null;
  subjectType:  'game' | 'player';
  subjectName:  string;
  marketType:   string;
  marketLabel:  string;
  label:        string;
  line:         number | null;
  source:       string;
  firstSeenAt:  string;
  firstRank:    number;
  firstScore:   number;
  /** Cote décimale à la première apparition ; `null` = le livre ne cote pas ce pari. */
  firstPrice:   number | null;
  lastRank:     number;
  lastScore:    number;
  lastPrice:    number | null;
  bestRank:     number;
  bookTitle:    string | null;
  outcome:      'pending' | 'win' | 'loss' | 'void';
}

export interface BestBetsProfitResponse {
  from:   string;
  to:     string;
  settle: { checked: number; settled: number; error?: string };
  rows:   BestBetLogRow[];
  retrieved_at: string;
}
