#!/usr/bin/env node
/**
 * accuracy-live-gen.mjs — section « ArakIce vs its users » de
 * `public/nhl-prediction-accuracy.html` (NEWS_CONSENSUS_PLAN.md, étape 6, F5).
 *
 * POURQUOI ÉCRITE DANS LE HTML ET PAS CHARGÉE EN DIRECT
 * Décision du 2026-10-26 : la page sert à être trouvée et citée (Google, les
 * assistants IA). Un tableau chargé par JavaScript ne serait vu ni par l'un
 * ni par les autres. Le workflow `seo-gameday.yml` lance donc ce script chaque
 * matin après les pages de match, et commite la page si elle a changé.
 *
 * CE QUI EST PUBLIÉ
 * Taux de réussite par semaine, sur les matchs votés et réglés : le modèle
 * (choix FIGÉ dans l'heure avant le match, migration 050), le choix
 * majoritaire des utilisateurs, et les utilisateurs quand ≥ 80 % d'entre eux
 * étaient d'accord (≥ 10 votes). Pas de ROI (décision d'octobre 2026 : la page
 * publique ne montre que précision et calibration).
 *
 * SEUIL
 * Sous 300 picks réglés (`ready: false` côté serveur), les écarts sont du
 * bruit : le bloc reste VIDE et la page est inchangée. Il apparaît tout seul
 * le premier matin où le seuil est passé (prévu vers la mi-novembre 2026).
 *
 * PANNE
 * API muette, réponse illisible ou marqueurs introuvables : un avertissement,
 * la page n'est PAS touchée, et le script sort en 0 pour ne pas faire échouer
 * le workflow (les pages de match du jour doivent partir quand même).
 *
 * Usage :
 *   node scripts/accuracy-live-gen.mjs
 *   ACCURACY_API=http://localhost:3001/api/pickem/public-vs-model node scripts/accuracy-live-gen.mjs
 *   ACCURACY_JSON=./sample.json node scripts/accuracy-live-gen.mjs   # sans réseau
 *
 * Aucune dépendance — Node 18+.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(__dirname, "..", "public", "nhl-prediction-accuracy.html");
const API_URL = process.env.ACCURACY_API || "https://api.arakice.com/api/pickem/public-vs-model";
export const START = "<!-- F5:START -->";
export const END = "<!-- F5:END -->";
/** Là où le bloc est posé s'il manque : juste avant « Other measures ». */
const ANCHOR = "<h2>Other measures</h2>";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmtInt = (n) => Number(n).toLocaleString("en-US");
const longDate = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const monthDay = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
const shortDate = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** « 58.3% (7 of 12) », ou « — » sans match. */
export function cell(rate) {
  if (!rate || !rate.games || rate.pct === null || rate.pct === undefined) return "—";
  return `${Number(rate.pct).toFixed(1)}% (${fmtInt(rate.wins)}/${fmtInt(rate.games)})`;
}

const pctText = (rate) => (rate && rate.games && rate.pct !== null ? `${Number(rate.pct).toFixed(1)}%` : "n/a");

/**
 * Le HTML du bloc, marqueurs compris. `ready: false` (ou rien) → bloc vide :
 * rien n'est publié sous le seuil.
 */
