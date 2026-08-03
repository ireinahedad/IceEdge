// ============================================================
//  Web Push service
// ============================================================
// Sends browser push notifications via the Web Push protocol (VAPID).
//
// Required env (generate once with `npx web-push generate-vapid-keys`):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (e.g. mailto:you@site.com)
//
// The `web-push` package is loaded lazily so the server still boots if it isn't
// installed yet — push is simply disabled (logged) until deps + keys are set.

import { pool } from '../db/connection';
import { logger } from '../logger';
import { mapLimit } from './concurrency';

let webpush: any = null;
let configured = false;

function getWebPush(): any | null {
  if (configured) return webpush;
  configured = true;

  const pub  = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subj = process.env.VAPID_SUBJECT || 'mailto:admin@iceedge.app';
  if (!pub || !priv) {
    logger.warn('[Push] VAPID keys not set — push notifications disabled.');
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    webpush = require('web-push');
    webpush.setVapidDetails(subj, pub, priv);
  } catch {
    logger.warn('[Push] `web-push` package not installed — run `npm i web-push`.');
    webpush = null;
  }
  return webpush;
}

export function getVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null;
}

export function pushEnabled(): boolean {
  return !!getWebPush();
}

// ---- Subscription storage --------------------------------------------------

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export async function saveSubscription(userId: string, sub: PushSubscriptionInput): Promise<void> {
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET
       user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth],
  );
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

/** Purge d'un lot d'endpoints morts en UNE requête (voir `sendToUsers`). */
async function removeSubscriptions(endpoints: string[]): Promise<void> {
  if (endpoints.length === 0) return;
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint = ANY($1::text[])', [endpoints]);
}

// ---- Sending ---------------------------------------------------------------

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

/**
 * Plafond de notifications envoyées EN PARALLÈLE, tous destinataires confondus.
 *
 * 20 par défaut : assez pour que 3 000 appareils partent en ~1 min à 400 ms
 * l'appel, assez peu pour ne jamais monopoliser ni les sockets sortantes ni
 * l'event loop du process qui sert aussi l'API. Réglable, mais l'intérêt de la
 * valeur est d'exister, pas d'être optimale.
 */
const SEND_CONCURRENCY = Number(process.env.PUSH_CONCURRENCY) || 20;

export interface FanoutResult {
  /** Notifications acceptées par le service push (FCM / Mozilla / Apple). */
  sent:    number;
  /** Échecs transitoires — l'appareil reste enregistré. */
  failed:  number;
  /** Abonnements expirés (404/410), supprimés de la base. */
  expired: number;
}

/**
 * Envoie une notification à tous les appareils d'un LOT d'utilisateurs.
 *
 * Deux propriétés que le fan-out naïf n'avait pas, et qui sont ce que la ligne
 * G de l'audit demandait :
 *
 *  1. **Une seule requête de lecture** (`= ANY($1)`), au lieu d'une par
 *     destinataire. 2 000 abonnés, c'était 2 000 requêtes lancées d'un coup sur
 *     un pool de 10 connexions : les requêtes HTTP des utilisateurs passaient
 *     derrière, l'API semblait tomber pendant chaque scan.
 *  2. **Un plafond d'envois simultanés**, à l'échelle du LOT et non de chaque
 *     utilisateur. Le borner par utilisateur n'aurait rien borné du tout : le
 *     nombre d'appareils par personne est petit, c'est le nombre de personnes
 *     qui est grand.
 *
 * La purge des endpoints morts est elle aussi groupée en une requête — sinon on
 * remplaçait N envois concurrents par N `DELETE` concurrents le jour où un
 * service push expire un lot d'abonnements d'un coup (ce qui est le cas normal
 * après une mise à jour de navigateur).
 *
 * Un échec n'interrompt jamais le lot : chaque envoi est protégé, et la fonction
 * renvoie le décompte plutôt que de lever.
 */
export async function sendToUsers(userIds: string[], payload: PushPayload): Promise<FanoutResult> {
  const empty: FanoutResult = { sent: 0, failed: 0, expired: 0 };
  const wp = getWebPush();
  if (!wp || userIds.length === 0) return empty;

  const { rows } = await pool.query(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ANY($1::uuid[])`,
    [userIds],
  );
  if (rows.length === 0) return empty;

  const body = JSON.stringify(payload);
  const expired: string[] = [];
  let sent = 0;
  let failed = 0;

  await mapLimit(rows, SEND_CONCURRENCY, async (r) => {
    const subscription = { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } };
    try {
      await wp.sendNotification(subscription, body);
      sent += 1;
    } catch (err: any) {
      // 404/410 → l'abonnement n'existe plus côté navigateur. Collecté ici,
      // supprimé en un seul DELETE après la boucle.
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        expired.push(r.endpoint);
      } else {
        failed += 1;
        logger.warn({ err: err?.statusCode ?? err?.message }, '[Push] send failed');
      }
    }
  });

  try {
    await removeSubscriptions(expired);
  } catch (err: any) {
    // Une purge ratée ne doit pas transformer un envoi réussi en échec : les
    // endpoints morts seront redétectés au prochain envoi.
    logger.warn({ err: err?.message, count: expired.length }, '[Push] purge des endpoints expirés échouée');
  }

  return { sent, failed, expired: expired.length };
}

/** Sends a payload to every registered device of a user. Prunes dead endpoints. */
export async function sendToUser(userId: string, payload: PushPayload): Promise<void> {
  await sendToUsers([userId], payload);
}
