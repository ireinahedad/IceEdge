import { Router, Request, Response } from 'express';
import * as ProfileService from '../services/profile.service';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

// All /me routes require a valid JWT
router.use('/me', authenticate);

// GET /api/users/me
router.get('/me', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.sub;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    res.json(await ProfileService.getProfileById(userId));
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// GET /api/users/me/bets
router.get('/me/bets', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.sub;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    res.json(await ProfileService.getBetHistory(userId));
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// GET /api/users/me/stats
router.get('/me/stats', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.sub;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    res.json(await ProfileService.getBettingStats(userId));
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// PATCH /api/users/me
router.patch('/me', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.sub;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    res.json(await ProfileService.updateProfile(userId, req.body));
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

export default router;
