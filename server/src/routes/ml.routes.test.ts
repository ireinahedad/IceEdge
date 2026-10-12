import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Ce que ce fichier prouve : sur `/api/predict/*`, un corps invalide est refusé
 * AVANT tout appel sortant.
 *
 * C'est là qu'était le trou. Ces routes sont publiques (la landing affiche des
 * probabilités sans compte) et chacune déclenche des requêtes vers l'API NHL
 * puis vers le service ML Python : une requête entrante gratuite payait
 * plusieurs requêtes sortantes chères. Un schéma zod qui existe mais n'est pas
 * câblé sur la route ne change rien à ça — d'où les assertions
 * `expect(...).not.toHaveBeenCalled()` : elles testent le câblage, pas le
 * schéma (celui-là est couvert dans `validation/schemas.test.ts`).
 *
 * L'autre moitié du fichier est un garde-fou de non-régression : les corps que
 * le vrai client envoie aujourd'hui doivent continuer à passer.
 */

const engine = {
  predictMoneyline: vi.fn(() => 61), predictPuckLine: vi.fn(() => 40),
  predictTotalGoals: vi.fn(() => 55), predictAnytimeGoal: vi.fn(() => 45),
  predictFirstGoalScorer: vi.fn(async () => 12), predictShotsOU: vi.fn(() => 52),
  predictAssistsOU: vi.fn(() => 48), predictPointsOU: vi.fn(() => 50),
  predictPPPoint: vi.fn(() => 33),
  predictPositionBasedProp: vi.fn(async (_id: string, prop: string) =>
    prop === 'goalie_saves_ou'
      ? { probability: 55, playerSpecific: true }
      : { probability: 50, playerSpecific: false }),
  predictFutures: vi.fn(async () => 20), predictOvertimeWinner: vi.fn(async () => 53),
  predictAltPuckLine: vi.fn(() => 50), predictRegulationResult: vi.fn(() => 40),
  predictTeamToScore: vi.fn(() => 50), predictBothTeamsScore: vi.fn(() => 70),
  predictCleanSheet: vi.fn(() => 10), predictTeamPPGoal: vi.fn(() => 40),
  predictPenaltyKill: vi.fn(() => 80),
  predictPeriodWinner: vi.fn(() => 38), predictPeriodTotalGoals: vi.fn(() => 45),
  buildRealFactors: vi.fn(async () => []),
  // Corrélation du coupon : absentes de ce double, la route recevait
  // `undefined` et rendait 500 sur /parlay.
  isScoreDerivable: vi.fn(() => false),
  predictGameLegCorrelation: vi.fn(async () => null),
  // Marchés qui servaient une constante dans le routeur. Les doubles rendent
  // `null` quand la sélection est illisible, comme le vrai moteur, parce que
  // c'est CE comportement que les tests ci-dessous vérifient.
  predictWinningMargin: vi.fn(async (_t?: string, _o?: string, _h?: boolean, sel?: string) =>
    sel ? 30 : null),
  predictGameToOvertime: vi.fn(async () => 21),
  predictHighestScoringPeriod: vi.fn(async (_t?: string, _o?: string, sel?: string) =>
    sel ? 34 : null),
  predictLastGoalScorer: vi.fn(async () => 11),
  predictGoalieSaves: vi.fn(async () => 55),
};
vi.mock('../services/predictionEngine', () => engine);

const mlApiClient = {
  predictGame:   vi.fn(async () => ({ probability: 0.61 })),
  predictPlayer: vi.fn(async () => ({ probability: 0.44 })),
  predictTeam:   vi.fn(async () => ({ probability: 0.2 })),
};
vi.mock('../services/mlApiClient', () => ({ mlApiClient }));

const fetchGameById  = vi.fn(async () => ({ homeTeam: { abbreviation: 'TOR' }, awayTeam: { abbreviation: 'MTL' } }));
const fetchPlayerById = vi.fn(async () => ({ name: 'X', gamesPlayed: 50, goals: 30, points: 80, assists: 50 }));
vi.mock('../services/nhlApiClient', () => ({ fetchGameById, fetchPlayerById }));

