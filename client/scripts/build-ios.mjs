/**
 * build-ios.mjs — `npm run build:ios`. APPLE_PLAN §4 (2.2) + R9.
 *
 * 1. Builds the app with VITE_TARGET=ios into dist-ios/ (same Vite config, same
 *    .env / .env.production as the web build — only the target changes).
 *    Set here rather than in package.json so it works the same on Windows.
 * 2. Prunes what the native app must not ship: the static SEO pages copied from
 *    public/ (one of them is best-nhl-betting-software.html), sitemaps, robots,
 *    the service worker. No route-shells.mjs either.
 * 3. Fails if anything bookmaker-related survived in the bundle. This is the
 *    "grep before every release" of APPLE_PLAN 2.2, automated: CI cannot ship an
 *    iOS build that links to a sportsbook.
 */
import { build } from "vite";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "dist-ios");

process.env.VITE_TARGET = "ios";
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
