/**
 * appleIap.service.ts — abonnement Pro acheté dans l'app iOS (StoreKit 2).
 * APPLE_PLAN Phase 5.
 *
 * Deux entrées, une seule écriture (`upsertFromApple`, donc les mêmes gardes
 * que Stripe) :
 *
 *  • `verifyClientTransaction` — l'app vient d'acheter ou de restaurer, et
 *    nous envoie la transaction signée par Apple. C'est ce qui rend le Pro
 *    actif tout de suite, sans attendre la notification.
 *  • `handleAppleNotification` — App Store Server Notifications V2 : renouvellements,
 *    expirations, annulations, remboursements, problèmes de facturation. C'est
 *    la seule façon de savoir qu'un abonnement a pris fin quand l'app n'est
 *    pas ouverte.
 *
 * Le lien transaction → compte est l'`appAccountToken` : l'app le pose à
 * l'achat, c'est notre `user_id` (un UUID, ce qu'Apple exige). Pour les
 * notifications sans ce jeton, on retombe sur `apple_original_transaction_id`.
 *
 * Variables d'environnement (toutes facultatives) :
 *   APPLE_BUNDLE_ID          défaut `com.arakice.arakice`
 *   APPLE_PRODUCT_IDS        défaut les deux produits ci-dessous, séparés par des virgules
 *   APPLE_IAP_ALLOW_SANDBOX  défaut `true`. TestFlight ET l'équipe de review
 *                            d'Apple achètent en Sandbox : le couper fait
 *                            échouer la review (Guideline 2.1).
 */

import { pool } from '../db/connection';
import { logger } from '../logger';
import { SubscriptionStatus } from '../types/subscription.type';
import { upsertFromApple } from './subscription.service';
import {
  AppleJwsError, AppleNotification, AppleRenewalInfo, AppleTransaction,
  entitlementFromApple, verifyAppleJws,
} from './appleJws';

export const DEFAULT_APPLE_PRODUCT_IDS = ['com.arakice.arakice.pro.monthly', 'com.arakice.arakice.pro.yearly'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function config() {
  return {
    bundleId: process.env.APPLE_BUNDLE_ID?.trim() || 'com.arakice.arakice',
    productIds: (process.env.APPLE_PRODUCT_IDS?.split(',').map((s) => s.trim()).filter(Boolean)) || DEFAULT_APPLE_PRODUCT_IDS,
    allowSandbox: process.env.APPLE_IAP_ALLOW_SANDBOX !== 'false',
  };
}

function reject(message: string, status = 400, code = 'APPLE_IAP_REJECTED'): never {
  throw Object.assign(new Error(message), { status, code });
}

/** Vérifie que la transaction est bien un de NOS abonnements, dans un environnement accepté. */
function checkTransaction(tx: AppleTransaction): void {
  const cfg = config();
  if (tx.bundleId !== cfg.bundleId) reject('Transaction d\'une autre application');
  if (!cfg.productIds.includes(tx.productId)) reject('Produit inconnu');
  if (tx.type !== 'Auto-Renewable Subscription') reject('Type de produit inattendu');
  if (tx.environment !== 'Production' && !(cfg.allowSandbox && tx.environment === 'Sandbox')) {
    reject('Environnement refusé');
  }
  if (!tx.originalTransactionId) reject('Transaction incomplète');
}

function decodeRenewal(jws: string | undefined | null, originalTransactionId: string): AppleRenewalInfo | null {
  if (!jws) return null;
  const renewal = verifyAppleJws<AppleRenewalInfo>(jws);
  // Une info de renouvellement d'un AUTRE abonnement ne doit rien décider ici.
  if (renewal.originalTransactionId !== originalTransactionId) return null;
  return renewal;
}

function isUniqueViolation(err: any): boolean {
  return err?.code === '23505';
}

/**
 * `POST /subscription/apple/verify` — l'app envoie la transaction qu'elle vient
 * d'acheter ou de restaurer (et son état de renouvellement, si elle l'a).
 */
export async function verifyClientTransaction(
  userId: string,
  transactionJws: string,
  renewalJws?: string | null,
): Promise<SubscriptionStatus> {
  const tx = verifyAppleJws<AppleTransaction>(transactionJws);
  checkTransaction(tx);

  // Achat fait depuis un autre compte ArakIce sur ce même identifiant Apple :
  // on ne le rattache pas à celui-ci.
  if (tx.appAccountToken && tx.appAccountToken.toLowerCase() !== userId.toLowerCase()) {
    reject('Cet abonnement Apple est rattaché à un autre compte ArakIce.', 409, 'APPLE_OTHER_ACCOUNT');
  }

  const renewal = decodeRenewal(renewalJws, tx.originalTransactionId);
  const ent = entitlementFromApple(tx, renewal);
  const signed = Math.max(tx.signedDate ?? 0, renewal?.signedDate ?? 0);

  try {
    return await upsertFromApple(userId, {
      ...ent,
      eventCreatedAt: signed ? new Date(signed) : null,
      originalTransactionId: tx.originalTransactionId,
      productId: tx.productId,
      environment: tx.environment,
    });
  } catch (err) {
    // Index unique (migration 045) : l'abonnement est déjà lié à un autre compte.
    if (isUniqueViolation(err)) {
      reject('Cet abonnement Apple est rattaché à un autre compte ArakIce.', 409, 'APPLE_OTHER_ACCOUNT');
    }
    throw err;
  }
}

async function resolveUserId(tx: AppleTransaction): Promise<string | null> {
  if (tx.appAccountToken && UUID_RE.test(tx.appAccountToken)) {
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [tx.appAccountToken.toLowerCase()]);
    if (rows[0]) return rows[0].id;
  }
  const { rows } = await pool.query<{ user_id: string }>(
    'SELECT user_id FROM subscriptions WHERE apple_original_transaction_id = $1',
    [tx.originalTransactionId],
  );
  return rows[0]?.user_id ?? null;
}

