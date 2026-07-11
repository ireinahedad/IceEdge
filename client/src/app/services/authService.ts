/**
 * authService.ts
 * Wraps /api/auth/* endpoints and manages token storage.
 *
 * Access token  → localStorage (short-lived, 15 min).
 * Refresh token → httpOnly cookie set by the server (never visible to JS).
 *   All /auth calls therefore use `credentials: 'include'` so the cookie
 *   flows between the client origin and the API origin.
 */

const BASE = import.meta.env.VITE_PROFILE_API_URL || '';

// --- Token storage ----------------------------------------------------------

const ACCESS_KEY  = 'ice_access';
const LEGACY_REFRESH_KEY = 'ice_refresh'; // pre-cookie era — cleaned up on load

export function getAccessToken(): string | null  { return localStorage.getItem(ACCESS_KEY); }

export function storeTokens(access: string) {
  localStorage.setItem(ACCESS_KEY, access);
  localStorage.removeItem(LEGACY_REFRESH_KEY);
}

export function clearTokens() {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(LEGACY_REFRESH_KEY);
}

// --- Authed fetch helper ----------------------------------------------------

export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getAccessToken();
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
      const newToken = getAccessToken();
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

async function tryRefresh(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include', // sends the httpOnly refresh cookie
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) { clearTokens(); return false; }
    const data = await res.json();
    storeTokens(data.access_token);
    return true;
  } catch {
    clearTokens();
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
  const token = getAccessToken();
  await fetch(`${BASE}/auth/logout`, {
    method: 'POST',
    credentials: 'include', // server reads + revokes the cookie
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  }).catch(() => {});
  clearTokens();
}

/** Sign out from every device by revoking all of the user's refresh tokens. */
export async function apiLogoutAll(): Promise<void> {
  const token = getAccessToken();
  await fetch(`${BASE}/auth/logout-all`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  }).catch(() => {});
  clearTokens();
}

export function getGoogleLoginUrl(): string {
  const serverBase = import.meta.env.VITE_PROFILE_API_URL?.replace('/api', '') || 'http://localhost:3001';
  return `${serverBase}/api/auth/google`;
}
