import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { validateBody } from '../middleware/validate.middleware';
import { slipSubmitSchema } from '../validation/schemas';
import * as SlipService from '../services/slip.service';
import { settlePendingSlips } from '../services/settlement.service';

const router = Router();

// All slip routes require a valid JWT
router.use(authenticate);

// ─── POST /api/slips/settle ───────────────────────────────────────────────────
// Check the caller's pending slips against real NHL results and settle them.
router.post('/settle', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.sub;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const summary = await settlePendingSlips(userId, 50);
    res.json(summary);
  } catch (err: any) {
    console.error('[POST /api/slips/settle]', err.message);
    res.status(err.status ?? 500).json({ error: err.message });
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

    const slipId = await SlipService.submitSlip(userId, legs, sport, combinedProbability ?? null);
    res.status(201).json({ slipId, message: 'Slip submitted successfully' });
  } catch (err: any) {
    console.error('[POST /api/slips]', err.message);
    res.status(err.status ?? 500).json({ error: err.message });
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
    console.error('[GET /api/slips]', err.message);
    res.status(err.status ?? 500).json({ error: err.message });
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
    console.error('[GET /api/slips/:id]', err.message);
    res.status(err.status ?? 500).json({ error: err.message });
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
    console.error('[PATCH /api/slips/:id/resolve]', err.message);
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

export default router;
