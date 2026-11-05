/**
 * x402.routes.ts — l'API pour agents, payée par appel en USDC (X402_PLAN.md, phase 2).
 *
 * ── Où ──────────────────────────────────────────────────────────────────────
 * Seulement sur l'hôte `X402_HOST` (agents.arakice.com) : le routeur rend la
 * main (`next('router')`) à tout autre hôte, donc rien n'existe sur
 * api.arakice.com. Monté dans app.ts AVANT le CORS global : le CORS du site
 * répond par origine avec `credentials`, ces routes ont besoin de `*`.
 * Sur l'hôte agents, toute autre adresse rend 404 : le reste de l'API ne s'y
 * voit pas.
 *
 * ── Ordre ───────────────────────────────────────────────────────────────────
 *   1. limiteur propre au routeur (par IP réelle, `clientIp` : CF-Connecting-IP
 *      si TRUST_CF_CONNECTING_IP=true, comme le reste) ;
 *   2. middleware de paiement : sans paiement valide → 402 AVANT tout handler,
 *      donc ni ML ni Neon ;
 *   3. handler. Le middleware garde la réponse en mémoire et ne règle (débite)
 *      que si le statut final est < 400 : 4xx, 5xx, match introuvable, ML en
 *      panne, jour sans match → aucun débit (vérifié dans @x402/express 2.28.0,
 *      `paymentMiddlewareFromHTTPServer`, et par x402.routes.test.ts).
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient, type FacilitatorClient, type RoutesConfig } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { limiterStore } from '../middleware/rateLimitStore';
import { clientIp } from '../middleware/clientIp';
import { sendError } from '../httpError';
import { logger } from '../logger';
import type { X402Config } from '../services/x402/config';
import { cdpAuthHeaders } from '../services/x402/cdpAuth';
import { allowedDates, DISCLAIMER, SOURCE, NOT_CHECKED, MAX_GAMES } from '../services/x402/format';
import { getAgentGames, getAgentResults, etDate } from '../services/x402/feed.service';

const GAMES_PATH = '/v1/nhl/games';
const RESULTS_PATH = '/v1/nhl/results';

/**
 * Descriptions : ce que rend l'endpoint et quand il sert, sans s'adresser à
 * l'agent (le Bazaar retire les textes lisibles comme une instruction).
 * ≤ 500 caractères. Interdits : gain, profit, « bat le marché », mise, ROI (§3).
 */
export const GAMES_DESCRIPTION =
  'NHL pre-game win and puck line (-1.5) probabilities from an independent model that takes no market odds as input, '
  + 'with starting goalies and a timestamp. Every game of the date that has not started. Each morning\'s numbers are '
  + 'also committed to a public git repository before the games. Useful when pricing NHL prediction markets.';
export const RESULTS_DESCRIPTION =
  'Free public track record of the same NHL model: each settled game with the probability committed before puck drop, '
  + 'the final score, and log-loss, Brier score and calibration. No odds, no betting returns.';

const EXAMPLE_GAMES = {
  date: '2026-11-03',
  games: [{
    gameId: '2026020187', home: 'TOR', away: 'MTL', startTimeUTC: '2026-11-04T00:00:00.000Z', status: 'scheduled',
    probabilities: { homeWin: 0.5712, homeMinus1_5: 0.2731, awayMinus1_5: 0.1302 },
    goalies: { home: null, away: null, confirmed: false },
    asOf: '2026-11-03T15:00:00.000Z',
  }],
  excluded: [],
  modelVersion: 'score-nhl-v1.0',
  asOf: '2026-11-03T15:00:00.000Z',
  source: SOURCE,
  notChecked: NOT_CHECKED,
  disclaimer: DISCLAIMER,
};

