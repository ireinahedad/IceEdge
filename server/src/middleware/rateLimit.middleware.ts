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
import type { Request } from 'express';
import { logger } from '../logger';
import { verifyAccessToken } from '../services/auth.service';
import { limiterStore } from './rateLimitStore';
import { clientIp } from './clientIp';

const isProd = process.env.NODE_ENV === 'production';

/**
 * Clé du limiteur : l'utilisateur authentifié, l'adresse IP à défaut.
 *
 * POURQUOI PAS L'IP SEULE — derrière un NAT d'opérateur mobile, des milliers
 * d'abonnés partagent une poignée d'adresses. Une seule IP consommait donc le
 * quota de tous : le premier utilisateur actif faisait rendre des 429 à des
 * inconnus, et le symptôme (« l'app rame sur mon téléphone, jamais sur le
 * wifi ») ne ressemble pas du tout à un limiteur.
 *
 * POURQUOI LE JETON EST VÉRIFIÉ ICI — `apiLimiter` est monté sur `/api` AVANT
 * toute route, donc avant `authenticate` : `req.user` n'existe pas encore. Lire
 * le `sub` d'un jeton NON vérifié serait un contournement complet du limiteur —
 * il suffirait de forger un `sub` différent à chaque requête pour repartir d'un
 * compteur neuf. La signature est donc validée (HMAC sur une charge minuscule,
 * quelques microsecondes) et un jeton invalide ou expiré retombe sur l'IP.
 *
 * CE QUE ÇA CHANGE, HONNÊTEMENT : le plafond devient « par compte » au lieu de
 * « par adresse ». Un attaquant disposant de N comptes vérifiés obtient N fois
 * le quota depuis une seule IP — la barrière déplacée est celle de la création
 * de comptes (`authLimiter` + vérification d'e-mail), pas celle-ci.
 *
 * Les préfixes `u:` / `ip:` évitent qu'un identifiant de compte puisse un jour
 * entrer en collision avec une adresse.
 */
export function userOrIpKey(req: Request): string {
  const attached = (req as any).user?.sub;
  if (attached) return `u:${attached}`;

  const header = req.headers['authorization'];
  if (header?.startsWith('Bearer ')) {
    try {
      return `u:${verifyAccessToken(header.slice(7)).sub}`;
    } catch {
      // Jeton absent, forgé ou expiré → on retombe sur l'IP, jamais sur un
      // identifiant non prouvé.
    }
  }
  return `ip:${clientIp(req) ?? 'unknown'}`;
}

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

/** Broad safety net — applied to all /api routes.
 *  Keyed per account when the request carries a valid token, per IP otherwise
 *  (cf. `userOrIpKey` : le NAT mobile faisait partager un quota à des inconnus). */
export const apiLimiter = rateLimit({
  // Compteurs partagés entre instances quand REDIS_URL est posée (ligne D).
  ...limiterStore('api'),
  windowMs: 60 * 1000,             // 1 minute
  limit:    apiLimit(),
  standardHeaders: 'draft-7',      // RateLimit-* headers
  legacyHeaders:   false,
  keyGenerator: userOrIpKey,
  message: { error: 'Too many requests, please slow down.' },
});

/** Strict — login / register. Blunts credential brute-force. */
export const authLimiter = rateLimit({
  ...limiterStore('auth'),
  windowMs: 15 * 60 * 1000,       // 15 minutes
  limit:    isProd ? 15 : 100,    // 15 attempts / 15 min / IP in prod
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  skipSuccessfulRequests: true,   // only count failed attempts
  message: { error: 'Too many attempts. Try again in a few minutes.' },
});

/** Moderate — writes (slips, chat messages, profile updates).
 *  Même clé que `apiLimiter` depuis le 2026-08-24 : par compte quand le jeton est
 *  valide, par IP sinon. Le NAT mobile faisait partager 30 écritures/min à des
 *  abonnés qui ne se connaissent pas — et c'est sur les écritures que le
 *  symptôme est le plus visible (message de chat refusé). Contrepartie assumée :
 *  N comptes valent N × 30 depuis une même adresse ; les salons gardent en plus
 *  leur propre limiteur par action (`chat.routes.ts`). */
export const writeLimiter = rateLimit({
  ...limiterStore('write'),
  windowMs: 60 * 1000,            // 1 minute
  limit:    isProd ? 30 : 500,    // 30 writes / min / compte en prod
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  keyGenerator: userOrIpKey,
  // Les LECTURES ne sont pas des écritures. Monté en préfixe sur `/api/slips`,
  // `/api/chat` et `/api/manual`, ce limiteur comptait aussi les GET : ouvrir le
  // chat (salons + messages + membres), revenir au premier plan et relire ses
  // coupons consommait les 30 « écritures » par minute, et la liste des coupons
  // renvoyait 429 à 30 lectures. QA dynamique du 2026-09-26 (P5). Les lectures
  // restent sous `apiLimiter`.
  skip: (req) => req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS',
  message: { error: 'Too many actions, please slow down.' },
});

