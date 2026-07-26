#!/usr/bin/env node
/**
 * ArakIce — programmatic SEO page generator.
 *
 * Produces static, indexable HTML into client/public/ :
 *   - /nhl-player-props            props hub with client-side player search
 *   - /props/<player-slug>         one evergreen page per active player (#1)
 *   - /nhl-matchups                matchup hub
 *   - /matchup/<a>-vs-<b>          one page per team pair that plays (#4)
 * ...and regenerates /sitemap.xml (static pages + generated pages).
 *
 * Pages are EVERGREEN: durable content + a CTA into the app for the live
 * "tonight" projection. Re-run this script to add newly scheduled matchups
 * and refresh rosters/stats. Run on a machine with internet (the NHL public
 * API is not reachable from CI sandboxes here).
 *
 * Usage:
 *   node scripts/seo-gen.mjs            # full run against the NHL API
 *   node scripts/seo-gen.mjs --sample   # offline fixtures -> ./scripts/_sample_out
 *   MIN_GP=5 node scripts/seo-gen.mjs   # only players with >=5 games played
 *
 * No dependencies — Node 18+ (global fetch).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────────────────────
const SITE = "https://arakice.com";
const API = "https://api-web.nhle.com/v1";
const SAMPLE = process.argv.includes("--sample");
const OUT_DIR = SAMPLE
  ? path.join(os.tmpdir(), "arakice-seo-sample")
  : process.env.SEO_OUT || path.join(__dirname, "..", "public");
const HORIZON_WEEKS = Number(process.env.HORIZON_WEEKS || 3); // how many schedule weeks to walk
const MIN_GP = Number(process.env.MIN_GP || 1);               // gate thin player pages
const CONCURRENCY = 6;

const STATIC_PAGES = [
  { loc: "/", changefreq: "daily", priority: "1.0" },
  { loc: "/nhl-predictions-today", changefreq: "daily", priority: "0.9" },
  { loc: "/best-nhl-picks-today", changefreq: "daily", priority: "0.9" },
  { loc: "/nhl-ai-predictions", changefreq: "weekly", priority: "0.8" },
  { loc: "/best-nhl-betting-software", changefreq: "monthly", priority: "0.7" },
];

// ── Small utilities ───────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slugify(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function nhlLogo(abbr) {
  return `https://assets.nhle.com/logos/nhl/svg/${String(abbr).toUpperCase()}_light.svg`;
}

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "ArakIce-SEO/1.0" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(400 * (i + 1));
    }
  }
}

async function pMap(items, fn, concurrency = CONCURRENCY) {
  const out = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const cur = idx++;
      try { out[cur] = await fn(items[cur], cur); }
      catch (e) { out[cur] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

async function writePage(relPath, html) {
  const full = path.join(OUT_DIR, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, html, "utf-8");
}

// ── Shared HTML shell ─────────────────────────────────────────────────────────
function layout({ title, desc, canonicalPath, jsonld, body, extraHead = "" }) {
  const url = SITE + canonicalPath;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}" />
  <link rel="canonical" href="${url}" />
  <meta name="robots" content="index, follow, max-image-preview:large" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="ArakIce" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:url" content="${url}" />
  <meta property="og:image" content="${SITE}/arakice-logo.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(desc)}" />
  <meta name="twitter:image" content="${SITE}/arakice-logo.png" />
  <link rel="icon" type="image/png" href="/arakice-logo.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/seo.css" />
${jsonld ? `  <script type="application/ld+json">\n${JSON.stringify(jsonld, null, 2)}\n  </script>\n` : ""}${extraHead}</head>
<body>
  <header class="site-header">
    <div class="wrap">
      <a class="brand" href="${SITE}/">Arak<span>Ice</span></a>
      <a class="nav-cta" href="${SITE}/">Open the app</a>
    </div>
  </header>
  <main>
${body}
    <div class="disclaimer">
      <p>ArakIce provides statistical analysis and predictions for informational and entertainment purposes only. Nothing here is financial advice or a guarantee of results. Betting involves risk and you should never wager more than you can afford to lose. Must be of legal gambling age in your jurisdiction. If gambling stops being fun, help is available — in the US call or text 1-800-GAMBLER.</p>
    </div>
  </main>
  <footer class="site-footer">
    <div class="wrap">
      <nav>
        <a href="${SITE}/nhl-predictions-today">NHL Predictions</a>
        <a href="${SITE}/nhl-player-props">Player Props</a>
        <a href="${SITE}/nhl-matchups">Matchups</a>
        <a href="${SITE}/best-nhl-picks-today">Best Picks</a>
      </nav>
      <span>&copy; ArakIce — statistical edge for smarter sports bets.</span>
    </div>
  </footer>
</body>
</html>
`;
}

function ctaBox(heading, text, label) {
  return `    <div class="cta-box">
      <h3>${esc(heading)}</h3>
      <p>${esc(text)}</p>
      <a class="btn" href="${SITE}/">${esc(label)}</a>
    </div>`;
}

// ── Templates ────────────────────────────────────────────────────────────────
function playerPage(p) {
  const isGoalie = p.pos === "G";
  const posName = { C: "center", L: "left wing", R: "right wing", D: "defenseman", G: "goaltender" }[p.pos] || "player";
  const team = p.teamName || p.team;
  const s = p.stats || {};
  const statCards = isGoalie
    ? [
        ["GP", s.gamesPlayed], ["W", s.wins], ["GAA", s.goalsAgainstAvg != null ? Number(s.goalsAgainstAvg).toFixed(2) : null],
        ["SV%", s.savePctg != null ? Number(s.savePctg).toFixed(3) : null], ["SO", s.shutouts],
      ]
    : [
        ["GP", s.gamesPlayed], ["G", s.goals], ["A", s.assists], ["P", s.points], ["SOG", s.shots],
      ];
  const cardsHtml = statCards
    .filter(([, v]) => v != null && v !== "")
    .map(([l, v]) => `        <div class="stat"><div class="value">${esc(v)}</div><div class="label">${esc(l)}</div></div>`)
    .join("\n");

  const propsFocus = isGoalie
    ? `For a goaltender like ${esc(p.name)}, the props that matter most are saves and, on the totals side, the game's over/under — both driven by how many shots the opposition is likely to generate. Our model estimates ${esc(p.name)}'s expected workload from the quality of shots ${esc(team)} tends to allow, the pace of the opponent, and rest, then compares that projection to the posted save line.`
    : `For a skater like ${esc(p.name)}, shots on goal and points are the headline props. Shots are the more stable of the two — they depend on ice time, role and how many attempts ${esc(team)} generates — while points swing more with linemates and finishing luck. The model projects each from ${esc(p.name)}'s usage and matchup, then flags where that number diverges from the sportsbook line.`;

  const stats = p.stats && p.stats.gamesPlayed
    ? `      <h2>${esc(p.name)}'s season at a glance</h2>
      <div class="stats-row">
${cardsHtml}
      </div>
      <p>These are ${esc(p.name)}'s current regular-season totals. They form the base rate the model starts from before adjusting for tonight's specific matchup, opponent quality, rest and role.</p>`
    : "";

  const jsonld = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      { "@type": "Question", name: `How are ${p.name}'s prop projections made?`,
        acceptedAnswer: { "@type": "Answer", text: `ArakIce projects ${p.name}'s output from usage, role and matchup — how many chances ${team} generates or allows, the opponent's pace, rest and recent form — then compares the projection to the posted prop line to find value.` } },
      { "@type": "Question", name: `Where can I see ${p.name}'s projection for tonight?`,
        acceptedAnswer: { "@type": "Answer", text: `Open the ArakIce app. When ${p.name} is on the slate, the live projection and the edge against the current line appear there, updated as lineups and odds move.` } },
      { "@type": "Question", name: `Are ${p.name} prop predictions guaranteed?`,
        acceptedAnswer: { "@type": "Answer", text: `No. Props are high-variance and no projection is guaranteed. The goal is to find value against the line over a large sample, not to win any single night.` } },
    ],
  };

  const body = `    <section class="hero">
      <p class="eyebrow">${esc(team)} · ${esc(posName)}</p>
      <h1>${esc(p.name)} Prop Predictions</h1>
      <p class="lede">Projections and betting context for ${esc(p.name)} of the ${esc(team)}. See how ArakIce models ${esc(p.name)}'s props — ${isGoalie ? "saves and totals" : "shots, points and more"} — and where the numbers point against the sportsbook line.</p>
    </section>
    <p>If you follow ${esc(p.name)}, you already know the box score only tells part of the story. Prop betting rewards understanding the <em>process</em> behind the numbers: the ice time, the role, the matchup and the pace that decide how many chances a ${esc(posName)} actually gets. This page explains how ArakIce turns that context into a projection for ${esc(p.name)}, and how to use it without fooling yourself.</p>
${ctaBox(`See ${p.name}'s live projection tonight`, `When ${p.name} is playing, ArakIce shows the projection and the edge against the current prop line — updated through the day.`, "Open ArakIce")}
${stats}
      <h2>How we project ${esc(p.name)}'s props</h2>
      <p>${propsFocus}</p>
      <p>Crucially, the projection is not just a season average dressed up. It weighs the specific game: the opponent ${esc(team)} faces, whether either team is on a back-to-back or a long road trip, the goaltending on the other side, and the referee crew's tendencies where they affect scoring. Those factors are weighed per matchup, so ${esc(p.name)}'s number on a rested home night against a weak defense looks very different from a tired night against an elite one.</p>
      <h2>Which ${esc(p.name)} props to watch</h2>
      <p>The best prop bets are the ones where the model and the market disagree most, not simply the ones with the biggest names attached. When ${esc(p.name)}'s projection clearly exceeds the posted line, that gap is the reason to bet the over; when it falls short, the under or a pass is the disciplined play. Treat the size of the gap as your guide to stake size, and remember that even a strong edge will miss plenty of individual nights.</p>
${ctaBox(`Track ${p.name} in the app`, `Follow ${p.name}'s projections game by game and get the edge against the line the moment it moves.`, "Open ArakIce")}
      <section class="related">
        <h2>Explore more</h2>
        <ul>
          <li><a href="${SITE}/nhl-player-props">All NHL player prop predictions</a></li>
          <li><a href="${SITE}/best-nhl-picks-today">Best NHL picks today</a></li>
          <li><a href="${SITE}/">Open the ArakIce app</a></li>
        </ul>
      </section>`;

  return layout({
    title: `${p.name} Prop Predictions & Projections | ArakIce`,
    desc: `${p.name} (${team}) prop predictions: ${isGoalie ? "save and totals" : "shots, points and more"} projections and betting context from ArakIce's NHL model.`,
    canonicalPath: `/props/${p.slug}`,
    jsonld,
    body,
  });
}

function propsHubPage(players) {
  const data = players.map((p) => ({ name: p.name, team: p.team, pos: p.pos, url: `/props/${p.slug}` }));
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "NHL Player Prop Predictions",
    description: "Search any NHL player for prop projections and betting context.",
    url: `${SITE}/nhl-player-props`,
  };
  const body = `    <section class="hero">
      <p class="eyebrow">Search ${players.length} NHL players</p>
      <h1>NHL Player Prop Predictions</h1>
      <p class="lede">Type any player's name to open their prop page — shots, points and goaltender saves, with the projection and the edge against the sportsbook line. Every active NHL player, one search away.</p>
    </section>
    <div class="search-wrap">
      <input id="player-search" type="search" placeholder="Search a player — e.g. Connor McDavid" autocomplete="off" aria-label="Search NHL players" />
      <div id="player-count"></div>
    </div>
    <ul id="player-list"></ul>
    <script id="players-data" type="application/json">${JSON.stringify(data)}</script>
    <script src="/seo-search.js" defer></script>
${ctaBox("See tonight's prop edges", "The app ranks tonight's player props by how far the projection beats the line. Open it to see the biggest edges live.", "Open ArakIce")}
      <h2>How ArakIce projects player props</h2>
      <p>A player prop is a bet on an individual's output — shots on goal, points, goaltender saves — rather than on who wins. The edge comes from projecting that output more accurately than the sportsbook's line. ArakIce builds each projection from usage and role, the pace and quality of the matchup, rest and travel, and the goaltending involved, then compares it to the posted number. Where the two disagree, there is value; where they agree, there is not.</p>
      <p>Props are fertile ground for edges because sportsbooks price hundreds of them every night and cannot sharpen each one. Use the search above to find any player, read the reasoning on their page, and open the app for tonight's live projection.</p>`;
  return layout({
    title: "NHL Player Prop Predictions | Search Any Player — ArakIce",
    desc: "Search any NHL player for prop projections — shots, points and goaltender saves — with the edge against the line, from ArakIce's model.",
    canonicalPath: "/nhl-player-props",
    jsonld,
    body,
  });
}

function matchupPage(a, b) {
  const sameDiv = a.division && a.division === b.division;
  const sameConf = a.conference && a.conference === b.conference;
  const rel = sameDiv ? `a ${esc(a.division)} Division clash` : sameConf ? `a ${esc(a.conference)} Conference matchup` : "an inter-conference matchup";
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      { "@type": "Question", name: `Who is favored, ${a.name} or ${b.name}?`,
        acceptedAnswer: { "@type": "Answer", text: `It depends on the specific game — home ice, rest, travel, goaltending and injuries all move the number. ArakIce projects a win probability for each side and compares it to the odds; open the app for the live number when these teams next meet.` } },
      { "@type": "Question", name: `How does ArakIce predict ${a.name} vs ${b.name}?`,
        acceptedAnswer: { "@type": "Answer", text: `The model weighs each team's expected goals, recent form, confirmed goaltending, rest and travel, and referee tendencies for the total, then converts that into a win probability and projected total for the game.` } },
      { "@type": "Question", name: `Are these predictions guaranteed?`,
        acceptedAnswer: { "@type": "Answer", text: `No. Hockey is high-variance and no prediction is guaranteed. The aim is to find value against the odds over a large sample of games.` } },
    ],
  };
  const body = `    <section class="hero">
      <p class="eyebrow">${rel}</p>
      <h1>${esc(a.name)} vs ${esc(b.name)} Prediction</h1>
      <div class="matchup-teams">
        <div class="team"><img src="${nhlLogo(a.abbr)}" alt="${esc(a.name)} logo" width="72" height="72" /><div class="abbr">${esc(a.abbr)}</div></div>
        <div class="vs">vs</div>
        <div class="team"><img src="${nhlLogo(b.abbr)}" alt="${esc(b.name)} logo" width="72" height="72" /><div class="abbr">${esc(b.abbr)}</div></div>
      </div>
      <p class="lede">Model-driven predictions and betting context for ${esc(a.name)} against ${esc(b.name)} — moneyline, total and puck line — with the factors that decide the matchup and a live pick in the app whenever these two meet.</p>
    </section>
    <p>When ${esc(a.name)} and ${esc(b.name)} meet, the smart number rarely matches the gut reaction. Records and recent scores are noisy; what actually predicts the game is the quality of chances each side creates and allows, who is in net, and the situational edges — rest, travel and schedule — that the public tends to overlook. This page explains how ArakIce reads ${esc(a.name)} vs ${esc(b.name)}.</p>
${ctaBox(`See the live ${a.abbr}–${b.abbr} pick`, `When ${a.name} and ${b.name} are on the slate, ArakIce shows the win probability, projected total and the edge against the odds — live.`, "Open ArakIce")}
      <h2>How the model reads ${esc(a.name)} vs ${esc(b.name)}</h2>
      <p>The projection starts with each team's expected-goals profile — how many quality chances ${esc(a.name)} and ${esc(b.name)} generate and concede — which is far more stable than goals scored. It then adjusts for the specifics of the meeting: which goaltenders are confirmed to start, whether either team is on a back-to-back or deep into a road trip, the travel and time-zone toll, and the referee crew's tendencies where they affect the total. Those factors are weighed for this matchup rather than applied as blanket rules.</p>
      <h2>Moneyline, total and puck line</h2>
      <p>The moneyline expresses the model's view of who wins ${esc(a.name)} vs ${esc(b.name)} most directly. The total (over/under) often carries the richest value, because it turns on pace, goaltending and refereeing rather than on which team is better. The puck line rewards backing a favourite expected to win comfortably, or an underdog expected to keep it close — the projected margin is what tells you whether it is worth the risk.</p>
      <h2>Finding the edge</h2>
      <p>A prediction is only actionable next to a price. ArakIce compares its win probability and projected total to the live odds and surfaces the gap — the edge. When the model and the market disagree meaningfully on ${esc(a.name)} vs ${esc(b.name)}, that is the bet; when they agree, the disciplined move is to pass. Open the app the next time these teams meet for the live number.</p>
${ctaBox("Get the pick when they play", "Open ArakIce and check the live prediction for this matchup and the rest of tonight's slate.", "Open ArakIce")}
      <section class="related">
        <h2>Explore more</h2>
        <ul>
          <li><a href="${SITE}/nhl-matchups">All NHL matchup predictions</a></li>
          <li><a href="${SITE}/nhl-predictions-today">NHL predictions today</a></li>
          <li><a href="${SITE}/">Open the ArakIce app</a></li>
        </ul>
      </section>`;
  return layout({
    title: `${a.name} vs ${b.name} Prediction, Odds & Pick | ArakIce`,
    desc: `${a.name} vs ${b.name} prediction: moneyline, total and puck-line context from ArakIce's NHL model, with a live pick in the app whenever they meet.`,
    canonicalPath: `/matchup/${a.slug}-vs-${b.slug}`,
    jsonld,
    body,
  });
}

function matchupHubPage(pairs) {
  const items = pairs
    .map((pr) => `          <li><a href="${SITE}/matchup/${pr.a.slug}-vs-${pr.b.slug}">${esc(pr.a.name)} vs ${esc(pr.b.name)}</a></li>`)
    .join("\n");
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "NHL Matchup Predictions",
    url: `${SITE}/nhl-matchups`,
  };
  const body = `    <section class="hero">
      <p class="eyebrow">${pairs.length} upcoming matchups</p>
      <h1>NHL Matchup Predictions</h1>
      <p class="lede">Model-driven predictions for every upcoming NHL matchup — moneyline, total and puck line, with the factors behind each game and a live pick in the app.</p>
    </section>
${ctaBox("See tonight's full slate", "ArakIce ranks tonight's games by edge against the odds. Open it for the live picks.", "Open ArakIce")}
      <section class="related">
        <h2>Upcoming matchups</h2>
        <ul>
${items}
        </ul>
      </section>`;
  return layout({
    title: "NHL Matchup Predictions | Every Upcoming Game — ArakIce",
    desc: "NHL matchup predictions for every upcoming game — moneyline, total and puck-line context from ArakIce's model.",
    canonicalPath: "/nhl-matchups",
    jsonld,
    body,
  });
}

// ── Sitemap ──────────────────────────────────────────────────────────────────
async function writeSitemap(dynamicLocs) {
  const rows = [];
  for (const p of STATIC_PAGES) {
    rows.push(`  <url>\n    <loc>${SITE}${p.loc}</loc>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`);
  }
  for (const loc of dynamicLocs) {
    rows.push(`  <url>\n    <loc>${SITE}${loc}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>`);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join("\n")}\n</urlset>\n`;
  await fs.writeFile(path.join(OUT_DIR, "sitemap.xml"), xml, "utf-8");
}

// ── Data fetchers ─────────────────────────────────────────────────────────────
async function fetchTeams() {
  const data = await getJSON(`${API}/standings/now`);
  const teams = {};
  for (const t of data.standings || []) {
    const abbr = t.teamAbbrev?.default;
    if (!abbr) continue;
    const common = t.teamCommonName?.default || t.teamName?.default || abbr;
    const full = t.teamName?.default || `${t.placeName?.default || ""} ${common}`.trim();
    teams[abbr] = {
      abbr,
      name: full,
      common,
      slug: slugify(common),
      division: t.divisionName || "",
      conference: t.conferenceName || "",
    };
  }
  return teams;
}

async function fetchMatchupPairs(teams) {
  const seen = new Set();
  const pairs = [];
  let date = "now";
  for (let w = 0; w < HORIZON_WEEKS; w++) {
    let data;
    try { data = await getJSON(`${API}/schedule/${date}`); } catch { break; }
    for (const day of data.gameWeek || []) {
      for (const g of day.games || []) {
        const aAbbr = g.awayTeam?.abbrev, bAbbr = g.homeTeam?.abbrev;
        if (!aAbbr || !bAbbr) continue;
        const [x, y] = [aAbbr, bAbbr].sort();
        if (seen.has(x + y)) continue;
        seen.add(x + y);
        const a = teams[x], b = teams[y];
        if (a && b) pairs.push({ a, b });
      }
    }
    if (!data.nextStartDate) break;
    date = data.nextStartDate;
  }
  return pairs;
}

async function fetchPlayers(teams) {
  const abbrs = Object.keys(teams);
  const rosters = await pMap(abbrs, async (abbr) => {
    try {
      const r = await getJSON(`${API}/roster/${abbr}/current`);
      const list = [...(r.forwards || []), ...(r.defensemen || []), ...(r.goalies || [])];
      return list.map((pl) => ({
        id: pl.id,
        name: `${pl.firstName?.default || ""} ${pl.lastName?.default || ""}`.trim(),
        pos: pl.positionCode || "",
        team: abbr,
        teamName: teams[abbr].name,
      }));
    } catch { return []; }
  });
  const players = rosters.flat().filter((p) => p.id && p.name);

  // Enrich with season stats (gates thin pages) — one landing call per player.
  await pMap(players, async (p) => {
    try {
      const l = await getJSON(`${API}/player/${p.id}/landing`);
      const sub = l.featuredStats?.regularSeason?.subSeason || {};
      p.stats = sub;
    } catch { p.stats = {}; }
  });

  // Slug + de-dup, gate by games played.
  const usedSlugs = new Set();
  const out = [];
  for (const p of players) {
    const gp = Number(p.stats?.gamesPlayed || 0);
    if (gp < MIN_GP) continue;
    let slug = slugify(p.name);
    if (usedSlugs.has(slug)) slug = `${slug}-${p.id}`;
    usedSlugs.add(slug);
    p.slug = slug;
    out.push(p);
  }
  return out;
}

// ── Fixtures for --sample (offline) ───────────────────────────────────────────
function sampleData() {
  const teams = {
    EDM: { abbr: "EDM", name: "Edmonton Oilers", common: "Oilers", slug: "oilers", division: "Pacific", conference: "Western" },
    CGY: { abbr: "CGY", name: "Calgary Flames", common: "Flames", slug: "flames", division: "Pacific", conference: "Western" },
    TOR: { abbr: "TOR", name: "Toronto Maple Leafs", common: "Maple Leafs", slug: "maple-leafs", division: "Atlantic", conference: "Eastern" },
  };
  const players = [
    { id: 8478402, name: "Connor McDavid", pos: "C", team: "EDM", teamName: "Edmonton Oilers", slug: "connor-mcdavid", stats: { gamesPlayed: 76, goals: 44, assists: 88, points: 132, shots: 258 } },
    { id: 8477934, name: "Leon Draisaitl", pos: "C", team: "EDM", teamName: "Edmonton Oilers", slug: "leon-draisaitl", stats: { gamesPlayed: 78, goals: 51, assists: 55, points: 106, shots: 271 } },
    { id: 8480830, name: "Jacob Markstrom", pos: "G", team: "CGY", teamName: "Calgary Flames", slug: "jacob-markstrom", stats: { gamesPlayed: 52, wins: 23, goalsAgainstAvg: 2.78, savePctg: 0.905, shutouts: 3 } },
  ];
  const pairs = [{ a: teams.CGY, b: teams.EDM }];
  return { teams, players, pairs };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`ArakIce SEO generator — ${SAMPLE ? "SAMPLE (offline)" : "LIVE (NHL API)"} → ${OUT_DIR}`);
  let teams, players, pairs;

  if (SAMPLE) {
    ({ teams, players, pairs } = sampleData());
  } else {
    console.log("Fetching teams (standings)…");
    teams = await fetchTeams();
    console.log(`  ${Object.keys(teams).length} teams`);
    console.log("Fetching schedule (matchup pairs)…");
    pairs = await fetchMatchupPairs(teams);
    console.log(`  ${pairs.length} upcoming pairs`);
    console.log("Fetching rosters + player stats…");
    players = await fetchPlayers(teams);
    console.log(`  ${players.length} players (>= ${MIN_GP} GP)`);
  }

  const dynamicLocs = [];

  // Player pages + hub
  for (const p of players) {
    await writePage(`props/${p.slug}.html`, playerPage(p));
    dynamicLocs.push(`/props/${p.slug}`);
  }
  await writePage("nhl-player-props.html", propsHubPage(players));
  dynamicLocs.push("/nhl-player-props");

  // Matchup pages + hub
  for (const pr of pairs) {
    await writePage(`matchup/${pr.a.slug}-vs-${pr.b.slug}.html`, matchupPage(pr.a, pr.b));
    dynamicLocs.push(`/matchup/${pr.a.slug}-vs-${pr.b.slug}`);
  }
  await writePage("nhl-matchups.html", matchupHubPage(pairs));
  dynamicLocs.push("/nhl-matchups");

  await writeSitemap(dynamicLocs);

  console.log(`Done. Wrote ${players.length} player pages, ${pairs.length} matchup pages, 2 hubs, sitemap.xml.`);
}

main().catch((e) => { console.error("Generator failed:", e); process.exit(1); });
