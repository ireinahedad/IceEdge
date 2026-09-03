#!/usr/bin/env node
/**
 * check-env.mjs — PRE_IOS_PLAN.md R7.3
 *
 * The same rules as `src/app/env.ts`, run at build time instead of in the
 * visitor's browser. The point is that a missing Vercel variable fails a
 * pipeline, not a phone.
 *
 * Usage:
 *   node scripts/check-env.mjs                 # validate the variables (mode: production)
 *   node scripts/check-env.mjs --mode=development
 *   node scripts/check-env.mjs --dist          # also scan dist/ for baked-in localhost URLs
 *   node scripts/check-env.mjs --dist-only     # scan dist/ only (needs no variables)
 *
 * Resolution order matches Vite: .env, .env.local, .env.<mode>, .env.<mode>.local,
 * with real environment variables (how Vercel and CI supply them) winning over all.
 *
 * Exit code 1 on an error. Warnings are printed and do not fail the run.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const REQUIRED_URLS = [
  'VITE_NHL_API_URL',
  'VITE_PREDICTION_API_URL',
  'VITE_PROFILE_API_URL',
  'VITE_SOCKET_URL',
];

/** Hosts that mean "nobody filled this in yet". Reported, but not fatal. */
const PLACEHOLDER_HOSTS = ['ton-backend.railway.app', 'your-ml-server.com', 'example.com'];

const args = process.argv.slice(2);
const distOnly = args.includes('--dist-only');
const scanDist = distOnly || args.includes('--dist');
const mode = (args.find((a) => a.startsWith('--mode=')) ?? '--mode=production').split('=')[1];

const errors = [];
const warnings = [];

// ── .env parsing (no dependency; Vite's precedence) ──────────────────────────

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadEnv() {
  const files = ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`];
  const loaded = [];
  let merged = {};
  for (const f of files) {
    const path = join(CLIENT_DIR, f);
    if (!existsSync(path)) continue;
    loaded.push(f);
    merged = { ...merged, ...parseEnvFile(path) };
  }
  // Real environment variables win — that is how Vercel and CI supply them.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('VITE_') && process.env[key]) merged[key] = process.env[key];
  }
  return { merged, loaded };
}

// ── Variable validation — mirrors requiredUrl() in src/app/env.ts ────────────

function checkVariables() {
  const { merged, loaded } = loadEnv();
  console.log(`mode: ${mode}`);
  console.log(`env files read: ${loaded.length ? loaded.join(', ') : 'none (using the process environment only)'}`);

  const strictHttps = mode === 'production';

  for (const name of REQUIRED_URLS) {
    const value = merged[name];
    if (!value) {
      errors.push(`${name} is not set. Add it to client/.env.${mode} or to the Vercel project's environment variables.`);
      continue;
    }
    if (strictHttps && !value.startsWith('https://')) {
      errors.push(`${name} must be https:// in production, got: ${value}`);
    }
    const placeholder = PLACEHOLDER_HOSTS.find((h) => value.includes(h));
    if (placeholder) {
      warnings.push(`${name} still points at the placeholder host ${placeholder} — ${value}`);
    }
    if (!errors.some((e) => e.startsWith(name))) console.log(`  ok  ${name} = ${value}`);
  }

  if (!merged.VITE_SENTRY_DSN) {
    console.log('  --  VITE_SENTRY_DSN is not set (optional: error monitoring is a no-op)');
  }
}

// ── Bundle scan — no variables needed, catches a localhost URL that shipped ──

/**
 * A dev-server URL, i.e. localhost *with a port*: `http://localhost:3001`.
 *
 * The port matters. react-router ships `new URL("http://localhost")` as a base
 * for relative-URL parsing, and matching a bare `http://localhost` therefore
 * flags every build. Nothing legitimate hard-codes a port into a bundle, so
 * this pattern means exactly one thing: someone re-added a
 * `|| 'http://localhost:3001'` fallback that env.ts exists to prevent.
 */
const DEV_URL = /https?:\/\/(?:localhost|127\.0\.0\.1):\d+/g;

function checkDist() {
  const distAssets = join(CLIENT_DIR, 'dist', 'assets');
  if (!existsSync(distAssets)) {
    errors.push('dist/assets not found — run `npm run build` before the --dist check.');
    return;
  }
  const files = readdirSync(distAssets).filter((f) => f.endsWith('.js'));
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(join(distAssets, f), 'utf8');
    const hits = [...new Set(src.match(DEV_URL) ?? [])];
    for (const hit of hits) offenders.push(`${f} contains ${hit}`);
  }
  console.log(`scanned ${files.length} bundle file(s) in dist/assets`);
  if (offenders.length) {
    errors.push(
      'A production bundle contains a dev-server URL — a localhost fallback is back in the client:\n    ' +
        offenders.join('\n    '),
    );
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────

console.log('check:env — PRE_IOS_PLAN.md R7\n');
if (!distOnly) checkVariables();
if (scanDist) checkDist();

if (warnings.length) {
  console.log('\nwarnings:');
  for (const w of warnings) console.log(`  !  ${w}`);
}

if (errors.length) {
  console.error('\nerrors:');
  for (const e of errors) console.error(`  x  ${e}`);
  console.error(`\ncheck:env failed with ${errors.length} error(s).`);
  process.exit(1);
}

console.log('\ncheck:env passed.');
