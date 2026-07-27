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

const isProd = process.env.NODE_ENV === 'production';

/** Broad safety net — applied to all /api routes. */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,             // 1 minute
  limit:    isProd ? 300 : 2000,   // SPA is chatty (many calls per page load)
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
