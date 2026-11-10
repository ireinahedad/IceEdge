#!/usr/bin/env node
/**
 * team-gen.mjs — une page par équipe (/team/<slug>) et le hub /nhl-teams.
 *
 * POURQUOI
 * Les recherches d'équipe (« maple leafs prediction tonight », « oilers next
 * game ») n'avaient aucune page qui leur réponde : les statistiques d'équipe ne
 * vivent que dans l'application, rendue côté client, illisible pour les robots
 * IA. Chaque page répond d'abord à la question (prochain match, chiffre public
 * d'arakiceML), puis montre ce qu'aucun gabarit ne peut inventer : les derniers
 * résultats de l'équipe À CÔTÉ de ce que le modèle disait avant le match, tirés
 * du dépôt public `arakice-nhl-predictions`. Elle sert aussi de moyeu de liens
 * vers les pages de match, de props et de confrontations de l'équipe.
 *
 * Même règle que gameday-gen.mjs : seuls les chiffres déjà prouvés par le dépôt
 * public sont affichés (victoire). Jamais de total (D3), jamais de cote.
 *
 * DONNÉES (sans clé, utilisables en CI)
 *   · api-web.nhle.com : classement, calendrier de saison par club
 *   · raw.githubusercontent.com : fichiers du bilan public, un par jour
 *   · le disque : public/match, public/props, public/matchup (liens existants)
 *
 * SORTIE   public/team/<slug>.html · public/nhl-teams.html · public/sitemap-teams.xml
 *
 * Usage :  node scripts/team-gen.mjs          # écrit dans public/
 *          node scripts/team-gen.mjs --dry    # écrit dans <tmp>/arakice-team-sample
 *          PREDICTIONS_DIR=<clone> PRED_START=2026-11-01 node scripts/team-gen.mjs
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { layout, slugify, esc, nhlLogo, getJSON, pMap, SITE, API, fit, TITLE_MAX, DESC_MAX } from "./seo-gen.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes("--dry");
const PUBLIC = path.join(__dirname, "..", "public");
const OUT_DIR = DRY ? path.join(os.tmpdir(), "arakice-team-sample") : PUBLIC;
const API_BASE = process.env.NHL_API || API;
const PRED_REPO = process.env.PREDICTIONS_REPO || "ireinahedad/arakice-nhl-predictions";
const PRED_DIR = process.env.PREDICTIONS_DIR || "";
// Premier jour du bilan public : avant, aucun fichier n'existe (inutile de les demander).
const PRED_START = process.env.PRED_START || "2026-11-01";
const GAME_TYPES = new Set([2, 3]);
const RECENT_N = 10;
const NEXT_N = 5;

// ── Dates (heure de l'Est, comme la LNH) ─────────────────────────────────────
const etToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
function shiftDate(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const dayLabel = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const longDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const faceoff = (utc) => (utc
  ? `${new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour: "numeric", minute: "2-digit" }).format(new Date(utc))} ET`
  : "");

// ── NHL ──────────────────────────────────────────────────────────────────────
async function fetchTeams() {
  const data = await getJSON(`${API_BASE}/standings/now`);
  const teams = {};
  for (const s of data.standings || []) {
    const abbr = s.teamAbbrev?.default;
    if (!abbr) continue;
    const common = s.teamCommonName?.default || s.teamName?.default || abbr;
    const gp = s.gamesPlayed || 0;
    teams[abbr] = {
      abbr, common, slug: slugify(common),
      name: s.teamName?.default || `${s.placeName?.default || ""} ${common}`.trim(),
      division: s.divisionName || "", conference: s.conferenceName || "",
      divRank: s.divisionSequence || null, leagueRank: s.leagueSequence || null,
      gp, wins: s.wins ?? 0, losses: s.losses ?? 0, otl: s.otLosses ?? 0, points: s.points ?? 0,
      last10: `${s.l10Wins ?? 0}-${s.l10Losses ?? 0}-${s.l10OtLosses ?? 0}`,
      streak: s.streakCode && s.streakCount ? `${s.streakCode}${s.streakCount}` : "",
      homeRec: `${s.homeWins ?? 0}-${s.homeLosses ?? 0}-${s.homeOtLosses ?? 0}`,
      roadRec: `${s.roadWins ?? 0}-${s.roadLosses ?? 0}-${s.roadOtLosses ?? 0}`,
      gfpg: gp ? +((s.goalFor ?? 0) / gp).toFixed(2) : null,
      gapg: gp ? +((s.goalAgainst ?? 0) / gp).toFixed(2) : null,
    };
  }
  return teams;
}

async function fetchSeason(abbr) {
  try {
    const d = await getJSON(`${API_BASE}/club-schedule-season/${abbr}/now`);
    return (d.games || [])
      .filter((g) => GAME_TYPES.has(Number(g.gameType)) && g.homeTeam?.abbrev && g.awayTeam?.abbrev)
      .map((g) => ({
        id: String(g.id), date: g.gameDate, startTimeUTC: g.startTimeUTC || null,
        home: g.homeTeam.abbrev, away: g.awayTeam.abbrev,
        homeScore: g.homeTeam.score ?? null, awayScore: g.awayTeam.score ?? null,
        state: String(g.gameState || "FUT"), last: g.gameOutcome?.lastPeriodType || "",
      }))
      .sort((a, b) => a.date.localeCompare(b.date) || String(a.startTimeUTC).localeCompare(String(b.startTimeUTC)));
  } catch { return []; }
}

const isFinal = (g) => ["FINAL", "OFF"].includes(g.state) && g.homeScore != null && g.awayScore != null;

// ── Bilan public ─────────────────────────────────────────────────────────────
async function loadPredictions(dates) {
  const out = new Map();
  await pMap(dates, async (date) => {
    const rel = `data/${date.slice(0, 4)}/${date}.json`;
    let doc = null;
    try {
      if (PRED_DIR) doc = JSON.parse(await fs.readFile(path.join(PRED_DIR, rel), "utf-8"));
      else {
        const res = await fetch(`https://raw.githubusercontent.com/${PRED_REPO}/HEAD/${rel}`, { signal: AbortSignal.timeout(15000) });
        if (res.ok) doc = await res.json();
      }
    } catch { doc = null; }
    for (const g of doc?.games ?? []) {
      const p = g?.probabilities;
      if (!g?.gameId || typeof p?.homeWin !== "number" || !(p.homeWin > 0 && p.homeWin < 1)) continue;
      out.set(String(g.gameId), { home: g.home, away: g.away, homeWin: p.homeWin, proofUrl: `https://github.com/${PRED_REPO}/blob/HEAD/${rel}` });
    }
  }, 4);
  return out;
}

/** P(cette équipe gagne), ou null si le fichier ne parle pas du même match. */
function teamProb(preds, g, abbr) {
  const p = preds.get(g.id);
  if (!p || p.home !== g.home || p.away !== g.away) return null;
  return g.home === abbr ? p.homeWin : 1 - p.homeWin;
}

