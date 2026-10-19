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
/** Statut par match : sans entrée, le match est à venir (pas de recalcul en direct). */
const STATUS: Record<string, string> = {};
vi.mock('./refereeStore', () => ({
  getGameRefFactor: vi.fn(async () => ({ multiplier: 1, refs: ['Wes McCauley', 'Chris Rooney'], source: 'scrape', note: '' })),
}));
vi.mock('./nhlApiClient', () => ({
  fetchGameById: vi.fn(async (id: string) => ({
    homeTeam: { abbreviation: 'TOR' }, awayTeam: { abbreviation: 'MTL' },
    ...(STATUS[id] ? { status: STATUS[id] } : {}),
  })),
  fetchTeamRoster: vi.fn(async (a: string) => a === 'TOR'
    ? [{ id: 11, position: 'C' }, { id: 12, position: 'G' }]
    : [{ id: 21, position: 'D' }]),
}));
const TILES = vi.hoisted(() => () => [
    { id: 'match', options: [
      { id: 'ml-home', ml: { type: 'game', subjectId: 'TOR', propType: 'moneyline', isHome: true } },
      { id: 'ml-away', ml: { type: 'game', subjectId: 'MTL', propType: 'moneyline', isHome: false } },
    ] },
    { id: 'puckline', options: [
      { id: 'pl-home-m25', ml: { type: 'game', subjectId: 'TOR', propType: 'puck_line', line: -2.5, isHome: true } },
      { id: 'no-ml' },
    ] },
    { id: 'ot', options: [
      { id: 'ot-yes', ml: { type: 'game', subjectId: 'TOR', propType: 'game_to_ot', selection: 'yes', isHome: true } },
    ] },
]);
/** Le recalcul en direct : un chiffre par tuile, comme le rendrait la grille. */
const buildLiveModelMarkets = vi.fn(async (_id: string, _m: unknown): Promise<any> => ({
  status: 'live', liveLabel: '0–3, 3e, 05:00 restantes',
  groups: TILES().map(g => ({ ...g, options: g.options.map((o: any) => ({ ...o, rulePct: o.id === 'ml-home' ? 1 : 0 })) })),
}));
vi.mock('./nhlPredictions', () => ({
  buildPrematchGameMarkets: vi.fn(async () => TILES()),
  buildLiveModelMarkets: (id: string, m: unknown) => buildLiveModelMarkets(id, m),
}));

import { getGameMlBundle, mlBundleKey, serializeBundle } from './gameMlBundle';

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
    expect(Object.keys(b.results).sort()).toEqual(['ml-away', 'ml-home', 'ot-yes', 'pl-home-m25']);
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
    // Arbitres du soir transmis au modèle joueur (pénalités, 2026-10-12).
    expect(predictGameBundle.mock.calls[0][0].referees).toEqual(['Wes McCauley', 'Chris Rooney']);
  });
});

describe('getGameMlBundle — en direct', () => {
  beforeEach(() => { predictGameBundle.mockClear(); buildLiveModelMarkets.mockClear(); });

  it('les chiffres du modèle passent par la grille du score : tuile et question', async () => {
    STATUS['2026020444'] = 'live';
    const b = await getGameMlBundle('2026020444');
    expect(b.live).toEqual({ label: '0–3, 3e, 05:00 restantes', final: false });
    // Entrées = les chiffres d'avant-match du MODÈLE (42 % partout dans ce bouchon).
    expect(buildLiveModelMarkets).toHaveBeenCalledWith('2026020444', { preHome: 0.42, ot: 0.42, lambdaT: 3.1 + 2.8 });
    expect(b.results['ml-home']).toMatchObject({ probability: 1, probability_scale: 'pct', live: true });
    expect(b.results['pl-home-m25']).toMatchObject({ probability: 0 });
    // Même chiffre par question (pages équipe et joueur)…
    expect(b.byKey[mlBundleKey('regulation_result', null, null, true)]?.probability).toBe(1);
    // … et l'avant-match, SANS le drapeau `live` (pâle), pour ce que la grille
    // ne recalcule pas.
    expect(b.byKey[mlBundleKey('clean_sheet', null, 'yes', true)]).toMatchObject({ probability: 42 });
    expect(b.byKey[mlBundleKey('clean_sheet', null, 'yes', true)]?.live).toBeUndefined();
  });

  it('un chiffre du modèle manque : les tuiles gardent l\'avant-match, sans drapeau `live`', async () => {
    STATUS['2026020555'] = 'live';
    predictGameBundle.mockImplementationOnce(async (body: any) => ({
      results: Object.fromEntries(body.markets.map((m: any) => [m.id, { probability: 42 }])),
      lambda_home: null, lambda_away: 2.8,
    }) as any);
    const b = await getGameMlBundle('2026020555');
    expect(b.live).toBeDefined();
    expect(Object.values(b.results).every(r => r?.probability === 42 && !r.live)).toBe(true);
  });

  it('recalcul impossible : le paquet d\'avant-match, tel quel', async () => {
    STATUS['2026020666'] = 'live';
    buildLiveModelMarkets.mockRejectedValueOnce(new Error('boom'));
    const b = await getGameMlBundle('2026020666');
    expect(b.live).toBeUndefined();
    expect(b.results['ml-home']).toMatchObject({ probability: 42 });
  });
});

describe('getGameMlBundle — rythme du direct (§10.2)', () => {
  beforeEach(() => { buildLiveModelMarkets.mockClear(); vi.useRealTimers(); });

  it('fin de match : le paquet ne vit que 10 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    STATUS['2026020777'] = 'live';
    buildLiveModelMarkets.mockImplementation(async () => ({
      status: 'live', liveLabel: '2–1, 3e, 01:40 restantes', refreshMs: 10_000,
      groups: TILES().map(g => ({ ...g, options: g.options.map((o: any) => ({ ...o, rulePct: 50 })) })),
    }));
    const b = await getGameMlBundle('2026020777');
    expect(b.live).toEqual({ label: '2–1, 3e, 01:40 restantes', final: false, refreshMs: 10_000 });
    vi.setSystemTime(Date.now() + 11_000);
    await getGameMlBundle('2026020777');
    expect(buildLiveModelMarkets).toHaveBeenCalledTimes(2);
  });

  it('milieu de match : toujours 30 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    STATUS['2026020888'] = 'live';
    buildLiveModelMarkets.mockImplementation(async () => ({
      status: 'live', liveLabel: '1–0, 2e, 10:00 restantes', refreshMs: 30_000,
      groups: TILES().map(g => ({ ...g, options: g.options.map((o: any) => ({ ...o, rulePct: 50 })) })),
    }));
    await getGameMlBundle('2026020888');
    vi.setSystemTime(Date.now() + 11_000);
    await getGameMlBundle('2026020888');
    expect(buildLiveModelMarkets).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 20_000);
    await getGameMlBundle('2026020888');
    expect(buildLiveModelMarkets).toHaveBeenCalledTimes(2);
  });
});

describe('serializeBundle', () => {
  it('sérialise une fois par paquet : même corps, même ETag', async () => {
    const b = await getGameMlBundle('2026020999');
    const a1 = serializeBundle(b);
    const a2 = serializeBundle(b);
    expect(a2).toBe(a1);
    expect(JSON.parse(a1.body)).toEqual(JSON.parse(JSON.stringify(b)));
    expect(a1.etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    // Un autre paquet (autre contenu) : autre ETag.
    expect(serializeBundle({ ...b, gameId: 'x' }).etag).not.toBe(a1.etag);
  });
});
