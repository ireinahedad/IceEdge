import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Ce que ce fichier prouve : **l'invite système envoyée au fournisseur vient du
 * serveur, jamais du corps de la requête.**
 *
 * C'était le trou : `systemPrompt` arrivait du client et était relayé tel quel.
 * Sur le chemin Pro — le seul facturé à l'opérateur — tout abonné disposait
 * donc d'un proxy LLM généraliste à ses frais, dans la limite du quota.
 *
 * L'assertion qui compte est celle qui LIT LE CORPS RÉELLEMENT ENVOYÉ au
 * fournisseur : un `systemPrompt` retiré de la lecture du corps mais réinjecté
 * ailleurs passerait toutes les autres. C'est le même raisonnement que dans
 * `ml.routes.test.ts` — on teste le câblage, pas l'intention.
 */

const isPro = vi.fn(async () => true);
vi.mock('../services/subscription.service', () => ({ isPro }));

vi.mock('../middleware/auth.middleware', () => ({
  authenticate: (req: any, _res: any, next: any) => { req.user = { sub: 'u1' }; next(); },
}));
vi.mock('../middleware/rateLimit.middleware', () => ({
  llmLimiter: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../db/connection', () => ({
  pool: { query: vi.fn(async () => ({ rows: [{ openaiApiKey: 'sk-test' }] })) },
}));
vi.mock('../services/crypto.util', () => ({ decryptSecret: (v: string) => v }));

const consumeProRequest = vi.fn(async (): Promise<any> => ({ allowed: true, used: 7, limit: 100, resetsAt: '2026-11-01T00:00:00.000Z' }));
const refundProRequest  = vi.fn(async () => {});
const consumeFreeParse  = vi.fn(async (): Promise<any> => ({ allowed: true, used: 1, limit: 2, resetsAt: '2026-10-11T00:00:00.000Z' }));
const refundFreeParse   = vi.fn(async () => {});
const getFreeParseUsage = vi.fn(async () => ({ used: 1, limit: 2, remaining: 1, resetsAt: '2026-10-11T00:00:00.000Z' }));
vi.mock('../services/llmQuota.service', () => ({
  consumeProRequest, refundProRequest, consumeFreeParse, refundFreeParse, getFreeParseUsage,
  getUsage: vi.fn(async () => ({ used: 0, limit: 100 })),
  MONTHLY_QUOTA: 100,
  MAX_OUTPUT_TOKENS: 800,
  PROMPT_BUDGET_CHARS: 3_000,
}));

// Le contexte de la commande du coupon, tel que le serveur le construit
// (calendrier + joueurs LNH). Bouchonné : ces tests portent sur le câblage.
const buildServerSlipContext = vi.fn(async (): Promise<any> => ({
  today: '2026-10-10',
  games: [{ id: 'g1', homeAbbr: 'TOR', awayAbbr: 'MTL', date: '2026-10-10' }],
  players: [{ id: '1', name: 'Nick Suzuki', teamAbbr: 'MTL', position: 'C' }],
  lines: { total_goals: [5.5, 6.5], shots_ou: [2.5] },
}));
vi.mock('../services/slipCommandContext', () => ({ buildServerSlipContext }));

// Le bloc FAITS : bouchonné, ses calculs sont testés dans llmFacts.test.ts.
const buildBetFacts = vi.fn(async (): Promise<any> => null);
vi.mock('../services/llmAnalysisContext', () => ({ buildBetFacts }));

vi.mock('../metrics', () => ({ recordUpstream: vi.fn() }));
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Le corps JSON que la route a réellement POSTé au fournisseur. */
let sentBody: any = null;

async function llmApp() {
  const { default: routes } = await import('./llm.routes');
  const a = express();
  a.use(express.json());
  a.use('/api/llm', routes);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  sentBody = null;
  // Clé OPÉRATEUR du chemin Pro. C'était `GITHUB_MODELS_TOKEN` jusqu'au
  // 2026-09-08, date à laquelle le chemin Pro est passé à OpenAI (GitHub Models
  // a été retiré le 30 juillet 2026).
  process.env.OPENAI_API_KEY = 'sk-test';
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
    sentBody = JSON.parse(init.body);
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: 'réponse' } }] }),
      text: async () => '',
    } as any;
  }));
});


import { buildGameFacts } from '../services/llmFacts';

