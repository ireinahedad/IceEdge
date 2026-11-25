import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../services/auth.service';
import { isPro } from '../services/subscription.service';
import { UserRole } from '../types/user.type';
import { sendError } from '../httpError';
import { touchActivity } from '../services/growth.service';

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
    // Rétention (migration 055) : une écriture par compte et par jour, au plus.
    touchActivity(req.user.sub);
    next();
  } catch (err: any) {
    sendError(res, err, { fallbackStatus: 401 });
  }
}

// -------------------------------------------------------
//  Optional authentication (guest-friendly)
// -------------------------------------------------------
//  Attaches req.user when a valid Bearer token is present, but does NOT
//  reject anonymous requests: routes decide per-endpoint whether a user is
//  required. Used by read-only public endpoints (e.g. public chat rooms) that
//  should be visible to signed-out visitors while writes stay protected.
//
//  Note: a present-but-invalid/expired token still returns 401 so the client's
//  authedFetch can refresh and retry, rather than silently downgrading a
//  logged-in user to the guest view.

export function optionalAuthenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    next(); // no credentials → treat as guest
    return;
  }

  const token = authHeader.slice(7);
  try {
    req.user = verifyAccessToken(token);
    next();
  } catch (err: any) {
    sendError(res, err, { fallbackStatus: 401 });
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
    sendError(res, err);
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
// -------------------------------------------------------
//  Contenu réservé aux comptes (2026-11-20, demande du user)
// -------------------------------------------------------
//  ⚠️ 2026-11-25 : le mur est levé (demande du user, la fréquentation chutait).
//  `requireAccount` n'est plus monté nulle part ; `privatizeCache` ne sert plus
//  qu'à /api/leaderboard. Gardés pour refermer une route au besoin.
//
//  Du 2026-11-20 au 2026-11-25, toutes les données d'ArakIce (NHL,
//  prédictions, cotes, nouvelles, pick'em, classement) exigeaient un jeton
//  valide. Les routes concernées
//  posaient un `Cache-Control: public` : sur une requête portant
//  `Authorization`, `public` AUTORISE un cache partagé (CDN) à stocker la
//  réponse et à la resservir à n'importe qui, connecté ou non (RFC 9111 §3.5).
//  `privatizeCache` réécrit donc toute politique `public` en `private` au
//  moment où elle est posée, et retire `s-maxage` (qui ne vise que les caches
//  partagés). Le navigateur de la personne connectée garde son cache ; le CDN
//  ne garde plus rien.

export function privatizeCache(_req: Request, res: Response, next: NextFunction): void {
  const setHeader = res.setHeader.bind(res);
  res.setHeader = ((name: string, value: number | string | readonly string[]) => {
    if (name.toLowerCase() === 'cache-control' && typeof value === 'string') {
      value = value
        .split(',')
        .map((d) => d.trim())
        .filter((d) => d && !/^s-maxage=/i.test(d))
        .map((d) => (d.toLowerCase() === 'public' ? 'private' : d))
        .join(', ');
    }
    return setHeader(name, value);
  }) as typeof res.setHeader;
  next();
}

/** `privatizeCache` puis `authenticate` : à monter sur tout routeur de contenu. */
export const requireAccount = [privatizeCache, authenticate];

// -------------------------------------------------------
//  Fil de nouvelles : clé de service OU compte (2026-11-22)
// -------------------------------------------------------
//  ⚠️ 2026-11-25 : plus monté (/api/news est redevenu public).
//  Les comptes de nouvelles par équipe (dépôt NHL-posting) lisent `/api/news`
//  depuis GitHub Actions, sans compte. Ils envoient `X-News-Key`, comparé en
//  temps constant à `NEWS_FEED_SECRET`. Sans la variable, ou sans l'en-tête,
//  on retombe sur `authenticate` : rien n'est ouvert par défaut. Une clé
//  FAUSSE répond 401 tout de suite, sans essayer le jeton.

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest();

export function newsFeedKeyOrAccount(req: Request, res: Response, next: NextFunction): void {
  const given = req.get('x-news-key');
  const secret = process.env.NEWS_FEED_SECRET;
  if (given == null || given === '' || !secret) {
    authenticate(req, res, next);
    return;
  }
  if (crypto.timingSafeEqual(sha256(given), sha256(secret))) {
    next();
    return;
  }
  res.status(401).json({ error: 'Invalid news key' });
}