const GAMES_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['date', 'games', 'asOf', 'source', 'disclaimer'],
  properties: {
    date: { type: 'string', format: 'date' },
    games: {
      type: 'array', maxItems: MAX_GAMES,
      items: {
        type: 'object',
        required: ['gameId', 'home', 'away', 'startTimeUTC', 'probabilities', 'goalies', 'asOf'],
        properties: {
          gameId: { type: 'string' }, home: { type: 'string' }, away: { type: 'string' },
          startTimeUTC: { type: 'string', format: 'date-time' },
          status: { type: 'string', enum: ['scheduled'] },
          probabilities: {
            type: 'object',
            properties: {
              homeWin: { type: 'number', description: 'P(home wins), overtime and shootout included' },
              homeMinus1_5: { type: ['number', 'null'], description: 'P(home wins by 2+ goals)' },
              awayMinus1_5: { type: ['number', 'null'], description: 'P(away wins by 2+ goals)' },
            },
          },
          goalies: {
            type: 'object',
            properties: {
              home: { type: ['string', 'null'] }, away: { type: ['string', 'null'] },
              confirmed: { type: 'boolean', description: 'false = usual starter assumed' },
            },
          },
          asOf: { type: 'string', format: 'date-time' },
        },
      },
    },
    excluded: { type: 'array' },
    modelVersion: { type: ['string', 'null'] },
    asOf: { type: 'string', format: 'date-time' },
    source: { type: 'string' },
    notChecked: { type: 'array', items: { type: 'string' } },
    disclaimer: { type: 'string' },
  },
};

const gamesQuery = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict();
const resultsQuery = z.object({
  kind: z.enum(['morning', 'pregame']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).strict();

/**
 * Le validateur de l'extension Bazaar ne connaît pas `format` (date, date-time)
 * et l'écrit dans les journaux à CHAQUE 402 — des milliers par jour avec les
 * indexeurs. Retiré de l'extension seulement ; l'OpenAPI le garde.
 */
function withoutFormats<T>(o: T): T {
  if (Array.isArray(o)) return o.map(withoutFormats) as T;
  if (o && typeof o === 'object') {
    return Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'format').map(([k, v]) => [k, withoutFormats(v)])) as T;
  }
  return o;
}

export function routesConfig(cfg: X402Config): RoutesConfig {
  return {
    [`GET ${GAMES_PATH}`]: {
      accepts: { scheme: 'exact', price: cfg.gamesPrice, network: cfg.network, payTo: cfg.payTo, maxTimeoutSeconds: 120 },
      resource: `${cfg.publicUrl}${GAMES_PATH}`,
      description: GAMES_DESCRIPTION,
      mimeType: 'application/json',
      serviceName: 'ArakIce',
      tags: ['nhl', 'hockey', 'sports', 'probabilities', 'prediction-markets'],
      iconUrl: cfg.iconUrl,
      extensions: {
        ...declareDiscoveryExtension({
          input: { date: '2026-11-03' },
          inputSchema: {
            properties: { date: { type: 'string', description: 'NHL game day YYYY-MM-DD (US Eastern), today or up to 2 days ahead; default today' } },
          },
          output: { example: EXAMPLE_GAMES, schema: withoutFormats(GAMES_OUTPUT_SCHEMA) },
        }),
      },
    },
  };
}