// ── Le disque : pages existantes vers lesquelles lier ───────────────────────
async function exists(f) { try { await fs.access(f); return true; } catch { return false; } }

async function propsByTeam() {
  const byTeam = new Map();
  let files = [];
  try { files = (await fs.readdir(path.join(PUBLIC, "props"))).filter((f) => f.endsWith(".html")); } catch { return byTeam; }
  for (const f of files.sort()) {
    const html = await fs.readFile(path.join(PUBLIC, "props", f), "utf-8");
    const team = (html.match(/<p class="eyebrow">([^<·]+?)\s*·/) || [])[1]?.trim();
    const name = (html.match(/<h1>([^<]+?) Prop Predictions<\/h1>/) || [])[1];
    if (!team || !name) continue;
    if (!byTeam.has(team)) byTeam.set(team, []);
    byTeam.get(team).push({ href: `/props/${f.slice(0, -5)}`, name: name.replace(/&#39;/g, "'").replace(/&amp;/g, "&") });
  }
  return byTeam;
}

async function matchupSet() {
  try { return new Set((await fs.readdir(path.join(PUBLIC, "matchup"))).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5))); }
  catch { return new Set(); }
}
const evergreenSlug = (a, b) => {
  const [x, y] = [a, b].sort((m, n) => m.abbr.localeCompare(n.abbr));
  return `${x.slug}-vs-${y.slug}`;
};

// ── Rendu ────────────────────────────────────────────────────────────────────
const pct = (p) => `${Math.round(p * 100)}%`;
const cell = (v, lab) => `        <div class="stat"><div class="value">${esc(v)}</div><div class="label">${esc(lab)}</div></div>`;

function resultLabel(g, abbr) {
  const us = g.home === abbr ? g.homeScore : g.awayScore;
  const them = g.home === abbr ? g.awayScore : g.homeScore;
  const extra = g.last === "OT" ? " OT" : g.last === "SO" ? " SO" : "";
  return { won: us > them, text: `${us > them ? "W" : "L"} ${us}-${them}${extra}` };
}

function teamPage(t, ctx) {
  const { teams, season, preds, props, matchups, matchPages, today } = ctx;
  const opp = (g) => teams[g.home === t.abbr ? g.away : g.home];
  const where = (g) => (g.home === t.abbr ? "vs" : "at");

  const upcoming = season.filter((g) => !isFinal(g) && g.date >= today).slice(0, NEXT_N);
  const finals = season.filter(isFinal);
  const recent = finals.slice(-RECENT_N).reverse();
  const next = upcoming[0] || null;
  const nextP = next ? teamProb(preds, next, t.abbr) : null;

  // Bilan du modèle sur les matchs de cette équipe (tous ceux qui ont un chiffre public).
  const called = finals.map((g) => ({ g, p: teamProb(preds, g, t.abbr) })).filter((x) => x.p != null && Math.round(x.p * 100) !== 50);
  const hits = called.filter(({ g, p }) => resultLabel(g, t.abbr).won === (p > 0.5)).length;

  const matchHref = (g) => {
    const a = teams[g.away], b = teams[g.home];
    if (!a || !b) return null;
    const rel = `${g.date}/${a.slug}-vs-${b.slug}`;
    return matchPages.has(rel) ? `${SITE}/match/${rel}` : null;
  };

  // ── La réponse d'abord ──
  const rec = `${t.wins}-${t.losses}-${t.otl}`;
  let nextLine = "";
  if (next && opp(next)) {
    const o = opp(next);
    nextLine = `Next game: the ${t.name} ${where(next) === "vs" ? "host" : "visit"} the ${o.name} on ${longDay(next.date)}${next.startTimeUTC ? `, ${faceoff(next.startTimeUTC)}` : ""}. `
      + (nextP != null
        ? `arakiceML gives the ${t.common} a ${pct(nextP)} chance to win, overtime and shootout included.`
        : `arakiceML's win probability for this game is published the morning of the game, Eastern time.`);
  }
  const recordLine = `The ${t.name} are ${rec} with ${t.points} points this season${t.divRank ? `, ${ordinal(t.divRank)} in the ${t.division} Division` : ""}, and ${t.last10} over their last 10 games.`;
  // Sous 5 matchs, « 3 sur 3 (100 %) » se lit comme de la réclame : on attend.
  const modelLine = called.length >= 5
    ? `Since the public prediction record began, arakiceML has favoured the eventual winner in ${hits} of ${called.length} ${t.common} games (${Math.round((100 * hits) / called.length)}%).`
    : "";

  const nextRows = upcoming.map((g) => {
    const o = opp(g);
    const p = teamProb(preds, g, t.abbr);
    const href = matchHref(g);
    const label = `${where(g)} ${o ? o.common : g.home === t.abbr ? g.away : g.home}`;
    return `          <tr><td>${esc(dayLabel(g.date))}</td><td>${href ? `<a href="${href}">${esc(label)}</a>` : esc(label)}</td><td>${esc(faceoff(g.startTimeUTC))}</td><td class="num">${p != null ? pct(p) : "—"}</td></tr>`;
  }).join("\n");

  const recentRows = recent.map((g) => {
    const o = opp(g);
    const r = resultLabel(g, t.abbr);
    const p = teamProb(preds, g, t.abbr);
    const href = matchHref(g);
    const label = `${where(g)} ${o ? o.common : ""}`;
    const verdict = p == null || Math.round(p * 100) === 50 ? "—" : (r.won === (p > 0.5) ? "Model's pick won" : "Upset");
    return `          <tr><td>${esc(dayLabel(g.date))}</td><td>${href ? `<a href="${href}">${esc(label)}</a>` : esc(label)}</td><td>${esc(r.text)}</td><td class="num">${p != null ? pct(p) : "—"}</td><td>${esc(verdict)}</td></tr>`;
  }).join("\n");

  const proof = [...upcoming, ...recent].map((g) => preds.get(g.id)?.proofUrl).find(Boolean);

  const teamProps = props.get(t.name) || [];
  const h2h = Object.values(teams)
    .filter((o) => o.abbr !== t.abbr && matchups.has(evergreenSlug(t, o)))
    .sort((a, b) => a.common.localeCompare(b.common))
    .map((o) => `          <li><a href="${SITE}/matchup/${evergreenSlug(t, o)}">${esc(t.common)} vs ${esc(o.common)}</a></li>`);

  const url = `${SITE}/team/${t.slug}`;
  const title = fit(TITLE_MAX, `${t.common} Predictions, Next Game & Model Record | ArakIce`, `${t.common} Predictions & Next Game | ArakIce`);
  const desc = next && opp(next) && nextP != null
    ? fit(DESC_MAX, `${t.name} predictions: arakiceML gives the ${t.common} ${pct(nextP)} ${where(next)} the ${opp(next).common} on ${dayLabel(next.date)}. Record ${rec}, recent results and what the model said.`,
                    `${t.common} predictions: ${pct(nextP)} ${where(next)} the ${opp(next).common}, ${dayLabel(next.date)}. Record ${rec}.`)
    : fit(DESC_MAX, `${t.name} predictions: next games, record ${rec}, last 10 ${t.last10}, and recent results next to what arakiceML said before each game.`,
                    `${t.common} predictions, next games and record ${rec}.`);

  const jsonld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage", "@id": `${url}#webpage`, url, name: title, description: desc, inLanguage: "en-CA",
        isPartOf: { "@type": "WebSite", "@id": `${SITE}/#website`, name: "ArakIce", url: `${SITE}/` },
        about: { "@id": `${url}#team` }, breadcrumb: { "@id": `${url}#breadcrumb` },
        dateModified: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      },
      {
        "@type": "SportsTeam", "@id": `${url}#team`, name: t.name, sport: "Ice hockey", logo: nhlLogo(t.abbr),
        memberOf: { "@type": "SportsOrganization", name: "National Hockey League" },
      },
      {
        "@type": "BreadcrumbList", "@id": `${url}#breadcrumb`,
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${SITE}/` },
          { "@type": "ListItem", position: 2, name: "NHL teams", item: `${SITE}/nhl-teams` },
          { "@type": "ListItem", position: 3, name: t.name, item: url },
        ],
      },
    ],
  };

  const body = `    <section class="hero">
      <p class="eyebrow">${esc([t.division && `${t.division} Division`, t.conference && `${t.conference} Conference`].filter(Boolean).join(" · "))}</p>
      <h1>${esc(t.name)} predictions</h1>
      <div class="matchup-teams"><div class="team"><img src="${nhlLogo(t.abbr)}" alt="${esc(t.name)}" width="72" height="72" /><div class="abbr">${esc(t.abbr)}</div></div></div>
      <p class="lede">${esc(nextLine || recordLine)}</p>
    </section>
${nextLine ? `      <p>${esc(recordLine)}</p>\n` : ""}${modelLine ? `      <p>${esc(modelLine)}</p>\n` : ""}      <div class="stats-row">
${[cell(rec, "record"), cell(t.points, "points"), cell(t.last10, "last 10"), t.streak && cell(t.streak, "streak"),
   t.gfpg != null && cell(t.gfpg, "goals for / game"), t.gapg != null && cell(t.gapg, "goals against / game"),
   cell(t.homeRec, "home"), cell(t.roadRec, "road")].filter(Boolean).join("\n")}
      </div>
${nextRows ? `      <h2>Next ${t.common} games</h2>
      <div class="h2h-wrap">
        <table class="h2h">
          <thead><tr><th>Date</th><th>Game</th><th>Puck drop</th><th>${esc(t.common)} win chance</th></tr></thead>
          <tbody>
${nextRows}
          </tbody>
        </table>
      </div>` : ""}
${recentRows ? `      <h2>Recent results and what the model said</h2>
      <div class="h2h-wrap">
        <table class="h2h">
          <thead><tr><th>Date</th><th>Game</th><th>Result</th><th>Model, before the game</th><th>Outcome</th></tr></thead>
          <tbody>
${recentRows}
          </tbody>
        </table>
      </div>
      <p class="src">Win chances are arakiceML's pre-game probabilities for the ${esc(t.common)}, overtime and shootout included, recorded each morning and committed to ArakIce's public prediction record before puck drop.${proof ? ` <a href="${proof}" rel="nofollow">See a timestamped file</a>.` : ""} "—" means the game predates the public record. One game says little; the <a href="${SITE}/nhl-prediction-accuracy">accuracy page</a> covers thousands.</p>` : ""}
    <div class="cta-box">
      <p class="cta-title">${esc(`${t.common} edges and player props`)}</p>
      <p>${esc(`The win probability is free here. In the app, ArakIce compares it to the sportsbook line, flags where the value is, and projects props for every ${t.common} player.`)}</p>
      <a class="btn" href="${SITE}/">Open ArakIce</a>
    </div>
${teamProps.length ? `      <h2>${esc(t.common)} player prop pages</h2>
      <ul>
${teamProps.map((p) => `          <li><a href="${SITE}${p.href}">${esc(p.name)} prop predictions</a></li>`).join("\n")}
      </ul>` : ""}
${h2h.length ? `      <h2>${esc(t.common)} head to head</h2>
      <ul>
${h2h.join("\n")}
      </ul>` : ""}
      <p class="src">Standings and schedule from the NHL public API, as of ${esc(longDay(today))}.</p>
      <section class="related">
        <h2>Explore more</h2>
        <ul>
          <li><a href="${SITE}/nhl-teams">All 32 NHL teams</a></li>
          <li><a href="${SITE}/nhl-predictions-today">NHL predictions today</a></li>
          <li><a href="${SITE}/match">Tonight's NHL games</a></li>
        </ul>
      </section>`;

  return layout({ title, desc, canonicalPath: `/team/${t.slug}`, jsonld, body });
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

function hubPage(list, today) {
  const rows = list.map(({ t, next, nextP, opp }) =>
    `          <tr><td><a href="${SITE}/team/${t.slug}">${esc(t.name)}</a></td><td>${esc(`${t.wins}-${t.losses}-${t.otl}`)}</td><td class="num">${t.points}</td><td>${esc(t.last10)}</td><td>${next && opp ? esc(`${next.home === t.abbr ? "vs" : "at"} ${opp.common}, ${dayLabel(next.date)}`) : "—"}</td><td class="num">${nextP != null ? pct(nextP) : "—"}</td></tr>`).join("\n");
  const jsonld = {
    "@context": "https://schema.org", "@type": "CollectionPage",
    name: "NHL teams: records, next games and model predictions", url: `${SITE}/nhl-teams`, inLanguage: "en-CA",
  };
  const body = `    <section class="hero">
      <p class="eyebrow">Updated ${esc(longDay(today))}</p>
      <h1>NHL teams: records, next games and predictions</h1>
      <p class="lede">All 32 NHL teams by points, with each club's next game and arakiceML's win probability for it once the morning numbers are public. Open a team for its recent results next to what the model said before each game.</p>
    </section>
      <div class="h2h-wrap">
        <table class="h2h">
          <thead><tr><th>Team</th><th>Record</th><th>Pts</th><th>Last 10</th><th>Next game</th><th>Model win chance</th></tr></thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </div>
      <p class="src">Standings and schedule from the NHL public API. Win chances from ArakIce's public prediction record; "—" until the morning of the game.</p>
      <section class="related">
        <h2>Explore more</h2>
        <ul>
          <li><a href="${SITE}/nhl-predictions-today">NHL predictions today</a></li>
          <li><a href="${SITE}/match">Tonight's NHL games</a></li>
          <li><a href="${SITE}/nhl-matchups">NHL matchups</a></li>
        </ul>
      </section>`;
  return layout({
    title: "NHL Teams: Records, Next Games & Predictions | ArakIce",
    desc: "All 32 NHL teams with record, points, last 10, next game and arakiceML's win probability, each linking to a team page with recent results vs the model.",
    canonicalPath: "/nhl-teams", jsonld, body,
  });
}

async function writeSitemap(slugs, today) {
  const locs = ["/nhl-teams", ...slugs.map((s) => `/team/${s}`)];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs
    .map((l) => `  <url>\n    <loc>${SITE}${l}</loc>\n    <lastmod>${today}</lastmod>\n  </url>`).join("\n")}\n</urlset>\n`;
  await write(path.join(OUT_DIR, "sitemap-teams.xml"), xml);
}

async function write(full, html) {
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, html, "utf-8");
}

