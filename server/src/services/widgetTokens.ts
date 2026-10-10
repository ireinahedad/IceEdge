// Jetons du widget iOS — APPLE_PLAN 4.2. Module à part (rien que la base) pour
// que `auth.routes` puisse les révoquer sans charger tout le moteur de
// prédiction. Le pourquoi du jeton : en-tête de la migration 044.

import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../db/connection';

/** Jetons gardés par utilisateur : un par appareil, quelques appareils au plus. */
const MAX_TOKENS_PER_USER = 5;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Nouveau jeton pour ce compte ; seul son hachage est stocké. */
export async function issueWidgetToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO widget_tokens (token_hash, user_id) VALUES ($1, $2)', [hash(token), userId]);
  // Les plus anciens au-delà du plafond : un iPhone réinstallé, un autre compte…
  await pool.query(
    `DELETE FROM widget_tokens WHERE user_id = $1 AND token_hash NOT IN (
       SELECT token_hash FROM widget_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2)`,
    [userId, MAX_TOKENS_PER_USER],
  );
  return token;
}

/** Retire UN jeton — seulement s'il appartient à `ownerId`. */
export async function revokeWidgetToken(token: string, ownerId: string): Promise<void> {
  await pool.query('DELETE FROM widget_tokens WHERE token_hash = $1 AND user_id = $2', [hash(token), ownerId]);
}

/** « Déconnecter tous les appareils » coupe aussi les widgets. */
export async function revokeAllWidgetTokens(userId: string): Promise<void> {
  await pool.query('DELETE FROM widget_tokens WHERE user_id = $1', [userId]);
}

/** Utilisateur derrière un jeton, ou null. Met à jour `last_used_at`. */
export async function userForWidgetToken(token: string): Promise<string | null> {
  if (!token || token.length > 100) return null;
  const { rows } = await pool.query(
    `UPDATE widget_tokens SET last_used_at = NOW() WHERE token_hash = $1 RETURNING user_id AS "userId"`,
    [hash(token)],
  );
  return rows[0]?.userId ? String(rows[0].userId) : null;
}

