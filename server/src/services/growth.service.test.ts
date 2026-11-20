import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * growth.service (migration 055) : la mesure ne doit JAMAIS casser une requête,
 * et `touchActivity` ne doit écrire qu'une fois par compte et par jour — sinon
 * chaque requête authentifiée coûterait une écriture Neon.
 */

async function load(query: ReturnType<typeof vi.fn>) {
  vi.resetModules();
  vi.doMock('../db/connection', () => ({ pool: { query } }));
  vi.doMock('../logger', () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));
  return import('./growth.service');
}

describe('growth.service', () => {
  let query: ReturnType<typeof vi.fn>;
  beforeEach(() => { query = vi.fn(async () => ({ rowCount: 1, rows: [] })); });

  it('touchActivity écrit une seule fois par compte et par jour', async () => {
    const g = await load(query);
    g.touchActivity('u1');
    g.touchActivity('u1');
    g.touchActivity('u1');
    g.touchActivity('u2');
    await Promise.resolve();
    const inserts = query.mock.calls.filter(([sql]) => String(sql).includes('user_activity_days'));
    expect(inserts).toHaveLength(2);
  });

  it('trackEvent ignore un nom hors liste blanche', async () => {
    const g = await load(query);
    await g.trackEvent('u1', 'drop_table' as never);
    expect(query).not.toHaveBeenCalled();
  });

  it('trackEvent ne lève pas si la table manque (migration non appliquée)', async () => {
    query.mockRejectedValue(Object.assign(new Error('relation "product_events" does not exist'), { code: '42P01' }));
    const g = await load(query);
    await expect(g.trackEvent('u1', 'trial_started')).resolves.toBeUndefined();
  });

  it('trackEvent ne garde que des propriétés plates et courtes', async () => {
    const g = await load(query);
    await g.trackEvent('u1', 'checkout_started', { period: 'monthly', nested: { a: 1 }, 'bad key!': 'x', long: 'y'.repeat(500) });
    const props = JSON.parse(query.mock.calls[0][1][2]);
    expect(props).toEqual({ period: 'monthly', long: 'y'.repeat(120) });
  });

  it('saveSignupSource refuse une source vide et nettoie les valeurs', async () => {
    const g = await load(query);
    expect(await g.saveSignupSource('u1', { source: '' })).toBe(false);
    expect(query).not.toHaveBeenCalled();
    await g.saveSignupSource('u1', { source: 'YouTube<script>', campaign: 'Daily Parlays' });
    const params = query.mock.calls[0][1];
    expect(params[1]).toBe('youtubescript');
    expect(params[3]).toBe('dailyparlays');
  });
});
