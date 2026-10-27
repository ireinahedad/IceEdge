import { describe, it, expect, beforeEach, vi } from 'vitest';
import { consumeScan, refundScan, getScanUsage, SCAN_FREE_DAILY } from './scanQuota.service';

/** D2 (tranché 2026-10-27) : 3 scans gratuits par jour UTC, illimité en Pro. */

const rows = new Map<string, number>();
let down = false;
const query = vi.fn(async (sql: string, params: any[] = []) => {
  if (down) throw new Error('db down');
  const key = `${params[0]}|${params[1]}`;
  if (sql.includes('INSERT INTO slip_scan_daily')) {
    const cur = rows.get(key);
    if (cur === undefined) { rows.set(key, 1); return { rowCount: 1, rows: [{ count: 1 }] }; }
    if (cur >= Number(params[2])) return { rowCount: 0, rows: [] };   // WHERE count < limite fausse
    rows.set(key, cur + 1);
    return { rowCount: 1, rows: [{ count: cur + 1 }] };
  }
  if (sql.includes('UPDATE slip_scan_daily')) {
    rows.set(key, Math.max((rows.get(key) ?? 0) - 1, 0));
    return { rowCount: 1, rows: [] };
  }
  if (sql.includes('SELECT count FROM slip_scan_daily')) {
    const c = rows.get(key);
    return { rowCount: c == null ? 0 : 1, rows: c == null ? [] : [{ count: c }] };
  }
  throw new Error(`requête inattendue : ${sql}`);
});
vi.mock('../db/connection', () => ({ pool: { query: (...a: any[]) => (query as any)(...a) } }));
vi.mock('../logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));


const DAY1 = new Date('2026-10-27T10:00:00Z');
const DAY2 = new Date('2026-10-28T00:00:01Z');

beforeEach(() => { rows.clear(); down = false; query.mockClear(); });

describe('scanQuota', () => {
  it('3 par défaut', () => expect(SCAN_FREE_DAILY).toBe(3));

  it('3 scans gratuits, le 4e refusé, remis à zéro le lendemain (UTC)', async () => {
    for (let i = 1; i <= 3; i++) {
      const v = await consumeScan('u1', false, DAY1);
      expect(v).toMatchObject({ allowed: true, pro: false, used: i, limit: 3 });
    }
    const v4 = await consumeScan('u1', false, DAY1);
    expect(v4).toMatchObject({ allowed: false, reason: 'user', used: 3, limit: 3 });
    expect(v4.resetsAt).toBe('2026-10-28T00:00:00.000Z');
    expect((await consumeScan('u1', false, DAY2)).allowed).toBe(true);
  });

  it('chaque compte a son propre compteur', async () => {
    for (let i = 0; i < 3; i++) await consumeScan('u1', false, DAY1);
    expect((await consumeScan('u2', false, DAY1)).allowed).toBe(true);
  });

  it('Pro : illimité, rien n’est compté', async () => {
    for (let i = 0; i < 10; i++) expect((await consumeScan('u1', true, DAY1))).toMatchObject({ allowed: true, pro: true, limit: null });
    expect(query).not.toHaveBeenCalled();
  });

  it('remboursement : un scan rendu redevient disponible, jamais sous zéro', async () => {
    for (let i = 0; i < 3; i++) await consumeScan('u1', false, DAY1);
    await refundScan('u1', DAY1);
    expect((await consumeScan('u1', false, DAY1)).allowed).toBe(true);
    await refundScan('u9', DAY1);
    expect(rows.get('u9|2026-10-27')).toBe(0);
  });

  it('usage du jour', async () => {
    expect(await getScanUsage('u1', false, DAY1)).toMatchObject({ used: 0, limit: 3, remaining: 3 });
    await consumeScan('u1', false, DAY1);
    expect(await getScanUsage('u1', false, DAY1)).toMatchObject({ used: 1, remaining: 2 });
    expect(await getScanUsage('u1', true, DAY1)).toMatchObject({ pro: true, limit: null, remaining: null });
  });

  it('base injoignable → refusé (pas d’accès gratuit à l’aveugle)', async () => {
    down = true;
    expect(await consumeScan('u1', false, DAY1)).toMatchObject({ allowed: false, reason: 'db' });
  });
});
