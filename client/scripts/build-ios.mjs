/**
 * build-ios.mjs — `npm run build:ios`. APPLE_PLAN §4 (2.2) + R9.
 *
 * 1. Builds the app with VITE_TARGET=ios into dist-ios/ (same Vite config, same
 *    .env / .env.production as the web build — only the target changes).
 *    Set here rather than in package.json so it works the same on Windows.
 * 2. Prunes what the native app must not ship: the static SEO pages copied from
 *    public/ (one of them is best-nhl-betting-software.html), sitemaps, robots,
 *    the service worker. No route-shells.mjs either.
 * 0. R7 — fails before building if any VITE_*_URL is missing or not https://
 *    (ATS would block it on the phone and the app would open on an empty screen).
 * 3. Fails if anything bookmaker-related survived in the bundle. This is the
 *    "grep before every release" of APPLE_PLAN 2.2, automated: CI cannot ship an
 *    iOS build that links to a sportsbook.
 */
import { build, loadEnv } from "vite";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "dist-ios");

process.env.VITE_TARGET = "ios";

// ── 0. env: every API URL must be https (R7) ──────────────────────────────
const REQUIRED_URLS = ["VITE_NHL_API_URL", "VITE_PREDICTION_API_URL", "VITE_PROFILE_API_URL", "VITE_SOCKET_URL"];
const viteEnv = loadEnv("production", ROOT, "VITE_");
const badEnv = REQUIRED_URLS.filter((k) => !/^https:\/\//.test(viteEnv[k] ?? ""));
if (badEnv.length) {
  console.error(`\n✗ build:ios — these must be set to an https:// URL (R7): ${badEnv.map((k) => `${k}=${viteEnv[k] ?? "(unset)"}`).join(", ")}\n`);
  process.exit(1);
}
// The path matters as much as the scheme: a base URL missing its /api suffix
// still passes the https check, and every call then lands on the server's
// catch-all 404 ({ error: "Not found" }) — the app opens but loads nothing.
const EXPECTED_PATH = {
  VITE_NHL_API_URL:        /\/api\/nhl\/?$/,
  VITE_PREDICTION_API_URL: /\/api\/?$/,
  VITE_PROFILE_API_URL:    /\/api\/?$/,
  VITE_SOCKET_URL:         /^https:\/\/[^/]+\/?$/,
};
const EXAMPLE = {
  VITE_NHL_API_URL:        "https://api.example.com/api/nhl",
  VITE_PREDICTION_API_URL: "https://api.example.com/api",
  VITE_PROFILE_API_URL:    "https://api.example.com/api",
  VITE_SOCKET_URL:         "https://api.example.com",
};
const badPath = REQUIRED_URLS.filter((k) => !EXPECTED_PATH[k].test(viteEnv[k]));
if (badPath.length) {
  console.error(`\n✗ build:ios — wrong path (every call would 404):\n${badPath.map((k) => `  ${k}=${JSON.stringify(viteEnv[k])}  → expected like ${EXAMPLE[k]}`).join("\n")}\n`);
  process.exit(1);
}

await build({ root: ROOT, build: { outDir: OUT, emptyOutDir: true } });

// ── 2. prune ───────────────────────────────────────────────────────────────
const KEEP = [
  /^index\.html$/,
  /^assets\//,
  /^fonts\//,
  /^arakice-[\w-]+\.png$/,
  /^manifest\.webmanifest$/,
];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const rel = (p) => relative(OUT, p).split("\\").join("/");
let pruned = 0;
for (const file of walk(OUT)) {
  if (!KEEP.some((re) => re.test(rel(file)))) { rmSync(file); pruned++; }
}
// Drop directories left empty (match/, fr/, matchup/, props/…).
for (const name of readdirSync(OUT)) {
  const p = join(OUT, name);
  if (statSync(p).isDirectory() && walk(p).length === 0) rmSync(p, { recursive: true });
}

// ── 2b. CSP (R16) ─ the web CSP is a Vercel header; the app has no server, so
// it travels as a meta tag. Same rules minus Google (fonts are self-hosted,
// no Google sign-in on iOS) and minus what a meta tag cannot carry.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");
const indexPath = join(OUT, "index.html");
const html = readFileSync(indexPath, "utf8");
if (!html.includes("<meta charset")) throw new Error("build:ios — index.html has no <meta charset>, cannot place the CSP");
writeFileSync(indexPath, html.replace(/(<meta charset[^>]*>)/i, `$1\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`));

// ── 3. guard ───────────────────────────────────────────────────────────────
const FORBIDDEN = [
  /stake\.com/i, /bet365\.com/i, /bet99\.com/i,
  /[?&](affiliate|btag|c)=\$\{/,
  /Place on /, /Parier sur /, /sportsbook/i, /Site de paris/,
  /best-nhl-betting-software/i,
];
const hits = [];
for (const file of walk(OUT)) {
  if (!/\.(js|html|css|json|webmanifest)$/.test(file)) continue;
  const text = readFileSync(file, "utf8");
  for (const re of FORBIDDEN) {
    const m = text.match(re);
    if (m) {
      const at = text.indexOf(m[0]);
      hits.push(`${rel(file)}: ${re} → …${text.slice(Math.max(0, at - 50), at + 50).replace(/\s+/g, " ")}…`);
    }
  }
}

if (hits.length) {
  console.error(`\n✗ build:ios — bookmaker content found in the iOS bundle (APPLE_PLAN 2.2):\n  ${hits.join("\n  ")}\n`);
  process.exit(1);
}
console.log(`\n✓ build:ios — dist-ios/ ready (${pruned} web-only files pruned, no bookmaker content).`);
