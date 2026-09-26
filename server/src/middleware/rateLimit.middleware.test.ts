import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Request } from 'express';
import { userOrIpKey } from './rateLimit.middleware';

/**
 * La clé de `apiLimiter` est un point de sécurité, pas un réglage de confort.
 *
 * Le limiteur est monté sur `/api` AVANT `authenticate`, donc il lit lui-même le
 * jeton. S'il faisait confiance à un `sub` non vérifié, forger un identifiant
 * différent à chaque requête suffirait à ne jamais être limité — le limiteur
 * deviendrait décoratif. Ces tests portent exactement là-dessus : aucun n'a de
 * symptôme visible côté produit, donc rien d'autre ne les protège.
 */

/** Fabrique une requête minimale au sens de ce que lit `userOrIpKey`. */
function reqWith(headers: Record<string, string>, ip = '203.0.113.7', user?: unknown): Request {
  return { headers, ip, user } as unknown as Request;
}

function signed(sub: string, secret = process.env.JWT_SECRET!): string {
  return jwt.sign({ sub, email: 'a@b.co', role: 'user' }, secret, { expiresIn: '15m' });
}

describe('userOrIpKey', () => {
  it('classe par compte quand le jeton est valide', () => {
    const key = userOrIpKey(reqWith({ authorization: `Bearer ${signed('user-123')}` }));
    expect(key).toBe('u:user-123');
  });

  it('retombe sur l’IP quand le jeton est signé avec une AUTRE clé', () => {
    // C'est le contournement que le test protège : sans vérification de
    // signature, ce `sub` forgé ouvrirait un compteur neuf à chaque requête.
    const forged = signed('attacker-forged', 'not-the-server-secret');
    const key = userOrIpKey(reqWith({ authorization: `Bearer ${forged}` }));
    expect(key).toBe('ip:203.0.113.7');
  });

  it('retombe sur l’IP quand le jeton est expiré', () => {
    const expired = jwt.sign({ sub: 'user-123' }, process.env.JWT_SECRET!, { expiresIn: -10 });
    expect(userOrIpKey(reqWith({ authorization: `Bearer ${expired}` }))).toBe('ip:203.0.113.7');
  });

  it('retombe sur l’IP sans en-tête, et sur un en-tête malformé', () => {
    expect(userOrIpKey(reqWith({}))).toBe('ip:203.0.113.7');
    expect(userOrIpKey(reqWith({ authorization: 'Bearer pas-un-jwt' }))).toBe('ip:203.0.113.7');
    expect(userOrIpKey(reqWith({ authorization: 'Basic abc' }))).toBe('ip:203.0.113.7');
  });

  it('préfixe les deux espaces de noms pour qu’ils ne se croisent jamais', () => {
    const asUser = userOrIpKey(reqWith({}, '203.0.113.7', { sub: '203.0.113.7' }));
    const asIp   = userOrIpKey(reqWith({}, '203.0.113.7'));
    expect(asUser).toBe('u:203.0.113.7');
    expect(asIp).toBe('ip:203.0.113.7');
    expect(asUser).not.toBe(asIp);
  });

  it('préfère `req.user` quand une route l’a déjà attaché (pas de 2ᵉ vérification)', () => {
    const key = userOrIpKey(reqWith({ authorization: `Bearer ${signed('du-jeton')}` }, '203.0.113.7', { sub: 'du-middleware' }));
    expect(key).toBe('u:du-middleware');
  });
});

describe('writeLimiter', () => {
  // QA dynamique 2026-09-26 (P5) : monté en préfixe sur /api/slips et /api/chat,
  // il comptait les GET — la liste des coupons renvoyait 429 à la 31e lecture.
  it('ne compte pas les lectures, compte les écritures', async () => {
    const { default: express } = await import('express');
    const { default: request } = await import('supertest');
    const { writeLimiter } = await import('./rateLimit.middleware');
    const app = express();
    app.use('/w', writeLimiter, (_req, res) => { res.status(200).end(); });
    const limit = Number((await request(app).post('/w')).headers['ratelimit-limit'] ?? 500);

    for (let i = 0; i < limit + 5; i++) {
      expect((await request(app).get('/w')).status).toBe(200);
    }
    let last = 0;
    for (let i = 0; i < limit; i++) last = (await request(app).post('/w')).status;
    expect(last).toBe(429);
  });
});
