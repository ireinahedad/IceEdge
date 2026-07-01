/**
 * dev.routes.ts
 * Developer-only endpoints — gated to admin role.
 * Mount at /api/dev  (only in non-production or for admins).
 *
 * GET  /api/dev/ml-info          — ML service health + model info + feature importances
 * POST /api/dev/ml-test          — Run a live test prediction and return the full response
 */

import { Router, Request, Response } from 'express';
import { authenticate }   from '../middleware/auth.middleware';
import { requireRole }    from '../middleware/auth.middleware';
import { mlApiClient }    from '../services/mlApiClient';
import {
  buildGameFeatures,
  buildPlayerPropFeatures,
} from '../services/featureEngineering';

const router = Router();

// All dev routes require a valid JWT + admin role
router.use(authenticate, requireRole('admin'));

const ML_URL = process.env.ML_SERVICE_URL || 'http://localhost:8000';

// ── GET /api/dev/ml-info ──────────────────────────────────────────────────────
router.get('/ml-info', async (_req: Request, res: Response) => {
  try {
    // Ping the Python service health + feature endpoints in parallel
    const timeout = (ms: number) =>
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));

    const [healthRaw, featuresRaw] = await Promise.all([
      Promise.race([
        fetch(`${ML_URL}/health`).then(r => r.json()),
        timeout(4000),
      ]).catch((e) => ({ error: e.message ?? 'ML service unreachable' })),

      Promise.race([
        fetch(`${ML_URL}/features`).then(r => r.json()),
        timeout(4000),
      ]).catch(() => null),
    ]);

    // Run a quick game test prediction for BOS vs NYR
    let gameSample: unknown = null;
    let playerSample: unknown = null;

    try {
      const gameFeats = await buildGameFeatures('bos', 'nyr', 'moneyline');
      gameSample = await mlApiClient.predictGame(gameFeats);
    } catch { /* service may be down */ }

    try {
      const playerFeats = await buildPlayerPropFeatures('8478402', 'goals', 0.5, 'over');
      playerSample = await mlApiClient.predictPlayer(playerFeats);
    } catch { /* service may be down */ }

    res.json({
      ml_url:        ML_URL,
      service_up:    !(healthRaw as any)?.error,
      health:        healthRaw,
      features:      featuresRaw,
      samples: {
        game:   gameSample,
        player: playerSample,
      },
      retrieved_at: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/dev/ml-test ─────────────────────────────────────────────────────
// Body: { type: "game"|"player"|"team", teamId?, opponentId?, playerId?, propType?, line?, selection? }
router.post('/ml-test', async (req: Request, res: Response) => {
  try {
    const { type, teamId, opponentId, playerId, propType, line, selection } = req.body as {
      type: 'game' | 'player' | 'team';
      teamId?: string;
      opponentId?: string;
      playerId?: string;
      propType?: string;
      line?: number;
      selection?: string;
    };

    let result: unknown;

    if (type === 'game') {
      const features = await buildGameFeatures(teamId ?? 'bos', opponentId ?? 'nyr', propType ?? 'moneyline', line);
      result = await mlApiClient.predictGame(features);
    } else if (type === 'player') {
      const features = await buildPlayerPropFeatures(playerId ?? '8478402', propType ?? 'goals', line ?? 0.5, selection ?? 'over');
      result = await mlApiClient.predictPlayer(features);
    } else if (type === 'team') {
      const { buildTeamFuturesFeatures } = await import('../services/featureEngineering');
      const features = await buildTeamFuturesFeatures(teamId ?? 'bos', propType ?? 'moneyline');
      result = await mlApiClient.predictTeam(features);
    } else {
      return res.status(400).json({ error: 'type must be game | player | team' });
    }

    res.json({ type, result, tested_at: new Date().toISOString() });
  } catch (err: any) {
    res.status(503).json({ error: err.message ?? 'ML test failed' });
  }
});

export default router;
