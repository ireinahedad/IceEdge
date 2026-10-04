import { describe, it, expect, vi, beforeEach } from 'vitest';

const predictGameBundle = vi.fn();
const fetchTeamGoalies = vi.fn();
vi.mock('./mlApiClient', () => ({ mlApiClient: { predictGameBundle: (b: unknown) => predictGameBundle(b) } }));
vi.mock('./nhlApiClient', () => ({ fetchTeamGoalies: (a: string) => fetchTeamGoalies(a) }));
vi.mock('./gameMlBundle', () => ({
  modelMarket: (_id: string, p?: string) => p ?? 'moneyline',
  mlBundleKey: (m: string, l: unknown, s: unknown, h: boolean) => `${m}|${l}|${s}|${h}`,
}));

import { computeGoalieSensitivity, computeGoalieSensitivities, pendingSide, unknownSides } from './llmSensitivity';

const feats: any = { home_team: 'COL', away_team: 'WPG', home_goalie: 'Georgiev' };
const bet = { market: 'moneyline', line: null, selection: null, isHome: true };

beforeEach(() => { predictGameBundle.mockReset(); fetchTeamGoalies.mockReset(); });

describe('pendingSide', () => {
  it('un seul côté sans partant', () => {
    expect(pendingSide({ home_goalie: 'A' })).toBe('away');
    expect(pendingSide({ away_goalie: 'A' })).toBe('home');
    expect(pendingSide({})).toBeNull();
    expect(pendingSide({ home_goalie: 'A', away_goalie: 'B' })).toBeNull();
  });
});

describe('computeGoalieSensitivity', () => {
  it('relance le modèle avec chaque gardien du côté inconnu et rend la fourchette', async () => {
    fetchTeamGoalies.mockResolvedValue([{ id: 1, name: 'Hellebuyck' }, { id: 2, name: 'Brossoit' }]);
    predictGameBundle.mockImplementation(async (b: any) => ({
      results: { [b.markets[0].id]: { probability: b.features.away_goalie_id === 1 ? 55 : 66 } },
    }));
    const r = await computeGoalieSensitivity(feats, bet, 60);
    expect(r).toEqual({ side: 'away', team: 'WPG', lowPct: 55, highPct: 66, lowGoalie: 'Hellebuyck', highGoalie: 'Brossoit', swingPts: 11 });
    expect(predictGameBundle.mock.calls[0][0].features.away_goalie).toBe('Hellebuyck');
    expect(feats.away_goalie).toBeUndefined();   // features d'origine intactes
  });

  it('null si les deux partants sont connus, effectif trop court ou erreur ML', async () => {
    expect(await computeGoalieSensitivity({ ...feats, away_goalie: 'X' }, bet, 60)).toBeNull();
    fetchTeamGoalies.mockResolvedValue([{ id: 1, name: 'Solo' }]);
    expect(await computeGoalieSensitivity(feats, bet, 60)).toBeNull();
    fetchTeamGoalies.mockResolvedValue([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
    predictGameBundle.mockRejectedValue(new Error('down'));
    expect(await computeGoalieSensitivity(feats, bet, 60)).toBeNull();
  });
});

describe('les deux gardiens inconnus', () => {
  it('varie chaque côté seul, l\'autre restant inconnu', async () => {
    fetchTeamGoalies.mockImplementation(async (abbr: string) =>
      abbr === 'COL' ? [{ id: 1, name: 'C1' }, { id: 2, name: 'C2' }] : [{ id: 3, name: 'W1' }, { id: 4, name: 'W2' }]);
    predictGameBundle.mockImplementation(async (b: any) => {
      const f = b.features;
      const p = f.home_goalie_id === 1 ? 60 : f.home_goalie_id === 2 ? 58 : f.away_goalie_id === 3 ? 50 : 61;
      return { results: { [b.markets[0].id]: { probability: p } } };
    });
    const out = await computeGoalieSensitivities({ home_team: 'COL', away_team: 'WPG' } as any, { ...bet, gameId: 'g-both' }, 55);
    expect(out.map(o => [o.side, o.swingPts])).toEqual([['home', 2], ['away', 11]]);
    expect(unknownSides({})).toEqual(['home', 'away']);
  });
});
