import { Router, Request, Response, NextFunction } from 'express';
import * as ProfileService from '../services/profile.service';
import { authenticate, requirePro } from '../middleware/auth.middleware';
import { validateBody } from '../middleware/validate.middleware';
import { avatarSchema, profileUpdateSchema } from '../validation/schemas';
import { uploadAvatar, deleteAvatarByUrl } from '../services/avatarStorage';
import { sendError } from '../httpError';

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
    sendError(res, err);
  }
});

// Consulter les paris d'un AUTRE joueur est réservé aux abonnés Pro ; les siens
// restent accessibles sans abonnement. Extrait en middleware nommé pour que
// `/slips` et `/summary` partagent exactement la même règle — deux copies de la
// même closure finiraient par diverger, et c'est un mur d'accès.
function requireProForOthers(req: Request, res: Response, next: NextFunction) {
  const viewerId = (req as any).user?.sub;
  if (viewerId && viewerId === req.params.userId) return next();
  return requirePro(req, res, next);
}

// GET /api/users/:userId/summary — identité + forme récente, pour l'en-tête.
router.get('/:userId/summary', authenticate, requireProForOthers, async (req: Request, res: Response) => {
  try {
    const viewerId = (req as any).user?.sub;
    if (!viewerId) return res.status(401).json({ error: 'Unauthorized' });
    res.json(await ProfileService.getPlayerSummary(req.params.userId, viewerId));
  } catch (err: any) {
    sendError(res, err);
  }
});

// GET /api/users/:userId/slips — another player's bets/slips.
router.get('/:userId/slips', authenticate, requireProForOthers, async (req: Request, res: Response) => {
  try {
    const viewerId = (req as any).user?.sub;
    if (!viewerId) return res.status(401).json({ error: 'Unauthorized' });
    const limit = Number(req.query.limit) || 25;
    res.json(await ProfileService.getPublicSlips(req.params.userId, viewerId, limit));
  } catch (err: any) {
    sendError(res, err);
  }
});

// GET /api/users/me
router.get('/me', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.sub;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    res.json(await ProfileService.getProfileById(userId));
  } catch (err: any) {
    sendError(res, err);
  }
});

// GET /api/users/me/bets
router.get('/me/bets', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.sub;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    res.json(await ProfileService.getBetHistory(userId));
  } catch (err: any) {
    sendError(res, err);
  }
});

// GET /api/users/me/stats
router.get('/me/stats', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.sub;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    res.json(await ProfileService.getBettingStats(userId));
  } catch (err: any) {
    sendError(res, err);
  }
});

// PATCH /api/users/me
//
// `validateBody` posé le 2026-08-24 : la route acceptait `req.body` tel quel, et
// les colonnes visées sont des `TEXT` sans borne. Le schéma est une liste blanche
// (les clés inconnues sont retirées) et plafonne chaque champ — cf.
// `profileUpdateSchema`, qui explique pourquoi `username` y reste large.
router.patch('/me', validateBody(profileUpdateSchema), async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.sub;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    res.json(await ProfileService.updateProfile(userId, req.body));
  } catch (err: any) {
    sendError(res, err);
  }
});

// POST /api/users/me/avatar  { avatarDataUrl: string }
//
// Reçoit une data-URI base64 (le client l'a déjà redimensionnée en 256×256).
// Si Cloudflare R2 est configuré, l'image est poussée sur le bucket et seule
// son URL est stockée en base. Sinon on retombe sur l'ancien comportement
// (data-URI en base) pour que l'app fonctionne sans object-store.
router.post('/me/avatar', validateBody(avatarSchema), async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.sub;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // Shape + size already enforced by avatarSchema (data:image/ URI, ≤ 400k chars).
    const { avatarDataUrl } = req.body as { avatarDataUrl: string };

    const previousUrl = await ProfileService.getAvatarUrl(userId);
    const storedUrl   = await uploadAvatar(userId, avatarDataUrl);

    const updated = await ProfileService.updateProfile(userId, {
      avatarUrl: storedUrl ?? avatarDataUrl,
    });

    // L'ancien objet n'est supprimé qu'une fois le nouveau enregistré : en cas
    // d'échec entre les deux, l'utilisateur garde un avatar valide.
    if (storedUrl) await deleteAvatarByUrl(userId, previousUrl);

    res.json({ avatarUrl: updated.avatarUrl });
  } catch (err: any) {
    sendError(res, err);
  }
});

export default router;
