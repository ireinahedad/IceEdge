/**
 * widgetBridge.ts — APPLE_PLAN 4.2. Feeds the iOS home-screen widget
 * « paris en cours ».
 *
 * The widget runs in its own iOS process and cannot use the app's session, so
 * the app asks the server for a read-only widget token (`POST /widget/token`)
 * and hands it, with the API address and the language, to the native
 * `WidgetBridge` plugin (ios/App/App/WidgetBridgePlugin.swift), which stores
 * them in the App Group the widget reads. iOS-only (dynamic imports behind a
 * VITE_TARGET literal).
 *
 * ⚠️ Never return `WidgetBridge` from an async function — a Capacitor plugin is
 * a Proxy that answers `.then` (see tokenStore.ts).
 */
import { registerPlugin } from '@capacitor/core';
import { authedFetch } from './authService';
import { tokenStore } from './tokenStore';
import { env } from '../env';

interface WidgetBridgePlugin {
  setConfig(opts: { token: string; apiBase: string; lang: 'fr' | 'en' }): Promise<void>;
  clear(): Promise<void>;
  reload(): Promise<void>;
}

const WidgetBridge = registerPlugin<WidgetBridgePlugin>('WidgetBridge');

/** The widget token this device holds (not secret-grade: read-only, one route). */
const TOKEN_KEY = 'ice_widget_token';
const read = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
const write = (v: string | null) => {
  try { if (v === null) localStorage.removeItem(TOKEN_KEY); else localStorage.setItem(TOKEN_KEY, v); } catch { /* private mode */ }
};

const appLang = (): 'fr' | 'en' => (document.documentElement.lang === 'en' ? 'en' : 'fr');

let inFlight: Promise<void> | null = null;

/**
 * Signed in → make sure the widget has a token and the current settings.
 * Called at launch and after every session change; cheap when nothing changed
 * (the native side only reloads the widget when its settings differ).
 */
export function syncWidget(): Promise<void> {
  inFlight ??= (async () => {
    try {
      if (!(await tokenStore.getAccess())) return;
      let token = read();
      if (!token) {
        const res = await authedFetch('/widget/token', { method: 'POST' });
        if (!res.ok) return;
        token = String((await res.json() as { token?: string }).token ?? '');
        if (!token) return;
        write(token);
      }
      await WidgetBridge.setConfig({ token, apiBase: env.profileApiUrl, lang: appLang() });
    } catch (err) {
      console.warn('[widget] sync failed', err);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** The bets changed (new slip, app going to background): redraw the widget. */
export function reloadWidget(): void {
  void WidgetBridge.reload().catch(() => {});
}

/** Sign-out: the server forgets the token, the widget shows « connecte-toi ». */
export async function forgetWidgetOnLogout(): Promise<void> {
  const token = read();
  write(null);
  if (token) {
    await authedFetch('/widget/token/revoke', { method: 'POST', body: JSON.stringify({ token }) }).catch(() => {});
  }
  await WidgetBridge.clear().catch(() => {});
}
