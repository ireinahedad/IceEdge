import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Suppression de compte — Guideline 5.1.1(v).
 *
 * Ce qui est verrouillé ici est le câblage HTTP, les services sont bouchonnés :
 *   1. pas de jeton → 401, rien n'est supprimé ;
 *   2. reconfirmation refusée → rien n'est supprimé ;
 *   3. la cible est toujours le porteur du jeton, jamais une valeur du corps ;
 *   4. `DELETE /users/:id` n'est plus ouvert au propriétaire (contournement de
 *      la reconfirmation), seulement à l'admin.
 */

const mockAuth = {
  verifyAccessToken: vi.fn(),
  startReauth:       vi.fn(),
  confirmIdentity:   vi.fn(),
};
const mockDeletion = { deleteAccount: vi.fn() };

vi.mock('../services/auth.service', () => mockAuth);
vi.mock('../services/accountDeletion.service', () => mockDeletion);
vi.mock('../services/user.service', () => ({}));
vi.mock('../services/subscription.service', () => ({ isPro: vi.fn() }));

async function userApp() {
  const { default: routes } = await import('./user.routes');
  const a = express();
  a.use(express.json());
  a.use('/api/users', routes);
  return a;
}

const AUTH = { Authorization: 'Bearer token' };

describe('suppression de compte', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.verifyAccessToken.mockReturnValue({ sub: 'u1', email: 'a@b.com', role: 'user' });
    mockAuth.confirmIdentity.mockResolvedValue(undefined);
    mockDeletion.deleteAccount.mockResolvedValue(undefined);
  });

  it('sans jeton : 401 et rien n\'est supprimé', async () => {
    const res = await request(await userApp()).delete('/api/users/me').send({ password: 'x' });
    expect(res.status).toBe(401);
    expect(mockDeletion.deleteAccount).not.toHaveBeenCalled();
  });

  it('POST /me/deletion renvoie la méthode de reconfirmation du porteur', async () => {
    mockAuth.startReauth.mockResolvedValue({ method: 'code' });
    const res = await request(await userApp()).post('/api/users/me/deletion').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ method: 'code' });
    expect(mockAuth.startReauth).toHaveBeenCalledWith('u1');
  });

  it('mot de passe faux : 403 (pas 401, voir confirmIdentity), compte intact', async () => {
    mockAuth.confirmIdentity.mockRejectedValue(
      Object.assign(new Error('Incorrect password'), { status: 403, code: 'REAUTH_FAILED' }),
    );
    const res = await request(await userApp()).delete('/api/users/me').set(AUTH).send({ password: 'faux' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('REAUTH_FAILED');
    expect(mockDeletion.deleteAccount).not.toHaveBeenCalled();
  });

  it('reconfirmé : 204, et la cible est le porteur du jeton — pas le corps', async () => {
    const res = await request(await userApp())
      .delete('/api/users/me')
      .set(AUTH)
      .send({ password: 'bon', id: 'quelqu-un-d-autre', userId: 'autre' });
    expect(res.status).toBe(204);
    expect(mockAuth.confirmIdentity).toHaveBeenCalledWith('u1', { password: 'bon', code: undefined });
    expect(mockDeletion.deleteAccount).toHaveBeenCalledWith('u1');
    // La preuve est vérifiée AVANT la suppression.
    expect(mockAuth.confirmIdentity.mock.invocationCallOrder[0])
      .toBeLessThan(mockDeletion.deleteAccount.mock.invocationCallOrder[0]);
  });

  it('code de courriel : transmis nettoyé des espaces', async () => {
    const res = await request(await userApp()).delete('/api/users/me').set(AUTH).send({ code: ' 123456 ' });
    expect(res.status).toBe(204);
    expect(mockAuth.confirmIdentity).toHaveBeenCalledWith('u1', { password: undefined, code: '123456' });
  });

  it('un corps non textuel ne passe pas pour une preuve', async () => {
    await request(await userApp()).delete('/api/users/me').set(AUTH).send({ password: { $ne: null } });
    expect(mockAuth.confirmIdentity).toHaveBeenCalledWith('u1', { password: undefined, code: undefined });
  });

  it('échec Stripe : l\'erreur remonte telle quelle (502), le client peut réessayer', async () => {
    mockDeletion.deleteAccount.mockRejectedValue(
      Object.assign(new Error('Impossible d\'annuler'), { status: 502, code: 'STRIPE_CANCEL_FAILED' }),
    );
    const res = await request(await userApp()).delete('/api/users/me').set(AUTH).send({ password: 'bon' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('STRIPE_CANCEL_FAILED');
  });

  it('DELETE /users/:id : refusé au propriétaire lui-même', async () => {
    const res = await request(await userApp()).delete('/api/users/u1').set(AUTH);
    expect(res.status).toBe(403);
    expect(mockDeletion.deleteAccount).not.toHaveBeenCalled();
  });

  it('DELETE /users/:id : permis à l\'admin, sans reconfirmation', async () => {
    mockAuth.verifyAccessToken.mockReturnValue({ sub: 'admin1', email: 'x@y.com', role: 'admin' });
    const res = await request(await userApp()).delete('/api/users/u2').set(AUTH);
    expect(res.status).toBe(204);
    expect(mockDeletion.deleteAccount).toHaveBeenCalledWith('u2');
    expect(mockAuth.confirmIdentity).not.toHaveBeenCalled();
  });
});
