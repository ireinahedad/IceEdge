// ============================================================
//  Push service — Web Push (navigateurs) + APNs (app iOS)
// ============================================================
// Sends browser push notifications via the Web Push protocol (VAPID), and —
// since APPLE_PLAN 4.1 (2026-10-10) — native iOS notifications through APNs
// (`./apns`). Callers do not pick a channel by default: `sendToUsers` reaches
// every device a user has, whichever kind it is.
//
// Required env (generate once with `npx web-push generate-vapid-keys`):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (e.g. mailto:you@site.com)
//
// The `web-push` package is loaded lazily so the server still boots if it isn't
// installed yet — push is simply disabled (logged) until deps + keys are set.

import { pool } from '../db/connection';
import { logger } from '../logger';
import { mapLimit } from './concurrency';
import { apnsEnabled, isDeadToken, sendApns } from './apns';

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

/** Vrai si AU MOINS un canal (Web Push ou APNs) est configuré. */
export function pushEnabled(): boolean {
  return !!getWebPush() || apnsEnabled();
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

/**
 * Désabonne UN endpoint.
 *
 * `ownerId` est requis : la route /push/unsubscribe est authentifiée, mais elle
 * ne prouvait rien sur l'endpoint reçu. N'importe quel compte pouvait donc
 * supprimer l'abonnement d'un autre en fournissant son endpoint — les
 * notifications de la victime s'arrêtaient sans qu'elle sache pourquoi.
 * La clause `user_id = $2` fait de la propriété une condition de la suppression.
 */
export async function removeSubscription(endpoint: string, ownerId: string): Promise<void> {
  await pool.query(
    'DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2',
    [endpoint, ownerId],
  );
}

/** Purge d'un lot d'endpoints morts en UNE requête (voir `sendToUsers`). */
async function removeSubscriptions(endpoints: string[]): Promise<void> {
  if (endpoints.length === 0) return;
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint = ANY($1::text[])', [endpoints]);
}

// ---- iOS device tokens (APNs) ----------------------------------------------

export type PushLang = 'fr' | 'en';

/**
 * Enregistre (ou ré-attribue) le jeton APNs d'un iPhone.
 *
 * Le jeton est la clé : un autre compte qui se connecte sur le même appareil
 * en devient propriétaire. L'app ré-enregistre son jeton à chaque lancement
 * (Apple peut le changer), d'où l'`updated_at` et la langue rafraîchis.
 */
export async function saveDeviceToken(userId: string, token: string, lang: PushLang): Promise<void> {
  await pool.query(
    `INSERT INTO apns_device_tokens (token, user_id, lang)
     VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE SET
       user_id = EXCLUDED.user_id, lang = EXCLUDED.lang, updated_at = NOW()`,
    [token, userId, lang],
  );
}

/** Retire UN jeton — seulement s'il appartient à `ownerId` (même garde que `removeSubscription`). */
export async function removeDeviceToken(token: string, ownerId: string): Promise<void> {
  await pool.query('DELETE FROM apns_device_tokens WHERE token = $1 AND user_id = $2', [token, ownerId]);
}

async function removeDeviceTokens(tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  await pool.query('DELETE FROM apns_device_tokens WHERE token = ANY($1::text[])', [tokens]);
}

// ---- Sending ---------------------------------------------------------------

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

/** La même notification dans les deux langues. Chaque iPhone reçoit celle de
 *  son app ; un abonnement Web Push, qui n'a pas de langue, reçoit le français. */
export interface LocalizedPayload {
  fr: PushPayload;
  en: PushPayload;
}

export type AnyPayload = PushPayload | LocalizedPayload;

export function payloadFor(p: AnyPayload, lang: PushLang): PushPayload {
  return 'fr' in p ? p[lang] : p;
}

export type PushChannel = 'web' | 'apns';

export interface SendOptions {
  /** Canaux visés. Défaut : les deux. `['apns']` pour une notification que
   *  l'abonnement Web Push n'a jamais demandée (il a été pris pour les value bets). */
  channels?: PushChannel[];
}

/** Une notification destinée à un utilisateur précis. */
export interface PushMessage {
  userId: string;
  payload: AnyPayload;
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
  /** Notifications acceptées par le service push (FCM / Mozilla / Apple / APNs). */
  sent:    number;
  /** Échecs transitoires — l'appareil reste enregistré. */
  failed:  number;
  /** Abonnements / jetons morts (404/410, BadDeviceToken), supprimés de la base. */
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
export async function sendToUsers(
  userIds: string[],
  payload: AnyPayload,
  opts: SendOptions = {},
): Promise<FanoutResult> {
  return sendMessages(userIds.map((userId) => ({ userId, payload })), opts);
}

/**
 * Variante de `sendToUsers` où chaque utilisateur reçoit SON message (ex. « ton
 * pari est gagné » pour l'un, « perdu » pour l'autre). Mêmes garanties : une
 * requête de lecture par canal, un plafond d'envois simultanés commun aux deux
 * canaux, une purge groupée par canal. Si un utilisateur figure deux fois, le
 * dernier message l'emporte.
 */
export async function sendMessages(messages: PushMessage[], opts: SendOptions = {}): Promise<FanoutResult> {
  const result: FanoutResult = { sent: 0, failed: 0, expired: 0 };
  if (messages.length === 0) return result;

  const channels = opts.channels ?? ['web', 'apns'];
  const byUser = new Map<string, AnyPayload>(messages.map((m) => [m.userId, m.payload]));
  const userIds = [...byUser.keys()];

  const jobs: Array<() => Promise<void>> = [];
  const expiredWeb: string[] = [];
  const expiredApns: string[] = [];

  const wp = channels.includes('web') ? getWebPush() : null;
  if (wp) {
    const { rows } = await pool.query(
      `SELECT user_id AS "userId", endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ANY($1::uuid[])`,
      [userIds],
    );
    for (const r of rows) {
      const body = JSON.stringify(payloadFor(byUser.get(String(r.userId))!, 'fr'));
      jobs.push(async () => {
        const subscription = { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } };
        try {
          await wp.sendNotification(subscription, body);
          result.sent += 1;
        } catch (err: any) {
          // 404/410 → l'abonnement n'existe plus côté navigateur. Collecté ici,
          // supprimé en un seul DELETE après la boucle.
          if (err?.statusCode === 404 || err?.statusCode === 410) {
            expiredWeb.push(r.endpoint);
          } else {
            result.failed += 1;
            logger.warn({ err: err?.statusCode ?? err?.message }, '[Push] send failed');
          }
        }
      });
    }
  }

  if (channels.includes('apns') && apnsEnabled()) {
    const { rows } = await pool.query(
      `SELECT user_id AS "userId", token, lang FROM apns_device_tokens WHERE user_id = ANY($1::uuid[])`,
      [userIds],
    );
    for (const r of rows) {
      const msg = payloadFor(byUser.get(String(r.userId))!, r.lang === 'en' ? 'en' : 'fr');
      jobs.push(async () => {
        const res = await sendApns(r.token, msg);
        if (res.status === 200) {
          result.sent += 1;
        } else if (isDeadToken(res)) {
          expiredApns.push(r.token);
        } else {
          result.failed += 1;
          logger.warn({ status: res.status, reason: res.reason }, '[Push] APNs send failed');
        }
      });
    }
  }

  if (jobs.length === 0) return result;
  await mapLimit(jobs, SEND_CONCURRENCY, (job) => job());

  // Une purge ratée ne doit pas transformer un envoi réussi en échec : les
  // destinations mortes seront redétectées au prochain envoi.
  try {
    await removeSubscriptions(expiredWeb);
  } catch (err: any) {
    logger.warn({ err: err?.message, count: expiredWeb.length }, '[Push] purge des endpoints expirés échouée');
  }
  try {
    await removeDeviceTokens(expiredApns);
  } catch (err: any) {
    logger.warn({ err: err?.message, count: expiredApns.length }, '[Push] purge des jetons APNs expirés échouée');
  }
  result.expired = expiredWeb.length + expiredApns.length;
  return result;
}

// `sendToUser(userId, payload)` supprimée le 2026-08-10 : ce n'était plus qu'un
// `sendToUsers([userId], payload)` sans appelant depuis que le fan-out a été
// borné (ligne G de l'audit de scalabilité). Passer par `sendToUsers` même pour
// un seul destinataire est volontaire — une requête de lecture, un plafond de
// concurrence, une purge groupée.
