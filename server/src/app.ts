import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import authRoutes          from './routes/auth.routes';
import userRoutes          from './routes/user.routes';
import profileRoutes       from './routes/profile.routes';
import nhlRoutes           from './routes/nhl.route';
import oddsRoutes          from './routes/odds.route';
import mlRoutes            from './routes/ml.routes';
import tennisRoutes        from './routes/tennis.route';
import chatRoutes          from './routes/chat.routes';
import slipRoutes          from './routes/slip.routes';
import { getLeaderboard }  from './services/profile.service';
import { seedAll }         from './db/seed';

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

// Auth
app.use('/api/auth',          authRoutes);

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

// Chat
app.use('/api/chat',          chatRoutes);

// Bet slips (auth-gated)
app.use('/api/slips',         slipRoutes);

// Odds
app.use('/api/odds',          oddsRoutes);

// ML / prediction
app.use('/api/predict',       mlRoutes);

// Tennis live data
app.use('/api/tennis',        tennisRoutes);

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
