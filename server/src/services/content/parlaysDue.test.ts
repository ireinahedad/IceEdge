import { describe, it, expect } from 'vitest';

/**
 * « Est-ce l'heure ? » — `scripts/parlays-due.mjs`, lancé toutes les 30 min
 * par le workflow avant toute installation (MARKETING_PLAN Phase D).
 */

// Module ESM sans types, hors de `src` : chargé dynamiquement.
const load = () => import('../../../scripts/parlays-due.mjs' as string) as Promise<any>;

const starts = ['2026-10-23T23:00:00Z', '2026-10-24T02:00:00Z'];   // 19:00 ET et 22:00 ET
const at = (iso: string) => new Date(iso);

describe('parlays-due — pick', () => {
  it('gel à partir de 06:00 UTC du jour NHL (14 h à Bali) ; non une fois tout commencé', async () => {
    const { decide } = await load();
    const date = '2026-10-23';
    expect(decide({ mode: 'pick', now: at('2026-10-23T05:59:00Z'), date, starts, parlays: [] }).due).toBe(false);
    expect(decide({ mode: 'pick', now: at('2026-10-23T06:00:00Z'), date, starts, parlays: [] }).due).toBe(true);
    expect(decide({ mode: 'pick', now: at('2026-10-23T21:00:00Z'), date, starts, parlays: [] }).due).toBe(true);
    expect(decide({ mode: 'pick', now: at('2026-10-24T01:30:00Z'), date, starts, parlays: [] }).due).toBe(true);
    expect(decide({ mode: 'pick', now: at('2026-10-24T02:00:00Z'), date, starts, parlays: [] }).due).toBe(false);
  });

  it('06:00 UTC reste 14 h à Bali en heure normale de l’Est (après le 1er nov.)', async () => {
    const { freezeOpensAt } = await load();
    const t = freezeOpensAt('2026-11-10');
    expect(new Date(t).toLocaleString('en-GB', { timeZone: 'Asia/Makassar', hour: '2-digit', minute: '2-digit' })).toBe('14:00');
    expect(new Date(t).toLocaleString('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })).toBe('2026-11-10');
  });

  it('aucun match → non', async () => {
    const { decide } = await load();
    expect(decide({ mode: 'pick', now: at('2026-10-23T21:00:00Z'), date: '2026-10-23', starts: [], parlays: [] }))
      .toMatchObject({ due: false, reason: 'aucun match ce jour-là' });
  });

  it('déjà gelé mais publication incomplète → on reprend, même hors fenêtre', async () => {
    const { decide } = await load();
    const parlays = [{ youtubePickId: 'abc', tiktokPickSentAt: null }];
    expect(decide({ mode: 'pick', now: at('2026-10-24T03:00:00Z'), starts: [], parlays }).due).toBe(true);
  });

  it('tout publié → non', async () => {
    const { decide } = await load();
    const parlays = [{ youtubePickId: 'a', tiktokPickSentAt: 'x' }, { youtubePickId: 'a', tiktokPickSentAt: 'x' }];
    expect(decide({ mode: 'pick', now: at('2026-10-23T21:00:00Z'), starts, parlays }).due).toBe(false);
  });
});

describe('parlays-due — result', () => {
  it('combinés de la veille non publiés → oui ; rien de gelé → non ; publié → non', async () => {
    const { decide } = await load();
    const now = at('2026-10-24T13:15:00Z');
    expect(decide({ mode: 'result', now, starts: [], parlays: [{ youtubeResultId: null }] }).due).toBe(true);
    expect(decide({ mode: 'result', now, starts: [], parlays: [] }).due).toBe(false);
    expect(decide({ mode: 'result', now, starts: [], parlays: [{ youtubeResultId: 'v', tiktokResultSentAt: 't' }] }).due).toBe(false);
  });
});

describe('etDay', () => {
  it('jour NHL de l’Est, décalable', async () => {
    const { etDay } = await load();
    expect(etDay(at('2026-10-24T02:00:00Z'))).toBe('2026-10-23');
    expect(etDay(at('2026-10-24T02:00:00Z'), -1)).toBe('2026-10-22');
  });
});
