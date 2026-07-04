/**
 * pushService.ts — Web Push subscription helper.
 *
 * enableValueBetPush() registers the service worker, asks for notification
 * permission, subscribes via the Push API and stores the subscription server-
 * side. disableValueBetPush() removes it. Both are safe no-ops on unsupported
 * browsers (returns false).
 */
import { authedFetch } from './authService';

const BASE = import.meta.env.VITE_PROFILE_API_URL || '';

function supported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function getRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  return existing ?? navigator.serviceWorker.register('/sw.js');
}

/** Returns true on success. Throws only on unexpected errors. */
export async function enableValueBetPush(): Promise<boolean> {
  if (!supported()) return false;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;

  // Fetch the server's VAPID public key.
  const keyRes = await fetch(`${BASE}/push/vapid-public-key`);
  if (!keyRes.ok) return false;
  const { key } = await keyRes.json() as { key: string };

  const reg = await getRegistration();
  await navigator.serviceWorker.ready;

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
  }

  const res = await authedFetch('/push/subscribe', {
    method: 'POST',
    body: JSON.stringify(sub.toJSON()),
  });
  return res.ok;
}

export async function disableValueBetPush(): Promise<void> {
  if (!supported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  await authedFetch('/push/unsubscribe', {
    method: 'POST',
    body: JSON.stringify({ endpoint }),
  }).catch(() => {});
}
