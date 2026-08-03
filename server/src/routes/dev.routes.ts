/**
 * dev.routes.ts
 * Developer-only endpoints — gated to admin role.
 * Mount at /api/dev  (only in non-production or for admins).
 *
 * GET  /api/dev/ml-info          — ML service health + model info + feature importances
 * POST /api/dev/ml-test          — Run a live test prediction and return the full response
 * GET  /api/dev/metrics          — Compteurs : appels sortants, caches, event loop, mémoire
 * POST /api/dev/metrics/reset    — Ouvre une nouvelle fenêtre de mesure
 */

import { Router, Request, Response } from 'express';
import { authenticate }   from '../middleware/auth.middleware';
import { requireRole }    from '../middleware/auth.middleware';
import { mlApiClient, mlHeaders, ML_URL, mlCircuitState } from '../services/mlApiClient';
import {
  buildGameFeatures,
  buildPlayerPropFeatures,
} from '../services/featureEngineering';
import { snapshotMetrics, resetMetrics } from '../metrics';

const router = Router();

// All dev routes require a valid JWT + admin role
router.use(authenticate, requireRole('admin'));

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

      // /features is token-protected on the ML service — send X-ML-Token.
      Promise.race([
        fetch(`${ML_URL}/features`, { headers: mlHeaders() }).then(r => r.json()),
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

// ── GET /api/dev/metrics ──────────────────────────────────────────────────────
//
// Instantané des compteurs : appels sortants par API externe, efficacité de
// chaque cache nommé, retard de l'event loop, mémoire du process.
//
// Existe pour rendre vérifiables les critères des tests de charge de l'audit,
// qui portent tous sur ce que le serveur ÉMET, pas sur ce qu'il répond — donc
// invisibles depuis k6. Voir `loadtest/README.md`.
//
// Lecture seule, et déjà doublement protégé : `authenticate` + `requireRole('admin')`
// en tête de ce routeur, lui-même non monté en production sans ENABLE_DEV_ROUTES.
router.get('/metrics', (_req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  // Le disjoncteur ML est ajouté ici plutôt que dans `metrics.ts` : c'est un
  // état, pas un compteur, et il n'a pas à survivre à `resetMetrics`. Sans lui,
  // un tir de charge où le service Python est tombé montrerait « 0 appel ML »
  // sans dire si c'est le cache qui a bien travaillé ou le circuit qui est
  // ouvert — deux situations opposées, indiscernables sur les seuls compteurs.
  res.json({ ...snapshotMetrics(), mlCircuit: mlCircuitState() });
});

// ── POST /api/dev/metrics/reset ───────────────────────────────────────────────
//
// Ouvre une nouvelle fenêtre de mesure. À appeler juste avant un tir de charge
// pour que les chiffres ne portent que sur lui.
//
// Ne vide PAS les caches : un cache déjà chaud reste chaud. Pour mesurer un
// démarrage à froid (scénario S3), il faut redémarrer le service — sinon on
// lirait « 0 exécution » et on conclurait à tort que la déduplication marche.
// L'instantané d'avant remise à zéro est renvoyé, pour ne rien perdre si on
// oublie de le lire d'abord.
router.post('/metrics/reset', (_req: Request, res: Response) => {
  const before = snapshotMetrics();
  resetMetrics();
  res.json({ reset_at: new Date().toISOString(), before });
});

export default router;
