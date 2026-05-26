import { pool } from '../db/connection';

async function getRoomWithMessages(roomId: string) {
  const { rows: roomRows } = await pool.query(
    `SELECT id, name, icon, description, is_live AS "isLive", is_pinned AS "isPinned",
            member_count AS "memberCount", created_at AS "createdAt"
     FROM chat_rooms WHERE id = $1`,
    [roomId]
  );
  if (!roomRows[0]) throw Object.assign(new Error('Room not found'), { status: 404 });

  const messages = await getMessages(roomId);
  const last = messages[messages.length - 1];

  return {
    ...roomRows[0],
    lastMessage:   last?.text ?? null,
    lastMessageAt: last?.sentAt ?? null,
    unread:        0,
    messages,
  };
}

async function getMessages(roomId: string) {
  const { rows } = await pool.query(
    `SELECT m.id, m.user_id AS "userId", m.username, m.display_name AS "displayName",
            m.avatar, m.tier, m.text, m.sent_at AS "sentAt", m.tag,
            m.reply_to_username AS "replyToUsername", m.reply_to_text AS "replyToText"
     FROM chat_messages m
     WHERE m.room_id = $1
     ORDER BY m.sent_at ASC
     LIMIT 100`,
    [roomId]
  );

  const messages = await Promise.all(rows.map(async row => {
    const { rows: reactions } = await pool.query(
      `SELECT emoji, count FROM chat_reactions WHERE message_id = $1`,
      [row.id]
    );
    return {
      id:          row.id,
      userId:      row.userId,
      username:    row.username,
      displayName: row.displayName,
      avatar:      row.avatar,
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
  async getRooms() {
    const { rows } = await pool.query(
      `SELECT id, name, icon, description, is_live AS "isLive",
              is_pinned AS "isPinned", member_count AS "memberCount"
       FROM chat_rooms
       ORDER BY is_pinned DESC, name ASC`
    );

    const rooms = await Promise.all(rows.map(async room => {
      const { rows: lastMsg } = await pool.query(
        `SELECT text, sent_at FROM chat_messages
         WHERE room_id = $1 ORDER BY sent_at DESC LIMIT 1`,
        [room.id]
      );
      return {
        ...room,
        lastMessage:   lastMsg[0]?.text      ?? null,
        lastMessageAt: lastMsg[0]?.sent_at   ?? null,
        unread:        0,
        messages:      [],
      };
    }));

    return rooms;
  },

  getRoomMessages: (roomId: string) => getMessages(roomId),

  async sendMessage(roomId: string, payload: {
    userId?: string;
    username: string;
    displayName: string;
    avatar: string;
    tier: string;
    text: string;
    tag?: string;
    replyTo?: { username: string; text: string };
  }) {
    const id = `msg_${Date.now()}`;
    await pool.query(
      `INSERT INTO chat_messages
        (id, room_id, user_id, username, display_name, avatar, tier, text, tag, reply_to_username, reply_to_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, roomId, payload.userId ?? null, payload.username, payload.displayName,
       payload.avatar, payload.tier, payload.text, payload.tag ?? null,
       payload.replyTo?.username ?? null, payload.replyTo?.text ?? null]
    );

    const { rows } = await pool.query(
      `SELECT * FROM chat_messages WHERE id = $1`, [id]
    );
    const m = rows[0];
    return {
      id:          m.id,
      userId:      m.user_id,
      username:    m.username,
      displayName: m.display_name,
      avatar:      m.avatar,
      tier:        m.tier,
      text:        m.text,
      sentAt:      m.sent_at,
      tag:         m.tag,
      reactions:   [],
      replyTo:     m.reply_to_username
        ? { username: m.reply_to_username, text: m.reply_to_text }
        : undefined,
    };
  },

  async createRoom(payload: { name: string; icon: string; description: string }) {
    const id = `room_${Date.now()}`;
    await pool.query(
      `INSERT INTO chat_rooms (id, name, icon, description) VALUES ($1,$2,$3,$4)`,
      [id, payload.name, payload.icon, payload.description]
    );
    return getRoomWithMessages(id);
  },

  async toggleReaction(messageId: string, emoji: string) {
    await pool.query(
      `INSERT INTO chat_reactions (message_id, emoji, count)
       VALUES ($1,$2,1)
       ON CONFLICT (message_id, emoji)
       DO UPDATE SET count = chat_reactions.count + 1`,
      [messageId, emoji]
    );
  },
};
