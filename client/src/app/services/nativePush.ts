/**
 * nativePush.ts — APPLE_PLAN 4.1. Native iOS notifications (APNs) through
 * `@capacitor/push-notifications`. Loaded only by the iOS build (dynamic
 * imports behind a VITE_TARGET literal): the web bundle never contains it.
 *
 * The flow:
 *   enable  → ask iOS for permission → register with APNs → POST the device
 *             token to /push/apns/register (with the app's language).
 *   launch  → if the user had turned it on and iOS still allows it, register
 *             again: Apple can rotate the token, the server upserts.
 *   disable / sign-out → tell the server to forget this device.
 *
 * ⚠️ Never return `PushNotifications` from an async function — a Capacitor
 * plugin is a Proxy that answers `.then`, so a promise resolved with it never
 * settles (same trap as tokenStore.ts / SecureStorage). Only call its methods.
 */
import { PushNotifications } from '@capacitor/push-notifications';
import { authedFetch } from './authService';
import { tokenStore } from './tokenStore';

/** The user turned notifications on in the app (iOS permission is separate). */
const ENABLED_KEY = 'ice_native_push';
/** Last APNs token sent to the server — needed to unregister it later. */
const TOKEN_KEY = 'ice_apns_token';

const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string | null) => {
  try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ }
};

function appLang(): 'fr' | 'en' {
  return document.documentElement.lang === 'en' ? 'en' : 'fr';
}

/** Registers with APNs and resolves with the device token (hex). */
function obtainToken(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const handles: Array<{ remove: () => Promise<void> }> = [];
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const h of handles) void h.remove();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('APNs registration timed out'))), 15_000);

    Promise.all([
      PushNotifications.addListener('registration', (t) => finish(() => resolve(t.value))),
      PushNotifications.addListener('registrationError', (e) => finish(() => reject(new Error(e.error)))),
    ])
      .then((hs) => { handles.push(...hs); if (done) for (const h of hs) void h.remove(); return PushNotifications.register(); })
      .catch((err) => finish(() => reject(err)));
  });
}

async function sendToken(token: string): Promise<boolean> {
  const res = await authedFetch('/push/apns/register', {
    method: 'POST',
    body: JSON.stringify({ token, lang: appLang() }),
  });
  if (res.ok) write(TOKEN_KEY, token);
  return res.ok;
}

async function permissionGranted(): Promise<boolean> {
  try {
    return (await PushNotifications.checkPermissions()).receive === 'granted';
  } catch {
    return false;
  }
}

/** On in the app AND allowed by iOS. */
export async function isNativePushOn(): Promise<boolean> {
  return read(ENABLED_KEY) === '1' && (await permissionGranted());
}

/** Returns false if iOS permission is refused or registration fails. */
export async function enableNativePush(): Promise<boolean> {
  try {
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
      perm = await PushNotifications.requestPermissions();
    }
    if (perm.receive !== 'granted') return false;
    const ok = await sendToken(await obtainToken());
    if (ok) write(ENABLED_KEY, '1');
    return ok;
  } catch (err) {
    console.warn('[push] enable failed', err);
    return false;
  }
}

/** Server forgets this device; APNs registration is dropped too. */
export async function disableNativePush(): Promise<void> {
  write(ENABLED_KEY, null);
  const token = read(TOKEN_KEY);
  write(TOKEN_KEY, null);
  if (token) {
    await authedFetch('/push/apns/unregister', { method: 'POST', body: JSON.stringify({ token }) }).catch(() => {});
  }
  await PushNotifications.unregister().catch(() => {});
}

/**
 * Called by `apiLogout` BEFORE the session is cleared (the call needs it): the
 * next account to sign in on this iPhone must not receive this one's alerts,
 * and must opt in for itself.
 */
export async function forgetDeviceOnLogout(): Promise<void> {
  if (!read(TOKEN_KEY) && read(ENABLED_KEY) !== '1') return;
  await disableNativePush();
}

/** App launch: refresh the token server-side if the user had opted in. */
export async function syncNativePush(): Promise<void> {
  if (read(ENABLED_KEY) !== '1') return;
  if (!(await tokenStore.getAccess())) return;
  if (!(await permissionGranted())) return; // turned off in iOS Settings — keep the flag, iOS decides
  try {
    await sendToken(await obtainToken());
  } catch (err) {
    console.warn('[push] sync failed', err);
  }
}

/**
 * Tap on a notification → open the route it carries (`url`, set by the
 * server: `/player/<id>` for a settled bet, `/` for a value bet). Installed
 * at startup so a tap that cold-launches the app is not missed.
 */
export function installNotificationTapHandler(navigate: (to: string) => void): void {
  void PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
    const url = action.notification?.data?.url;
    if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')) navigate(url);
  });
}
