import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { validateBody } from '../middleware/validate.middleware';
import { slipSubmitSchema } from '../validation/schemas';
import * as SlipService from '../services/slip.service';
import { settlePendingSlips, legSettlementProblem } from '../services/settlement.service';
import { logger } from '../logger';
import { sendError } from '../httpError';

const router = Router();

// All slip routes require a valid JWT
router.use(authenticate);

// ─── POST /api/slips/settle ───────────────────────────────────────────────────
// Check the caller's pending slips against real NHL results and settle them.
router.post('/settle', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.sub;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    // Chemin interactif : quelqu'un attend la réponse. Plafond bas ET budget
    // court — le job de fond réglera le reste, personne ne doit tenir une
    // connexion HTTP ouverte pendant que la file se vide.
    const summary = await settlePendingSlips(userId, { max: 50, budgetMs: 10_000 });
    res.json(summary);
  } catch (err: any) {
    logger.error({ err: err.message }, '[POST /api/slips/settle]');
    sendError(res, err);
  }
});

// ─── POST /api/slips ──────────────────────────────────────────────────────────
// Submit a new prediction slip
router.post('/', validateBody(slipSubmitSchema), async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.sub;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const { legs, sport = 'hockey', combinedProbability } = req.body as {
      legs: SlipService.SlipLeg[];
      sport?: string;
      combinedProbability?: number;
    };

    if (!Array.isArray(legs) || legs.length === 0) {
      res.status(400).json({ error: 'legs array is required' });
      return;
    }

    // Une jambe que le règlement ne saura jamais décider figerait le coupon en
    // attente : on la refuse ici plutôt que de la découvrir des jours plus tard.
    for (let i = 0; i < legs.length; i++) {
      const problem = legSettlementProblem(legs[i]);
      if (problem) {
        logger.warn({ userId, leg: i, marketType: legs[i]?.marketType, problem }, '[POST /api/slips] jambe non réglable refusée');
        res.status(400).json({ error: `Leg ${i + 1} (${legs[i]?.selection ?? legs[i]?.marketType}) cannot be settled: ${problem}` });
        return;
      }
    }

    const slipId = await SlipService.submitSlip(userId, legs, sport, combinedProbability ?? null);
    res.status(201).json({ slipId, message: 'Slip submitted successfully' });
  } catch (err: any) {
    logger.error({ err: err.message }, '[POST /api/slips]');
    sendError(res, err);
  }
});

// ─── GET /api/slips ───────────────────────────────────────────────────────────
// List the authenticated user's slips
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.sub;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const limit  = Math.min(parseInt(String(req.query.limit  ?? 50), 10), 200);
    const slips  = await SlipService.getSlips(userId, limit);
    res.json(slips);
  } catch (err: any) {
    logger.error({ err: err.message }, '[GET /api/slips]');
    sendError(res, err);
  }
});

// ─── GET /api/slips/:id ───────────────────────────────────────────────────────
// Get a single slip
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.sub;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const slip = await SlipService.getSlip(req.params.id, userId);
    res.json(slip);
  } catch (err: any) {
    logger.error({ err: err.message }, '[GET /api/slips/:id]');
    sendError(res, err);
  }
});

// ─── PATCH /api/slips/:id/resolve ─────────────────────────────────────────────
// Manual resolution — ADMIN ONLY. Regular users cannot self-report results
// (settlement is automatic via the NHL API); this stays as an admin override
// for markets that cannot be auto-settled (player props, etc.).
router.patch('/:id/resolve', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.sub;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    if ((req as any).user?.role !== 'admin') {
      res.status(403).json({ error: 'Results are settled automatically — manual resolution is admin-only' });
      return;
    }

    const { outcome } = req.body as { outcome: 'win' | 'loss' };
    if (outcome !== 'win' && outcome !== 'loss') {
      res.status(400).json({ error: 'outcome must be "win" or "loss"' });
      return;
    }

    const result = await SlipService.resolveSlip(req.params.id, outcome, userId);
    res.json({
      ...result,
      message: outcome === 'win'
        ? `+${result.xpAwarded} XP awarded${result.tieredUp ? ` — you reached ${result.newTier}!` : ''}`
        : 'Slip marked as loss',
    });
  } catch (err: any) {
    logger.error({ err: err.message }, '[PATCH /api/slips/:id/resolve]');
    sendError(res, err);
  }
});

export default router;
