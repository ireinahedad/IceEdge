import { describe, it, expect } from 'vitest';
import { scrubEvent } from './instrument';

// QA dynamique 2026-09-26 : les événements Sentry portaient le jeton d'accès
// (`authorization`) et le refresh token (`cookie: ice_refresh=…`).
describe('scrubEvent', () => {
  it('retire les en-têtes qui portent un secret, quelle que soit la casse', () => {
    const ev = scrubEvent({
      request: {
        headers: {
          Authorization: 'Bearer eyJ…', cookie: 'ice_refresh=abc', 'X-ML-Token': 't',
          'stripe-signature': 's', 'user-agent': 'curl', host: 'api',
        },
        cookies: { ice_refresh: 'abc' },
      },
    });
    const h = ev.request.headers;
    expect(h.Authorization).toBe('[Filtered]');
    expect(h.cookie).toBe('[Filtered]');
    expect(h['X-ML-Token']).toBe('[Filtered]');
    expect(h['stripe-signature']).toBe('[Filtered]');
    expect(h['user-agent']).toBe('curl');
    expect(ev.request.cookies).toEqual({});
    expect(JSON.stringify(ev)).not.toContain('abc');
  });

  it('laisse passer un événement sans requête', () => {
    expect(scrubEvent({ message: 'x' } as any)).toEqual({ message: 'x' });
  });
});
