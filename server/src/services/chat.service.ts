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
  // Strip control characters (keep newlines/tabs), enforce length
  const cleaned = String(raw)
    .split('')
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c === 9 || c === 10 || c === 13 || c >= 32;
    })
    .join('')
    .trim();
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

/** Serialise a room for a given viewer (hides join code from non-members). */
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

// ─── Messages ─────────────────────────────────────────────────────────────────

async function getMessages(roomId: string) {
  const { rows } = await pool.query(
    `SELECT m.id, m.user_id AS "userId", m.username, m.display_name AS "displayName",
            m.avatar, m.tier, m.text, m.sent_at AS "sentAt", m.tag,
            m.reply_to_username AS "replyToUsername", m.reply_to_text AS "replyToText",
            COALESCE(up.avatar_url, u.avatar_url) AS "avatarUrl"
     FROM chat_messages m
     LEFT JOIN users u          ON u.id = m.user_id
     LEFT JOIN user_profiles up ON up.user_id = m.user_id
     WHERE m.room_id = $1
     ORDER BY m.sent_at ASC
     LIMIT 100`,
    [roomId],
  );

  const messages = await Promise.all(rows.map(async row => {
    const { rows: reactions } = await pool.query(
      `SELECT emoji, count FROM chat_reactions WHERE message_id = $1`,
      [row.id],
    );
    return {
      id:          row.id,
      userId:      row.userId,
      username:    row.username,
      displayName: row.displayName,
      avatar:      row.avatar,
      avatarUrl:   row.avatarUrl ?? null,
      tier:        row.tier,
      text:        row.text,
      sentAt:      row.sentAt,
      tag:         row.tag,
      replyTo:     row.replyToUsername
        ? { username: row.replyToUsername, text: row.replyToText }
        : undefined,
      reactions: reactions.map(r => ({ emoji: r.emoji, count: parseInt(r.count), reacted: false })),
    };
  }));

  return messages;
}

// ─── Public service ───────────────────────────────────────────────────────────

