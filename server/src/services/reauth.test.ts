import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Reconfirmation d'identité avant suppression de compte.
 *
 * Un compte à mot de passe doit retaper son mot de passe (un code de courriel
 * ne le remplace pas) ; un compte Google n'en a pas et reçoit un code à usage
 * unique. `pool.query` est un mini-Postgres en mémoire qui ne connaît que les
 * énoncés utilisés ici — toute autre requête lève.
 */

const users: Record<string, any> = {};
let codes: any[] = [];
let seq = 0;

const query = vi.fn(async (sql: string, params: any[] = []) => {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s.startsWith('SELECT * FROM users WHERE id = $1')) {
    const u = users[params[0]];
    return { rows: u && u.is_active ? [u] : [] };
  }
  if (s.startsWith('UPDATE email_verification_codes SET consumed = TRUE WHERE user_id')) {
    codes.filter((c) => c.user_id === params[0] && c.purpose === params[1]).forEach((c) => { c.consumed = true; });
    return { rows: [] };
  }
  if (s.startsWith('INSERT INTO email_verification_codes')) {
    codes.push({ id: ++seq, user_id: params[0], code_hash: params[1], expires_at: params[2], purpose: params[3], consumed: false, attempts: 0, created_at: new Date(Date.now() + seq) });
    return { rows: [] };
  }
  if (s.startsWith('SELECT * FROM email_verification_codes')) {
    const rows = codes
      .filter((c) => c.user_id === params[0] && c.purpose === params[1] && !c.consumed)
      .sort((a, b) => b.created_at - a.created_at);
    return { rows: rows.slice(0, 1) };
  }
  if (s.startsWith('UPDATE email_verification_codes SET attempts')) {
    codes.find((c) => c.id === params[0]).attempts++;
    return { rows: [] };
  }
  if (s.startsWith('UPDATE email_verification_codes SET consumed = TRUE WHERE id')) {
    codes.find((c) => c.id === params[0]).consumed = true;
    return { rows: [] };
  }
  throw new Error(`requête inattendue : ${s}`);
});

const sendAccountDeletionCode = vi.fn(async (_to: string, _code: string) => {});

vi.mock('../db/connection', () => ({ pool: { query } }));
vi.mock('./email.service', () => ({
  sendVerificationCode: vi.fn(),
  sendPasswordResetCode: vi.fn(),
  sendAccountDeletionCode,
}));

describe('reconfirmation avant suppression', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    codes = [];
    const { hashPassword } = await import('./auth.service');
    users.pw = { id: 'pw', email: 'pw@x.com', first_name: null, is_active: true, password_hash: await hashPassword('motdepasse1') };
    users.gg = { id: 'gg', email: 'gg@x.com', first_name: null, is_active: true, password_hash: null };
  });

  it('compte à mot de passe : méthode « password », aucun courriel', async () => {
    const { startReauth } = await import('./auth.service');
    expect(await startReauth('pw')).toEqual({ method: 'password' });
    expect(sendAccountDeletionCode).not.toHaveBeenCalled();
  });

  it('compte à mot de passe : bon mot de passe accepté, mauvais ou absent refusé', async () => {
    const { confirmIdentity } = await import('./auth.service');
    await expect(confirmIdentity('pw', { password: 'motdepasse1' })).resolves.toBeUndefined();
    await expect(confirmIdentity('pw', { password: 'faux' })).rejects.toMatchObject({ status: 403, code: 'REAUTH_FAILED' });
    await expect(confirmIdentity('pw', {})).rejects.toMatchObject({ status: 403 });
  });

  it('compte à mot de passe : un code ne remplace pas le mot de passe', async () => {
    const { confirmIdentity } = await import('./auth.service');
    await expect(confirmIdentity('pw', { code: '123456' })).rejects.toMatchObject({ status: 403 });
  });

  it('compte Google : code envoyé par courriel, puis accepté une seule fois', async () => {
    const { startReauth, confirmIdentity } = await import('./auth.service');
    expect(await startReauth('gg')).toEqual({ method: 'code' });
    await vi.waitFor(() => expect(sendAccountDeletionCode).toHaveBeenCalled());

    const [to, code] = sendAccountDeletionCode.mock.calls[0];
    expect(to).toBe('gg@x.com');
    expect(codes[0].purpose).toBe('account_delete');

    await expect(confirmIdentity('gg', { code })).resolves.toBeUndefined();
    await expect(confirmIdentity('gg', { code })).rejects.toMatchObject({ status: 400 });
  });

  it('compte Google : mauvais code ou code absent refusé', async () => {
    const { startReauth, confirmIdentity } = await import('./auth.service');
    await startReauth('gg');
    const [, code] = await vi.waitFor(() => {
      expect(sendAccountDeletionCode).toHaveBeenCalled();
      return sendAccountDeletionCode.mock.calls[0];
    });
    const wrong = code === '000000' ? '111111' : '000000';
    await expect(confirmIdentity('gg', { code: wrong })).rejects.toMatchObject({ status: 400 });
    await expect(confirmIdentity('gg', {})).rejects.toMatchObject({ status: 403, code: 'REAUTH_FAILED' });
  });

  it('compte inexistant : 404', async () => {
    const { startReauth } = await import('./auth.service');
    await expect(startReauth('absent')).rejects.toMatchObject({ status: 404 });
  });
});
