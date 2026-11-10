#!/usr/bin/env node
/**
 * indexnow.mjs — tell Bing (and the other IndexNow engines) which public pages
 * just changed, so they are recrawled the same day instead of weeks later.
 * ChatGPT search draws on Bing's index: this is the fastest path from "page
 * generated" to "page an assistant can cite".
 *
 * Reads the files changed by the last commit (the one seo-gameday.yml just
 * made) under client/public, maps them to URLs, and POSTs them in one batch.
 * Never fails the workflow: a refused ping only costs a slower recrawl.
 *
 * Key file: client/public/b99f8d99211c8a7ad5f3605847a85cf8.txt (served at https://arakice.com/b99f8d99211c8a7ad5f3605847a85cf8.txt,
 * which is how the engines verify the site is ours).
 *
 * Usage (after the commit):  node scripts/indexnow.mjs [<git range>]   default HEAD~1..HEAD
 */
import { execFileSync } from "node:child_process";

const KEY = "b99f8d99211c8a7ad5f3605847a85cf8";
const HOST = "arakice.com";
const SITE = `https://${HOST}`;
const range = process.argv[2] || "HEAD~1..HEAD";

let files = [];
try {
  files = execFileSync("git", ["diff", "--name-only", range, "--", "client/public"], { encoding: "utf-8" })
    .split("\n").map((f) => f.trim()).filter(Boolean);
} catch (e) {
  console.log(`indexnow: git diff ${range} impossible (${e.message.split("\n")[0]}) — rien envoyé`);
  process.exit(0);
}

const urls = [...new Set(files
  .filter((f) => f.endsWith(".html") || f.endsWith(".xml"))
  .map((f) => f.replace(/^client\/public/, "").replace(/\/index\.html$/, "").replace(/\.html$/, ""))
  .map((p) => (p.endsWith(".xml") ? p : p || "/"))
  .filter((p) => !p.endsWith(".xml")) // sitemaps are fetched on their own schedule
  .map((p) => SITE + p))].slice(0, 10000);

if (!urls.length) { console.log("indexnow: aucune page modifiée"); process.exit(0); }

try {
  const res = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `${SITE}/${KEY}.txt`, urlList: urls }),
    signal: AbortSignal.timeout(20000),
  });
  // 200 = reçu, 202 = reçu (clé en cours de validation). Le reste : on le dit, sans échouer.
  console.log(`indexnow: ${urls.length} URL → HTTP ${res.status}`);
} catch (e) {
  console.log(`indexnow: envoi raté (${e.message}) — sans conséquence`);
}
