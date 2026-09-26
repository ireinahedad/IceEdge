import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * `PATCH /users/:id` — admin seulement (QA dynamique 2026-09-26, S1.5).
 *
 * Ouverte au propriétaire, la route changeait l'email sans vérification : un
 * jeton d'accès volé suffisait à poser l'adresse de l'attaquant, puis à
 * réinitialiser le mot de passe par « mot de passe oublié ».
 */

const mockAuth = { verifyAccessToken: vi.fn() };
const mockUsers = { updateUser: vi.fn() };

vi.mock('../services/auth.service', () => mockAuth);
vi.mock('../services/user.service', () => mockUsers);
vi.mock('../services/accountDeletion.service', () => ({ deleteAccount: vi.fn() }));
vi.mock('../services/subscription.service', () => ({ isPro: vi.fn() }));

async function userApp() {
  const { default: routes } = await import('./user.routes');
  const a = express();
  a.use(express.json());
  a.use('/api/users', routes);
  return a;
}

const AUTH = { Authorization: 'Bearer token' };
const asUser  = () => mockAuth.verifyAccessToken.mockReturnValue({ sub: 'u1', email: 'a@b.com', role: 'user' });
const asAdmin = () => mockAuth.verifyAccessToken.mockReturnValue({ sub: 'adm', email: 'x@y.com', role: 'admin' });

describe('PATCH /users/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsers.updateUser.mockResolvedValue({ id: 'u1' });
  });

  it('refusé au propriétaire lui-même (changement d’email sans vérification)', async () => {
    asUser();
    const res = await request(await userApp()).patch('/api/users/u1').set(AUTH).send({ email: 'evil@x.com' });
    expect(res.status).toBe(403);
    expect(mockUsers.updateUser).not.toHaveBeenCalled();
  });

  it('permis à l’admin', async () => {
    asAdmin();
    const res = await request(await userApp()).patch('/api/users/u1').set(AUTH).send({ first_name: 'Ann' });
    expect(res.status).toBe(200);
    expect(mockUsers.updateUser).toHaveBeenCalledWith('u1', { first_name: 'Ann' });
  });

  it('champ inconnu (role) refusé, même pour l’admin', async () => {
    asAdmin();
    const res = await request(await userApp()).patch('/api/users/u1').set(AUTH).send({ role: 'admin' });
    expect(res.status).toBe(400);
    expect(mockUsers.updateUser).not.toHaveBeenCalled();
  });

  it('email déjà pris → 409, pas 500', async () => {
    asAdmin();
    mockUsers.updateUser.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));
    const res = await request(await userApp()).patch('/api/users/u1').set(AUTH).send({ email: 'taken@x.com' });
    expect(res.status).toBe(409);
  });
});
