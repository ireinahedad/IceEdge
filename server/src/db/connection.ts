import { Pool, PoolConfig } from 'pg';

const config: PoolConfig = {
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'user_service_db',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max:      Number(process.env.DB_POOL_MAX) || 10,
  idleTimeoutMillis:    30_000,
  connectionTimeoutMillis: 2_000,
};

export const pool = new Pool(config);

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

/** Verify DB connectivity at startup */
export async function connectDB(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    console.log('[DB] PostgreSQL connected ✓');
  } finally {
    client.release();
  }
}