const facts = () => buildGameFacts({
  bet: { type: 'game', label: 'Over 5.5', propType: 'total_goals_over', line: 5.5, gameId: '1' },
  features: {
    home_team: 'COL', away_team: 'WPG', home_win_pct: 0.6, away_win_pct: 0.5,
    home_goals_for_pg: 3.4, away_goals_for_pg: 2.8, home_goals_against_pg: 2.7, away_goals_against_pg: 3.3,
    home_rest_days: 2, away_rest_days: 2, home_b2b: 0, away_b2b: 0, total_line_market: 5.5,
    home_goalie: 'A', away_goalie: 'B',
  } as any,
  result: { probability: 62, confidence: 70, model_version: 'v', model_type: 't', explanation: '', feature_importances: [] } as any,
  lambdaHome: 3.4, lambdaAway: 2.63, locale: 'fr',
});

const BET = { type: 'game', label: 'Over 5.5', gameId: '1', propType: 'total_goals_over', line: 5.5 };

describe('POST /api/llm — analyse v2 (bloc FAITS construit par le serveur)', () => {
  it('avec `bet` : invite v2, FAITS en message utilisateur, JSON demandé, réponse validée', async () => {
    buildBetFacts.mockResolvedValueOnce(facts());
    (fetch as any).mockImplementationOnce(async (_u: string, init: any) => {
      sentBody = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content: JSON.stringify({
        headline: 'Total attendu 6,03 contre une ligne de 5,5.',
        drivers: [{ key: 'expected_total', text: 'COL 3,4 et WPG 2,63 buts attendus.' }],
        followups: ['Et si le gardien change ?'],
      }) } }] }) } as any;
    });
    const res = await request(await llmApp()).post('/api/llm')
      .send({ prompt: 'legacy', taskType: 'explain_bet', locale: 'fr', bet: BET });
    expect(res.status).toBe(200);
    expect(sentBody.messages[0].content).toContain('NARRATEUR');
    expect(sentBody.messages[0].content).not.toContain('Verdict');
    expect(sentBody.messages[1].content).toContain('CANDIDATS');
    expect(sentBody.messages[1].content).not.toContain('legacy');
    expect(sentBody.response_format).toEqual({ type: 'json_object' });
    expect(res.body.analysis.source).toBe('llm');
    expect(res.body.analysis.drivers[0]).toMatchObject({ key: 'expected_total', tier: 'major', side: 'for' });
    expect(res.body.text).toContain('▲');
    expect(res.body.factsText).toContain('6,03');
  });

  it('un chiffre inventé par le modèle : texte déterministe, la réponse reste 200', async () => {
    buildBetFacts.mockResolvedValueOnce(facts());
    (fetch as any).mockImplementationOnce(async () => ({
      ok: true, status: 200, text: async () => '',
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ headline: 'Total attendu 9,99', drivers: [{ key: 'expected_total', text: '9,99' }] }) } }] }),
    }));
    const res = await request(await llmApp()).post('/api/llm')
      .send({ prompt: 'x', taskType: 'explain_bet', locale: 'fr', bet: BET });
    expect(res.status).toBe(200);
    expect(res.body.analysis.source).toBe('fallback');
    expect(res.body.analysis.headline).toContain('6,03');
  });

  it('faits indisponibles : ancienne invite libre, ancien format de réponse', async () => {
    buildBetFacts.mockResolvedValueOnce(null);
    const res = await request(await llmApp()).post('/api/llm')
      .send({ prompt: 'x', taskType: 'explain_bet', locale: 'fr', bet: BET });
    expect(res.status).toBe(200);
    expect(sentBody.messages[0].content).toContain('analyste de paris LNH');
    expect(sentBody.response_format).toBeUndefined();
    expect(res.body).toEqual({ text: 'réponse' });
  });

  it('un `bet` inutilisable est ignoré, et ne coûte aucun calcul de faits', async () => {
    const res = await request(await llmApp()).post('/api/llm')
      .send({ prompt: 'x', taskType: 'explain_bet', locale: 'fr', bet: { type: 'nimporte', label: '' } });
    expect(res.status).toBe(200);
    expect(buildBetFacts).not.toHaveBeenCalled();
  });

  it('ask_followup ignore `bet` : pas de faits, pas de JSON', async () => {
    await request(await llmApp()).post('/api/llm')
      .send({ prompt: 'Question : x', taskType: 'ask_followup', locale: 'fr', bet: BET });
    expect(buildBetFacts).not.toHaveBeenCalled();
    expect(sentBody.response_format).toBeUndefined();
  });
});
