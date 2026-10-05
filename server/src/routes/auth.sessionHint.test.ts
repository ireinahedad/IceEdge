import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

/**
 * Témoin de session `ice_session_hint` (QA I4, 2026-10-06).
 *
 * Le front relance un refresh silencieux quand localStorage a été vidé, à
 * condition de voir ce témoin. Verrouillé ici :
 *   1. posé avec le cookie de refresh, LISIBLE (pas HttpOnly), sur le domaine
 *      parent, valeur `1` — jamais le jeton ;
 *   2. effacé avec le cookie de refresh (déconnexion) ;
 *   3. absent tant que `SESSION_HINT_DOMAIN` n'est pas défini ;
 *   4. jamais posé pour un client natif (pas de cookie du tout).
 */

const TOKENS = { access_token: 'a.b.c', refresh_token: 'r.e.f', expires_in: 900, refresh_expires_in: 604800 };
const USER = { id: 'u1', email: 'a@b.com', username: 'u', role: 'user' };
const mockAuth = {
  register: vi.fn(), verifyEmail: vi.fn(), resendVerification: vi.fn(), forgotPassword: vi.fn(),
  resetPassword: vi.fn(), login: vi.fn(), refreshTokens: vi.fn(), logout: vi.fn(), logoutAll: vi.fn(),
  verifyAccessToken: vi.fn(), exchangeGoogleCode: vi.fn(), loginWithGoogle: vi.fn(),
};
vi.mock('../services/auth.service', () => mockAuth);

async function app() {
  vi.resetModules();
  const { default: routes } = await import('./auth.routes');
  const a = express();
  a.use(cookieParser()); a.use(express.json()); a.use('/api/auth', routes);
  return a;
}
const hint = (res: request.Response) =>
  (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith('ice_session_hint='));
const CREDS = { email: 'a@b.com', password: 'motdepasse1' };

describe('témoin de session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.login.mockResolvedValue({ user: USER, tokens: TOKENS });
    mockAuth.refreshTokens.mockResolvedValue(TOKENS);
    mockAuth.logout.mockResolvedValue(undefined);
  });
  afterEach(() => { delete process.env.SESSION_HINT_DOMAIN; });

  it('posé au login, lisible, domaine parent, sans le jeton', async () => {
    process.env.SESSION_HINT_DOMAIN = 'arakice.com';
    const res = await request(await app()).post('/api/auth/login').set('Origin', 'https://arakice.com').send(CREDS);
    expect(res.status).toBe(200);
    const c = hint(res)!;
    expect(c).toMatch(/^ice_session_hint=1;/);
    expect(c).not.toMatch(/HttpOnly/i);
    expect(c).toMatch(/Domain=arakice\.com/i);
    expect(c).not.toContain(TOKENS.refresh_token);
  });

  it('reposé à chaque refresh (même durée que le cookie de refresh)', async () => {
    process.env.SESSION_HINT_DOMAIN = 'arakice.com';
    const res = await request(await app()).post('/api/auth/refresh').set('Cookie', 'ice_refresh=r.e.f').send({});
    expect(res.status).toBe(200);
    expect(hint(res)).toMatch(/Max-Age=604800/);
  });

  it('effacé à la déconnexion', async () => {
    process.env.SESSION_HINT_DOMAIN = 'arakice.com';
    mockAuth.verifyAccessToken.mockReturnValue({ sub: 'u1', email: 'a@b.com', role: 'user' });
    const res = await request(await app()).post('/api/auth/logout')
      .set('Authorization', 'Bearer a.b.c').set('Cookie', 'ice_refresh=r.e.f').send({});
    expect(res.status).toBeLessThan(300);
    expect(hint(res)).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('absent sans SESSION_HINT_DOMAIN', async () => {
    const res = await request(await app()).post('/api/auth/login').set('Origin', 'https://arakice.com').send(CREDS);
    expect(res.status).toBe(200);
    expect(hint(res)).toBeUndefined();
  });

  it('jamais pour un client natif', async () => {
    process.env.SESSION_HINT_DOMAIN = 'arakice.com';
    const res = await request(await app()).post('/api/auth/login').set('X-Client', 'native').send(CREDS);
    expect(res.status).toBe(200);
    expect(hint(res)).toBeUndefined();
  });
});
