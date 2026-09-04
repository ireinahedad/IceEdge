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
  predictFirstGoalScorer: vi.fn(() => 12), predictShotsOU: vi.fn(() => 52),
  predictAssistsOU: vi.fn(() => 48), predictPointsOU: vi.fn(() => 50),
  predictPPPoint: vi.fn(() => 33), predictPositionBasedProp: vi.fn(() => 50),
  predictFutures: vi.fn(async () => 20), predictDoubleChance: vi.fn(() => 50),
  predictAltPuckLine: vi.fn(() => 50), predictRegulationResult: vi.fn(() => 40),
  predictTeamToScore: vi.fn(() => 50), predictBothTeamsScore: vi.fn(() => 70),
  predictCleanSheet: vi.fn(() => 10), predictTeamPPGoal: vi.fn(() => 40),
  predictPenaltyKill: vi.fn(() => 80), predictWinningMargin: vi.fn(() => 30),
  predictPeriodWinner: vi.fn(() => 38), predictPeriodTotalGoals: vi.fn(() => 45),
  buildRealFactors: vi.fn(async () => []),
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
vi.mock('../services/bestBets.service', () => ({ getBestBets: vi.fn(async () => ({ bets: [], meta: {} })) }));

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
