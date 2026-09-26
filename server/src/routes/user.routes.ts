import { Router, Request, Response } from 'express';
import * as UserService from '../services/user.service';
import * as AuthService from '../services/auth.service';
import { deleteAccount } from '../services/accountDeletion.service';
import { accountDeletionLimiter } from '../middleware/rateLimit.middleware';
import {
  authenticate,
  requireRole,
  requireOwnerOrAdmin,
} from '../middleware/auth.middleware';
import { UpdateUserBody, UpdatePasswordBody } from '../types/user.type';
import { sendError } from '../httpError';
import { validateBody } from '../middleware/validate.middleware';
import { adminUpdateUserSchema } from '../validation/schemas';

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
    return sendError(res, err);
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
    return sendError(res, err);
  }
});

// POST /users/:userId/block — bloquer. Idempotent.
router.post('/:userId/block', async (req: Request, res: Response) => {
  try {
    await UserService.blockUser(req.user!.sub, req.params.userId);
    return res.status(204).send();
  } catch (err: any) {
    return sendError(res, err);
  }
});

// DELETE /users/:userId/block — débloquer. Idempotent et silencieux.
router.delete('/:userId/block', async (req: Request, res: Response) => {
  try {
    await UserService.unblockUser(req.user!.sub, req.params.userId);
    return res.status(204).send();
  } catch (err: any) {
    return sendError(res, err);
  }
});

// -------------------------------------------------------
//  Suppression de son propre compte — Guideline 5.1.1(v)
// -------------------------------------------------------
//
// Deux temps, parce qu'un jeton d'accès ne suffit pas pour une action
// définitive (voir `confirmIdentity`) :
//   1. POST   /users/me/deletion → { method: 'password' | 'code' } ; pour un
//      compte Google, le code part par courriel à ce moment-là ;
//   2. DELETE /users/me { password } ou { code } → 204, tout est effacé.
//
// La cible est TOUJOURS `req.user.sub`. Aucun identifiant n'est lu dans la
// requête : il n'existe aucun moyen de désigner le compte de quelqu'un d'autre.

router.post('/me/deletion', accountDeletionLimiter, async (req: Request, res: Response) => {
  try {
    return res.json(await AuthService.startReauth(req.user!.sub));
  } catch (err: any) {
    return sendError(res, err);
  }
});

router.delete('/me', accountDeletionLimiter, async (req: Request, res: Response) => {
  try {
    const { password, code } = req.body ?? {};
    await AuthService.confirmIdentity(req.user!.sub, {
      password: typeof password === 'string' ? password : undefined,
      code:     typeof code === 'string' ? code.trim() : undefined,
    });
    await deleteAccount(req.user!.sub);
    return res.status(204).send();
  } catch (err: any) {
    return sendError(res, err);
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
    return sendError(res, err);
  }
});

// -------------------------------------------------------
//  PATCH /users/:id  —  admin only
// -------------------------------------------------------
//
// Était « admin ou soi-même », sans validation, et le client ne s'en sert plus
// (le profil passe par `PATCH /users/me`, profile.routes.ts). Ouverte au
// propriétaire, elle changeait l'`email` du compte SANS vérification : un jeton
// d'accès volé (15 min) suffisait à poser l'adresse de l'attaquant, puis
// « mot de passe oublié » lui envoyait le code — prise de compte durable. Même
// raisonnement que `DELETE /users/:id` plus bas. Un doublon d'email ou de pseudo
// renvoie 409 au lieu d'un 500. QA dynamique du 2026-09-26 (S1.5).

router.patch(
  '/:id',
  requireRole('admin'),
  validateBody(adminUpdateUserSchema),
  async (req: Request<{ id: string }, {}, UpdateUserBody>, res: Response) => {
    try {
      const updated = await UserService.updateUser(req.params.id, req.body);
      return res.json(updated);
    } catch (err: any) {
      if (err?.code === '23505') {
        return res.status(409).json({ error: 'Email or username already in use' });
      }
      return sendError(res, err);
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
      return sendError(res, err);
    }
  },
);

// -------------------------------------------------------
//  DELETE /users/:id  —  admin only
// -------------------------------------------------------
//
// Était « admin ou soi-même ». Le soi-même passe désormais par `DELETE /me`,
// qui exige une reconfirmation : laisser cette porte ouverte au propriétaire
// permettrait de la contourner avec un simple jeton d'accès.

router.delete('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    await deleteAccount(req.params.id);
    return res.status(204).send();
  } catch (err: any) {
    return sendError(res, err);
  }
});

export default router;