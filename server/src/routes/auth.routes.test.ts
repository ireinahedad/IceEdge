import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

/**
 * Le transport du refresh token — PRE_IOS_PLAN.md R3.3.
 *
 * Ce fichier existe pour UNE régression : le jour où quelqu'un simplifie
 * `sendTokens()`, le refresh token part dans le corps de la réponse d'un
 * navigateur. Le cookie httpOnly existe précisément pour que le JavaScript de
 * la page ne puisse jamais le lire ; le rendre lisible annule la garantie sans
 * qu'aucun test ne tombe.
 *
 * Trois comportements verrouillés ici :
 *   1. sans `X-Client: native` → cookie, et RIEN dans le corps ;
 *   2. avec l'en-tête et sans origine navigateur → corps complet, aucun cookie ;
 *   3. avec l'en-tête MAIS une origine http(s) → cookie quand même. C'est le
 *      garde-fou anti-XSS : `X-Client` est un en-tête de requête, un navigateur
 *      peut le poser.
 *
 * `AuthService` est bouchonné : ce qui est testé est le câblage HTTP, pas la
 * rotation des jetons (elle ne change pas, R3.2).
 */

const TOKENS = {
  access_token:       'access.jwt.value',
  refresh_token:      'refresh.jwt.value',
  expires_in:         900,
  refresh_expires_in: 604800,
};

const USER = { id: 'u1', email: 'a@b.com', username: 'u', role: 'user' };

const mockAuth = {
  register:            vi.fn(),
  verifyEmail:         vi.fn(),
  resendVerification:  vi.fn(),
  forgotPassword:      vi.fn(),
  resetPassword:       vi.fn(),
  login:               vi.fn(),
  refreshTokens:       vi.fn(),
  logout:              vi.fn(),
  logoutAll:           vi.fn(),
  verifyAccessToken:   vi.fn(),
  exchangeGoogleCode:  vi.fn(),
  loginWithGoogle:     vi.fn(),
};

vi.mock('../services/auth.service', () => mockAuth);

async function authApp() {
  const { default: routes } = await import('./auth.routes');
  const a = express();
  a.use(cookieParser());
  a.use(express.json());
  a.use('/api/auth', routes);
  return a;
}

/** Le cookie de refresh est-il posé par cette réponse ? */
function refreshCookie(res: request.Response): string | undefined {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return set?.find((c) => c.startsWith('ice_refresh='));
}

const CREDENTIALS = { email: 'a@b.com', password: 'motdepasse1' };

describe('transport du refresh token (R3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.login.mockResolvedValue({ user: USER, tokens: TOKENS });
    mockAuth.refreshTokens.mockResolvedValue(TOKENS);
  });

  it('navigateur : cookie posé, aucun refresh token dans le corps', async () => {
    const res = await request(await authApp())
      .post('/api/auth/login')
      .set('Origin', 'https://arakice.com')
      .send(CREDENTIALS);

    expect(res.status).toBe(200);
    expect(refreshCookie(res)).toMatch(/HttpOnly/i);
    expect(res.body.tokens.access_token).toBe(TOKENS.access_token);
    expect(res.body.tokens.refresh_token).toBeUndefined();
    expect(res.body.tokens.refresh_expires_in).toBeUndefined();
  });

  it('natif : refresh token dans le corps, aucun cookie', async () => {
    const res = await request(await authApp())
      .post('/api/auth/login')
      .set('X-Client', 'native')
      .send(CREDENTIALS);

    expect(res.status).toBe(200);
    expect(refreshCookie(res)).toBeUndefined();
    expect(res.body.tokens.refresh_token).toBe(TOKENS.refresh_token);
    expect(res.body.tokens.refresh_expires_in).toBe(TOKENS.refresh_expires_in);
  });

  // LE cas qui justifie le garde-fou : un XSS sur le site tourne dans un
  // navigateur, donc il envoie une origine http(s). Il peut poser l'en-tête,
  // il n'obtient pas le jeton pour autant.
  it('en-tête natif depuis une origine navigateur : reste sur le cookie', async () => {
    const res = await request(await authApp())
      .post('/api/auth/login')
      .set('X-Client', 'native')
      .set('Origin', 'https://arakice.com')
      .send(CREDENTIALS);

    expect(res.status).toBe(200);
    expect(refreshCookie(res)).toBeDefined();
    expect(res.body.tokens.refresh_token).toBeUndefined();
  });

  it('/refresh natif : jetons complets dans le corps, aucun cookie', async () => {
    const res = await request(await authApp())
      .post('/api/auth/refresh')
      .set('X-Client', 'native')
      .send({ refresh_token: 'ancien.refresh' });

    expect(res.status).toBe(200);
    expect(mockAuth.refreshTokens).toHaveBeenCalledWith('ancien.refresh');
    expect(refreshCookie(res)).toBeUndefined();
    expect(res.body.refresh_token).toBe(TOKENS.refresh_token);
  });

  it('/refresh navigateur : le cookie est relu, tourné, et rien ne fuit', async () => {
    const res = await request(await authApp())
      .post('/api/auth/refresh')
      .set('Origin', 'https://arakice.com')
      .set('Cookie', 'ice_refresh=ancien.refresh')
      .send({});

    expect(res.status).toBe(200);
    expect(mockAuth.refreshTokens).toHaveBeenCalledWith('ancien.refresh');
    expect(refreshCookie(res)).toBeDefined();
    expect(res.body.access_token).toBe(TOKENS.access_token);
    expect(res.body.refresh_token).toBeUndefined();
  });

  // Le corps dépend d'un en-tête de requête : sans Vary, un cache partagé
  // pourrait servir la réponse d'un client à l'autre.
  it('annonce Vary: X-Client', async () => {
    const res = await request(await authApp())
      .post('/api/auth/login')
      .set('Origin', 'https://arakice.com')
      .send(CREDENTIALS);

    expect(String(res.headers['vary'] ?? '')).toContain('X-Client');
  });
});
