import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/connection', () => ({ pool: { query: vi.fn() } }));
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('./jobLock', () => ({ withJobLock: vi.fn(), getJobState: vi.fn(), setJobState: vi.fn() }));
vi.mock('./valueBets.service', () => ({ getCurrentValueBets: vi.fn() }));
vi.mock('./push.service', () => ({ sendToUsers: vi.fn(), pushEnabled: () => true }));
vi.mock('./nhlApiClient', () => ({ fetchGamesByDate: vi.fn() }));

import { inScanWindow } from './valueBetScan.service';

const T = (iso: string) => Date.parse(iso);
// 19:00 ET et 22:00 ET le 2026-10-30 (EDT = UTC−4).
const starts = [T('2026-10-30T23:00:00Z'), T('2026-10-31T02:00:00Z')];

describe('inScanWindow', () => {
  it('is closed on a day without games', () => {
    expect(inScanWindow(T('2026-10-30T18:00:00Z'), [])).toBe(false);
  });
  it('is closed overnight, before 7 h ahead of the first puck drop', () => {
    expect(inScanWindow(T('2026-10-30T15:59:00Z'), starts)).toBe(false);
  });
  it('opens 7 h before the first game (noon ET)', () => {
    expect(inScanWindow(T('2026-10-30T16:00:00Z'), starts)).toBe(true);
  });
  it('stays open until the last puck drop, then closes', () => {
    expect(inScanWindow(T('2026-10-31T01:59:00Z'), starts)).toBe(true);
    expect(inScanWindow(T('2026-10-31T02:00:00Z'), starts)).toBe(false);
  });
});
