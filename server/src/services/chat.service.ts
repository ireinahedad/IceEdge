import crypto from 'crypto';
import { pool } from '../db/connection';
import { containsProhibited } from './moderation.service';

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

/**
 * Motifs de signalement — exactement la liste du CHECK de la migration 032.
 * Les deux doivent bouger ensemble : ajouter un motif ici sans migration donne
 * un 500 Postgres, l'inverse donne un motif que personne ne peut choisir.
 */
export const REPORT_REASONS = ['spam', 'harassment', 'hate', 'sexual', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/**
 * Les deux décisions qu'un admin peut rendre (R4.2h). `open` est l'état initial
 * et n'est pas une décision — on ne « remet pas en attente » un signalement
 * traité. Même contrainte que ci-dessus : cette liste et le CHECK de la
 * migration 032 bougent ensemble.
 */
export const REVIEW_DECISIONS = ['actioned', 'dismissed'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** Longueur maximale de la note libre jointe à un signalement. */
const MAX_NOTE_LENGTH = 500;

/**
 * Nombre de rapporteurs DISTINCTS qui masque un message sans revue humaine
 * (R4.2d). C'est la « réponse rapide » que demande la Guideline 1.2 : assez
 * bas pour agir avant qu'un humain ne lise la file, assez haut pour qu'une
 * seule personne ne puisse pas faire taire quelqu'un.
 *
 * Ça reste brigadable par trois comptes complices. C'est le prix assumé d'un
 * masquage automatique — d'où le fait qu'il soit réversible (hidden_at remis à
 * NULL) et que la file d'admin (R4.2h) doive être lue pour de vrai.
 */
const AUTO_HIDE_REPORTS = 3;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function httpError(message: string, status: number) {
  return Object.assign(new Error(message), { status });
}

/** Accepts #RGB or #RRGGBB, returns a normalized #RRGGBB or null. */
function sanitizeColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    return ('#' + v.slice(1).split('').map((c) => c + c).join('')).toLowerCase();
  }
  return null;
}

function generateJoinCode(): string {
  // 6 chars, unambiguous alphabet (no 0/O/1/I)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return code;
}

/** Retire les caractères de contrôle (garde tabulation et sauts de ligne). */
function stripControlChars(raw: unknown): string {
  return String(raw)
    .split('')
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c === 9 || c === 10 || c === 13 || c >= 32;
    })
    .join('')
    .trim();
}

function sanitizeText(raw: string): string {
  // Strip control characters (keep newlines/tabs), enforce length
  const cleaned = stripControlChars(raw);
  if (!cleaned) throw httpError('Message text is empty', 400);
  if (cleaned.length > MAX_TEXT_LENGTH) throw httpError(`Message too long (max ${MAX_TEXT_LENGTH} chars)`, 400);
  return cleaned;
}

/**
 * Note libre d'un signalement : optionnelle, tronquée, jamais rejetée.
 *
 * Contrairement au texte d'un message, une note vide n'est pas une erreur — le
 * motif seul suffit à signaler. Elle est tronquée plutôt que refusée : personne
 * ne doit renoncer à signaler parce qu'il a trop écrit.
 */
