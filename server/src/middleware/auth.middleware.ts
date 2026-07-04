import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../services/auth.service';
import { isPro } from '../services/subscription.service';
import { UserRole } from '../types/user.type';

// -------------------------------------------------------
//  Require a valid JWT access token
// -------------------------------------------------------

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    req.user = verifyAccessToken(token);
    next();
  } catch (err: any) {
    res.status(err.status ?? 401).json({ error: err.message });
  }
}

// -------------------------------------------------------
//  Require specific role(s)
// -------------------------------------------------------

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}

// -------------------------------------------------------
//  Require an active Pro subscription (admins always pass)
// -------------------------------------------------------
//  Use after `authenticate`. Checks the DB so a downgrade takes effect
//  immediately rather than waiting for the 15-min access token to expire.

export async function requirePro(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }
  try {
    if (req.user.role === 'admin' || (await isPro(req.user.sub))) {
      next();
      return;
    }
    res.status(402).json({ error: 'Pro subscription required', code: 'PRO_REQUIRED' });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
}

// -------------------------------------------------------
//  Require the caller to be the resource owner OR admin
// -------------------------------------------------------

export function requireOwnerOrAdmin(req: Request, res: Response, next: NextFunction): void {
  const { user } = req;
  const targetId = req.params.id;

  if (!user) {
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }

  if (user.role === 'admin' || user.sub === targetId) {
    next();
  } else {
    res.status(403).json({ error: 'Forbidden' });
  }
}