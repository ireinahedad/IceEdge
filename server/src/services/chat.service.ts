import crypto from 'crypto';
import { pool } from '../db/connection';

/**
 * Chat service — public & private rooms with membership.
 *
 * Security model:
 * - Every route is authenticated (JWT). The sender's identity (username,
 *   display name, avatar, tier) is ALWAYS derived server-side from the
 *   database — never trusted from the client payload.
 * - Private rooms: messages are only readable/writable by members.
 * - Public rooms: readable by any authenticated user; posting auto-joins.
 * - Roles: 'admin' can delete the room and kick members. Room creator is
 *   the first admin. If the last admin leaves, the oldest member is promoted.
 */

const MAX_TEXT_LENGTH = 1000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function httpError(message: string, status: number) {
  return Object.assign(new Error(message), { status });
}

function generateJoinCode(): string {
  // 6 chars, unambiguous alphabet (no 0/O/1/I)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return code;
}

function sanitizeText(raw: string): string {
  // Strip control characters, collapse length
  const cleaned = String(raw).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (!cleaned) throw httpError('Message text is empty', 400);
  if (cleaned.length > MAX_TEXT_LENGTH) throw httpError(`Message too long (max ${MAX_TEXT_LENGTH} chars)`, 400);
  return cleaned;
}

/** Identity used for messages — always loaded from DB, never from the client. */
async function getSenderIdentity(userId: string) {
  const { rows } = await pool.query(
    `SELECT u.id, u.username,
            COALESCE(up.display_name, u.first_name, u.username) AS "displayName",
            COALESCE(up.avatar, '👤') AS avatar,
            COALESCE(up.avatar_url, u.avatar_url) AS "avatarUrl",
            COALESCE(up.tier, 'rookie') AS tier
     FROM users u
     LEFT JOIN user_profiles up ON up.user_id = u.id
     WHERE u.id = $1 AND u.is_active = TRUE`,
    [userId],
  );
  if (!rows[0]) throw httpError('User not found', 401);
  return rows[0];
}

async function getMembership(roomId: string, userId: string) {
  const { rows } = await pool.query(
    'SELECT role, pinned FROM chat_room_members WHERE room_id = $1 AND user_id = $2',
    [roomId, userId],
  );
  return rows[0] ?? null;
}

async function getRoomRow(roomId: string) {
  const { rows } = await pool.query(
    `SELECT id, name, icon, description, is_live AS "isLive", is_pinned AS "isPinned",
            is_private AS "isPrivate", join_code AS "joinCode", created_by AS "createdBy",
            created_at AS "createdAt"
     FROM chat_rooms WHERE id = $1`,
    [roomId],
  );
  if (!rows[0]) throw httpError('Room not found', 404);
  return rows[0];
}

/** Throws 403 unless the user may READ the room (member, or public room). */
async function assertCanRead(roomId: string, userId: string) {
  const room = await getRoomRow(roomId);
  if (!room.isPrivate) return room;
  const member = await getMembership(roomId, userId);
  if (!member) throw httpError('You are not a member of this private room', 403);
  return room;
}

/** Throws 403 unless the user is an admin of the room. */
async function assertAdmin(roomId: string, userId: string) {
  const member = await getMembership(roomId, userId);
  if (!member || member.role !== 'admin') throw httpError('Admin access required', 403);
}

async function memberCount(roomId: string): Promise<number> {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM chat_room_members WHERE room_id = $1', [roomId],
  );
  return rows[0].n;
}

/** Serialise a room for a given viewer (hides join code from non-members of private rooms). */
async function viewRoom(room: any, userId: string) {
  const member = await getMembership(room.id, userId);
  const count = await memberCount(room.id);
  const { rows: lastMsg } = await pool.query(
    `SELECT text, sent_at FROM chat_messages WHERE room_id = $1 ORDER BY sent_at DESC LIMIT 1`,
    [room.id],
  );
  return {
    id:            room.id,
    name:          room.name,
    icon:          room.icon,
    description:   room.description,
    isLive:        room.isLive,
    isPrivate:     room.isPrivate,
    // Join code is visible to members only
    joinCode:      member ? room.joinCode : null,
    memberCount:   count,
    isMember:      !!member,
    role:          member?.role ?? null,
    isPinned:      member?.pinned ?? false,
    lastMessage:   lastMsg[0]?.text    ?? null,
    lastMessageAt: lastMsg[0]?.sent_at ?? null,
    unread:        0,
    messages:      [],
  };
}

// ─── Messages ────────