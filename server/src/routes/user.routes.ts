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