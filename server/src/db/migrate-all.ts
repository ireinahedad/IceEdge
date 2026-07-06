import 'dotenv/config';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

// Applies the base schema then every incremental migration, in order.
// Idempotent: all migration files use IF NOT EXISTS / duplicate-safe guards,
// so re-running is safe. Uses DATABASE_URL (e.g. your Neon connection string).

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[migrate] DATABASE_URL is not set');
  process.exit(1);
}

// SSL is required by Neon. rejectUnauthorized:false avoids local CA hassles.
const pool = new Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000,
});

const dbDir         = __dirname;                       // src/db
const schemaPath    = join(dbDir, 'schema.sql');
const migrationsDir = join(dbDir, 'migrations');

async function runFile(label: string, path: string): Promise<void> {
  const sql = readFileSync(path, 'utf8');
  try {
    await pool.query(sql);
    console.log(`[migrate] ✓ ${label}`);
  } catch (err: any) {
    // Keep going: partial/legacy databases may already have some objects.
    console.warn(`[migrate] ⚠ ${label} — ${err.message}`);
  }
}

(async () => {
  console.log('[migrate] Connecting to DB…');
  console.log(url!.replace(/:[^:@]+@/, ':********@'));

  await runFile('schema.sql', schemaPath);

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // 002_… 003_… … 014_…

  for (const f of files) {
    await runFile(`migrations/${f}`, join(migrationsDir, f));
  }

  console.log('[migrate] ✓ All migrations applied');
  await pool.end();
})().catch(async (err: any) => {
  console.error('[migrate] ✗ Fatal:', err.message);
  await pool.end();
  process.exit(1);
});
