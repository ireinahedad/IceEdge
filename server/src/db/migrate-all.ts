import 'dotenv/config';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

// Applies the base schema then every incremental migration, in order.
//
// Versioned (M2): a schema_migrations ledger records which files have run, so
// each incremental migration is applied exactly once and in a single
// transaction (BEGIN → run → record → COMMIT). This removes the reliance on
// every file being perfectly idempotent and makes "what's applied" auditable.
// The base schema.sql is still (re)run every time — it is IF NOT EXISTS
// throughout and defines the baseline — but it too is recorded.
// Uses DATABASE_URL (e.g. your Neon connection string).

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[migrate] DATABASE_URL is not set');
  process.exit(1);
}

// SSL is opt-in via DB_SSL=true (required by Neon/Supabase/external connections).
// Leave unset for local Postgres, which doesn't support SSL.
const useSsl = process.env.DB_SSL === 'true';
const pool = new Pool({
  connectionString: url,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 15_000,
});

const dbDir         = __dirname;                       // src/db
const schemaPath    = join(dbDir, 'schema.sql');
const migrationsDir = join(dbDir, 'migrations');

// Collects every migration that failed so the process can exit non-zero.
// We run *all* files before failing (rather than stopping at the first error)
// so a single run surfaces the complete list of problems.
const failures: Array<{ label: string; message: string }> = [];

const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   TEXT        PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;

async function isApplied(label: string): Promise<boolean> {
  const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [label]);
  return !!rowCount && rowCount > 0;
}

// Runs one file in its own transaction and records it in the ledger on success.
// `alwaysRun` = true re-applies the file even if already recorded (base schema).
async function runFile(label: string, path: string, alwaysRun = false): Promise<void> {
  if (!alwaysRun && (await isApplied(label))) {
    console.log(`[migrate] • ${label} (already applied, skipped)`);
    return;
  }

  const sql = readFileSync(path, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING',
      [label],
    );
    await client.query('COMMIT');
    console.log(`[migrate] ✓ ${label}`);
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    // A failed migration is rolled back atomically — the ledger is not updated,
    // so it will be retried on the next run. Record it and keep going so one
    // run surfaces the complete list of problems, then exit non-zero.
    console.error(`[migrate] ✗ ${label} — ${err.message}`);
    failures.push({ label, message: err.message });
  } finally {
    client.release();
  }
}

/**
 * Affiche la CIBLE avant de toucher quoi que ce soit.
 *
 * POURQUOI — `DATABASE_URL` vient de `.env`, qui porte la base de DÉV. Les
 * migrations qui comptent s'appliquent sur Neon, en surchargeant la variable
 * dans l'environnement le temps de la commande (cf. DEPLOYMENT.md §1). Les deux
 * commandes sont identiques à l'écran : rien, dans la sortie, ne disait laquelle
 * venait de tourner. On peut donc croire avoir migré la prod en ayant migré son
 * poste — et le découvrir au premier symptôme, qui sera muet (une table
 * manquante côté prod ne lève pas d'erreur, elle produit une donnée vide).
 *
 * Le mot de passe est retiré : cette ligne finit dans des logs de déploiement.
 */
function describeTarget(raw: string): string {
  try {
    const u = new URL(raw);
    const db = u.pathname.replace(/^\//, '') || '(défaut)';
    const local = /^(localhost|127\.0\.0\.1|::1)$/.test(u.hostname);
    return `${u.hostname}:${u.port || '5432'}/${db}`
      + `  ssl=${useSsl ? 'on' : 'off'}`
      + (local ? '  ← BASE LOCALE' : '');
  } catch {
    return '(URL illisible)';
  }
}

(async () => {
  console.log(`[migrate] Cible : ${describeTarget(url)}`);
  console.log('[migrate] Connecting to DB…');

  await pool.query(LEDGER_DDL);

  // Base schema is idempotent (IF NOT EXISTS throughout) → re-run every time.
  await runFile('schema.sql', schemaPath, true);

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // 002_… 003_… … 021_…

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
  // Les deux pannes de connexion qui ne se lisent pas d'elles-mêmes. Le couple
  // (hôte, DB_SSL) est le seul réglage qu'on peut avoir juste pour une cible et
  // faux pour l'autre — d'où une erreur qui survient précisément quand on vient
  // de changer de cible, c'est-à-dire au pire moment.
  if (/does not support SSL/i.test(err.message)) {
    console.error(
      '[migrate]   → Postgres local : poser DB_SSL=false (ou le retirer) pour '
      + 'cette commande. DB_SSL=true ne vaut que pour Neon.',
    );
  } else if (/self.signed|SSL|certificate/i.test(err.message)) {
    console.error('[migrate]   → Cible distante : DB_SSL=true est requis (Neon exige TLS).');
  }
  await pool.end();
  process.exit(1);
});
