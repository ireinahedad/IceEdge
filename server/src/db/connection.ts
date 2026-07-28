import { Pool, PoolConfig } from 'pg';
import { logger } from '../logger';

// Managed Postgres (Neon, Railway, Render…) exposes a single DATABASE_URL.
// Prefer it when present; otherwise fall back to discrete DB_* vars for local dev.
// SSL is opt-in via DB_SSL=true (required by Neon / any external connection;
// leave unset for Railway's private network, which doesn't use SSL).
const useSsl = process.env.DB_SSL === 'true';

const config: PoolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DB_POOL_MAX) || 10,
      ssl: useSsl ? { rejectUnauthorized: false } : undefined,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    }
  : {
      host:     process.env.DB_HOST     || 'localhost',
      port:     Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME     || 'user_service_db',
      user:     process.env.DB_USER     || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      max:      Number(process.env.DB_POOL_MAX) || 10,
      ssl:      useSsl ? { rejectUnauthorized: false } : undefined,
      idleTimeoutMillis:    30_000,
      connectionTimeoutMillis: 5_000,
    };

export const pool = new Pool(config);

// Neon expose deux endpoints : direct (quelques dizaines de connexions) et
// pooled, via PgBouncer (~10 000). L'application doit utiliser le pooled —
// l'endpoint direct tient tant qu'il n'y a qu'une instance Railway, puis sature
// silencieusement dès qu'on scale ou que le job de règlement se dispute le pool
// avec les requêtes web. La panne se manifeste alors par des erreurs de
// connexion sous charge, difficiles à relier à leur cause.
//
// Avertissement au démarrage plutôt que blocage : d'autres hébergeurs Postgres
// ont d'autres conventions de nommage, et un déploiement ne doit pas échouer
// sur une heuristique.
{
  const url = process.env.DATABASE_URL;
  if (url && /neon\.tech/i.test(url) && !/-pooler\./i.test(url)) {
    logger.warn(
      '[DB] DATABASE_URL utilise l\'endpoint Neon DIRECT (pas de "-pooler" dans l\'hôte). ' +
      'Basculer sur l\'URL "Connection pooling" du dashboard Neon avant de scaler — ' +
      'voir DEPLOYMENT.md §1.',
    );
  }
}

pool.on('error', (err) => {
  logger.error({ err: err.message }, '[DB] Unexpected pool error');
});

/** Verify DB connectivity at startup */
export async function connectDB(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}