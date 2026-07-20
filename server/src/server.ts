import 'dotenv/config';
import './instrument'; // Sentry — must load before app + its dependencies
import { createServer } from 'http';
import type { Server as HttpServer } from 'http';
import app from './app';
import { pool, connectDB } from './db/connection';
import { initSocket, io } from './socket';
import { startSettlementJob } from './services/settlement.service';
import { startValueBetScan } from './services/valueBetScan.service';

const PORT = Number(process.env.PORT) || 3001;

// How long to wait for in-flight work to finish before forcing exit.
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10_000;

(async () => {
  try {
    await connectDB();
    // Auto-settle pending bets against real NHL results every 15 min
    startSettlementJob();
    // Scan for value bets and push to opted-in Pro users
    startValueBetScan();
  } catch (err: any) {
    console.warn(`[Server] PostgreSQL unavailable - DB features disabled. (${err.message})`);
  }

  const httpServer = createServer(app);
  initSocket(httpServer);

  httpServer.listen(PORT, () => {
    console.log(`[Server] Running on http://localhost:${PORT} (HTTP + WebSocket)`);
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
    console.log(`[Server] ${signal} received — shutting down gracefully…`);

    const forceExit = setTimeout(() => {
      console.error('[Server] Forced exit after shutdown timeout');
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
      console.log('[Server] Clean shutdown complete');
      clearTimeout(forceExit);
      process.exit(0);
    } catch (err: any) {
      console.error('[Server] Error during shutdown:', err?.message);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
