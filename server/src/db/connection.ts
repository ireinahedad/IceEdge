import { Pool, PoolConfig } from 'pg';
import { logger } from '../logger';

// Managed Postgres (Railway, Supabase, Render…) exposes a single DATABASE_URL.
// Prefer it when present; otherwise fall back to discrete DB_* vars for local dev.
// SSL is opt-in via DB_SSL=true (required by Supabase / external connections;
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