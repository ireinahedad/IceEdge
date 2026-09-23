import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Le paquet ML d'un match : UN calcul Python pour toutes les tuiles, partagé
 * entre visiteurs. C'est ce qui remplace les ~95 `POST /predict/ml` (et les
 * 429) d'une page de match en mode ML.
 */

const predictGameBundle = vi.fn(async (body: any) => ({
  results: Object.fromEntries(body.markets.map((m: any) => [m.id, { probability: 42 }])),
  lambda_home: 3.1, lambda_away: 2.8,
}));
const buildGameFeatures = vi.fn(async () => ({ home_team: 'TOR', away_team: 'MTL' }));

vi.mock('./mlApiClient', () => ({ mlApiClient: { predictGameBundle: (b: unknown) => predictGameBundle(b) } }));
vi.mock('./featureEngineering', () => ({ buildGameFeatures: (...a: unknown[]) => (buildGameFeatures as any)(...a) }));
vi.mock('./nhlApiClient', () => ({
  fetchGameById: vi.fn(async () => ({ homeTeam: { abbreviation: 'TOR' }, awayTeam: { abbreviation: 'MTL' } })),
  fetchTeamRoster: vi.fn(async (a: string) => a === 'TOR'
    ? [{ id: 11, position: 'C' }, { id: 12, position: 'G' }]
    : [{ id: 21, position: 'D' }]),
}));
vi.mock('./nhlPredictions', () => ({
  buildGameMarkets: vi.fn(async () => [
    { id: 'match', options: [
      { id: 'ml-home', ml: { type: 'game', subjectId: 'TOR', propType: 'moneyline', isHome: true } },
      { id: 'ml-away', ml: { type: 'game', subjectId: 'MTL', propType: 'moneyline', isHome: false } },
    ] },
    { id: 'puckline', options: [
      { id: 'pl-home-m25', ml: { type: 'game', subjectId: 'TOR', propType: 'puck_line', line: -2.5, isHome: true } },
      { id: 'no-ml' },
    ] },
  ]),
}));

import { getGameMlBundle, mlBundleKey } from './gameMlBundle';

describe('getGameMlBundle', () => {
  beforeEach(() => { predictGameBundle.mockClear(); buildGameFeatures.mockClear(); });

  it('une requête Python pour toutes les tuiles, même avec des visiteurs simultanés', async () => {
    const [a, b, c] = await Promise.all([
      getGameMlBundle('2026020111'), getGameMlBundle('2026020111'), getGameMlBundle('2026020111'),
    ]);
    expect(predictGameBundle).toHaveBeenCalledTimes(1);
    expect(buildGameFeatures).toHaveBeenCalledTimes(1);
    expect(a).toBe(b); expect(b).toBe(c);
    // Et la visite suivante sort du cache.
    await getGameMlBundle('2026020111');
    expect(predictGameBundle).toHaveBeenCalledTimes(1);
  });

  it('les tuiles « in Reg » demandent la victoire en 60 min ; la ligne et le côté voyagent', async () => {
    const b = await getGameMlBundle('2026020222');
    const markets = predictGameBundle.mock.calls[0][0].markets;
    const byKey = new Map(markets.map((m: any) => [m.id, m]));
    expect(byKey.get(mlBundleKey('regulation_result', null, null, true))).toBeDefined();
    expect(byKey.get(mlBundleKey('regulation_result', null, null, false))).toBeDefined();
    expect(byKey.get(mlBundleKey('puck_line', -2.5, null, true))).toMatchObject({ market_type: 'puck_line', line: -2.5 });
    // Résultats par tuile de la page match…
    expect(Object.keys(b.results).sort()).toEqual(['ml-away', 'ml-home', 'pl-home-m25']);
    expect(b.results['ml-home']?.probability).toBe(42);
    // … et par question, extras compris (victoire toutes issues, blanchissage,
    // écart du visiteur) pour les pages équipe et joueur.
    expect(b.byKey[mlBundleKey('moneyline', null, null, false)]).toBeDefined();
    expect(b.byKey[mlBundleKey('clean_sheet', null, 'yes', true)]).toBeDefined();
    expect(b.byKey[mlBundleKey('winning_margin', null, '3+', false)]).toBeDefined();
  });

  it('les marchés sans côté ont une seule clé, les questions en double un seul calcul', () => {
    expect(mlBundleKey('total_goals_over', 5.5, null, false)).toBe(mlBundleKey('total_goals_over', 5.5, null, true));
    expect(mlBundleKey('period1_winner', null, 'draw', false)).toBe(mlBundleKey('period1_winner', null, 'draw', true));
    expect(mlBundleKey('moneyline', null, null, false)).not.toBe(mlBundleKey('moneyline', null, null, true));
  });

  it('envoie les deux effectifs (sans gardiens) pour le modèle joueur, dans la même requête', async () => {
    await getGameMlBundle('2026020333');
    expect(predictGameBundle).toHaveBeenCalledTimes(1);
    expect(predictGameBundle.mock.calls[0][0].players).toEqual({ home: ['11'], away: ['21'] });
  });
});
