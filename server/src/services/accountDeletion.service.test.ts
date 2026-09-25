import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * L'ordre des opérations est ce qui compte ici :
 *   • Stripe d'abord — s'il refuse, aucune requête d'effacement n'est lancée ;
 *   • messages de chat supprimés explicitement (leur clé étrangère est
 *     `SET NULL`, la cascade ne les emporterait pas), dans la même transaction
 *     que le compte ;
 *   • avatar R2 seulement après le COMMIT.
 */

const queries: string[] = [];
const client = {
  query: vi.fn(async (sql: string) => {
    queries.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
    if (sql.includes('SELECT u.avatar_url')) {
      return { rows: selectRows, rowCount: selectRows.length };
    }
    return { rows: [], rowCount: 2 };
  }),
  release: vi.fn(),
};
let selectRows: any[] = [];

const cancelStripe = vi.fn();
const deleteAvatar = vi.fn();

vi.mock('../db/connection', () => ({ pool: { connect: vi.fn(async () => client) } }));
vi.mock('./subscription.service', () => ({ cancelStripeForAccountDeletion: cancelStripe }));
vi.mock('./avatarStorage', () => ({ deleteAvatarByUrl: deleteAvatar }));

describe('deleteAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queries.length = 0;
    selectRows = [{ userAvatar: 'https://r2/avatars/u1/a.webp', profileAvatar: 'https://r2/avatars/u1/a.webp' }];
    cancelStripe.mockResolvedValue(undefined);
    deleteAvatar.mockResolvedValue(undefined);
  });

  it('annule Stripe, efface chat + compte dans une transaction, puis l\'avatar', async () => {
    const { deleteAccount } = await import('./accountDeletion.service');
    await deleteAccount('u1');

    expect(cancelStripe).toHaveBeenCalledWith('u1');
    expect(queries).toEqual([
      'BEGIN',
      'SELECT u.avatar_url AS',
      'DELETE FROM chat_messages',
      'DELETE FROM users',
      'COMMIT',
    ]);
    expect(cancelStripe.mock.invocationCallOrder[0]).toBeLessThan(client.query.mock.invocationCallOrder[0]);
    // Même URL sur les deux colonnes : une seule suppression.
    expect(deleteAvatar).toHaveBeenCalledTimes(1);
    expect(deleteAvatar).toHaveBeenCalledWith('u1', 'https://r2/avatars/u1/a.webp');
    expect(client.release).toHaveBeenCalled();
  });

  it('Stripe refuse : rien n\'est effacé', async () => {
    cancelStripe.mockRejectedValue(Object.assign(new Error('stripe down'), { status: 502 }));
    const { deleteAccount } = await import('./accountDeletion.service');

    await expect(deleteAccount('u1')).rejects.toMatchObject({ status: 502 });
    expect(client.query).not.toHaveBeenCalled();
    expect(deleteAvatar).not.toHaveBeenCalled();
  });

  it('compte introuvable : 404, ROLLBACK, aucun DELETE', async () => {
    selectRows = [];
    const { deleteAccount } = await import('./accountDeletion.service');

    await expect(deleteAccount('u1')).rejects.toMatchObject({ status: 404 });
    expect(queries).toContain('ROLLBACK');
    expect(queries.some((q) => q.startsWith('DELETE'))).toBe(false);
    expect(deleteAvatar).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalled();
  });
});
