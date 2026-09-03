import { Router, Request, Response } from 'express';
import * as UserService from '../services/user.service';
import {
  authenticate,
  requireRole,
  requireOwnerOrAdmin,
} from '../middleware/auth.middleware';
import { UpdateUserBody, UpdatePasswordBody } from '../types/user.type';

const router = Router();

// All user routes require authentication
router.use(authenticate);

// -------------------------------------------------------
//  GET /users  —  admin only
// -------------------------------------------------------

router.get('/', requireRole('admin'), async (_req: Request, res: Response) => {
  try {
    const users = await UserService.getAllUsers();
    return res.json(users);
  } catch (err: any) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

// -------------------------------------------------------
//  Blocage entre utilisateurs — R4.2e (Guideline 1.2)
// -------------------------------------------------------
//
// Déclarées AVANT `/:id` : `/me/blocks` a deux segments et ne serait pas
// capturée par `/:id` de toute façon, mais l'ordre rend la lecture sans piège
// pour la prochaine route « me » que quelqu'un ajoutera.
//
// ⚠️ Pas de `requireOwnerOrAdmin` ici, et ce n'est pas un oubli : `:userId` est
// la CIBLE du blocage, pas le propriétaire de la ressource. Le middleware
// signifierait « tu ne peux bloquer que toi-même ». Le bloqueur est toujours
// `req.user.sub`, jamais une valeur envoyée par le client.

// GET /users/me/blocks — la liste que l'écran Réglages affiche
router.get('/me/blocks', async (req: Request, res: Response) => {
  try {
    return res.json(await UserService.getBlockedUsers(req.user!.sub));
  } catch (err: any) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

// POST /users/:userId/block — bloquer. Idempotent.
router.post('/:userId/block', async (req: Request, res: Response) => {
  try {
    await UserService.blockUser(req.user!.sub, req.params.userId);
    return res.status(204).send();
  } catch (err: any) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

// DELETE /users/:userId/block — débloquer. Idempotent et silencieux.
router.delete('/:userId/block', async (req: Request, res: Response) => {
  try {
    await UserService.unblockUser(req.user!.sub, req.params.userId);
    return res.status(204).send();
  } catch (err: any) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

// -------------------------------------------------------
//  GET /users/:id
// -------------------------------------------------------

router.get('/:id', requireOwnerOrAdmin, async (req: Request, res: Response) => {
  try {
    const user = await UserService.getUserById(req.params.id);
    return res.json(user);
  } catch (err: any) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

// -------------------------------------------------------
//  PATCH /users/:id
// -------------------------------------------------------

router.patch(
  '/:id',
  requireOwnerOrAdmin,
  async (req: Request<{ id: string }, {}, UpdateUserBody>, res: Response) => {
    try {
      const updated = await UserService.updateUser(req.params.id, req.body);
      return res.json(updated);
    } catch (err: any) {
      return res.status(err.status ?? 500).json({ error: err.message });
    }
  },
);

// -------------------------------------------------------
//  PATCH /users/:id/password
// -------------------------------------------------------

router.patch(
  '/:id/password',
  requireOwnerOrAdmin,
  async (req: Request<{ id: string }, {}, UpdatePasswordBody>, res: Response) => {
    try {
      const { current_password, new_password } = req.body;
      if (!current_password || !new_password) {
        return res.status(400).json({ error: 'current_password and new_password are required' });
      }
      if (new_password.length < 8) {
        return res.status(400).json({ error: 'New password must be at least 8 characters' });
      }

      await UserService.updatePassword(req.params.id, { current_password, new_password });
      return res.status(204).send();
    } catch (err: any) {
      return res.status(err.status ?? 500).json({ error: err.message });
    }
  },
);

// -------------------------------------------------------
//  DELETE /users/:id  —  admin only (or self)
// -------------------------------------------------------

router.delete('/:id', requireOwnerOrAdmin, async (req: Request, res: Response) => {
  try {
    await UserService.deleteUser(req.params.id);
    return res.status(204).send();
  } catch (err: any) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

export default router;