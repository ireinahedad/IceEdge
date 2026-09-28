import { describe, it, expect, vi, beforeEach } from 'vitest';

// Bords de `submitSlip` : la base, l'API NHL et le réveil du règlement.
const { query, fetchGame } = vi.hoisted(() => ({
  query:     vi.fn(async () => ({ rows: [{ id: 'slip-1' }] })),
  fetchGame: vi.fn(),
}));
vi.mock('../db/connection', () => ({ pool: { query } }));
vi.mock('./nhlApiClient', () => ({ fetchGameById: fetchGame }));
vi.mock('./settlement.service', () => ({ notifySlipPlaced: vi.fn() }));

import { xpForOutcome, submitSlip } from './slip.service';

// Settlement math is a money path — pin the risk-based XP formula so a refactor
// can't silently change payouts. (Pure function, no DB.)
describe('xpForOutcome', () => {
  it('awards more XP for riskier (lower-probability) wins', () => {
    expect(xpForOutcome('win', 20)).toBeGreaterThan(xpForOutcome('win', 80));
  });

  it('floors a win at +10 XP even for near-certain bets', () => {
    expect(xpForOutcome('win', 99)).toBe(10);
  });

  it('penalises safe losses more, flooring at -5', () => {
    expect(xpForOutcome('loss', 10)).toBe(-5);   // -max(5, round(10/2)) = -5
    expect(xpForOutcome('loss', 80)).toBe(-40);  // -max(5, round(80/2)) = -40
  });

  it('defaults to 50% when probability is null', () => {
    expect(xpForOutcome('win', null)).toBe(100); // round((100-50)*2) = 100
  });

  it('clamps out-of-range probabilities into 1..99', () => {
    expect(xpForOutcome('win', 0)).toBe(xpForOutcome('win', 1));
    expect(xpForOutcome('win', 150)).toBe(xpForOutcome('win', 99));
  });
});

// Pas de pari sur un match commencé (2026-09-28) : une jambe posée en direct
// gardait sa probabilité d'avant-match, donc un XP quasi garanti.
describe('submitSlip — match déjà commencé', () => {
  const leg = (gameId: string, selection = 'MTL to win') => ({
    marketType: 'moneyline', subjectId: 'mtl', subjectName: 'MTL', subjectLogo: '',
    selection, probability: 40, oddsLabel: '+150', gameId, selectionValue: 'mtl',
  });
  const HOUR = 3_600_000;
  beforeEach(() => { query.mockClear(); fetchGame.mockReset(); });

  it('accepte un match à venir', async () => {
    fetchGame.mockResolvedValue({ status: 'scheduled', startTimeUTC: new Date(Date.now() + HOUR).toISOString() });
    await expect(submitSlip('u1', [leg('g1')] as any)).resolves.toBe('slip-1');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('refuse (409 GAME_STARTED) un match en cours, sans rien insérer', async () => {
    fetchGame.mockResolvedValue({ status: 'live', startTimeUTC: new Date(Date.now() - HOUR).toISOString() });
    await expect(submitSlip('u1', [leg('g1')] as any)).rejects.toMatchObject({ status: 409, code: 'GAME_STARTED' });
    expect(query).not.toHaveBeenCalled();
  });

  it("refuse dès l'heure prévue atteinte, même si la LNH dit encore « scheduled »", async () => {
    fetchGame.mockResolvedValue({ status: 'scheduled', startTimeUTC: new Date(Date.now() - 60_000).toISOString() });
    await expect(submitSlip('u1', [leg('g1')] as any)).rejects.toMatchObject({ code: 'GAME_STARTED' });
  });

  it('refuse un coupon dont UNE seule jambe est commencée, et la nomme', async () => {
    fetchGame.mockImplementation(async (id: string) => id === 'g2'
      ? { status: 'final', startTimeUTC: new Date(Date.now() - 4 * HOUR).toISOString() }
      : { status: 'scheduled', startTimeUTC: new Date(Date.now() + HOUR).toISOString() });
    await expect(submitSlip('u1', [leg('g1'), leg('g2', 'TOR to win')] as any))
      .rejects.toThrow(/TOR to win/);
    expect(query).not.toHaveBeenCalled();
  });

  it("laisse passer si l'API NHL ne répond pas (ouvert en panne, à dessein)", async () => {
    fetchGame.mockRejectedValue(new Error('NHL down'));
    await expect(submitSlip('u1', [leg('g1')] as any)).resolves.toBe('slip-1');
  });
});
