import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * trialLifecycle : un courriel par compte et par type, jamais deux, et une
 * panne d'envoi ne doit pas « consommer » le courriel (la réservation est
 * retirée pour qu'il reparte au passage suivant).
 */

const target = { id: 'u1', email: 'a@example.com', first_name: 'Ana' };

async function load(opts: { sendFails?: boolean } = {}) {
  vi.resetModules();
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM subscriptions s')) {
      // Fenêtre « bientôt fini » seulement : un compte à prévenir.
      return { rows: String(sql).includes("+ INTERVAL '30 hours'") && params[0] === 'email_trial_ending' ? [target] : [] };
    }
    if (sql.startsWith('INSERT INTO product_events')) return { rows: [{ id: '42' }] };
    return { rows: [], rowCount: 1 };
  });
  const ending = vi.fn(async () => { if (opts.sendFails) throw new Error('resend down'); });
  const ended = vi.fn(async () => {});
  vi.doMock('../db/connection', () => ({ pool: { query } }));
  vi.doMock('../logger', () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));
  vi.doMock('./jobLock', () => ({ withJobLock: vi.fn() }));
  vi.doMock('./email.service', () => ({ sendTrialEndingEmail: ending, sendTrialEndedEmail: ended }));
  const mod = await import('./trialLifecycle.service');
  return { mod, query, ending, ended };
}

describe('trialLifecycle', () => {
  beforeEach(() => { delete process.env.TRIAL_EMAILS_ENABLED; });

  it('envoie le courriel « se termine demain » et le réserve avant l’envoi', async () => {
    const { mod, query, ending, ended } = await load();
    const sent = await mod.runTrialLifecycle();
    expect(sent).toEqual({ ending: 1, ended: 0 });
    expect(ending).toHaveBeenCalledWith('a@example.com', 'Ana');
    expect(ended).not.toHaveBeenCalled();
    const order = query.mock.calls.map(([sql]) => String(sql).slice(0, 30));
    expect(order.findIndex((s) => s.startsWith('INSERT INTO product_events'))).toBeGreaterThan(-1);
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('DELETE FROM product_events'))).toBe(false);
  });

  it('retire la réservation si l’envoi échoue', async () => {
    const { mod, query } = await load({ sendFails: true });
    const sent = await mod.runTrialLifecycle();
    expect(sent).toEqual({ ending: 0, ended: 0 });
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('DELETE FROM product_events'))).toBe(true);
  });

  it('reste éteint sans TRIAL_EMAILS_ENABLED=true', async () => {
    const { mod } = await load();
    expect(mod.trialEmailsEnabled()).toBe(false);
    expect(mod.startTrialLifecycleJob()).toBeNull();
  });
});
