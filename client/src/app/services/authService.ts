/**
 * authService.ts
 * Wraps /api/auth/* endpoints and manages token storage.
 */

const BASE = import.meta.env.VITE_PROFILE_API_URL || '';

// --- Token storage ----------------------------------------------------------

const ACCESS_KEY  = 'ice_access';
const REFRESH_KEY = 'ice_refresh';

export function getAccessToken(): string | null  { return localStorage.getItem(ACCESS_KEY); }
export function getRefreshToken(): string | null { return localStorage.getItem(REFRESH_KEY); }

export function storeTokens(access: string, refresh: string) {
  localStorage.setItem(ACCESS_KEY,  access);
  localStorage.setItem(REFRESH_KEY, refresh);
}

export function clearTokens() {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
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

  // If 401 and we have a refresh token, try to refresh once
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
  const refresh_token = getRefreshToken();
  if (!refresh_token) return false;
  try {
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token }),
    });
    if (!res.ok) { clearTokens(); return false; }
    const data = await res.json();
    storeTokens(data.access_token, data.refresh_token);
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
  tokens: { access_token: string; refresh_token: string; expires_in: number };
}

export async function apiRegister(
  email: string,
  username: string,
  password: string,
  first_name?: string
): Promise<AuthResult> {
  const res = await fetch(`${BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, username, password, first_name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Registration failed');
  }
  return res.json();
}

export async function apiLogin(email: string, password: string): Promise<AuthResult> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Login failed');
  }
  return res.json();
}

export async function apiLogout(): Promise<void> {
  const refresh_token = getRefreshToken();
  if (!refresh_token) return;
  await authedFetch('/auth/logout', {
    method: 'POST',
    body: JSON.stringify({ refresh_token }),
  }).catch(() => {});
  clearTokens();
}

export function getGoogleLoginUrl(): string {
  const serverBase = import.meta.env.VITE_PROFILE_API_URL?.replace('/api', '') || 'http://localhost:3001';
  return `${serverBase}/api/auth/google`;
}
