import 'dotenv/config';
import './instrument'; // Sentry — must load before app + its dependencies
import { createServer } from 'http';
import type { Server as HttpServer } from 'http';
import app from './app';
import { logger } from './logger';
import { pool, connectDB } from './db/connection';
import { initSocket, io } from './socket';
import { startSettlementJob } from './services/settlement.service';
import { startValueBetScan } from './services/valueBetScan.service';
import { startCleanupJob } from './services/cleanup.service';
import { startOddsLogger } from './services/oddsLogger.service';

const PORT = Number(process.env.PORT) || 3001;

// How long to wait for in-flight work to finish before forcing exit.
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10_000;

// Mode veille (hors-saison NHL) : DORMANT=true démarre l'API normalement mais
// sans aucun job de fond. Neon suspend son compute après 5 min d'inactivité et
// le plan gratuit ne couvre que 100 CU-heures/mois ; hors saison, les jobs
// périodiques réveillent la base pour ne rien trouver. Ce n'est pas zéro
// compute — une requête utilisateur réveille toujours la base — mais c'est zéro
// réveil programmé. Voir DEPLOYMENT.md § « Budget compute ».
const DORMANT = process.env.DORMANT === 'true';

(async () => {
  try {
    await connectDB();
    if (DORMANT) {
      // Volontairement en warn : ce mode a des conséquences fonctionnelles
      // (paris non réglés) et ne doit pas passer inaperçu dans les logs.
      logger.warn(
        '[Server] DORMANT=true — jobs de fond désactivés (règlement, value bets, ' +
        'nettoyage, log des cotes). Les paris en attente ne seront PAS réglés tant ' +
        'que la variable reste à true ; le rattrapage se fera au redémarrage.',
      );
    } else {
      // Auto-settle pending bets against real NHL results every 15 min
      startSettlementJob();
      // Scan for value bets and push to opted-in Pro users
      startValueBetScan();
      // Daily housekeeping: prune expired/revoked tokens and used codes
      startCleanupJob();
      // Journalise les cotes NHL du jour pour le réentraînement ML (odds_live_log.csv)
      startOddsLogger();
    }
  } catch (err: any) {
    logger.warn(`[Server] PostgreSQL unavailable - DB features disabled. (${err.message})`);
  }

  const httpServer = createServer(app);
  initSocket(httpServer);

  httpServer.listen(PORT, () => {
    logger.info(`[Server] Running on http://localhost:${PORT} (HTTP + WebSocket)`);
  });

  registerGracefulShutdown(httpServer);
})();

/**
 * Graceful shutdown — on SIGTERM/SIGINT (deploys, container stop, Ctrl-C):
 *   1. stop accepting new HTTP connections (drain in-flight requests)
 *   2. close all WebSocket connections
 *   3. close the Postgres pool
 * A hard timeout forces exit if something hangs, so a stuck connection can't
 * block a rolling deploy. Idempotent: a second signal is ignored.
 */
function registerGracefulShutdown(httpServer: HttpServer): void {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[Server] ${signal} received — shutting down gracefully…`);

    const forceExit = setTimeout(() => {
      logger.error('[Server] Forced exit after shutdown timeout');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      // Stop taking new WebSocket + HTTP connections, drain existing ones.
      await new Promise<void>((resolve) => io?.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
      await pool.end();
      logger.info('[Server] Clean shutdown complete');
      clearTimeout(forceExit);
      process.exit(0);
    } catch (err: any) {
      logger.error('[Server] Error during shutdown:', err?.message);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