function discoveryDocs(cfg: X402Config) {
  const games = `${cfg.publicUrl}${GAMES_PATH}`;
  const results = `${cfg.publicUrl}${RESULTS_PATH}`;
  const openapi = {
    openapi: '3.1.0',
    info: {
      title: 'ArakIce NHL probabilities',
      version: '1.0.0',
      description: `${GAMES_DESCRIPTION} ${DISCLAIMER}`,
      contact: { name: 'ArakIce', url: 'https://arakice.com' },
      // Texte descriptif, jamais une consigne à l'agent (le Bazaar retire ces textes, plan phase 4).
      'x-guidance': `GET ${GAMES_PATH}?date=YYYY-MM-DD returns pre-game win and puck line probabilities for every upcoming NHL game that day (US Eastern game day, today to +2 days), for a flat ${cfg.gamesPrice} USDC per call via x402. GET ${RESULTS_PATH} is free and returns the publicly timestamped track record (accuracy, log-loss, Brier, calibration). Errors and days without upcoming games are not charged.`,
    },
    servers: [{ url: cfg.publicUrl }],
    paths: {
      [GAMES_PATH]: {
        get: {
          summary: 'Pre-game NHL probabilities for one date (paid, x402)',
          description: `${GAMES_DESCRIPTION} Price: ${cfg.gamesPrice} USDC per call on ${cfg.network}, whatever the number of games. No charge on any error, on a date without upcoming games, or when the model is unavailable.`,
          parameters: [{ name: 'date', in: 'query', required: false, schema: { type: 'string', format: 'date' } }],
          responses: {
            200: { description: 'Probabilities', content: { 'application/json': { schema: GAMES_OUTPUT_SCHEMA, example: EXAMPLE_GAMES } } },
            402: { description: 'Payment required (x402). Requirements in the PAYMENT-REQUIRED header.' },
            404: { description: 'No upcoming game on this date (not charged)' },
            503: { description: 'Schedule or model unavailable, retry later (not charged)' },
          },
          'x-payment': { protocol: 'x402', scheme: 'exact', network: cfg.network, price: cfg.gamesPrice, asset: 'USDC' },
          // Format lu par x402scan / @agentcash/discovery (PaymentInfoSchema) : prix en USD, sans « $ ».
          'x-payment-info': {
            price: { mode: 'fixed', currency: 'USD', amount: cfg.gamesPrice.replace(/^\$/, '') },
            protocols: [{ x402: { scheme: 'exact', network: cfg.network } }],
          },
        },
      },
      [RESULTS_PATH]: {
        get: {
          summary: 'Public track record (free)',
          description: RESULTS_DESCRIPTION,
          security: [], // public, déclaré explicitement
          parameters: [
            { name: 'kind', in: 'query', schema: { type: 'string', enum: ['morning', 'pregame'], default: 'morning' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500, default: 200 } },
          ],
          responses: { 200: { description: 'Track record' } },
        },
      },
    },
  };
  const wellKnown = {
    x402Version: 2,
    provider: 'ArakIce',
    resources: [{ url: games, method: 'GET', description: GAMES_DESCRIPTION, scheme: 'exact', network: cfg.network, price: cfg.gamesPrice, mimeType: 'application/json' }],
    free: [{ url: results, method: 'GET', description: RESULTS_DESCRIPTION }],
    openapi: `${cfg.publicUrl}/openapi.json`,
  };
  const llms = [
    '# ArakIce NHL probabilities',
    '',
    `> ${GAMES_DESCRIPTION}`,
    '',
    `- [Pre-game probabilities](${games}): GET, paid with x402 (${cfg.gamesPrice} USDC per call, ${cfg.network}). Optional \`date\` (YYYY-MM-DD, US Eastern game day, today to +2 days). Not charged on errors or days without upcoming games.`,
    `- [Track record](${results}): GET, free. \`kind=morning\` (publicly timestamped, default) or \`pregame\`.`,
    `- [OpenAPI](${cfg.publicUrl}/openapi.json)`,
    `- [Public timestamped record](https://github.com/${cfg.proofRepo})`,
    '',
    'Pre-game only: games already started are listed under `excluded`. Win and puck line only, no totals.',
    `${DISCLAIMER} Not checked: ${NOT_CHECKED.join('; ')}.`,
    '',
  ].join('\n');
  return { openapi, wellKnown, llms };
}

/** CORS ouvert : un agent n'a pas de cookie à protéger ici, et rien ne dépend de l'appelant. */
function agentCors(req: Request, res: Response, next: NextFunction) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, PAYMENT-SIGNATURE, X-PAYMENT');
  res.setHeader('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE, EXTENSION-RESPONSES');
  res.setHeader('Access-Control-Max-Age', '86400');
  // helmet pose `same-origin` : un agent dans un navigateur ne pourrait pas lire la réponse.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
}

export interface AgentsRouterOptions {
  /** Tests : facilitateur simulé. Sinon, `HTTPFacilitatorClient` sur `cfg.facilitatorUrl`. */
  facilitator?: FacilitatorClient;
  /** false = ne pas interroger le facilitateur au démarrage (tests). */
  syncFacilitatorOnStart?: boolean;
}

