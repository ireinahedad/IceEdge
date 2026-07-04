import { Router, Request, Response } from 'express';
import * as ProfileService from '../services/profile.service';
import { authenticate, requirePro } from '../middleware/auth.middleware';

const router = Router();

// All /me routes require a valid JWT
router.use('/me', authenticate);

// GET /api/users/search?q=  — find public players by name (authenticated)
router.get('/search', authenticate, async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q ?? '');
    if (q.trim().length < 2) return res.json([]);
    res.json(await ProfileService.searchUsers(q));
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// GET /api/users/:userId/slips — another player's bets/slips.
// Viewing OTHER players' bets is a Pro feature; own slips are fetched via /me routes.
router.get('/:userId/slips', authenticate, async (req: Request, res: Response, next) => {
  // Your own slips are always allowed; someone else's require Pro.
  const viewerId = (req as any).user?.sub;
  if (viewerId && viewerId === req.params.userId) return next();
  return requirePro(req, res, next);
}, async (req: Request, res: Response) => {
  try {
    const viewerId = (req as any).user?.sub;
    if (!viewerId) return res.status(401).json({ error: 'Unauthorized' });
    res.json(await ProfileService.getPublicSlips(req.params.userId, viewerId));
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

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

// POST /api/users/me/avatar  { avatarDataUrl: string }
// Accepts a base64 data URI and saves it as the user's avatar_url
router.post('/me/avatar', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.sub;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { avatarDataUrl } = req.body as { avatarDataUrl?: string };
    if (!avatarDataUrl) return res.status(400).json({ error: 'avatarDataUrl is required' });

    // Basic validation — must be a data URI image
    if (!avatarDataUrl.startsWith('data:image/')) {
      return res.status(400).json({ error: 'avatarDataUrl must be an image data URI' });
    }

    // Limit size to ~2 MB (base64 is ~4/3 of binary)
    if (avatarDataUrl.length > 2_800_000) {
      return res.status(413).json({ error: 'Image too large (max ~2 MB)' });
    }

    const updated = await ProfileService.updateProfile(userId, { avatarUrl: avatarDataUrl });
    res.json({ avatarUrl: updated.avatarUrl });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

export default router;
