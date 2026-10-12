import { describe, it, expect, vi } from 'vitest';

// `oddsLogger.service` importe la base et le client : on ne veut que `isValidTwoWay`.
vi.mock('../db/connection', () => ({ pool: { query: vi.fn() } }));
vi.mock('./oddsClient', () => ({
  ODDS_COLLECT_BOOKMAKERS: 'draftkings', ODDS_SHADOW_BOOKMAKERS: [], fetchCollectorOdds: vi.fn(),
}));
vi.mock('./oddsQuota', () => ({ collectorMaySpend: vi.fn(), remaining: vi.fn() }));

import { rebuildPrices, diffPrices, type SnapshotRow } from './oddsLogRepair';

const BOOKS = ['draftkings'];
const snap = (observed: string, ml: [number, number] | null, extra: Partial<SnapshotRow> = {}): SnapshotRow => ({
  game_date: '2026-10-03', home_team: 'NYI', away_team: 'NJD',
  observed_at: observed, commence_time: '2026-10-03T23:40:00Z', bookmaker: 'draftkings',
  home_ml: ml?.[0] ?? null, away_ml: ml?.[1] ?? null,
  total: null, total_over: null, total_under: null,
  puck_line_home: -1.5, pl_home_price: 2.9, pl_away_price: 1.45,
  ...extra,
});

describe('rebuildPrices — cas réels du 2026-10-03 (NYI–NJD)', () => {
  it('ouverture = 1re observation du JOUR, clôture = dernière AVANT la mise au jeu', () => {
    const r = rebuildPrices([
      // août, livre inconnu, trois issues : écarté (jour, livre, marge)
      snap('2026-08-31T15:00:08Z', [2.56, 2.49], { bookmaker: null }),
      snap('2026-10-03T15:00:00Z', [2.10, 1.76]),                        // 11 h ET
      snap('2026-10-03T22:45:00Z', [2.15, 1.72]),                        // 18 h 45 ET
      // 21 h 45 ET, match commencé (mise au jeu réelle 23:46:52Z) : écarté
      snap('2026-10-04T01:45:40Z', [1.0, 31.0], { commence_time: '2026-10-03T23:46:52Z' }),
    ], BOOKS);
    expect([r.home_ml_open, r.away_ml_open]).toEqual([2.10, 1.76]);
    expect([r.home_ml_close, r.away_ml_close]).toEqual([2.15, 1.72]);
    expect(r.puck_line_home).toBe(-1.5);
  });

  it("aucune observation valide le jour du match → prix NULL, pas le prix d'août", () => {
    const r = rebuildPrices([
      snap('2026-09-20T21:00:34Z', [2.35, 2.35], { bookmaker: null }),
    ], BOOKS);
    expect(r.home_ml_open).toBeNull();
    expect(r.home_ml_close).toBeNull();
    expect(r.pl_home_price).toBeNull();
  });

  it('livre parallèle et paire impossible écartés', () => {
    const r = rebuildPrices([
      snap('2026-10-03T15:00:00Z', [2.05, 2.65]),                                // marge 0.87
      snap('2026-10-03T21:00:00Z', [1.95, 1.90], { bookmaker: 'bet99_ca_on' }),  // pas le livre de collecte
      snap('2026-10-03T22:45:00Z', [1.95, 1.87]),
    ], BOOKS);
    expect([r.home_ml_open, r.home_ml_close]).toEqual([1.95, 1.95]);
  });

  it('diffPrices : liste les colonnes qui changent, NULL compris', () => {
    const current = { home_ml_open: '2.5600', away_ml_open: '2.4900', home_ml_close: '1.0000',
                      away_ml_close: '31.0000', puck_line_home: '-1.5', pl_home_price: '2.9',
                      pl_away_price: '1.45', pl_home_price_open: '2.9', pl_away_price_open: '1.45' };
    const r = rebuildPrices([snap('2026-10-03T22:45:00Z', [2.15, 1.72])], BOOKS);
    expect(diffPrices(current, r).sort()).toEqual(
      ['away_ml_close', 'away_ml_open', 'home_ml_close', 'home_ml_open'].sort());
  });
});
