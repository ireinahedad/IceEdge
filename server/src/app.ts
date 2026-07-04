import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';

import authRoutes          from './routes/auth.routes';
import userRoutes          from './routes/user.routes';
import profileRoutes       from './routes/profile.routes';
import nhlRoutes           from './routes/nhl.route';
import oddsRoutes          from './routes/odds.route';
import mlRoutes            from './routes/ml.routes';
import tennisRoutes        from './routes/tennis.route';
import chatRoutes          from './routes/chat.routes';
import slipRoutes          from './routes/slip.routes';
import devRoutes           from './routes/dev.routes';
import llmRoutes           from './routes/llm.routes';
import subscriptionRoutes  from './routes/subscription.routes';
import pushRoutes          from './routes/push.routes';
import { getLeaderboard }  from './services/profile.service';
import { seedAll }         from './db/seed';
import { apiLimiter, authLimiter, writeLimiter } from './middleware/rateLimit.middleware';

const app = express();

// Behind a proxy in prod (Railway/Render/Fly) → trust the first hop so
// express-rate-limit keys on the real client IP, not the proxy's.
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

app.use(helmet());
// credentials:true is required so the httpOnly refresh-token cookie flows
// between the client (5173) and the API (3001). '*' is not allowed with
// credentials, hence the explicit default origin.
app.use(cors({
  origin: process.env.CORS_ORIGIN || process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(cookieParser());
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

// Dev ML dashboard (admin-only)
app.use('/api/dev',           devRoutes);

// Dev-only seed endpoint
if (process.env.NODE_ENV !== 'production') {
  app.post('/dev/seed', async (_req, res) => {
    try { await seedAll(); res.json({ message: 'Seed complete' }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });
}

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// 404 catch-all
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Global error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Error]', err);
  res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' });
});

export default app;
