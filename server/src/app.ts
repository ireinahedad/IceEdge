import express from 'express';
import * as Sentry from '@sentry/node';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';

import authRoutes          from './routes/auth.routes';
import userRoutes          from './routes/user.routes';
import profileRoutes       from './routes/profile.routes';
import nhlRoutes           from './routes/nhl.routes';
import oddsRoutes          from './routes/odds.routes';
import injuriesRoutes      from './routes/injuries.routes';
import mlRoutes            from './routes/ml.routes';
import tennisRoutes        from './routes/tennis.routes';
import chatRoutes          from './routes/chat.routes';
import slipRoutes          from './routes/slip.routes';
import devRoutes           from './routes/dev.routes';
import llmRoutes           from './routes/llm.routes';
import subscriptionRoutes, { stripeWebhook } from './routes/subscription.routes';
import pushRoutes          from './routes/push.routes';
import { getLeaderboard }  from './services/profile.service';
import { pool }            from './db/connection';
import { httpLogger, logger } from './logger';
import { seedAll }         from './db/seed';
import { apiLimiter, authLimiter, writeLimiter } from './middleware/rateLimit.middleware';

const app = express();

// Behind a proxy in prod (Railway/Render/Fly) → trust the first hop so
// express-rate-limit keys on the real client IP, not the proxy's.
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

app.use(helmet());
// Structured per-request logging + request ids (before routes so every handler
// gets req.log and the x-request-id header is set on the response).
app.use(httpLogger);
// credentials:true is required so the httpOnly refresh-token cookie flows
// between the client (5173) and the API (3001). '*' is not allowed with
// credentials, hence the explicit default origin.
// Allowed origins: the configured client(s) (CORS_ORIGIN may be a comma-
// separated list) plus any Vercel preview deployment of this project.
const allowedOrigins = (process.env.CORS_ORIGIN || process.env.CLIENT_URL || 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// Preview URLs look like https://ice-edge-<hash>-ireina-hedad-s-projects.vercel.app
const vercelPreview = /^https:\/\/ice-edge[a-z0-9-]*\.vercel\.app$/i;

app.use(cors({
  origin(origin, cb) {
    // Non-browser clients (curl, health checks) send no Origin — allow them.
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin) || vercelPreview.test(origin)) return cb(null, true);
    return cb(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
}));
app.use(cookieParser());

// Stripe webhook — MUST receive the raw body to verify the signature, so it is
// mounted with express.raw BEFORE the JSON parser below. Registered early so it
// also bypasses the /api JSON rate limiter.
app.post('/api/subscription/webhook', express.raw({ type: 'application/json' }), stripeWebhook);

// 5 MB: allows base64 avatar uploads (~2 MB binary → ~2.8 MB base64) with margin
app.use(express.json({ limit: '5mb' }));

// Broad rate-limit on the whole API (health check stays outside /api).
app.use('/api', apiLimiter);

// Auth — strict limiter first (brute-force protection), then routes.
app.use('/api/auth',          authLimiter, authRoutes);

// Users: profile /me routes first (no auth), then admin CRUD (require JWT)
app.use('/api/users',         profileRoutes);
app.use('/api/users',         userRoutes);

// NHL data (live from NHL API)
app.use('/api/nhl',           nhlRoutes);

// Leaderboard
app.get('/api/leaderboard', async (_req, res) => {
  try { res.json(await getLeaderboard()); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Chat (writes are limited to blunt spam)
app.use('/api/chat',          writeLimiter, chatRoutes);

// Bet slips (auth-gated; writes limited)
app.use('/api/slips',         writeLimiter, slipRoutes);

// Odds
app.use('/api/odds',          oddsRoutes);
app.use('/api/injuries',      injuriesRoutes);

// ML / prediction
app.use('/api/predict',       mlRoutes);

// Tennis live data
app.use('/api/tennis',        tennisRoutes);

// LLM proxy (uses user's own OpenAI key)
app.use('/api/llm',           llmRoutes);

// Subscriptions (Free / Pro)
app.use('/api/subscription',  subscriptionRoutes);

// Web Push (value-bet notifications)
app.use('/api/push',          pushRoutes);

// Dev ML dashboard (admin-only). Defence in depth: even though every route is
// gated behind authenticate + requireRole('admin'), the router is not mounted
// at all in production unless explicitly opted in via ENABLE_DEV_ROUTES=true.
// This removes the attack surface entirely in a normal prod deployment.
const devRoutesEnabled =
  process.env.NODE_ENV !== 'production' || process.env.ENABLE_DEV_ROUTES === 'true';
if (devRoutesEnabled) {
  app.use('/api/dev',         devRoutes);
}

// Dev-only seed endpoint
if (process.env.NODE_ENV !== 'production') {
  app.post('/dev/seed', async (_req, res) => {
    try { await seedAll(); res.json({ message: 'Seed complete' }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });
}

// Health checks — liveness vs readiness are deliberately separate.
//
// Liveness: is the process up and the event loop responsive? No dependencies.
// An orchestrator uses this to decide whether to RESTART the container, so it
// must NOT depend on Postgres — a DB blip should not trigger a restart loop.
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Readiness: can this instance actually serve requests right now? Checks the
// one hard dependency, Postgres. A load balancer uses this to decide whether to
// ROUTE traffic; returning 503 pulls the instance out of rotation while its DB
// is unreachable instead of sending users failing requests.
//
// The ML service is intentionally NOT checked here: predictions fall back to a
// rule-based path when it's down, so gating readiness on it would cause false
// outages and hammer the ML service with probe traffic.
app.get('/health/ready', async (_req, res) => {
  const checks: Record<string, 'ok' | 'down'> = { db: 'down' };
  try {
    const client = await pool.connect();
    try {
      // Bound the probe so a hung DB can't hang the health endpoint.
      await client.query('SET statement_timeout = 3000');
      await client.query('SELECT 1');
      checks.db = 'ok';
    } finally {
      client.release();
    }
  } catch (err: any) {
    logger.error({ err: err?.message ?? err }, '[health] readiness DB check failed');
  }

  const ready = checks.db === 'ok';
  res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'unavailable', checks });
});

// 404 catch-all
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Sentry error capture — no-op unless SENTRY_DSN is configured (see instrument.ts).
// Must be registered after routes and before our own error handler.
Sentry.setupExpressErrorHandler(app);

// Global error handler
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Log with the request-scoped logger so the error is correlated to its
  // request id; fall back to console if the logger middleware didn't run.
  ((req as any).log?.error?.bind((req as any).log) ?? console.error)({ err }, 'request failed');
  const status = err.status ?? 500;
  // Don't leak internal error details for unexpected 5xx in production.
  const isClientError = status >= 400 && status < 500;
  const message =
    isClientError || process.env.NODE_ENV !== 'production'
      ? err.message ?? 'Internal server error'
      : 'Internal server error';
  res.status(status).json({ error: message });
});

export default app;