/** Dedicated — email-sending endpoints (password reset, resend verification).
 *  `authLimiter` uses `skipSuccessfulRequests`, and these endpoints always
 *  return 200 (neutral, to avoid account enumeration), so they would otherwise
 *  be effectively un-throttled and abusable for email-bombing a victim's inbox.
 *  This limiter counts EVERY request, keyed by IP. */
export const passwordResetLimiter = rateLimit({
  ...limiterStore('password-reset'),
  windowMs: 60 * 60 * 1000,       // 1 hour
  limit:    isProd ? 5 : 100,     // 5 email triggers / hour / IP in prod
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  message: { error: 'Too many requests. Please try again later.' },
});

/** Dedicated — account deletion. Both steps are covered: starting one may send
 *  an email, and confirming one checks a password, which must not become a
 *  guessing oracle for someone holding a stolen access token. 10 rather than
 *  5: a single honest attempt already uses two (start + confirm). */
export const accountDeletionLimiter = rateLimit({
  ...limiterStore('account-deletion'),
  windowMs: 60 * 60 * 1000,       // 1 hour
  limit:    isProd ? 10 : 100,
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  message: { error: 'Too many requests. Please try again later.' },
});

/** Dedicated — LLM proxy. The Pro path bills the operator's OpenAI
 *  account, so it needs its own tight, per-user limit independent of the broad
 *  apiLimiter. Keyed by user id (route is authenticated) with an IP fallback. */
export const llmLimiter = rateLimit({
  ...limiterStore('llm'),
  windowMs: 60 * 1000,            // 1 minute
  limit:    isProd ? 10 : 60,     // 10 prompts / min / user in prod
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  keyGenerator: (req) => (req as any).user?.sub || clientIp(req),
  message: { error: 'Too many AI requests, please slow down.' },
});

/** Tight — promo-code redemption. Promo codes are guessable secrets, so this
 *  blunts brute-forcing. Keyed by user id (redeem is authenticated) with an IP
 *  fallback, so one account/IP can't grind through the code space. */
export const redeemLimiter = rateLimit({
  ...limiterStore('redeem'),
  windowMs: 60 * 60 * 1000,       // 1 hour
  limit:    isProd ? 10 : 100,    // 10 attempts / hour / user in prod
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  keyGenerator: (req) => (req as any).user?.sub || clientIp(req),
  message: { error: 'Too many promo attempts. Try again later.' },
});

/**
 * Dédié — les deux routes de prédiction qui construisent des variables et
 * appellent le service ML Python (`POST /api/predict/ml`, `POST
 * /api/predict/factors`).
 *
 * POURQUOI UN LIMITEUR À PART. Ces routes sont publiques et doivent le rester :
 * la landing (`BestBetsSection`) appelle `/predict/ml` sans compte, et exiger
 * une authentification supprimerait la fonctionnalité pour un visiteur. Le coût
 * n'est donc borné que par le débit. Une requête entrante y déclenche plusieurs
 * requêtes sortantes — API NHL puis service Python — et les caches TTL ne
 * couvrent rien quand l'identifiant change à chaque appel, ce qu'un abus fait
 * par construction. `apiLimiter` (300/min) plafonne la façade ; ici on plafonne
 * la dépense.
 *
 * POURQUOI 60 ET PAS MOINS. La rafale légitime la plus grosse est celle de
 * `BestBetsSection` : 20 appels `/predict/ml` d'un coup quand l'onglet ML est
 * sélectionné. 60/min laisse trois fois cette rafale avant le premier 429.
 * Descendre en dessous rendrait des 429 à un visiteur qui ne fait que cliquer.
 *
 * Même clé que `apiLimiter` (`userOrIpKey`) : par compte quand le jeton est
 * valide, par IP sinon — le NAT mobile ferait sinon partager 60 prédictions à
 * des abonnés qui ne se connaissent pas.
 */
export const predictLimiter = rateLimit({
  ...limiterStore('predict'),
  windowMs: 60 * 1000,            // 1 minute
  limit:    isProd ? 60 : 600,    // 60 prédictions ML / min / compte en prod
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  keyGenerator: userOrIpKey,
  message: { error: 'Too many prediction requests, please slow down.' },
});
