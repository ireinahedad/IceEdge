import { pool } from '../db/connection';
// Hashing lives in auth.service so the cost factor has a single definition.
import { toPublicUser, hashPassword, verifyPassword } from './auth.service';
import {
  UserRow,
  UserPublic,
  UpdateUserBody,
  UpdatePasswordBody,
} from '../types/user.type';

// -------------------------------------------------------
//  Get all users (admin)
// -------------------------------------------------------

export async function getAllUsers(): Promise<UserPublic[]> {
  const { rows } = await pool.query<UserRow>(
    `SELECT * FROM users ORDER BY created_at DESC`,
  );
  return rows.map(toPublicUser);
}

// -------------------------------------------------------
//  Get single user by ID
// -------------------------------------------------------

export async function getUserById(id: string): Promise<UserPublic> {
  const { rows } = await pool.query<UserRow>(
    'SELECT * FROM users WHERE id = $1',
    [id],
  );

  if (!rows[0]) {
    throw Object.assign(new Error('User not found'), { status: 404 });
  }

  return toPublicUser(rows[0]);
}

// -------------------------------------------------------
//  Update user profile
// -------------------------------------------------------

export async function updateUser(id: string, body: UpdateUserBody): Promise<UserPublic> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (body.email !== undefined) {
    fields.push(`email = $${idx++}`);
    values.push(body.email.toLowerCase());
  }
  if (body.username !== undefined) {
    fields.push(`username = $${idx++}`);
    values.push(body.username.toLowerCase());
  }
  if (body.first_name !== undefined) {
    fields.push(`first_name = $${idx++}`);
    values.push(body.first_name);
  }
  if (body.last_name !== undefined) {
    fields.push(`last_name = $${idx++}`);
    values.push(body.last_name);
  }
  if (body.is_active !== undefined) {
    fields.push(`is_active = $${idx++}`);
    values.push(body.is_active);
  }

  if (fields.length === 0) {
    throw Object.assign(new Error('No fields to update'), { status: 400 });
  }

  values.push(id); // last param = WHERE id = $N

  const { rows } = await pool.query<UserRow>(
    `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values,
  );

  if (!rows[0]) {
    throw Object.assign(new Error('User not found'), { status: 404 });
  }

  return toPublicUser(rows[0]);
}

// -------------------------------------------------------
//  Update password
// -------------------------------------------------------

export async function updatePassword(id: string, body: UpdatePasswordBody): Promise<void> {
  const { rows } = await pool.query<UserRow>(
    'SELECT * FROM users WHERE id = $1',
    [id],
  );

  const user = rows[0];
  if (!user) {
    throw Object.assign(new Error('User not found'), { status: 404 });
  }

  const valid = await verifyPassword(body.current_password, user.password_hash);
  if (!valid) {
    throw Object.assign(new Error('Current password is incorrect'), { status: 400 });
  }

  const newHash = await hashPassword(body.new_password);

  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, id]);
}

// -------------------------------------------------------
//  Blocage entre utilisateurs (R4.2e)
// -------------------------------------------------------
//
// Le blocage est SYMÉTRIQUE : une seule ligne cache les messages dans les deux
// sens. C'est la migration 032 qui porte ce choix, et l'index sur `blocked_id`
// n'existe que pour la moitié « je suis le bloqué » de la lecture.
//
// Ces routes ne portent volontairement PAS `requireOwnerOrAdmin` : `:userId`
// est la CIBLE du blocage, pas le propriétaire de la ressource. Le middleware y
// signifierait « tu ne peux bloquer que toi-même », ce que le CHECK de la table
// interdit de toute façon. Le bloqueur est toujours l'appelant authentifié,
// jamais un identifiant venu du client.

/** Un identifiant non-UUID ferait échouer Postgres en 22P02, donc en 500. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BlockedUser {
  id: string;
  username: string;
  displayName: string;
  avatar: string;
  avatarUrl: string | null;
  createdAt: string;
}

/**
 * Bloquer quelqu'un. Idempotent : bloquer deux fois n'est pas une erreur, et la
 * date du premier blocage est conservée (`DO NOTHING`, pas `DO UPDATE`).
 */
export async function blockUser(blockerId: string, blockedId: string): Promise<void> {
  if (!UUID_RE.test(blockedId)) {
    throw Object.assign(new Error('User not found'), { status: 404 });
  }
  if (blockerId === blockedId) {
    throw Object.assign(new Error('You cannot block yourself'), { status: 400 });
  }

  const { rowCount } = await pool.query(
    'SELECT 1 FROM users WHERE id = $1 AND is_active = TRUE',
    [blockedId],
  );
  if (!rowCount) {
    throw Object.assign(new Error('User not found'), { status: 404 });
  }

  await pool.query(
    `INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)
     ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
    [blockerId, blockedId],
  );
}

/**
 * Débloquer. Idempotent aussi, et silencieux si rien n'était bloqué : Apple
 * vérifie qu'un blocage est réversible, pas qu'il proteste. Un 404 ici ne ferait
 * qu'obliger le client à distinguer deux états qui donnent le même résultat.
 */
export async function unblockUser(blockerId: string, blockedId: string): Promise<void> {
  if (!UUID_RE.test(blockedId)) return;
  await pool.query(
    'DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2',
    [blockerId, blockedId],
  );
}

/**
 * La liste que l'écran « Utilisateurs bloqués » affiche (R4.3e).
 *
 * Ne rend QUE les gens que l'appelant a bloqués — jamais ceux qui l'ont bloqué.
 * Le masquage est symétrique, mais la liste ne l'est pas : révéler « untel vous
 * a bloqué » est une information qu'aucun produit ne donne, et qui se retourne
 * immédiatement en harcèlement.
 */
export async function getBlockedUsers(blockerId: string): Promise<BlockedUser[]> {
  const { rows } = await pool.query(
    `SELECT u.id,
            u.username,
            COALESCE(up.display_name, u.first_name, u.username) AS "displayName",
            COALESCE(up.avatar, '👤')                           AS avatar,
            COALESCE(up.avatar_url, u.avatar_url)               AS "avatarUrl",
            b.created_at                                        AS "createdAt"
       FROM user_blocks b
       JOIN users u             ON u.id = b.blocked_id
       LEFT JOIN user_profiles up ON up.user_id = u.id
      WHERE b.blocker_id = $1
      ORDER BY b.created_at DESC`,
    [blockerId],
  );
  return rows as BlockedUser[];
}

// -------------------------------------------------------
//  Delete user
// -------------------------------------------------------

export async function deleteUser(id: string): Promise<void> {
  const { rowCount } = await pool.query(
    'DELETE FROM users WHERE id = $1',
    [id],
  );

  if (!rowCount) {
    throw Object.assign(new Error('User not found'), { status: 404 });
  }
}