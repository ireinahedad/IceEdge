/**
 * authService.ts
 * Wraps /api/auth/* endpoints. Where the session is *kept* is tokenStore.ts.
 *
 * Web: access token in localStorage, refresh token in an httpOnly cookie the
 * server sets — so every /auth call uses `credentials: 'include'` and the
 * cookie flows between the client origin and the API origin.
 *
 * Native (Phase 3): WKWebView drops that cookie, so the refresh token is held
 * by the store and travels in the request body behind `X-Client: native`
 * (PRE_IOS_PLAN.md R3). Only one function below branches on it — `tryRefresh`
 * — and it branches on whether the *store* has a refresh token, not on the
 * platform. On web the store returns null forever, so the browser path is the
 * code that always ran.
 */

import { env } from '../env';
import { tokenStore } from './tokenStore';

const BASE = env.profileApiUrl;

/** Marks a request as coming from the native shell (see tokenStore.ts). */
const NATIVE_CLIENT_HEADER = { 'X-Client': 'native' } as const;

// --- Authed fetch helper ----------------------------------------------------

export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await tokenStore.getAccess();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers as Record<string, string> ?? {}),
    },
  });

  // If 401, try a cookie-based refresh once, then replay the request
  if (res.status === 401) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      const newToken = await tokenStore.getAccess();
      return fetch(`${BASE}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${newToken}`,
          ...(init.headers as Record<string, string> ?? {}),
        },
      });
    }
  }
  return res;
}

/**
 * Exchange the refresh credential for a new access token. R3.5.
 *
 * One branch, keyed on what the store holds rather than on the platform:
 *   web    → getRefresh() is null → `credentials: 'include'`, no body. The
 *            httpOnly cookie *is* the credential, exactly as before.
 *   native → the token is in hand → it travels in the body behind
 *            `X-Client: native`, because no cookie survives WKWebView.
 *
 * A failure clears the session, which now notifies the auth context (R3.8):
 * before that, the tokens were dropped but the UI kept rendering 401s.
 */
async function tryRefresh(): Promise<boolean> {
  try {
    const refresh = await tokenStore.getRefresh();

    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      credentials: refresh ? 'omit' : 'include',
      headers: refresh
        ? { 'Content-Type': 'application/json', ...NATIVE_CLIENT_HEADER }
        : { 'Content-Type': 'application/json' },
      body: refresh ? JSON.stringify({ refresh_token: refresh }) : undefined,
    });
    if (!res.ok) { await tokenStore.clear(); return false; }

    const data = await res.json();
    // `refresh_token` is present only in a native response; the store drops it
    // on web. Rotation means the old one is already revoked server-side.
    await tokenStore.setTokens(data.access_token, data.refresh_token);
    return true;
  } catch {
    await tokenStore.clear();
    return false;
  }
}

// --- Auth API calls ---------------------------------------------------------

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  first_name: string | null;
  last_name:  string | null;
  role: string;
  avatar_url?: string | null;
}

export interface AuthResult {
  user: AuthUser;
  tokens: { access_token: string; expires_in: number };
}

/** /register no longer logs in immediately — it returns a pending state. */
export interface PendingVerification {
  pending: true;
  email: string;
}

/** Error thrown when login is blocked because the email isn't verified yet. */
export class EmailNotVerifiedError extends Error {
  email: string;
  constructor(email: string) {
    super('Email not verified');
    this.name = 'EmailNotVerifiedError';
    this.email = email;
  }
}

// Register returns a pending state normally, OR a full session when email
// verification is disabled on the server (dev bypass).
export async function apiRegister(
  email: string,
  username: string,
  password: string,
  first_name?: string
): Promise<PendingVerification | AuthResult> {
  const res = await fetch(`${BASE}/auth/register`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, username, password, first_name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Registration failed');
  }
  return res.json();
}

/** Confirms the 6-digit code; on success the user is logged in. */
export async function apiVerifyEmail(email: string, code: string): Promise<AuthResult> {
  const res = await fetch(`${BASE}/auth/verify-email`, {
    method: 'POST',
    credentials: 'include', // receive the refresh cookie
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Verification failed');
  }
  return res.json();
}

export async function apiResendVerification(email: string): Promise<void> {
  await fetch(`${BASE}/auth/resend-verification`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  }).catch(() => {});
}

/** Requests a password-reset code by email. Always resolves (no enumeration). */
export async function apiForgotPassword(email: string): Promise<void> {
  await fetch(`${BASE}/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  }).catch(() => {});
}

/** Sets a new password using the emailed reset code. */
export async function apiResetPassword(email: string, code: string, newPassword: string): Promise<void> {
  const res = await fetch(`${BASE}/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code, new_password: newPassword }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Reset failed');
  }
}

export async function apiLogin(email: string, password: string, remember = false): Promise<AuthResult> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    credentials: 'include', // receive the refresh cookie
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, remember }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    if (res.status === 403 && err.code === 'EMAIL_NOT_VERIFIED') {
      throw new EmailNotVerifiedError(err.email ?? email);
    }
    throw new Error(err.error ?? 'Login failed');
  }
  return res.json();
}

export async function apiLogout(): Promise<void> {
  const token   = await tokenStore.getAccess();
  const refresh = await tokenStore.getRefresh(); // native only — null on web

  await fetch(`${BASE}/auth/logout`, {
    method: 'POST',
    credentials: refresh ? 'omit' : 'include', // web: server reads + revokes the cookie
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(refresh ? NATIVE_CLIENT_HEADER : {}),
    },
    // The route already accepted a body token before R3; native needs it,
    // otherwise the server has nothing to revoke.
    body: refresh ? JSON.stringify({ refresh_token: refresh }) : undefined,
  }).catch(() => {});

  await tokenStore.clear();
}

/** Sign out from every device by revoking all of the user's refresh tokens. */
export async function apiLogoutAll(): Promise<void> {
  const token = await tokenStore.getAccess();
  await fetch(`${BASE}/auth/logout-all`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  }).catch(() => {});
  await tokenStore.clear();
}

export function getGoogleLoginUrl(): string {
  const serverBase = env.profileServerUrl;
  return `${serverBase}/api/auth/google`;
}