function sanitizeNote(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const cleaned = stripControlChars(raw).slice(0, MAX_NOTE_LENGTH);
  return cleaned || null;
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
    `SELECT id, name, icon, description, color, is_live AS "isLive", is_pinned AS "isPinned",
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

// ─── Vue « salon » ────────────────────────────────────────────────────────────

/**
 * Une SEULE requête pour tout ce qu'une carte de salon affiche.
 *
 * Avant, chaque salon coûtait trois allers-retours Neon (appartenance, nombre
 * de membres, dernier message) en plus de la requête de liste : ouvrir le chat
 * avec dix salons visibles = 31 requêtes, toutes lancées en parallèle par le
 * `Promise.all` — donc 31 connexions du pool mobilisées par visiteur, sur un
 * pool qui en compte une dizaine. À quelques centaines de personnes ouvrant le
 * chat en même temps, le pool sature et la latence explose alors que la charge
 * réelle est dérisoire.
 *
 * Ici :
 *  - l'appartenance vient du LEFT JOIN déjà présent dans la requête de liste ;
 *  - le nombre de membres est une sous-requête corrélée servie par la clé
 *    primaire (room_id, user_id) — parcours d'index seul, pas de scan ;
 *  - le dernier message vient d'un LEFT JOIN LATERAL … LIMIT 1, servi par
 *    idx_chat_messages_room_sent (migration 019).
 *
 * `$1` est l'id du spectateur, ou NULL pour un invité non connecté : la
 * jointure ne matche alors jamais, donc `isMember` est faux et le code d'accès
 * reste masqué. Le même SQL sert les deux cas, ce qui supprime la duplication
 * entre `viewRoom` et `viewRoomGuest` — et le risque qu'elles divergent sur ce
 * qu'elles exposent.
 */
const ROOM_VIEW_SELECT = `
  SELECT r.id, r.name, r.icon, r.description, r.color,
         r.is_live    AS "isLive",
         r.is_private AS "isPrivate",
         r.join_code  AS "joinCode",
         m.role,
         COALESCE(m.pinned, FALSE) AS pinned,
         (m.user_id IS NOT NULL)   AS "isMember",
         (SELECT COUNT(*)::int FROM chat_room_members cm WHERE cm.room_id = r.id) AS "memberCount",
         lm.text    AS "lastMessage",
         lm.sent_at AS "lastMessageAt"
    FROM chat_rooms r
    LEFT JOIN chat_room_members m
           ON m.room_id = r.id AND m.user_id = $1::uuid
    LEFT JOIN LATERAL (
      SELECT text, sent_at
        FROM chat_messages
       WHERE room_id = r.id
       ORDER BY sent_at DESC
       LIMIT 1
    ) lm ON TRUE
`;

/** Ligne plate → objet salon. Le code d'accès n'est jamais exposé à un non-membre. */
function serializeRoomView(row: any) {
  return {
    id:            row.id,
    name:          row.name,
    icon:          row.icon,
    description:   row.description,
    color:         row.color ?? null,
    isLive:        row.isLive,
    isPrivate:     row.isPrivate,
    joinCode:      row.isMember ? row.joinCode : null,
    memberCount:   row.memberCount,
    isMember:      row.isMember,
    role:          row.role ?? null,
    isPinned:      row.pinned,
    lastMessage:   row.lastMessage   ?? null,
    lastMessageAt: row.lastMessageAt ?? null,
    unread:        0,
    messages:      [],
  };
}

/**
 * @param userId  id du spectateur, ou null pour un invité.
 * @param where   clause SQL utilisant `r` / `m`. DOIT être une constante écrite
 *                dans ce module : elle est concaténée telle quelle. Toute valeur
 *                venant de l'appelant passe par `params` ($2, $3, …), jamais par
 *                cette chaîne.
 * @param params  valeurs de $2, $3, …
 */
async function roomViews(userId: string | null, where: string, params: unknown[] = []) {
  const { rows } = await pool.query(
    // Expression complète plutôt que l'alias `pinned` : pour un non-membre
    // `m.pinned` vaut NULL, et un tri DESC place les NULL en tête. Le COALESCE
    // reproduit exactement l'ordre d'origine (épinglés d'abord, puis A→Z).
    `${ROOM_VIEW_SELECT} WHERE ${where} ORDER BY COALESCE(m.pinned, FALSE) DESC, r.name ASC`,
    [userId, ...params],
  );
  return rows.map(serializeRoomView);
}

/** Vue d'un seul salon pour un spectateur donné (null = invité). */
async function viewRoom(roomId: string, userId: string | null) {
  const [view] = await roomViews(userId, 'r.id = $2', [roomId]);
  if (!view) throw httpError('Room not found', 404);
  return view;
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export interface RoomMessages {
  messages: Array<Record<string, unknown>>;
  /** userId → avatarUrl, pour les seuls auteurs qui ont un avatar. */
  avatars: Record<string, string>;
}

/**
 * Historique d'un salon : 100 messages + la table des avatars de leurs auteurs.
 *
 * `avatarUrl` est une propriété de l'AUTEUR, pas du message : la répéter sur
 * chacun des 100 messages multipliait la même valeur par le nombre de messages
 * envoyés par la personne. Tant que les avatars sont stockés en data-URI base64
 * (~27 ko pièce), dix participants bavards suffisaient à produire une réponse
 * JSON de plusieurs Mo — sérialisée synchrones sur l'event loop du process Node.
 *
 * Ici chaque avatar n'apparaît qu'une fois, dans `avatars`. Le client refusionne
 * (`avatarUrl: avatars[userId] ?? null`) : le contrat des composants ne change
 * pas. La déduplication reste utile après la migration vers R2 — elle rend la
 * taille de la réponse indépendante du contenu de `avatar_url`.
 *
 * ── R4.2f — le filtrage vit en SQL, pas en JS ───────────────────────────────
 *
 * Deux exclusions, en une seule requête :
 *
 * 1. `m.hidden_at IS NULL` — les messages masqués par trois rapporteurs
 *    (R4.2d) disparaissent pour TOUT LE MONDE, y compris leur auteur. Un
 *    masquage visible uniquement des autres est un bannissement fantôme : celui
 *    qui écrit croit être lu, et n'a aucune raison de se corriger.
 *
 * 2. L'anti-jointure sur `user_blocks` — un `LEFT JOIN` suivi de
 *    `b.blocker_id IS NULL` garde les messages pour lesquels AUCUNE ligne de
 *    blocage n'existe. La condition est symétrique : bloquer cache dans les deux
 *    sens, donc on cherche « je suis bloqueur OU bloqué ». C'est cette seconde
 *    moitié qui justifie `idx_user_blocks_blocked` (migration 032).
 *
 * `viewerId` vaut NULL pour un invité : `$2::uuid IS NOT NULL` court-circuite
 * alors la jointure entière, et il ne reste que le filtre des masqués. Le cast
 * explicite est obligatoire — sans lui Postgres ne sait pas typer un paramètre
 * qui n'apparaît que dans une comparaison à NULL.
 *
 * Filtrer en JS après coup aurait été plus court et faux : `LIMIT 100`
 * s'applique AVANT, donc bloquer un bavard aurait rendu des pages de moins en
 * moins remplies.
 *
 * ⚠️ Ce qui n'est PAS filtré ici : les messages envoyés en direct par le socket
 * (R4.2g). Le serveur diffuse à toute la salle et ne peut pas filtrer par
 * destinataire sans réécrire la diffusion ; c'est le client qui s'en charge
 * (R4.3d). L'historique et le direct n'ont donc pas la même garantie.
 *
 * ── Pourquoi une sous-requête et deux tris ─────────────────────────────────
 *
 * On veut les cent messages les plus RÉCENTS, affichés du plus ancien au plus
 * récent. `ORDER BY sent_at ASC LIMIT 100` faisait le contraire : il rendait les
 * cent PREMIERS messages du salon, donc un salon actif affichait son histoire
 * d'ouverture pour toujours et jamais la conversation en cours (corrigé le
 * 2026-09-03, le tri croissant seul datait d'avant R4).
 *
 * Le `LIMIT` doit donc s'appliquer à un tri DÉCROISSANT, et la remise en ordre
 * chronologique se fait ensuite, sur ces cent lignes-là. Faire les deux dans une
 * seule requête est impossible : un `ORDER BY` sert le `LIMIT`, pas l'affichage.
 *
 * `m.id DESC` en second critère n'est pas décoratif : `sent_at` peut être
 * identique à la milliseconde pour deux messages, et sans départage la centième
 * ligne varierait d'un appel à l'autre. Les identifiants sont
 * `msg_<horodatage>_<hexa>`, donc leur ordre lexicographique suit le temps.
 */
/** Au-delà, on coupe : l'instantané est STOCKÉ, il ne doit pas enfler. */
const ATTACHMENT_MAX_LEGS = 12;

/**
 * L'instantané d'un coupon, tel qu'il voyagera DANS le message.
 *
 * ⚠️⚠️ Il est construit ICI, depuis la base, et JAMAIS reçu du client — celui-ci
 * n'envoie qu'un `slipId` (voir `chatSendMessageSchema`). Accepter la carte
 * toute faite laisserait n'importe qui afficher « parlay 8 jambes, 96 % » dans
 * un salon sans avoir rien verrouillé.
 *
 * ⚠️ `WHERE user_id = $2` : on ne partage que SON PROPRE coupon. C'est aussi ce
 * qui rend ce chemin étranger à `show_slips` — le réglage de visibilité de la
 * page joueur n'est ni lu ni écrit ici. Partager un coupon dans une salle ne le
 * rend donc pas visible sur le profil, et masquer son profil n'empêche pas de
 * le partager. Les deux gestes sont indépendants, comme demandé.
 *
 * ⚠️ La requête est écrite ici plutôt qu'en appelant `slip.service.getSlip` :
 * ce module tirerait alors `settlement.service` et `nhlApiClient` derrière lui,
 * pour huit lignes de SQL. Si la RÈGLE DE PROPRIÉTÉ change là-bas, elle doit
 * changer ici aussi.
 *
 * FIGÉ volontairement : rien ne relit ce coupon plus tard. Un coupon partagé
 * « en attente » le reste dans le fil, même une fois réglé.
 */
async function buildSlipAttachment(slipId: string, userId: string) {
  const { rows } = await pool.query(
    `SELECT id, placed_at AS "placedAt", legs, leg_count AS "legCount",
            is_parlay AS "isParlay", combined_probability AS "combinedProbability",
            outcome
       FROM bet_slips
      WHERE id = $1 AND user_id = $2`,
    [slipId, userId],
  );
  const slip = rows[0];
  if (!slip) throw httpError('Slip not found', 404);

  const legs: any[] = Array.isArray(slip.legs) ? slip.legs : [];

  return {
    kind:                'slip' as const,
    slipId:              slip.id,
    placedAt:            slip.placedAt,
    legCount:            slip.legCount,
    isParlay:            slip.isParlay,
    combinedProbability: slip.combinedProbability,
    outcome:             slip.outcome,
    // Recopié champ par champ, borné, jamais étalé : une jambe porte aussi des
    // identifiants de match qui n'ont rien à faire dans un salon.
    legs: legs.slice(0, ATTACHMENT_MAX_LEGS).map((l) => ({
      subjectName:    String(l?.subjectName ?? '').slice(0, 80),
      selection:      String(l?.selection ?? l?.marketType ?? '').slice(0, 120),
      probability:    Number(l?.probability) || 0,
      // Servent uniquement à retrouver la couleur d'équipe à l'affichage.
      subjectId:      l?.subjectId      ? String(l.subjectId).slice(0, 20)      : undefined,
      selectionValue: l?.selectionValue ? String(l.selectionValue).slice(0, 20) : undefined,
    })),
  };
}

async function getMessages(roomId: string, viewerId: string | null): Promise<RoomMessages> {
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT m.id, m.user_id AS "userId", m.username, m.display_name AS "displayName",
              m.avatar, m.tier, m.text, m.sent_at AS "sentAt", m.tag, m.attachment,
              m.reply_to_username AS "replyToUsername", m.reply_to_text AS "replyToText",
              COALESCE(up.avatar_url, u.avatar_url) AS "avatarUrl"
         FROM chat_messages m
         LEFT JOIN users u          ON u.id = m.user_id
         LEFT JOIN user_profiles up ON up.user_id = m.user_id
         LEFT JOIN user_blocks b
                ON $2::uuid IS NOT NULL
               AND (   (b.blocker_id = $2::uuid AND b.blocked_id = m.user_id)
                    OR (b.blocked_id = $2::uuid AND b.blocker_id = m.user_id))
        WHERE m.room_id = $1
          AND m.hidden_at IS NULL
          AND b.blocker_id IS NULL
        ORDER BY m.sent_at DESC, m.id DESC
        LIMIT 100
     ) recent
     ORDER BY recent."sentAt" ASC, recent.id ASC`,
    [roomId, viewerId],
  );

  const reactionsByMessage = await fetchReactions(rows.map((r) => String(r.id)));

  const avatars: Record<string, string> = {};
  for (const row of rows) {
    if (row.userId && row.avatarUrl) avatars[String(row.userId)] = row.avatarUrl;
  }

  const messages = rows.map((row) => ({
    id:          row.id,
    userId:      row.userId,
    username:    row.username,
    displayName: row.displayName,
    avatar:      row.avatar,
    tier:        row.tier,
    text:        row.text,
    sentAt:      row.sentAt,
    tag:         row.tag,
    attachment:  row.attachment ?? undefined,
    replyTo:     row.replyToUsername
      ? { username: row.replyToUsername, text: row.replyToText }
      : undefined,
    reactions:   reactionsByMessage.get(String(row.id)) ?? [],
  }));

  return { messages, avatars };
}

