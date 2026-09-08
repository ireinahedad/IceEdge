import 'dotenv/config';
import './instrument'; // Sentry — must load before app + its dependencies
import { createServer } from 'http';
import type { Server as HttpServer } from 'http';
import app, { devRoutesEnabled } from './app';
import { logger } from './logger';
import { pool, connectDB } from './db/connection';
import { initSocket, io } from './socket';
import { startSettlementJob } from './services/settlement.service';
import { startValueBetScan } from './services/valueBetScan.service';
import { startCleanupJob } from './services/cleanup.service';
import { startOddsLogger, verifyOddsApiKey } from './services/oddsLogger.service';
import { verifyAvatarStorage } from './services/avatarStorage';
import { allowedOrigins } from './cors';
import { USE_MOCK } from './services/nhlApiClient';

const PORT = Number(process.env.PORT) || 3001;

// How long to wait for in-flight work to finish before forcing exit.
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10_000;

// Mode veille (hors-saison NHL) : DORMANT=true démarre l'API normalement mais
// sans aucun job de fond. Neon suspend son compute après 5 min d'inactivité, et
// le projet est sur le plan Launch : aucune allocation incluse, 0,106 $/CU-heure
// facturée sans plafond dur. Hors saison, les jobs périodiques réveillent donc
// la base pour ne rien trouver, et chaque réveil se paie. Ce n'est pas zéro
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
      // Journalise les cotes NHL du jour pour le réentraînement ML
      // (tables `odds_log` et `odds_snapshots` — plus de CSV depuis la 027)
      startOddsLogger();
    }
  } catch (err: any) {
    logger.warn(`[Server] PostgreSQL unavailable - DB features disabled. (${err.message})`);
  }

  const httpServer = createServer(app);
  initSocket(httpServer);

  httpServer.listen(PORT, () => {
    logger.info(`[Server] Running on http://localhost:${PORT} (HTTP + WebSocket)`);

    // Réglages qui changent SILENCIEUSEMENT ce que le serveur fait, et qu'on ne
    // peut pas déduire de son comportement sans mesurer. Les taire coûte cher :
    // un tir de charge de six minutes a été perdu (2026-08-03) parce que
    // `NHL_USE_MOCK` avait été posé dans le mauvais terminal — le run mesurait
    // l'API NHL réelle en croyant mesurer la mécanique interne, et rien à
    // l'écran ne le disait. Ces variables sont lues à l'IMPORT des modules :
    // un serveur déjà démarré ne les verra jamais.
    logger.info(
      {
        // La valeur EFFECTIVE, pas la variable brute — même raison que pour
        // `ENABLE_DEV_ROUTES` plus bas : en production `NHL_USE_MOCK=true` est
        // ignoré sans `ALLOW_MOCK_IN_PRODUCTION=true`, et la bannière doit dire
        // ce que le serveur FAIT. C'est cette ligne que le préflight du tir de
        // charge B3 lit pour savoir si le run mesure autre chose que prévu.
        NHL_USE_MOCK:   USE_MOCK,
        NHL_TIMEOUT_MS: Number(process.env.NHL_TIMEOUT_MS) || 8_000,
        ML_DISABLED:    process.env.ML_DISABLED === 'true',
        ODDS_API_KEY:   process.env.ODDS_API_KEY ? 'présente (validité vérifiée par verifyOddsApiKey)' : 'ABSENTE (proxy → [])',
        API_RATE_LIMIT: process.env.API_RATE_LIMIT ?? 'défaut',
        // Les quatre du préflight B4 (`QA_TEST_PLAN.md`, § Runbooks B4). Même
        // critère que les lignes ci-dessus : chacune casse quelque chose en
        // silence, et aucune ne se voit dans une réponse HTTP.
        NODE_ENV:       process.env.NODE_ENV ?? 'non posé (⇒ cookie de refresh sans Secure)',
        // La liste RÉSOLUE, pas la variable : c'est elle que `isAllowedOrigin`
        // compare par égalité de chaîne, slash final et casse compris.
        CORS_ORIGIN:    allowedOrigins,
        EMAIL_VERIFICATION_DISABLED: process.env.EMAIL_VERIFICATION_DISABLED === 'true',
        ENABLE_DEV_ROUTES: devRoutesEnabled ? 'routes /api/dev MONTÉES' : 'routes /api/dev NON montées',
      },
      '[Server] Réglages effectifs',
    );

    // Sonde R2 : un appel réseau réel, parce que la ligne « R2 configuré » ne
    // vérifie que la présence des variables. Sans elle, un bucket injoignable
    // se traduit seulement par des avatars qui repartent en base64 — un repli
    // volontairement silencieux, donc indébogable. Lancée sans `await` : elle
    // ne doit ni retarder l'écoute ni pouvoir empêcher le démarrage.
    void verifyAvatarStorage();

    // Sonde The Odds API : même raison que ci-dessus, appliquée à la clé de
    // cotes. La ligne `ODDS_API_KEY: présente` du bloc au-dessus ne teste que
    // la présence de la variable ; une clé révoquée y passerait au vert et ne
    // se manifesterait qu'au premier jour de matchs. La sonde est gratuite
    // (`/v4/sports` est hors quota) et, comme l'autre, lancée sans `await`.
    void verifyOddsApiKey();
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