export function createAgentsRouter(cfg: X402Config, opts: AgentsRouterOptions = {}): Router {
  const router = Router();
  const docs = discoveryDocs(cfg);

  router.use((req, _res, next) => {
    if (cfg.allowAnyHost || String(req.hostname ?? '').toLowerCase() === cfg.host) return next();
    return next('router');
  });
  router.use(agentCors);
  router.use(rateLimit({
    ...limiterStore('x402'),
    windowMs: 60_000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `ip:${clientIp(req) ?? 'unknown'}`,
    message: { error: 'Too many requests, slow down.' },
  }));

  // Facilitateur : celui de Coinbase (JWT à chaque appel) si une clé CDP est réglée, sinon x402.org (testnet).
  const facilitator = opts.facilitator ?? new HTTPFacilitatorClient({
    url: cfg.facilitatorUrl,
    timeoutMs: 30_000,
    ...(cfg.cdp ? { createAuthHeaders: cdpAuthHeaders(cfg.cdp, cfg.facilitatorUrl) } : {}),
  });
  const server = new x402ResourceServer(facilitator).register(cfg.network, new ExactEvmScheme());
  router.use(paymentMiddleware(routesConfig(cfg), server, undefined, undefined, opts.syncFacilitatorOnStart ?? true));

  router.get(GAMES_PATH, async (req, res) => {
    try {
      const q = gamesQuery.safeParse(req.query);
      if (!q.success) return res.status(400).json({ error: 'Query: optional date=YYYY-MM-DD only', code: 'bad_request' });
      const today = etDate();
      const date = q.data.date ?? today;
      if (!allowedDates(today).includes(date)) {
        return res.status(400).json({ error: `date must be one of ${allowedDates(today).join(', ')} (US Eastern game days)`, code: 'bad_date' });
      }
      const body = await getAgentGames(date);
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json(body);
    } catch (err: any) {
      if (err?.code === 'no_games') return res.status(404).json({ error: err.message, code: err.code, excluded: err.excluded ?? [] });
      if (err?.status === 503) return res.status(503).json({ error: err.message, code: err.code });
      return sendError(res, err, { context: '[x402/games]' });
    }
  });

  router.get(RESULTS_PATH, async (req, res) => {
    try {
      const q = resultsQuery.safeParse(req.query);
      if (!q.success) return res.status(400).json({ error: 'Query: kind=morning|pregame, limit=1..500', code: 'bad_request' });
      res.setHeader('Cache-Control', 'public, max-age=600');
      return res.json(await getAgentResults(q.data.kind ?? 'morning', cfg.proofRepo, q.data.limit ?? 200));
    } catch (err) {
      return sendError(res, err, { context: '[x402/results]' });
    }
  });

  router.get('/openapi.json', (_req, res) => res.set('Cache-Control', 'public, max-age=3600').json(docs.openapi));
  router.get('/.well-known/x402', (_req, res) => res.set('Cache-Control', 'public, max-age=3600').json(docs.wellKnown));
  // Favicon attendu à la racine par les annuaires : renvoie vers l'icône PNG du site.
  router.get(['/favicon.ico', '/favicon.png'], (_req, res) => res.set('Cache-Control', 'public, max-age=86400').redirect(302, cfg.iconUrl));
  router.get('/llms.txt', (_req, res) => res.set('Cache-Control', 'public, max-age=3600').type('text/plain').send(docs.llms));
  router.get('/', (_req, res) => res.json({
    name: 'ArakIce NHL probabilities', openapi: `${cfg.publicUrl}/openapi.json`, llms: `${cfg.publicUrl}/llms.txt`,
    endpoints: [GAMES_PATH, RESULTS_PATH],
  }));
  // Rien d'autre sur cet hôte.
  router.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  logger.info({ host: cfg.host, network: cfg.network, price: cfg.gamesPrice, facilitator: cfg.facilitatorUrl, cdp: Boolean(cfg.cdp) }, '[x402] API pour agents active');
  return router;
}
