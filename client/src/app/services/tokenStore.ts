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
 * Nothing imports `platform.ts` here. There is one implementation today; the
 * seam is the exported `tokenStore`, which Phase 3 swaps.
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

export const tokenStore: TokenStore = webStore;