export const chatService = {
  /** All public rooms + private rooms the user belongs to. Pinned first. */
  async getRoomsForUser(userId: string) {
    const { rows } = await pool.query(
      `SELECT r.id, r.name, r.icon, r.description, r.is_live AS "isLive",
              r.is_private AS "isPrivate", r.join_code AS "joinCode"
       FROM chat_rooms r
       LEFT JOIN chat_room_members m ON m.room_id = r.id AND m.user_id = $1
       WHERE r.is_private = FALSE OR m.user_id IS NOT NULL
       ORDER BY COALESCE(m.pinned, FALSE) DESC, r.name ASC`,
      [userId],
    );
    return Promise.all(rows.map(r => viewRoom(r, userId)));
  },

  /** Look up a room by its join code (works for public and private). */
  async findRoomByCode(code: string, userId: string) {
    const normalized = String(code).trim().toUpperCase();
    if (!/^[A-Z0-9]{4,10}$/.test(normalized)) throw httpError('Invalid code format', 400);
    const { rows } = await pool.query(
      `SELECT id, name, icon, description, is_live AS "isLive",
              is_private AS "isPrivate", join_code AS "joinCode"
       FROM chat_rooms WHERE join_code = $1`,
      [normalized],
    );
    if (!rows[0]) throw httpError('No room found for this code', 404);
    return viewRoom(rows[0], userId);
  },

  /** Join a room: by code (any room) or directly (public rooms only). */
  async joinRoom(userId: string, opts: { roomId?: string; code?: string }) {
    let room: any;
    if (opts.code) {
      const normalized = String(opts.code).trim().toUpperCase();
      const { rows } = await pool.query(
        `SELECT id, name, icon, description, is_live AS "isLive",
                is_private AS "isPrivate", join_code AS "joinCode"
         FROM chat_rooms WHERE join_code = $1`,
        [normalized],
      );
      if (!rows[0]) throw httpError('No room found for this code', 404);
      room = rows[0];
    } else if (opts.roomId) {
      room = await getRoomRow(opts.roomId);
      // Direct join (no code) is only allowed for public rooms
      if (room.isPrivate) throw httpError('This room is private — join with its code', 403);
    } else {
      throw httpError('roomId or code is required', 400);
    }

    await pool.query(
      `INSERT INTO chat_room_members (room_id, user_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT (room_id, user_id) DO NOTHING`,
      [room.id, userId],
    );
    return viewRoom(room, userId);
  },

  /** Leave a room. Promotes the oldest member if the last admin leaves. */
  async leaveRoom(roomId: string, userId: string) {
    const member = await getMembership(roomId, userId);
    if (!member) throw httpError('You are not a member of this room', 400);

    await pool.query(
      'DELETE FROM chat_room_members WHERE room_id = $1 AND user_id = $2',
      [roomId, userId],
    );

    // If no admin remains, promote the earliest-joined member
    const { rows: admins } = await pool.query(
      `SELECT 1 FROM chat_room_members WHERE room_id = $1 AND role = 'admin' LIMIT 1`, [roomId],
    );
    if (admins.length === 0) {
      await pool.query(
        `UPDATE chat_room_members SET role = 'admin'
         WHERE room_id = $1 AND user_id = (
           SELECT user_id FROM chat_room_members WHERE room_id = $1 ORDER BY joined_at ASC LIMIT 1
         )`,
        [roomId],
      );
      // Private room with nobody left → delete it (messages cascade)
      const remaining = await memberCount(roomId);
      const room = await getRoomRow(roomId);
      if (remaining === 0 && room.isPrivate) {
        await pool.query('DELETE FROM chat_rooms WHERE id = $1', [roomId]);
      }
    }
  },

  /** Pin/unpin a room for this user only. */
  async setPinned(roomId: string, userId: string, pinned: boolean) {
    const room = await getRoomRow(roomId);
    const member = await getMembership(roomId, userId);
    if (!member) {
      if (room.isPrivate) throw httpError('You are not a member of this private room', 403);
      await pool.query(
        `INSERT INTO chat_room_members (room_id, user_id, role) VALUES ($1, $2, 'member')
         ON CONFLICT (room_id, user_id) DO NOTHING`,
        [roomId, userId],
      );
    }
    await pool.query(
      'UPDATE chat_room_members SET pinned = $3 WHERE room_id = $1 AND user_id = $2',
      [roomId, userId, !!pinned],
    );
    return viewRoom(room, userId);
  },

  /** Members list — visible to room members only (private rooms). */
  async getMembers(roomId: string, userId: string) {
    const room = await getRoomRow(roomId);
    const me = await getMembership(roomId, userId);
    if (room.isPrivate && !me) throw httpError('You are not a member of this private room', 403);
    const { rows } = await pool.query(
      `SELECT m.user_id AS "userId", m.role, m.joined_at AS "joinedAt",
              u.username,
              COALESCE(up.display_name, u.username) AS "displayName",
              COALESCE(up.avatar, '👤') AS avatar,
              COALESCE(up.avatar_url, u.avatar_url) AS "avatarUrl"
       FROM chat_room_members m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN user_profiles up ON up.user_id = m.user_id
       WHERE m.room_id = $1
       ORDER BY m.role ASC, m.joined_at ASC`,
      [roomId],
    );
    return rows;
  },

  /** Admin: kick a member (cannot kick yourself — use leave). */
  async kickMember(roomId: string, adminId: string, targetUserId: string) {
    await assertAdmin(roomId, adminId);
    if (adminId === targetUserId) throw httpError('Use leave to exit the room yourself', 400);
    const { rowCount } = await pool.query(
      'DELETE FROM chat_room_members WHERE room_id = $1 AND user_id = $2',
      [roomId, targetUserId],
    );
    if (!rowCount) throw httpError('User is not a member of this room', 404);
  },

  /** Admin: promote/demote a member. */
  async setRole(roomId: string, adminId: string, targetUserId: string, role: 'admin' | 'member') {
    await assertAdmin(roomId, adminId);
    if (!['admin', 'member'].includes(role)) throw httpError('Invalid role', 400);
    if (adminId === targetUserId && role === 'member') {
      // Demoting yourself: only if another admin remains
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM chat_room_members WHERE room_id = $1 AND role = 'admin'`, [roomId],
      );
      if (rows[0].n <= 1) throw httpError('You are the last admin — promote someone first', 400);
    }
    const { rowCount } = await pool.query(
      'UPDATE chat_room_members SET role = $3 WHERE room_id = $1 AND user_id = $2',
      [roomId, targetUserId, role],
    );
    if (!rowCount) throw httpError('User is not a member of this room', 404);
  },

  /** Admin: delete the room entirely. */
  async deleteRoom(roomId: string, adminId: string) {
    await assertAdmin(roomId, adminId);
    await pool.query('DELETE FROM chat_rooms WHERE id = $1', [roomId]);
  },

  /** Messages — private rooms require membership. */
  async getRoomMessages(roomId: string, userId: string) {
    await assertCanRead(roomId, userId);
    return getMessages(roomId);
  },

  /** Send a message. Identity comes from the DB, never the client. */
  async sendMessage(roomId: string, userId: string, payload: {
    text: string;
    tag?: string;
    replyTo?: { username: string; text: string };
  }) {
    const room = await getRoomRow(roomId);
    const member = await getMembership(roomId, userId);
    if (!member) {
      if (room.isPrivate) throw httpError('You are not a member of this private room', 403);
      // Posting in a public room auto-joins it
      await pool.query(
        `INSERT INTO chat_room_members (room_id, user_id, role) VALUES ($1, $2, 'member')
         ON CONFLICT (room_id, user_id) DO NOTHING`,
        [roomId, userId],
      );
    }

    const text = sanitizeText(payload.text);
    const tag  = payload.tag && ['pick', 'analysis', 'hot'].includes(payload.tag) ? payload.tag : null;
    const replyUsername = payload.replyTo?.username ? String(payload.replyTo.username).slice(0, 100) : null;
    const replyText     = payload.replyTo?.text ? String(payload.replyTo.text).slice(0, 300) : null;

    const sender = await getSenderIdentity(userId);

    const id = `msg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    await pool.query(
      `INSERT INTO chat_messages
        (id, room_id, user_id, username, display_name, avatar, tier, text, tag, reply_to_username, reply_to_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, roomId, sender.id, sender.username, sender.displayName,
       sender.avatar, sender.tier, text, tag, replyUsername, replyText],
    );

    return {
      id,
      userId:      sender.id,
      username:    sender.username,
      displayName: sender.displayName,
      avatar:      sender.avatar,
      avatarUrl:   sender.avatarUrl ?? null,
      tier:        sender.tier,
      text,
      sentAt:      new Date().toISOString(),
      tag:         tag ?? undefined,
      reactions:   [],
      replyTo:     replyUsername ? { username: replyUsername, text: replyText ?? '' } : undefined,
    };
  },

  /** Create a room — creator becomes admin; every room gets a join code. */
  async createRoom(userId: string, payload: {
    name: string; icon: string; description: string; isPrivate?: boolean;
  }) {
    const name = String(payload.name).trim().slice(0, 100);
    if (!name) throw httpError('Room name is required', 400);
    const icon = String(payload.icon ?? '💬').slice(0, 20);
    const description = String(payload.description ?? '').trim().slice(0, 300);
    const isPrivate = !!payload.isPrivate;

    const id = `room_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

    // Retry join-code generation on the (rare) unique collision
    let created = false;
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      try {
        await pool.query(
          `INSERT INTO chat_rooms (id, name, icon, description, is_private, join_code, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, name, icon, description, isPrivate, generateJoinCode(), userId],
        );
        created = true;
      } catch (e: any) {
        if (e.code !== '23505') throw e;
      }
    }
    if (!created) throw httpError('Could not generate a unique join code, try again', 500);

    await pool.query(
      `INSERT INTO chat_room_members (room_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [id, userId],
    );

    const room = await getRoomRow(id);
    return viewRoom(room, userId);
  },

  /** Reactions — same visibility rule as reading the room. */
  async toggleReaction(roomId: string, messageId: string, userId: string, emoji: string) {
    await assertCanRead(roomId, userId);
    // The message must belong to the room the user is authorised for —
    // prevents reacting to private-room messages via a public roomId.
    const { rows: msgRows } = await pool.query(
      'SELECT room_id FROM chat_messages WHERE id = $1', [messageId],
    );
    if (!msgRows[0] || msgRows[0].room_id !== roomId) {
      throw httpError('Message not found in this room', 404);
    }
    const cleanEmoji = String(emoji).slice(0, 8);
    await pool.query(
      `INSERT INTO chat_reactions (message_id, emoji, count)
       VALUES ($1,$2,1)
       ON CONFLICT (message_id, emoji)
       DO UPDATE SET count = chat_reactions.count + 1`,
      [messageId, cleanEmoji],
    );
  },

  /** Used by the socket layer to authorise joining a room channel. */
  async canRead(roomId: string, userId: string): Promise<boolean> {
    try { await assertCanRead(roomId, userId); return true; }
    catch { return false; }
  },
};
