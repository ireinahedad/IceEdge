/**
 * accountDeletion.service.ts
 * ------------------------------------------------------------------
 * Suppression de compte en libre-service — App Store Guideline 5.1.1(v) et
 * Loi 25 (droit à l'effacement).
 *
 * Immédiate et définitive. Il n'y a ni corbeille ni délai de grâce : ce que la
 * personne a demandé, c'est que ses données disparaissent, pas qu'elles soient
 * « désactivées ».
 *
 * Ce qui part, et comment :
 *   • abonnement Stripe → annulé chez Stripe, AVANT tout le reste (voir
 *     `cancelStripeForAccountDeletion`) ;
 *   • messages de chat → supprimés explicitement. La clé étrangère est
 *     `ON DELETE SET NULL` (le salon survit à son auteur), ce qui laisserait le
 *     texte, le pseudo et le nom affiché en place ;
 *   • tout le reste → `ON DELETE CASCADE` depuis `users` : profil (et la clé
 *     OpenAI qu'il porte), coupons, abonnement local, jetons de session, codes
 *     de courriel, abonnements push, compteurs IA, blocages, signalements
 *     déposés, appartenances aux salons ;
 *   • avatar sur R2 → supprimé après la validation, au mieux (un échec est
 *     journalisé, l'objet reste orphelin mais n'est plus relié à personne).
 *
 * Ce qui reste, volontairement : les salons que la personne a créés
 * (`created_by` passe à NULL — les autres membres y ont leurs messages) et les
 * décisions de modération qu'elle aurait rendues en tant qu'admin.
 */

import { pool } from '../db/connection';
import { logger } from '../logger';
import { cancelStripeForAccountDeletion } from './subscription.service';
import { deleteAvatarByUrl } from './avatarStorage';

export async function deleteAccount(userId: string): Promise<void> {
  // Lève (502) si Stripe refuse : rien n'a encore été effacé.
  await cancelStripeForAccountDeletion(userId);

  const client = await pool.connect();
  let avatarUrls: (string | null)[] = [];
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT u.avatar_url AS "userAvatar", up.avatar_url AS "profileAvatar"
         FROM users u
         LEFT JOIN user_profiles up ON up.user_id = u.id
        WHERE u.id = $1
        FOR UPDATE OF u`,
      [userId],
    );
    if (!rows[0]) throw Object.assign(new Error('User not found'), { status: 404 });
    avatarUrls = [rows[0].userAvatar, rows[0].profileAvatar];

    const chat = await client.query('DELETE FROM chat_messages WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM users WHERE id = $1', [userId]);

    await client.query('COMMIT');
    logger.info({ userId, chatMessages: chat.rowCount ?? 0 }, '[account] compte supprimé');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  for (const url of new Set(avatarUrls)) await deleteAvatarByUrl(userId, url);
}