const features = {
  buildGameFeatures:        vi.fn(async () => ({})),
  buildPlayerPropFeatures:  vi.fn(async () => ({})),
  buildTeamFuturesFeatures: vi.fn(async () => ({})),
};
vi.mock('../services/featureEngineering', () => features);
vi.mock('../services/bestBets.service', () => ({ getBestBets: vi.fn(async () => ({ bets: [], meta: {} })), normalizeDate: (d?: string) => d }));

const getGameMlBundle = vi.fn();
vi.mock('../services/gameMlBundle', () => ({ getGameMlBundle: (id: string) => getGameMlBundle(id) }));

// Value bets (Pro) : le calcul est mocké, on teste le CÂBLAGE — compte exigé,
// puis abonnement Pro vérifié en base par le vrai `requirePro`.
const getCurrentValueBets = vi.fn(async () => [{ id: 'g1-moneyline-TOR' }]);
vi.mock('../services/valueBets.service', () => ({ getCurrentValueBets: () => getCurrentValueBets() }));
const isPro = vi.fn(async (_id: string) => false);
vi.mock('../services/subscription.service', () => ({ isPro: (id: string) => isPro(id) }));
/** `x-test-user` : absent = pas de session ; sinon l'identifiant de l'appelant. */
vi.mock('../middleware/auth.middleware', async (orig) => ({
  ...(await orig<typeof import('../middleware/auth.middleware')>()),
  authenticate: (req: any, res: any, next: any) => {
    const sub = req.headers['x-test-user'];
    if (!sub) { res.status(401).json({ error: 'Unauthenticated' }); return; }
    req.user = { sub, role: sub === 'admin' ? 'admin' : 'user' };
    next();
  },
  // Invité sans `x-test-user` ; sinon l'appelant, comme `authenticate`.
  optionalAuthenticate: (req: any, _res: any, next: any) => {
    const sub = req.headers['x-test-user'];
    if (sub) req.user = { sub, role: sub === 'admin' ? 'admin' : 'user' };
    next();
  },
}));

// Best Parlay : la construction est mockée (testée dans
// `bestParlays.service.test.ts`), le filtrage Pro est le VRAI.
const parlay = (i: number) => ({
  id: `bp-${i}`, kind: i % 2 ? 'mixed' : 'moneyline', legs: [{ id: `l${i}a` }, { id: `l${i}b` }, { id: `l${i}c` }],
  probability: 30 + i, assumesIndependence: false, coherentPairs: 0, bookPrice: null,
});
const getBestParlays = vi.fn(async () => ({
  parlays: [0, 1, 2, 3].map(parlay),
  meta: { generatedAt: '2026-10-04T00:00:00.000Z', day: '2026-10-04', mlAvailable: true },
}));
vi.mock('../services/bestParlays.service', async (orig) => ({
  ...(await orig<typeof import('../services/bestParlays.service')>()),
  getBestParlays: () => getBestParlays(),
}));

async function predictApp() {
  const { default: routes } = await import('./ml.routes');
  const a = express();
  a.use(express.json());
  a.use('/api/predict', routes);
  return a;
}

