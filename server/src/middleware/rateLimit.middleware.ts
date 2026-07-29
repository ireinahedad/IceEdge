/**
 * rateLimit.middleware.ts
 * ------------------------------------------------------------------
 * Rate limiters (express-rate-limit). Protects the API from abuse and
 * brute-force. Three tiers:
 *   - apiLimiter    : broad limit on every /api request
 *   - authLimiter   : strict limit on login/register (brute-force)
 *   - writeLimiter  : moderate limit on state-changing POST/PATCH routes
 *
 * NOTE: behind a proxy (Railway, Render, Fly, Vercel), set
 * `app.set('trust proxy', 1)` so the real client IP is used, not the proxy's.
 */

import rateLimit from 'express-rate-limit';
import { logger } from '../logger';

const isProd = process.env.NODE_ENV === 'production';

/**
 * Plafond du limiteur large, surchargeable par `API_RATE_LIMIT`.
 *
 * Raison d'être : un test de charge part d'une poignée d'adresses IP. À 500
 * utilisateurs virtuels, le limiteur répond 429 dès la première seconde et le
 * test mesure alors le limiteur, pas l'application — on croit avoir prouvé que
 * le serveur tient, alors qu'il n'a rien servi. Il faut donc pouvoir le relever
 * le temps du tir, sans toucher au code.
 *
 * Le défaut est INCHANGÉ. La surcharge est bruyante en production : une valeur
 * mise pour un test et oubliée dans les variables Railway est exactement le
 * genre d'erreur qui ne se remarque qu'au premier abus.
 */
function apiLimit(): number {
  const raw = process.env.API_RATE_LIMIT;
  const parsed = Number(raw);
  const fallback = isProd ? 300 : 2000;      // SPA is chatty (many calls per page load)

  if (!raw) return fallback;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    logger.warn({ API_RATE_LIMIT: raw }, '[rateLimit] valeur invalide — défaut conservé');
    return fallback;
  }
  if (isProd) {
    logger.warn(
      { limit: parsed, defaut: fallback },
      '[rateLimit] API_RATE_LIMIT surchargé EN PRODUCTION — à retirer après le test de charge',
    );
  }
  return parsed;
}

/** Broad safety net — applied to all /api routes. */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,             // 1 minute
  limit:    apiLimit(),
  standardHeaders: 'draft-7',      // RateLimit-* headers
  legacyHeaders:   false,
  message: { error: 'Too many requests, please slow down.' },
});

/** Strict — login / register. Blunts credential brute-force. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,       // 15 minutes
  limit:    isProd ? 15 : 100,    // 15 attempts / 15 min / IP in prod
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  skipSuccessfulRequests: true,   // only count failed attempts
  message: { error: 'Too many attempts. Try again in a few minutes.' },
});

/** Moderate — writes (slips, chat messages, profile updates). */
export const writeLimiter = rateLimit({
  windowMs: 60 * 1000,            // 1 minute
  limit:    isProd ? 30 : 500,    // 30 writes / min / IP in prod
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  message: { error: 'Too many actions, please slow down.' },
});

/** Dedicated — email-sending endpoints (password reset, resend verification).
 *  `authLimiter` uses `skipSuccessfulRequests`, and these endpoints always
 *  return 200 (neutral, to avoid account enumeration), so they would otherwise
 *  be effectively un-throttled and abusable for email-bombing a victim's inbox.
 *  This limiter counts EVERY request, keyed by IP. */
export const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,       // 1 hour
  limit:    isProd ? 5 : 100,     // 5 email triggers / hour / IP in prod
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  message: { error: 'Too many requests. Please try again later.' },
});

/** Dedicated — LLM proxy. The Pro path bills the operator's GitHub Models
 *  account, so it needs its own tight, per-user limit independent of the broad
 *  apiLimiter. Keyed by user id (route is authenticated) with an IP fallback. */
export const llmLimiter = rateLimit({
  windowMs: 60 * 1000,            // 1 minute
  limit:    isProd ? 10 : 60,     // 10 prompts / min / user in prod
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  keyGenerator: (req) => (req as any).user?.sub || req.ip,
  message: { error: 'Too many AI requests, please slow down.' },
});

/** Tight — promo-code redemption. Promo codes are guessable secrets, so this
 *  blunts brute-forcing. Keyed by user id (redeem is authenticated) with an IP
 *  fallback, so one account/IP can't grind through the code space. */
export const redeemLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,       // 1 hour
  limit:    isProd ? 10 : 100,    // 10 attempts / hour / user in prod
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  keyGenerator: (req) => (req as any).user?.sub || req.ip,
  message: { error: 'Too many promo attempts. Try again later.' },
});
