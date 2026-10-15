import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Coupon d'un même match avec une jambe JOUEUR (piste 2) : « X marque » et
 * « son équipe gagne » ne sont plus multipliées comme si elles étaient
 * indépendantes — la loi jointe des scores fournit le facteur.
 */

const { engine } = vi.hoisted(() => ({
  engine: {
    isScoreDerivable: (m: string) => ['moneyline', 'total_goals', 'puck_line'].includes(m),
    predictGameLegCorrelation: vi.fn(async (_h: string, _a: string, _legs: unknown[], player?: unknown) =>
      ({ factor: player ? 1.3 : 1.05, joint: 0, independent: 0 })),
  },
}));
vi.mock('./predictionEngine', () => engine);

const { nhl } = vi.hoisted(() => ({
  nhl: {
    fetchGameById: vi.fn(async () => ({ homeTeam: { abbreviation: 'EDM' }, awayTeam: { abbreviation: 'CGY' } })),
    fetchPlayerById: vi.fn(async (id: string) => ({ id, teamAbbr: id === '97' || id === '29' ? 'EDM' : 'TOR' })),
  },
}));
vi.mock('./nhlApiClient', () => nhl);

import { computeParlayProbability, type WireParlayLeg } from './parlayProbability';

const win: WireParlayLeg = { marketType: 'moneyline', probability: 60, gameId: '2026020100',
  selection: 'edm', teamId: 'edm', opponentId: 'cgy', isHome: true, subjectType: 'team' };
const scores = (id = '97', o: Partial<WireParlayLeg> = {}): WireParlayLeg => ({
  marketType: 'anytime_goal', probability: 40, gameId: '2026020100', selection: 'yes', line: 0.5,
  teamId: id, subjectType: 'player', ...o });

beforeEach(() => { engine.predictGameLegCorrelation.mockClear(); });

describe('computeParlayProbability — jambe joueur dans la loi jointe', () => {
  it('« McDavid marque » + « Edmonton gagne » : facteur de la grille, plus le produit', async () => {
    const r = await computeParlayProbability([win, scores()]);
    expect(r.combinedProbability).toBeCloseTo(24, 6);
    expect(r.adjustedProbability).toBeCloseTo(31.2, 6);   // 24 % × 1,3
    expect(r.exactLegs).toBe(2);
    expect(r.assumesIndependence).toBe(false);
    const [h, a, legs, player] = engine.predictGameLegCorrelation.mock.calls[0];
    expect([h, a]).toEqual(['edm', 'cgy']);
    expect(legs).toHaveLength(1);
    // Camp lu sur le match ; cadence tirée du chiffre affiché : −ln(1 − 0,40).
    expect(player).toEqual({ isHome: true, rate: expect.closeTo(-Math.log(0.6), 9) });
  });

  it('jamais au-dessus de la jambe la moins probable', async () => {
    engine.predictGameLegCorrelation.mockResolvedValueOnce({ factor: 4, joint: 0, independent: 0 });
    const r = await computeParlayProbability([win, scores()]);
    expect(r.adjustedProbability).toBeCloseTo(40, 6);
  });

  it('« 1+ point » entre aussi ; « 2+ buts » reste au produit', async () => {
    await computeParlayProbability([win, scores('97', { marketType: 'points_ou', selection: 'over' })]);
    expect(engine.predictGameLegCorrelation.mock.calls[0][3]).toBeDefined();
    engine.predictGameLegCorrelation.mockClear();
    const two = await computeParlayProbability([win, scores('97', { line: 1.5 })]);
    expect(engine.predictGameLegCorrelation).not.toHaveBeenCalled();
    expect(two.adjustedProbability).toBeCloseTo(24, 6);
    expect(two.assumesIndependence).toBe(true);
  });

  it('une seule jambe joueur par match dans la grille ; la seconde au produit', async () => {
    const r = await computeParlayProbability([win, scores('97'), scores('29', { probability: 30 })]);
    expect(engine.predictGameLegCorrelation).toHaveBeenCalledTimes(1);
    expect(r.adjustedProbability).toBeCloseTo(Math.round(24 * 1.3 * 0.3 * 10) / 10, 6);
    expect(r.assumesIndependence).toBe(true);
  });

  it('joueur absent de ce match : sa jambe reste au produit, sans facteur joueur', async () => {
    const r = await computeParlayProbability([win, scores('16')]);   // joueur de TOR
    expect(engine.predictGameLegCorrelation).not.toHaveBeenCalled();
    expect(r.adjustedProbability).toBeCloseTo(24, 6);
    expect(r.assumesIndependence).toBe(true);
  });

  it('deux jambes de match + un buteur : les trois dans la grille', async () => {
    const over: WireParlayLeg = { marketType: 'total_goals', probability: 50, gameId: '2026020100',
      selection: 'over', line: 5.5, teamId: 'edm', opponentId: 'cgy', isHome: true, subjectType: 'game' };
    const r = await computeParlayProbability([win, over, scores()]);
    expect(r.exactLegs).toBe(3);
    expect(r.adjustedProbability).toBeCloseTo(12 * 1.3, 6);
  });
});