describe('/api/predict/* — le corps invalide est refusé avant tout appel sortant', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('POST /ml sans subjectId : 400, et NI variables NI service Python', async () => {
    const res = await request(await predictApp()).post('/api/predict/ml').send({ type: 'game' });
    expect(res.status).toBe(400);
    expect(features.buildGameFeatures).not.toHaveBeenCalled();
    expect(mlApiClient.predictGame).not.toHaveBeenCalled();
  });

  it('POST /ml avec un type inconnu : 400 avant les variables', async () => {
    const res = await request(await predictApp()).post('/api/predict/ml').send({ type: 'goalie', subjectId: 'x' });
    expect(res.status).toBe(400);
    expect(features.buildGameFeatures).not.toHaveBeenCalled();
  });

  it('POST /single sans marketType : 400, et pas d\'appel à l\'API NHL', async () => {
    const res = await request(await predictApp()).post('/api/predict/single').send({ gameId: '2025020123' });
    expect(res.status).toBe(400);
    expect(fetchGameById).not.toHaveBeenCalled();
    expect(engine.buildRealFactors).not.toHaveBeenCalled();
  });

  it('POST /parlay avec une probabilité non numérique : 400, plus jamais NaN', async () => {
    // Avant : `legs.reduce((acc, l) => acc * (l.probability/100))` renvoyait
    // `combinedProbability: NaN`, affiché tel quel sur le coupon.
    const res = await request(await predictApp())
      .post('/api/predict/parlay')
      .send({ legs: [{ marketType: 'moneyline', probability: null }] });
    expect(res.status).toBe(400);
  });

  it('POST /factors avec un type hors des deux branches : 400 avant fetchPlayerById', async () => {
    const res = await request(await predictApp()).post('/api/predict/factors').send({ type: 'goalie', id: '8478402' });
    expect(res.status).toBe(400);
    expect(engine.buildRealFactors).not.toHaveBeenCalled();
  });
});

describe('/api/predict/* — les corps que le client envoie vraiment passent toujours', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('POST /ml : le corps de BestBetsSection (landing, sans compte)', async () => {
    const res = await request(await predictApp())
      .post('/api/predict/ml')
      .send({ type: 'game', subjectId: 'TOR', opponentId: '2025020123' });
    expect(res.status).toBe(200);
    expect(mlApiClient.predictGame).toHaveBeenCalledTimes(1);
  });

  it('POST /single : `teamId: ""` de GamePrediction.tsx reste accepté', async () => {
    const res = await request(await predictApp())
      .post('/api/predict/single')
      .send({ marketType: 'moneyline', gameId: '2025020123', teamId: '' });
    expect(res.status).toBe(200);
    expect(res.body.probability).toEqual(expect.any(Number));
  });

  it('POST /parlay : un coupon normal rend deux nombres', async () => {
    const res = await request(await predictApp())
      .post('/api/predict/parlay')
      .send({ legs: [{ marketType: 'moneyline', probability: 60 }, { marketType: 'total_goals', probability: 50 }] });
    expect(res.status).toBe(200);
    expect(res.body.combinedProbability).toBe(30);
    expect(Number.isNaN(res.body.adjustedProbability)).toBe(false);
  });
});

/**
 * Ce que ce bloc prouve : `/api/predict/single` ne rend JAMAIS un chiffre qu'il
 * n'a pas calculé, et dit ce qu'il faut savoir sur ceux qu'il rend.
 *
 * Avant, `computeProbability` finissait par `return 50` pour tout marché
 * inconnu, servait `predictWinningMargin()` = 12 pour les six seaux d'écart, et
 * répondait 24 / 38 en dur pour `game_to_ot` / `highest_scoring_period`. Aucun
 * de ces chiffres ne se distinguait d'une vraie probabilité à l'écran.
 */
