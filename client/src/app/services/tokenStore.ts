/**
 * tokenStore.ts — PRE_IOS_PLAN.md R3.4/R3.6. The one place that knows where the
 * session lives.
 *
 * Web: the access token sits in localStorage (short-lived, 15 min) and the
 * refresh token lives in an httpOnly cookie the server sets — so `getRefresh()`
 * returns `null` here, forever, by design. That is not a gap to fill in: the
 * cookie is unreadable to JavaScript precisely so that an XSS cannot walk off
 * with a long-lived credential, and writing the refresh token into localStorage
 * would hand it over.
 *
 * Native (Phase 3 of APPLE_PLAN.md): WKWebView drops the SameSite=None cookie,
 * so a Capacitor build must hold both tokens itself, in Keychain-backed
 * `@capacitor/preferences`. That store is the reason every method here is
 * `async` even though the web implementation is synchronous underneath —
 * Preferences is promise-based, and converting the call sites later would mean
 * touching each one twice.
 *
 * Phase 3 (2026-10-09): the native store lives below, in the iOS Keychain via
 * `@aparajita/capacitor-secure-storage` — not `@capacitor/preferences`, which is
 * plain UserDefaults and no place for a 30-day refresh token. `isIOS` is a build
 * constant, so the web bundle never contains the native store (dynamic import).
 */


export interface TokenStore {
  /** The bearer token for API calls, or null when signed out. */
  getAccess(): Promise<string | null>;
  /** Store a fresh session. `refresh` is ignored on web (the cookie has it). */
  setTokens(access: string, refresh?: string): Promise<void>;
  /** Web: always null — the httpOnly cookie holds it. Native: the token. */
  getRefresh(): Promise<string | null>;
  /** Drop the session and notify listeners. */
  clear(): Promise<void>;
}

const ACCESS_KEY = 'ice_access';

/**
 * Pre-cookie era key. Nothing reads it any more (R3.7 removed the last
 * reference), but a visitor who last signed in before the cookie migration can
 * still have a real refresh token sitting in their localStorage. Deleting the
 * code without sweeping the key would leave it there for good, so the sweep
 * runs once per load and the key itself is gone from the logic.
 */
const LEGACY_REFRESH_KEY = 'ice_refresh';
try { localStorage.removeItem(LEGACY_REFRESH_KEY); } catch { /* private mode */ }

// ── Session-cleared notification (R3.8) ──────────────────────────────────────
// Before this existed, a failed refresh called clearTokens() and stopped there:
// the tokens were gone but the UI still believed it was signed in, so it sat
// rendering 401s with no way out. The store now says so, AuthContext listens,
// and the route guard does the rest.

type Listener = () => void;
const listeners = new Set<Listener>();

/** Subscribe to "the session is gone". Returns an unsubscribe function. */
export function onSessionCleared(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function emitSessionCleared(): void {
  // Copy first: a listener may unsubscribe itself while we iterate.
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* a bad listener must not break sign-out */ }
  }
}

// ── Web implementation ───────────────────────────────────────────────────────
// Every localStorage access is wrapped: Safari private mode throws on write,
// and losing the token is not a reason to crash the app.

const webStore: TokenStore = {
  async getAccess() {
    try { return localStorage.getItem(ACCESS_KEY); } catch { return null; }
  },

  async setTokens(access: string, _refresh?: string) {
    // `_refresh` is dropped on purpose — see the header comment.
    try { localStorage.setItem(ACCESS_KEY, access); } catch { /* private mode */ }
  },

  async getRefresh() {
    return null;
  },

  async clear() {
    try { localStorage.removeItem(ACCESS_KEY); } catch { /* private mode */ }
    emitSessionCleared();
  },
};

// ── Native implementation (iOS Keychain) ─────────────────────────────────────
// A small in-memory cache in front of the Keychain: every API call reads the
// access token, and a Keychain round-trip through the bridge each time is
// needless. The Keychain stays the source of truth across app restarts.

const REFRESH_KEY = 'ice_refresh_native';

type SecureStoragePlugin = typeof import('@aparajita/capacitor-secure-storage')['SecureStorage'];

/**
 * ⚠️ Never `return SecureStorage` from an async function. A Capacitor plugin is a
 * Proxy that answers *every* property — including `then`. Resolving a promise
 * with it makes JS treat it as a thenable and call `SecureStorage.then()`, which
 * rejects ("not implemented on ios") and leaves the outer promise pending
 * forever: every token read hangs, so every API call hangs. Wrapping the plugin
 * in a plain object keeps it out of promise resolution.
 */
let plugin: Promise<{ s: SecureStoragePlugin }> | null = null;
function secure(): Promise<{ s: SecureStoragePlugin }> {
  plugin ??= import('@aparajita/capacitor-secure-storage').then((m) => ({ s: m.SecureStorage }));
  return plugin;
}

let cache: { access: string | null; refresh: string | null } | null = null;

async function load(): Promise<{ access: string | null; refresh: string | null }> {
  if (cache) return cache;
  try {
    const { s } = await secure();
    const [access, refresh] = await Promise.all([s.get(ACCESS_KEY, false, false), s.get(REFRESH_KEY, false, false)]);
    cache = {
      access:  typeof access  === 'string' ? access  : null,
      refresh: typeof refresh === 'string' ? refresh : null,
    };
  } catch {
    cache = { access: null, refresh: null };
  }
  return cache;
}

const nativeStore: TokenStore = {
  async getAccess() { return (await load()).access; },

  async setTokens(access: string, refresh?: string) {
    const cur = await load();
    // A refresh response without a new refresh token keeps the current one.
    cache = { access, refresh: refresh ?? cur.refresh };
    try {
      const { s } = await secure();
      await s.set(ACCESS_KEY, access, false, false);
      if (refresh) await s.set(REFRESH_KEY, refresh, false, false);
    } catch { /* the in-memory session still works until the app is killed */ }
  },

  async getRefresh() { return (await load()).refresh; },

  async clear() {
    cache = { access: null, refresh: null };
    try {
      const { s } = await secure();
      await Promise.all([s.remove(ACCESS_KEY, false), s.remove(REFRESH_KEY, false)]);
    } catch { /* nothing left to protect if the Keychain is unreachable */ }
    emitSessionCleared();
  },
};

// Inline literal (not `isIOS`) so Rollup drops the native store — and its
// Keychain plugin chunk — from the web build.
export const tokenStore: TokenStore = import.meta.env.VITE_TARGET === 'ios' ? nativeStore : webStore;