async function main() {
  const today = etToday();
  const teams = await fetchTeams();
  const abbrs = Object.keys(teams);
  // Garde-fou : une panne d'API ne doit pas réécrire 32 pages vides.
  if (abbrs.length < 30) throw new Error(`classement LNH incomplet (${abbrs.length} équipes) : rien n'est écrit`);

  const seasons = new Map();
  await pMap(abbrs, async (ab) => { seasons.set(ab, await fetchSeason(ab)); }, 6);

  const dates = [];
  for (let d = PRED_START; d <= shiftDate(today, 1); d = shiftDate(d, 1)) dates.push(d);
  const preds = await loadPredictions(dates);

  const matchPages = new Set();
  try {
    for (const d of await fs.readdir(path.join(PUBLIC, "match"))) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      for (const f of await fs.readdir(path.join(PUBLIC, "match", d))) if (f.endsWith(".html") && f !== "index.html") matchPages.add(`${d}/${f.slice(0, -5)}`);
    }
  } catch { /* pas de pages de match : pas de liens */ }
  const [props, matchups] = await Promise.all([propsByTeam(), matchupSet()]);
  console.log(`ArakIce teams — ${abbrs.length} équipes, ${preds.size} probabilités publiques, ${matchPages.size} pages de match, ${[...props.values()].flat().length} pages props, ${matchups.size} confrontations`);

  const hub = [];
  for (const ab of abbrs) {
    const t = teams[ab];
    const season = seasons.get(ab) || [];
    await write(path.join(OUT_DIR, "team", `${t.slug}.html`), teamPage(t, { teams, season, preds, props, matchups, matchPages, today }));
    const next = season.find((g) => !isFinal(g) && g.date >= today) || null;
    hub.push({ t, next, nextP: next ? teamProb(preds, next, ab) : null, opp: next ? teams[next.home === ab ? next.away : next.home] : null });
  }
  hub.sort((a, b) => b.t.points - a.t.points || a.t.gp - b.t.gp || a.t.name.localeCompare(b.t.name));
  await write(path.join(OUT_DIR, "nhl-teams.html"), hubPage(hub, today));
  await writeSitemap(abbrs.map((a) => teams[a].slug).sort(), today);
  console.log(`Terminé. ${abbrs.length} pages d'équipe + /nhl-teams + sitemap-teams.xml → ${OUT_DIR}`);
}

main().catch((e) => { console.error("team-gen a échoué :", e); process.exit(1); });