describe('/api/predict/single — pas de chiffre inventé, et les réserves sont dites', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const post = async (body: Record<string, unknown>) =>
    request(await predictApp()).post('/api/predict/single').send(body);

  it('un marché que le moteur ne connaît pas : 422, plus jamais 50 %', async () => {
    const res = await post({ marketType: 'corner_kicks', teamId: 'TOR', opponentId: 'MTL' });
    expect(res.status).toBe(422);
    expect(res.body.probability).toBeUndefined();
    expect(res.body.error).toBe('no_estimate');
  });

  it('écart de victoire sans seau : 422 au lieu de la constante 12', async () => {
    const res = await post({ marketType: 'winning_margin', teamId: 'TOR', opponentId: 'MTL' });
    expect(res.status).toBe(422);
  });

  it('écart de victoire AVEC seau : le seau est transmis au moteur', async () => {
    const res = await post({
      marketType: 'winning_margin', teamId: 'TOR', opponentId: 'MTL', selection: '3+',
    });
    expect(res.status).toBe(200);
    expect(engine.predictWinningMargin).toHaveBeenCalledWith('TOR', 'MTL', true, '3+');
  });

  it('game_to_ot passe par le moteur et non par un 24 écrit en dur', async () => {
    const res = await post({ marketType: 'game_to_ot', teamId: 'TOR', opponentId: 'MTL' });
    expect(res.status).toBe(200);
    expect(engine.predictGameToOvertime).toHaveBeenCalledTimes(1);
    expect(res.body.probability).toBe(21);
  });

  it('« décidé en 60 minutes » reste le complément exact de « va en prolongation »', async () => {
    const yes = await post({ marketType: 'game_to_ot', teamId: 'TOR', opponentId: 'MTL', selection: 'yes' });
    const no  = await post({ marketType: 'game_to_ot', teamId: 'TOR', opponentId: 'MTL', selection: 'no'  });
    expect(yes.body.probability + no.body.probability).toBe(100);
  });

  it('highest_scoring_period sans période : 422 au lieu de la constante 38', async () => {
    const res = await post({ marketType: 'highest_scoring_period', teamId: 'TOR', opponentId: 'MTL' });
    expect(res.status).toBe(422);
  });

  it('highest_scoring_period avec période : le chiffre porte sa réserve', async () => {
    const res = await post({
      marketType: 'highest_scoring_period', teamId: 'TOR', opponentId: 'MTL', selection: 'P2',
    });
    expect(res.status).toBe(200);
    expect(res.body.caveat).toBe('period_symmetric');
  });

  it('last_goal_scorer appelle SA fonction et annonce l\'estimateur partagé', async () => {
    const res = await post({ marketType: 'last_goal_scorer', playerId: '8478402' });
    expect(res.status).toBe(200);
    // L'alias muet est parti : c'est un appel distinct, avec sa mise en garde.
    expect(engine.predictLastGoalScorer).toHaveBeenCalledTimes(1);
    expect(engine.predictFirstGoalScorer).not.toHaveBeenCalled();
    expect(res.body.caveat).toBe('shared_with_first_goal');
  });

  it('first_goal_scorer, lui, ne porte aucune réserve', async () => {
    const res = await post({ marketType: 'first_goal_scorer', playerId: '8478402' });
    expect(res.status).toBe(200);
    expect(res.body.caveat).toBeUndefined();
  });

  it('les mises en échec sont annoncées comme moyenne de ligue', async () => {
    const res = await post({ marketType: 'hits_ou', playerId: '8478402', line: 1.5, selection: 'over' });
    expect(res.status).toBe(200);
    expect(res.body.probability).toBe(50);
    expect(res.body.caveat).toBe('league_average');
  });

  it('les arrêts du gardien, eux, sont une vraie prédiction par joueur', async () => {
    const res = await post({ marketType: 'goalie_saves_ou', playerId: '8471234', line: 27.5, selection: 'over' });
    expect(res.status).toBe(200);
    expect(res.body.caveat).toBeUndefined();
  });
});

