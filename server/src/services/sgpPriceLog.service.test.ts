import { describe, it, expect, beforeEach, vi } from 'vitest';
import { toRow, logSgpPrices, hourOf, sgpPriceLogSchema } from './sgpPriceLog.service';

/** Journal anonyme des prix SGP : rien de l'utilisateur, heure arrondie, dédoublonnage par empreinte. */

const calls: { sql: string; params: any[] }[] = [];
let down = false;
vi.mock('../db/connection', () => ({
  pool: { query: async (sql: string, params: any[]) => { if (down) throw new Error('db down'); calls.push({ sql, params }); return { rowCount: 1, rows: [] }; } },
}));
vi.mock('../logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));


const group = (over: Record<string, unknown> = {}) => ({
  gameId: '2025020123', odds: '+600', modelPct: 10.5, modelSource: 'server' as const,
  legs: [
    { market: 'moneyline', subjectType: 'team' as const, subjectId: 'tor', selection: 'tor', modelPct: 55 },
    { market: 'goals_ou', subjectType: 'game' as const, subjectId: '2025020123', selection: 'over', line: 6.5, modelPct: 40 },
    { market: 'player_goals', subjectType: 'player' as const, subjectId: '8479318', selection: 'yes', line: 0.5, modelPct: 38 },
  ],
  ...over,
});
const body = (groups = [group()]) => ({ book: 'draftkings' as const, lang: 'en' as const, oddsFormat: 'american' as const, groups });
const NOW = new Date('2026-10-28T23:47:12.345Z');

beforeEach(() => { calls.length = 0; down = false; });

describe('toRow', () => {
  it('recalcule cote décimale, implicite, taxe et produit naïf', () => {
    const r = toRow(body(), group(), NOW)!;
    expect(r.paidDecimal).toBe(7);
    expect(r.impliedPct).toBe(14.3);
    expect(r.taxPct).toBe(26.5);             // 1 − 0.105 × 7
    expect(r.independentPct).toBeCloseTo(8.36, 2); // 55 % × 40 % × 38 %
    expect(r.marketKey).toBe('goals_ou+moneyline+player_goals');
    expect(r.nLegs).toBe(3);
  });

  it('heure arrondie, aucun champ qui désigne une personne', () => {
    const r = toRow(body(), group(), NOW)!;
    expect(r.loggedHour).toBe('2026-10-28T23:00:00.000Z');
    expect(hourOf(NOW)).toBe('2026-10-28T23:00:00.000Z');
    expect(Object.keys(r).some((k) => /user|ip|email|stake|payout/i.test(k))).toBe(false);
  });

  it('même SGP, jambes dans un autre ordre → même empreinte ; autre prix → autre empreinte', () => {
    const a = toRow(body(), group(), NOW)!;
    const b = toRow(body(), group({ legs: [...group().legs].reverse() }), NOW)!;
    const c = toRow(body(), group({ odds: '+650' }), NOW)!;
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(c.fingerprint).not.toBe(a.fingerprint);
  });

  it('cote illisible → null', () => {
    expect(toRow(body(), group({ odds: 'abc' }), NOW)).toBeNull();
  });
});

describe('sgpPriceLogSchema', () => {
  it('refuse un groupe d’une seule jambe et les champs inconnus ne passent pas', () => {
    expect(sgpPriceLogSchema.safeParse(body([group({ legs: [group().legs[0]] })])).success).toBe(false);
    const p = sgpPriceLogSchema.parse({ ...body(), userId: 'u1', stake: 20 } as any);
    expect('userId' in p || 'stake' in p).toBe(false);
  });
});

describe('logSgpPrices', () => {
  it('écrit une ligne par SGP, ON CONFLICT → seen_count', async () => {
    const r = await logSgpPrices(body([group(), group({ odds: 'x' })]), NOW);
    expect(r).toEqual({ logged: 1, skipped: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('ON CONFLICT (fingerprint)');
    expect(calls[0].sql).not.toMatch(/user_id/);
  });

  it('base injoignable → rien ne lève', async () => {
    down = true;
    await expect(logSgpPrices(body(), NOW)).resolves.toEqual({ logged: 0, skipped: 1 });
  });
});
