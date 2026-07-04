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

let webpush: any = null;
let configured = false;

function getWebPush(): any | null {
  if (configured) return webpush;
  configured = true;

  const pub  = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subj = process.env.VAPID_SUBJECT || 'mailto:admin@iceedge.app';
  if (!pub || !priv) {
    console.warn('[Push] VAPID keys not set — push notifications disabled.');
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    webpush = require('web-push');
    webpush.setVapidDetails(subj, pub, priv);
    console.log('[Push] Web Push configured ✓');
  } catch {
    console.warn('[Push] `web-push` package not installed — run `npm i web-push`.');
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

// ---- Sending ---------------------------------------------------------------

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

/** Sends a payload to every registered device of a user. Prunes dead endpoints. */
export async function sendToUser(userId: string, payload: PushPayload): Promise<void> {
  const wp = getWebPush();
  if (!wp) return;

  const { rows } = await pool.query(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
    [userId],
  );

  await Promise.all(rows.map(async (r) => {
    const subscription = { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } };
    try {
      await wp.sendNotification(subscription, JSON.stringify(payload));
    } catch (err: any) {
      // 404/410 → subscription expired; remove it.
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        await removeSubscription(r.endpoint);
      } else {
        console.warn('[Push] send failed:', err?.statusCode ?? err?.message);
      }
    }
  }));
}