// Paquet ML d'un match : en direct, ses chiffres suivent le score (recalcul
// toutes les 30 s côté serveur) ; une fois le match terminé, ils sont figés.
describe('GET /api/predict/game/:id/bundle — cache selon l\'état du match', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  const bundle = { gameId: '2026020001', results: {}, byKey: {} };

  it('avant-match : 2 min', async () => {
    getGameMlBundle.mockResolvedValue(bundle);
    const res = await request(await predictApp()).get('/api/predict/game/2026020001/bundle');
    expect(res.headers['cache-control']).toBe('public, max-age=120, stale-while-revalidate=600');
  });

  it('en direct : 30 s', async () => {
    getGameMlBundle.mockResolvedValue({ ...bundle, live: { label: '1–0', final: false } });
    const res = await request(await predictApp()).get('/api/predict/game/2026020001/bundle');
    expect(res.headers['cache-control']).toBe('public, max-age=30, stale-while-revalidate=30');
  });

  it('terminé : 6 h', async () => {
    getGameMlBundle.mockResolvedValue({ ...bundle, live: { label: 'final', final: true } });
    const res = await request(await predictApp()).get('/api/predict/game/2026020001/bundle');
    expect(res.headers['cache-control']).toBe('public, max-age=21600, stale-while-revalidate=43200');
  });

  it('état du match illisible : 503, le client affiche « — »', async () => {
    getGameMlBundle.mockRejectedValue(Object.assign(new Error('Données du match indisponibles'), { status: 503 }));
    const res = await request(await predictApp()).get('/api/predict/game/2026020001/bundle');
    expect(res.status).toBe(503);
  });
});

describe('GET /api/predict/value-bets — réservé aux Pro', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('sans compte : 401, et aucun calcul', async () => {
    const res = await request(await predictApp()).get('/api/predict/value-bets');
    expect(res.status).toBe(401);
    expect(getCurrentValueBets).not.toHaveBeenCalled();
  });

  it('compte gratuit : 402 PRO_REQUIRED, et aucun calcul', async () => {
    isPro.mockResolvedValueOnce(false);
    const res = await request(await predictApp()).get('/api/predict/value-bets').set('x-test-user', 'u1');
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('PRO_REQUIRED');
    expect(getCurrentValueBets).not.toHaveBeenCalled();
  });

  it('Pro : la liste partagée, jamais mise en cache public', async () => {
    isPro.mockResolvedValueOnce(true);
    const res = await request(await predictApp()).get('/api/predict/value-bets').set('x-test-user', 'u2');
    expect(res.status).toBe(200);
    expect(res.body.bets).toEqual([{ id: 'g1-moneyline-TOR' }]);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });
});

describe('GET /api/predict/best-parlays — 2 gratuits, le reste Pro', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('invité : les 2 premiers en entier, les autres SANS jambes ni pourcentage', async () => {
    const res = await request(await predictApp()).get('/api/predict/best-parlays');
    expect(res.status).toBe(200);
    expect(res.body.parlays).toHaveLength(4);
    expect(res.body.parlays[0].legs).toHaveLength(3);
    expect(res.body.parlays[1].probability).toBe(31);
    for (const p of res.body.parlays.slice(2)) {
      expect(p).toEqual({ id: expect.stringMatching(/^locked-/), kind: expect.any(String), locked: true, legCount: 3 });
    }
    expect(res.body.meta).toMatchObject({ freeCount: 2, total: 4 });
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(isPro).not.toHaveBeenCalled();
  });

  it('compte gratuit : même coupe', async () => {
    isPro.mockResolvedValueOnce(false);
    const res = await request(await predictApp()).get('/api/predict/best-parlays').set('x-test-user', 'u1');
    expect(res.body.parlays.filter((p: any) => p.locked)).toHaveLength(2);
  });

  it('Pro : tout', async () => {
    isPro.mockResolvedValueOnce(true);
    const res = await request(await predictApp()).get('/api/predict/best-parlays').set('x-test-user', 'u2');
    expect(res.body.parlays.every((p: any) => !p.locked && p.legs.length === 3)).toBe(true);
  });

  it('abonnement illisible : vue gratuite, jamais la vue Pro', async () => {
    isPro.mockRejectedValueOnce(new Error('db down'));
    const res = await request(await predictApp()).get('/api/predict/best-parlays').set('x-test-user', 'u3');
    expect(res.status).toBe(200);
    expect(res.body.parlays.filter((p: any) => p.locked)).toHaveLength(2);
  });
});