async function alreadyProcessed(uuid: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM apple_notifications WHERE notification_uuid = $1', [uuid]);
  return rows.length > 0;
}

/** Écrit APRÈS le traitement : un échec doit rester rejouable par Apple (voir `stripe_events`). */
async function markProcessed(n: AppleNotification): Promise<void> {
  await pool.query(
    `INSERT INTO apple_notifications (notification_uuid, notification_type, subtype, signed_date)
     VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))
     ON CONFLICT (notification_uuid) DO NOTHING`,
    [n.notificationUUID, n.notificationType, n.subtype ?? null, n.signedDate ?? null],
  );
}

/**
 * `POST /subscription/apple/notifications` — App Store Server Notifications V2.
 * Lève (400) si la signature est fausse ; tout le reste est acquitté (200), y
 * compris ce qui ne nous concerne pas, sinon Apple rejoue pendant des jours.
 */
export async function handleAppleNotification(signedPayload: string): Promise<void> {
  const n = verifyAppleJws<AppleNotification>(signedPayload);
  if (!n.notificationUUID || !n.notificationType) throw new AppleJwsError('notification incomplète');

  if (await alreadyProcessed(n.notificationUUID)) return;

  const cfg = config();
  const txJws = n.data?.signedTransactionInfo;
  if (n.notificationType === 'TEST' || !txJws || (n.data?.bundleId && n.data.bundleId !== cfg.bundleId)) {
    logger.info({ type: n.notificationType, subtype: n.subtype }, '[apple-iap] notification sans transaction à appliquer');
    await markProcessed(n);
    return;
  }

  const tx = verifyAppleJws<AppleTransaction>(txJws);
  try { checkTransaction(tx); }
  catch (err: any) {
    logger.warn({ type: n.notificationType, reason: err?.message }, '[apple-iap] notification ignorée');
    await markProcessed(n);
    return;
  }

  const userId = await resolveUserId(tx);
  if (!userId) {
    // Achat pas encore vérifié par l'app, ou compte supprimé. Rien à écrire ;
    // `verifyClientTransaction` fera le lien si le compte existe.
    logger.info({ type: n.notificationType, otid: tx.originalTransactionId }, '[apple-iap] notification sans compte');
    await markProcessed(n);
    return;
  }

  const renewal = decodeRenewal(n.data?.signedRenewalInfo, tx.originalTransactionId);
  const ent = entitlementFromApple(tx, renewal);
  try {
    await upsertFromApple(userId, {
      ...ent,
      eventCreatedAt: n.signedDate ? new Date(n.signedDate) : null,
      originalTransactionId: tx.originalTransactionId,
      productId: tx.productId,
      environment: tx.environment,
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    logger.warn({ userId, otid: tx.originalTransactionId }, '[apple-iap] abonnement déjà lié à un autre compte');
  }
  logger.info({ userId, type: n.notificationType, subtype: n.subtype, plan: ent.plan }, '[apple-iap] notification appliquée');
  await markProcessed(n);
}