interface Reaction { emoji: string; count: number; reacted: boolean }

/**
 * Réactions de plusieurs messages en UNE requête.
 *
 * Remplace un `SELECT … WHERE message_id = $1` par message : ouvrir un salon
 * de 100 messages coûtait 100 allers-retours Postgres, tous émis en parallèle
 * — soit 100 connexions du pool mobilisées par visiteur.
 */
async function fetchReactions(messageIds: string[]): Promise<Map<string, Reaction[]>> {
  const byMessage = new Map<string, Reaction[]>();
  if (messageIds.length === 0) return byMessage;

  const { rows } = await pool.query(
    `SELECT message_id AS "messageId", emoji, count
       FROM chat_reactions
      WHERE message_id = ANY($1::text[])`,
    [messageIds],
  );

  for (const r of rows) {
    const key = String(r.messageId);
    const list = byMessage.get(key) ?? [];
    list.push({ emoji: r.emoji, count: parseInt(r.count, 10), reacted: false });
    byMessage.set(key, list);
  }
  return byMessage;
}

// ─── Public service ───────────────────────────────────────────────────────────

export const chatService = {
  /** All public rooms + private rooms the user belongs to. Pinned first. */
  async getRoomsForUser(userId: string) {
    return roomViews(userId, '(r.is_private = FALSE OR m.user_id IS NOT NULL)');
  },

  /** Public rooms only — read-only listing for signed-out guests. */
  async getPublicRooms() {
    return roomViews(null, 'r.is_private = FALSE');
  },

  /** Messages of a PUBLIC room, for signed-out guests. Private rooms are rejected. */
  async getPublicRoomMessages(roomId: string) {
    const room = await getRoomRow(roomId);
    if (room.isPrivate) throw httpError('Sign in to view this private room', 401);
    // Invité : aucune liste de blocage, mais les messages masqués restent masqués.
    return getMessages(roomId, null);
  },

  /** Look up a room by its join code (works for public and private). */
  async findRoomByCode(code: string, userId: string) {
    const normalized = String(code).trim().toUpperCase();
    if (!/^[A-Z0-9]{4,10}$/.test(normalized)) throw httpError('Invalid code format', 400);
    const [view] = await roomViews(userId, 'r.join_code = $2', [normalized]);
    if (!view) throw httpError('No room found for this code', 404);
    return view;
  },

  /** Join a room: by code (any room) or directly (public rooms only). */
  async joinRoom(userId: string, opts: { roomId?: string; code?: string }) {
    let room: any;
    if (opts.code) {
      const normalized = String(opts.code).trim().toUpperCase();
      const { rows } = await pool.query(
        `SELECT id, name, icon, description, color, is_live AS "isLive",
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
    return viewRoom(room.id, userId);
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
    return viewRoom(roomId, userId);
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
    return getMessages(roomId, userId);
  },

  /** Send a message. Identity comes from the DB, never the client. */
  async sendMessage(roomId: string, userId: string, payload: {
    text: string;
    tag?: string;
    replyTo?: { username: string; text: string };
    /** Coupon à joindre. Seul l'identifiant traverse : voir `buildSlipAttachment`. */
    slipId?: string;
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

    // R4.2b — Guideline 1.2 : le contenu objectionnable est refusé à l'insertion.
    //
    // 422 et un message clair, PAS de bannissement fantôme. Un message qui
    // disparaît sans explication est signalé comme un bug par celui qui l'a
    // écrit, et il recommence ; un refus visible se corrige tout seul.
    //
    // Le filtre tourne APRÈS sanitizeText et AVANT tout INSERT : rien
    // d'objectionnable ne touche la base, donc rien à masquer après coup.
    if (containsProhibited(text)) {
      throw httpError(
        'Your message was blocked because it contains language that is not allowed here. Please rephrase.',
        422,
      );
    }

    const tag  = payload.tag && ['pick', 'analysis', 'hot'].includes(payload.tag) ? payload.tag : null;
    const replyUsername = payload.replyTo?.username ? String(payload.replyTo.username).slice(0, 100) : null;
    const replyText     = payload.replyTo?.text ? String(payload.replyTo.text).slice(0, 300) : null;

    const sender = await getSenderIdentity(userId);

    // Après le filtre de modération, avant l'INSERT : un coupon introuvable ou
    // qui n'appartient pas à l'expéditeur fait échouer TOUT l'envoi (404), il ne
    // dépose pas un message amputé de sa carte.
    const attachment = payload.slipId
      ? await buildSlipAttachment(String(payload.slipId), userId)
      : null;

    const id = `msg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    await pool.query(
      `INSERT INTO chat_messages
        (id, room_id, user_id, username, display_name, avatar, tier, text, tag, reply_to_username, reply_to_text, attachment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, roomId, sender.id, sender.username, sender.displayName,
       sender.avatar, sender.tier, text, tag, replyUsername, replyText,
       attachment ? JSON.stringify(attachment) : null],
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
      attachment:  attachment ?? undefined,
      reactions:   [],
      replyTo:     replyUsername ? { username: replyUsername, text: replyText ?? '' } : undefined,
    };
  },

  /** Create a room — creator becomes admin; every room gets a join code. */
  async createRoom(userId: string, payload: {
    name: string; icon: string; description: string; isPrivate?: boolean; color?: string;
  }) {
    const name = String(payload.name).trim().slice(0, 100);
    if (!name) throw httpError('Room name is required', 400);
    const icon = String(payload.icon ?? '💬').slice(0, 20);
    const description = String(payload.description ?? '').trim().slice(0, 300);
    const isPrivate = !!payload.isPrivate;
    const color = sanitizeColor(payload.color);

    const id = `room_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

    // Retry join-code generation on the (rare) unique collision
    let created = false;
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      try {
        await pool.query(
          `INSERT INTO chat_rooms (id, name, icon, description, color, is_private, join_code, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, name, icon, description, color, isPrivate, generateJoinCode(), userId],
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

    return viewRoom(id, userId);
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

  /** Delete a message. A user may only delete their OWN messages. */
  async deleteMessage(roomId: string, messageId: string, userId: string) {
    const { rows } = await pool.query(
      'SELECT room_id, user_id FROM chat_messages WHERE id = $1',
      [messageId],
    );
    const msg = rows[0];
    if (!msg || msg.room_id !== roomId) throw httpError('Message not found in this room', 404);
    if (msg.user_id !== userId) throw httpError('You can only delete your own messages', 403);
    // Reactions cascade via ON DELETE CASCADE.
    await pool.query('DELETE FROM chat_messages WHERE id = $1', [messageId]);
  },

  /**
   * Signaler un message (R4.2c), et le masquer tout seul à trois rapporteurs
   * distincts (R4.2d).
   *
   * AUTORISATION — signaler exige de pouvoir LIRE le salon. Sans ce contrôle,
   * n'importe quel compte pourrait signaler un message d'un salon privé, donc
   * confirmer son existence, en devinant un identifiant (`msg_<horodatage>_<6
   * hexa>` n'est pas un secret). Le chemin est imbriqué sous /rooms/:roomId
   * pour cette raison : le salon autorise, le message est ensuite vérifié comme
   * lui appartenant — même garde que toggleReaction.
   *
   * SIGNALER DEUX FOIS N'EST PAS UNE ERREUR. `ON CONFLICT DO NOTHING` sur
   * `UNIQUE (message_id, reporter_id)` : la contrainte EST la limite, personne
   * ne peut gonfler le compteur de masquage tout seul. La réponse porte
   * `alreadyReported`, mais le statut reste 201 dans les deux cas — répondre
   * 409 apprendrait à un client hostile ce qu'il a déjà signalé sans rien
   * apporter à l'interface.
   */
  async reportMessage(
    roomId: string,
    messageId: string,
    reporterId: string,
    payload: { reason: string; note?: string },
  ): Promise<{ alreadyReported: boolean; hidden: boolean }> {
    await assertCanRead(roomId, reporterId);

    const { rows } = await pool.query(
      'SELECT room_id, user_id FROM chat_messages WHERE id = $1',
      [messageId],
    );
    const msg = rows[0];
    if (!msg || msg.room_id !== roomId) throw httpError('Message not found in this room', 404);
    if (msg.user_id === reporterId) throw httpError('You cannot report your own message', 400);

    const reason = String(payload?.reason ?? '');
    if (!(REPORT_REASONS as readonly string[]).includes(reason)) {
      throw httpError(`reason must be one of: ${REPORT_REASONS.join(', ')}`, 400);
    }
    const note = sanitizeNote(payload?.note);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const inserted = await client.query(
        `INSERT INTO chat_reports (message_id, reporter_id, reason, note)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (message_id, reporter_id) DO NOTHING
         RETURNING id`,
        [messageId, reporterId, reason, note],
      );
      const created = inserted.rows.length > 0;

      // Le masquage vit dans la MÊME transaction que l'insertion : le compteur
      // ne peut pas être lu avant que le signalement qui le fait basculer soit
      // acquis, et un rollback n'abandonne jamais un message masqué sans la
      // ligne qui explique pourquoi.
      //
      // `hidden_at IS NULL` n'est pas une optimisation : il verrouille la ligne
      // du message, donc deux troisièmes signalements simultanés ne s'écrasent
      // pas l'horodatage l'un l'autre — le second ne renvoie rien et rend
      // `hidden: false`, ce qui est exact : il n'a pas masqué.
      //
      // COUNT(DISTINCT reporter_id) alors que UNIQUE (message_id, reporter_id)
      // rend le DISTINCT redondant : la requête énonce la règle qu'elle
      // applique, et survit au jour où la contrainte bougera.
      let hidden = false;
      if (created) {
        const hide = await client.query(
          `UPDATE chat_messages
              SET hidden_at = NOW(), hidden_reason = 'auto'
            WHERE id = $1
              AND hidden_at IS NULL
              AND (SELECT COUNT(DISTINCT reporter_id)
                     FROM chat_reports WHERE message_id = $1) >= $2
          RETURNING id`,
          [messageId, AUTO_HIDE_REPORTS],
        );
        hidden = hide.rows.length > 0;
      }

      await client.query('COMMIT');
      return { alreadyReported: !created, hidden };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * La file de modération (R4.2h) — les signalements ouverts, GROUPÉS PAR
   * MESSAGE, pas un par ligne.
   *
   * Trois personnes qui signalent le même message posent une seule question à
   * l'admin, pas trois. Une file ligne à ligne ferait relire le même texte trois
   * fois et rendrait la décision incohérente si on n'en traitait que deux.
   *
   * `reportId` est le plus petit identifiant du groupe : c'est celui qu'on
   * renvoie à `reviewReport()`, qui applique la décision à TOUS les
   * signalements ouverts du message.
   *
   * Réservé aux admins par la route (`dev.routes.ts` est déjà
   * `authenticate` + `requireRole('admin')` sur tout le routeur), donc rien
   * n'est masqué ici : le texte signalé est exactement ce qu'il y a à juger.
   */
  async getOpenReports(limit = 100) {
    const { rows } = await pool.query(
      `SELECT MIN(r.id)::int                        AS "reportId",
              r.message_id                          AS "messageId",
              COUNT(*)::int                         AS "reportCount",
              ARRAY_AGG(DISTINCT r.reason)          AS reasons,
              ARRAY_REMOVE(ARRAY_AGG(r.note), NULL) AS notes,
              MIN(r.created_at)                     AS "firstReportedAt",
              MAX(r.created_at)                     AS "lastReportedAt",
              m.room_id                             AS "roomId",
              rm.name                               AS "roomName",
              m.text,
              m.sent_at                             AS "sentAt",
              m.user_id                             AS "authorId",
              m.username                            AS "authorUsername",
              m.hidden_at                           AS "hiddenAt",
              m.hidden_reason                       AS "hiddenReason"
         FROM chat_reports r
         JOIN chat_messages m       ON m.id  = r.message_id
         LEFT JOIN chat_rooms rm    ON rm.id = m.room_id
        WHERE r.status = 'open'
        GROUP BY r.message_id, m.room_id, rm.name, m.text, m.sent_at,
                 m.user_id, m.username, m.hidden_at, m.hidden_reason
        ORDER BY MAX(r.created_at) DESC
        LIMIT $1`,
      [Math.min(Math.max(Number(limit) || 100, 1), 500)],
    );
    return rows;
  },

  /**
   * Trancher (R4.2h). L'admin agit sur un MESSAGE, pas sur une ligne : la
   * décision est appliquée à tous les signalements encore ouverts de ce message,
   * dans une transaction. Sinon un message signalé trois fois ressortirait deux
   * fois dans la file après un premier traitement.
   *
   * `actioned` masque le message avec `hidden_reason = 'admin'`, y compris s'il
   * était déjà masqué en `'auto'` : la décision humaine remplace la décision
   * automatique, et c'est ce qui distingue ensuite les deux au démasquage.
   *
   * `dismissed` RETIRE le masquage — mais seulement si sa raison est `'auto'`.
   * C'est la sortie de secours du seuil à trois : trois comptes complices font
   * masquer un message innocent, un admin le rétablit d'un geste. Un masquage
   * posé par un admin n'est jamais annulé par le rejet d'un signalement
   * ultérieur — cette décision-là se révoque à la main, pas par effet de bord.
   *
   * Rien n'est supprimé : le CASCADE de la migration 032 fait disparaître les
   * signalements avec le message, donc supprimer ici effacerait la trace de ce
   * qui a été modéré.
   */
  async reviewReport(reportId: number, adminId: string, decision: string) {
    if (!Number.isInteger(reportId) || reportId < 1) {
      throw httpError('Invalid report id', 400);
    }
    if (!(REVIEW_DECISIONS as readonly string[]).includes(decision)) {
      throw httpError(`status must be one of: ${REVIEW_DECISIONS.join(', ')}`, 400);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: found } = await client.query(
        'SELECT message_id FROM chat_reports WHERE id = $1',
        [reportId],
      );
      if (!found[0]) throw httpError('Report not found', 404);
      const messageId: string = found[0].message_id;

      const updated = await client.query(
        `UPDATE chat_reports
            SET status = $2, reviewed_by = $3, reviewed_at = NOW()
          WHERE message_id = $1 AND status = 'open'
        RETURNING id`,
        [messageId, decision, adminId],
      );

      let hidden: boolean;
      if (decision === 'actioned') {
        await client.query(
          `UPDATE chat_messages
              SET hidden_at = COALESCE(hidden_at, NOW()), hidden_reason = 'admin'
            WHERE id = $1`,
          [messageId],
        );
        hidden = true;
      } else {
        await client.query(
          `UPDATE chat_messages
              SET hidden_at = NULL, hidden_reason = NULL
            WHERE id = $1 AND hidden_reason = 'auto'`,
          [messageId],
        );
        const { rows: after } = await client.query(
          'SELECT hidden_at FROM chat_messages WHERE id = $1',
          [messageId],
        );
        hidden = after[0]?.hidden_at != null;
      }

      await client.query('COMMIT');
      return { messageId, status: decision, reportsUpdated: updated.rows.length, hidden };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },

  /** Used by the socket layer to authorise joining a room channel. */
  async canRead(roomId: string, userId: string): Promise<boolean> {
    try { await assertCanRead(roomId, userId); return true; }
    catch { return false; }
  },

  /**
   * Le pendant invité de `canRead`, pour le socket.
   *
   * Même règle que `getPublicRoomMessages` : un salon public est lisible sans
   * compte, un salon privé ne l'est jamais. Les deux doivent rester d'accord —
   * si l'un s'ouvrait sans l'autre, un invité verrait soit un historique qui ne
   * bouge pas, soit des messages en direct dont il ne peut pas lire l'histoire.
   *
   * `false` en cas d'erreur (salon introuvable, base indisponible) : le refus
   * est le défaut sûr, et le socket répond `room_error` comme pour tout autre
   * refus.
   */
  async isPublicRoom(roomId: string): Promise<boolean> {
    try { const room = await getRoomRow(roomId); return !room.isPrivate; }
    catch { return false; }
  },
};
