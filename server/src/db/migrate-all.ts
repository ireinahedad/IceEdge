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

// Collects every migration that failed so the process can exit non-zero.
// We run *all* files before failing (rather than stopping at the first error)
// so a single run surfaces the complete list of problems.
const failures: Array<{ label: string; message: string }> = [];

async function runFile(label: string, path: string): Promise<void> {
  const sql = readFileSync(path, 'utf8');
  try {
    await pool.query(sql);
    console.log(`[migrate] ✓ ${label}`);
  } catch (err: any) {
    // Migrations are written idempotently (IF NOT EXISTS / duplicate-safe
    // guards), so a genuine error means the schema may be incomplete.
    // Record it and keep going, but the process will fail at the end.
    console.error(`[migrate] ✗ ${label} — ${err.message}`);
    failures.push({ label, message: err.message });
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

  await pool.end();

  if (failures.length > 0) {
    console.error(
      `[migrate] ✗ ${failures.length} migration(s) failed — schema may be incomplete:`,
    );
    for (const { label, message } of failures) {
      console.error(`  • ${label}: ${message}`);
    }
    process.exit(1);
  }

  console.log('[migrate] ✓ All migrations applied');
})().catch(async (err: any) => {
  console.error('[migrate] ✗ Fatal:', err.message);
  await pool.end();
  process.exit(1);
});