export function renderSection(data) {
  if (!data || data.ready !== true || !Array.isArray(data.weeks) || data.weeks.length === 0) return `${START}\n    ${END}`;
  const t = data.total;
  const weeks = data.weeks.filter((w) => w.games > 0);
  const rows = weeks.map((w) =>
    `          <tr><td>${esc(shortDate(w.weekStart))} – ${esc(shortDate(w.weekEnd))}</td><td class="num">${fmtInt(w.games)}</td>` +
    `<td class="num">${cell(w.model)}</td><td class="num">${cell(w.crowd)}</td><td class="num">${cell(w.strongCrowd)}</td></tr>`,
  ).join("\n");
  const totalRow =
    `          <tr><th scope="row">All weeks</th><td class="num">${fmtInt(t.games)}</td>` +
    `<td class="num">${cell(t.model)}</td><td class="num">${cell(t.crowd)}</td><td class="num">${cell(t.strongCrowd)}</td></tr>`;
  const through = t.until ? longDate(t.until) : "";
  return `${START}
    <section id="model-vs-users">
    <h2>2026–27 season: the model vs. ArakIce users</h2>
    <p>Since October 24, 2026, ArakIce users can pick the winner of every NHL game before puck drop. The model's pick is recorded in the hour before each game and never changed afterwards, so it gets no help from hindsight. Over the ${fmtInt(t.games)} games users voted on (${fmtInt(data.settledPicks)} settled picks, between ${esc(monthDay(t.since))} and ${esc(through)}), the arakiceML model picked the winner <strong>${pctText(t.model)}</strong> of the time and the users' majority pick <strong>${pctText(t.crowd)}</strong>. When at least 80% of users agreed on a team, that team won <strong>${pctText(t.strongCrowd)}</strong> of the time.</p>

    <div class="h2h-wrap">
      <table class="h2h">
        <caption>Winner picked correctly, by week (Monday to Sunday, Eastern Time), games with at least one ArakIce user vote</caption>
        <thead><tr><th>Week</th><th class="num">Games</th><th class="num">arakiceML model</th><th class="num">Users' majority</th><th class="num">Users, 80%+ agree</th></tr></thead>
        <tbody>
${rows}
${totalRow}
        </tbody>
      </table>
    </div>
    <p><em>Updated every morning. A game counts once it is final. Games where the user vote was tied are left out of the majority column; the 80%+ column needs at least 10 votes on the game. A dash means no qualifying game that week. Weekly figures cover few games and swing a lot: read the season total first.</em></p>
    </section>
    ${END}`;
}

/** Remplace le bloc entre les marqueurs ; le pose avant `ANCHOR` s'il manque. `null` si impossible. */
export function injectSection(html, section) {
  const a = html.indexOf(START);
  const b = html.indexOf(END);
  if (a !== -1 && b > a) return html.slice(0, a) + section + html.slice(b + END.length);
  const i = html.indexOf(ANCHOR);
  if (i === -1) return null;
  return `${html.slice(0, i)}${section}\n\n    ${html.slice(i)}`;
}

/** `dateModified` du JSON-LD : avancé seulement quand la page change vraiment. */
export function touchDateModified(html, day) {
  return html.replace(/"dateModified":"\d{4}-\d{2}-\d{2}"/, `"dateModified":"${day}"`);
}

async function loadData() {
  if (process.env.ACCURACY_JSON) return JSON.parse(await fs.readFile(process.env.ACCURACY_JSON, "utf-8"));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(API_URL, { headers: { Accept: "application/json", "User-Agent": "ArakIce-SEO/1.0 (+https://arakice.com)" }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  let data;
  try {
    data = await loadData();
  } catch (err) {
    console.warn(`⚠️  F5 : API illisible (${err?.message ?? err}) — page de précision inchangée.`);
    return;
  }
  const html = await fs.readFile(PAGE, "utf-8");
  const next = injectSection(html, renderSection(data));
  if (next === null) {
    console.warn("⚠️  F5 : marqueurs et ancre introuvables dans nhl-prediction-accuracy.html — page inchangée.");
    return;
  }
  if (next === html) {
    console.log(`F5 : rien de neuf (${data?.ready ? "publié" : `pas encore publié : ${data?.settledPicks ?? 0}/${data?.minSettled ?? 300} picks réglés`}).`);
    return;
  }
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
  await fs.writeFile(PAGE, touchDateModified(next, today), "utf-8");
  console.log(`F5 : section écrite (${data.total?.games ?? 0} matchs, ${data.settledPicks} picks réglés).`);
}

const RUN_DIRECTLY = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (RUN_DIRECTLY) main().catch((err) => { console.warn(`⚠️  F5 : ${err?.message ?? err} — page inchangée.`); });
