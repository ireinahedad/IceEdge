#!/usr/bin/env node
/**
 * route-shells.mjs — per-route SEO shells for the client-rendered app.
 *
 * WHY THIS EXISTS
 * The app is a Vite + React SPA: every URL is served the same `index.html`, so
 * every app route shares one <title>, one meta description and one canonical.
 * Google therefore has exactly one indexable document for the whole app, which
 * is why the SERP shows a single bare result with no sitelinks — the expanded
 * sitelink block Google shows for youtube.com is just several *separately
 * indexed* pages, and it renders each one's own title and description.
 *
 * WHAT IT DOES
 * After `vite build`, this derives one real HTML file per route listed in
 * ROUTES, copied from `dist/index.html` with the head rewritten (title,
 * description, canonical, Open Graph, Twitter, JSON-LD) and a route-specific
 * <noscript> block. Vercel matches the filesystem before the SPA rewrite
 * (`/(.*) → /`), and `cleanUrls: true` serves `dist/schedule.html` at
 * `/schedule`, so:
 *   · crawlers get a document with a unique title/description/canonical
 *   · the browser boots the same React bundle and renders the real screen,
 *     because the router reads the URL — the visitor lands in the app, not on
 *     a landing page
 *
 * Asset URLs in dist/index.html are absolute (`/assets/...`, Vite `base: "/"`),
 * so a copy at any depth resolves correctly. Verified by assertAssetsAbsolute().
 *
 * Body content: Google executes JS, but GPTBot, ClaudeBot, PerplexityBot and
 * most other AI crawlers do NOT — they read the raw HTML and, with an empty
 * <div id="root">, saw nothing but a title. So every shell (and the homepage,
 * dist/index.html) also gets a static block INSIDE #root: what ArakIce is, the
 * key facts from llms.txt (single source of truth), tonight's game pages with
 * the model's public number, and the main sections. React's createRoot()
 * replaces the container's children on first render, so visitors never get a
 * second copy; a CSS delay (opacity 0 for 2.5 s) keeps it from flashing while
 * the bundle loads, and shows it to anyone without JS. Same words as the app,
 * same for every visitor: not cloaking.
 *
 * Usage:  node scripts/route-shells.mjs         (runs as part of `npm run build`)
 *         DIST_DIR=… SITE_URL=… node scripts/route-shells.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.DIST_DIR || path.join(__dirname, "..", "dist");
const SITE = (process.env.SITE_URL || "https://arakice.com").replace(/\/$/, "");

/**
 * One entry per route we want Google to index independently.
 *
 * `out`   — file written under dist/. With Vercel `cleanUrls: true`,
 *           `schedule.html` is served at `/schedule`.
 * `loc`   — canonical path (must match the React Router path).
 * `title` — what Google shows as the sitelink label. Keep it short and
 *           front-load the distinguishing word; long titles get truncated.
 * `desc`  — what Google shows under the sitelink label. ~110-150 chars.
 *
 * Deliberately excluded: routes behind `Protected` (/profile, /pro, /dev/ml),
 * per-entity routes whose ids churn (/stats/prediction/…, /share/:id), and any
 * URL whose content dies within a day — Google caches sitelinks for weeks, so a
 * nightly URL would surface as a dead link long after the game ended.
 */
const ROUTES = [
  {
    out: "nhl-predictions.html",
    loc: "/nhl-predictions",
    title: "NHL Predictions | Model Win Probabilities, Every Game | ArakIce",
    desc: "Machine learning win probabilities, totals and puck line context for every NHL game on the slate, updated as odds move.",
    heading: "NHL Predictions",
    blurb: "Model win probabilities, totals and puck-line context for every game on the slate.",
    games: true,
  },
  {
    out: "schedule.html",
    loc: "/schedule",
    title: "Tonight's NHL Games | Schedule and Model Picks | ArakIce",
    desc: "Every NHL game playing tonight with ArakIce's model probabilities, start times and the edges our model sees against the book.",
    heading: "Tonight's NHL Games",
    blurb: "Every game on today's slate with model probabilities, start times and the edges against the book.",
    games: true,
  },
  {
    out: "stats.html",
    loc: "/stats",
    title: "NHL Team and Player Stats | Model Inputs | ArakIce",
    desc: "The team and player statistics behind ArakIce's NHL predictions: scoring rates, goaltending, special teams and recent form.",
    heading: "NHL Stats",
    blurb: "The team and player numbers our NHL model runs on: scoring rates, goaltending, special teams, recent form.",
  },
  {
    // Nested path: written to dist/stats/chart.html, served at /stats/chart.
    out: path.join("stats", "chart.html"),
    loc: "/stats/chart",
    title: "NHL Stats Charts | Teams, Games and Players | ArakIce",
    desc: "The entry point to ArakIce's NHL charts: compare all 32 teams, browse results and upcoming games, or follow the league's scoring leaders.",
    heading: "NHL Stats Charts",
    blurb: "Compare teams, browse games and follow the league's leaders — or step into a single club.",
  },
  {
    // Nested path: written to dist/stats/chart/all-teams.html
    out: path.join("stats", "chart", "all-teams.html"),
    loc: "/stats/chart/all-teams",
    title: "NHL Team Stats Charts | All 32 Teams Compared | ArakIce",
    desc: "Interactive charts comparing all 32 NHL teams across the metrics that drive ArakIce's predictions: goals, expected goals, special teams and form.",
    heading: "NHL Team Stats Charts",
    blurb: "All 32 NHL teams compared across the metrics that drive our predictions.",
  },
  {
    out: "bet.html",
    loc: "/bet",
    title: "NHL Bet Builder | Score Any Slip Against the Model | ArakIce",
    desc: "Build an NHL slip leg by leg and see ArakIce's model probability and expected value for each selection before you commit.",
    heading: "NHL Bet Builder",
    blurb: "Build a slip leg by leg and see the model probability and expected value for each selection.",
  },
  {
    out: "league.html",
    loc: "/league",
    title: "NHL Standings & League View | ArakIce",
    desc: "NHL standings, divisions and league-wide form, alongside the model's read on which teams are over- and under-performing.",
    heading: "NHL Standings",
    blurb: "Standings, divisions and league-wide form, with the model's read on who is over- and under-performing.",
  },
  {
    out: "login.html",
    loc: "/login",
    title: "Sign In to ArakIce | NHL Predictions",
    desc: "Sign in to ArakIce to save slips, track your prediction history and get notified when the model finds a value bet.",
    heading: "Sign In to ArakIce",
    blurb: "Save slips, track your history and get notified when the model finds a value bet.",
    // A sign-in form has nothing to rank for. Indexed, it only competes with the
    // homepage on brand queries and pads the crawl budget. `follow` is kept so
    // the links out of the shell still count.
    robots: "noindex, follow",
  },
];

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Replace exactly one occurrence of `re` and throw if it isn't there.
 *
 * The whole point of this script is the head markup, so a silently skipped
 * substitution would ship a page that looks fine and is invisible to Google.
 * Failing the build is the correct response: it means index.html drifted and
 * this script needs updating alongside it.
 */
function sub(html, label, re, replacement) {
  const matches = html.match(new RegExp(re.source, re.flags.replace("g", "") + "g"));
  if (!matches) {
    throw new Error(
      `route-shells: could not find ${label} in dist/index.html.\n` +
        `  client/index.html probably changed — update the pattern in scripts/route-shells.mjs.`
    );
  }
  if (matches.length > 1) {
    throw new Error(`route-shells: ${label} matched ${matches.length}× in dist/index.html; expected exactly 1.`);
  }
  return html.replace(re, () => replacement);
}

/** Guard the assumption that a copy of index.html works from any directory depth. */
function assertAssetsAbsolute(html) {
  const bad = [...html.matchAll(/(?:src|href)="(?!https?:|\/\/|\/|#|data:|mailto:)([^"]+)"/g)].map((m) => m[1]);
  if (bad.length) {
    throw new Error(
      `route-shells: dist/index.html has relative asset URLs (${bad.join(", ")}).\n` +
        `  Nested shells like /stats/chart/all-teams would 404 on them. Set Vite \`base: "/"\`.`
    );
  }
}

// ── Crawlable static content inside #root ──────────────────────────────────

const STATIC_CSS = `<style>
      .seo-static { max-width: 760px; margin: 0 auto; padding: 40px 20px; color: var(--color-text-muted, #92A08A);
        font: 15px/1.65 'Inter', 'Inter Fallback', system-ui, sans-serif; opacity: 0; animation: seo-static-in 0s linear 2.5s forwards; }
      .seo-static h1, .seo-static h2 { color: var(--color-text, #F3F7F0); font-family: 'Oswald', 'Oswald Fallback', sans-serif; }
      .seo-static a { color: var(--color-accent, #9BF019); }
      @keyframes seo-static-in { to { opacity: 1; } }
    </style>
  </head>`;

const SECTIONS = [
  ["/nhl-predictions-today", "NHL Predictions Today", "tonight's games with model win probabilities"],
  ["/match", "Tonight's NHL game previews", "one page per game: model win chance, form, rest, head to head"],
  ["/best-nhl-picks-today", "Best NHL Picks Today", "the strongest edges of the night"],
  ["/nhl-player-props", "NHL Player Props", "shots, points and saves projections"],
  ["/nhl-prediction-accuracy", "NHL Prediction Accuracy", "out-of-sample results and calibration"],
  ["/nhl-teams", "NHL Teams", "all 32 teams: record, next game, model win chance, recent results vs the model"],
  ["/nhl-matchups", "NHL Matchups", "head-to-head history for every pair of teams"],
  ["/stats/chart/all-teams", "NHL Team Stats Charts", "all 32 teams compared"],
  ["/about", "About ArakIce", "the model, methodology and responsible gambling"],
];

/** "Key facts" bullets from dist/llms.txt — the one place those numbers live. */
async function keyFacts() {
  try {
    const txt = await fs.readFile(path.join(DIST, "llms.txt"), "utf-8");
    const lead = (txt.match(/^>\s*(.+)$/m) || [])[1] || "";
    const block = (txt.split(/^Key facts:\s*$/m)[1] || "").split(/^##/m)[0];
    const facts = block.split("\n").map((l) => l.match(/^-\s+(.+)$/)?.[1]).filter(Boolean);
    return { lead, facts };
  } catch {
    return { lead: "", facts: [] };
  }
}

const etToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/**
 * Tonight's game pages written by gameday-gen.mjs (copied into dist/ by Vite):
 * today's ET date, or the latest earlier slate. Label = the page's <h1>, plus
 * the model's public answer when the page carries one (FAQPage JSON-LD).
 */
async function tonightsGames() {
  const root = path.join(DIST, "match");
  let dates;
  try {
    dates = (await fs.readdir(root)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= etToday()).sort();
  } catch {
    return { date: null, games: [] };
  }
  const date = dates[dates.length - 1];
  if (!date) return { date: null, games: [] };
  const files = (await fs.readdir(path.join(root, date))).filter((f) => f.endsWith(".html") && f !== "index.html");
  const games = [];
  for (const f of files.sort()) {
    const html = await fs.readFile(path.join(root, date, f), "utf-8");
    const h1 = (html.match(/<h1>([\s\S]*?)<\/h1>/) || [])[1];
    if (!h1) continue;
    const label = h1.split(" — ")[0].replace(/&amp;/g, "&");
    let answer = "";
    const ld = html.match(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/);
    if (ld) {
      try {
        const faq = (JSON.parse(ld[1])["@graph"] || []).find((n) => n["@type"] === "FAQPage");
        answer = faq?.mainEntity?.[0]?.acceptedAnswer?.text?.split(/(?<=\.)\s/)[0] || "";
      } catch { /* page without a readable graph: link only */ }
    }
    games.push({ href: `/match/${date}/${f.replace(/\.html$/, "")}`, label, answer });
  }
  return { date, games };
}

/** The block that goes inside <div id="root">. `route` null = homepage. */
function staticBlock(route, facts, tonight) {
  const h1 = route ? route.heading : "ArakIce: NHL predictions from a machine learning model";
  const intro = route ? route.blurb : facts.lead;
  const li = (href, name, what) => `          <li><a href="${href}">${esc(name)}</a>${what ? `: ${esc(what)}` : ""}</li>`;
  const parts = [`<div class="seo-static">`, `      <h1>${esc(h1)}</h1>`];
  if (intro) parts.push(`      <p>${esc(intro)}</p>`);
  if ((!route || route.games) && tonight.games.length) {
    parts.push(`      <h2>Tonight's NHL games${tonight.date ? ` (${esc(tonight.date)})` : ""}</h2>`, `      <ul>`,
      ...tonight.games.map((g) => li(g.href, `${g.label} prediction`, g.answer)), `      </ul>`);
  }
  if (!route && facts.facts.length) {
    parts.push(`      <h2>Key facts</h2>`, `      <ul>`, ...facts.facts.map((f) => `          <li>${esc(f)}</li>`), `      </ul>`,
      `      <p>Every morning's pre-game probabilities are committed to a public GitHub repository before puck drop: <a href="https://github.com/ireinahedad/arakice-nhl-predictions">arakice-nhl-predictions</a>.</p>`);
  }
  parts.push(`      <h2>${route ? "More from ArakIce" : "Sections"}</h2>`, `      <ul>`,
    ...(route ? [li("/", "ArakIce home", "all NHL predictions and tools")] : []),
    ...SECTIONS.filter(([href]) => !route || href !== route.loc).map(([href, n, w]) => li(href, n, w)),
    `      </ul>`, `    </div>`);
  return parts.join("\n");
}

function withStatic(html, label, block) {
  html = sub(html, `${label}: <div id="root">`, /<div id="root"><\/div>/, `<div id="root">${block}</div>`);
  return sub(html, `${label}: </head>`, /<\/head>/, STATIC_CSS);
}

function shellFor(base, route, facts, tonight) {
  const url = SITE + route.loc;
  let html = base;

  html = sub(html, "<title>", /<title>[\s\S]*?<\/title>/, `<title>${esc(route.title)}</title>`);
  html = sub(html, 'meta name="description"', /<meta name="description" content="[^"]*" \/>/,
    `<meta name="description" content="${esc(route.desc)}" />`);
  html = sub(html, 'link rel="canonical"', /<link rel="canonical" href="[^"]*" \/>/,
    `<link rel="canonical" href="${url}" />`);
  html = sub(html, 'meta name="robots"', /<meta name="robots" content="[^"]*" \/>/,
    `<meta name="robots" content="${route.robots || "index, follow, max-image-preview:large"}" />`);

  html = sub(html, 'meta property="og:title"', /<meta property="og:title" content="[^"]*" \/>/,
    `<meta property="og:title" content="${esc(route.title)}" />`);
  html = sub(html, 'meta property="og:description"', /<meta property="og:description" content="[^"]*" \/>/,
    `<meta property="og:description" content="${esc(route.desc)}" />`);
  html = sub(html, 'meta property="og:url"', /<meta property="og:url" content="[^"]*" \/>/,
    `<meta property="og:url" content="${url}" />`);
  html = sub(html, 'meta name="twitter:title"', /<meta name="twitter:title" content="[^"]*" \/>/,
    `<meta name="twitter:title" content="${esc(route.title)}" />`);
  html = sub(html, 'meta name="twitter:description"', /<meta name="twitter:description" content="[^"]*" \/>/,
    `<meta name="twitter:description" content="${esc(route.desc)}" />`);

  // The homepage carries Organization + WebSite + SiteNavigationElement. Repeating
  // those on every route would assert several primary entities for one site, so
  // sub-pages get a WebPage that points back at the homepage entities instead,
  // plus a breadcrumb so Google can render the site hierarchy.
  const jsonld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": url + "#webpage",
        url,
        name: route.title,
        description: route.desc,
        isPartOf: { "@id": SITE + "/#website" },
        about: { "@id": SITE + "/#organization" },
        inLanguage: ["en-CA", "fr-CA"],
        primaryImageOfPage: { "@type": "ImageObject", url: SITE + "/arakice-og.png" },
      },
      {
        "@type": "BreadcrumbList",
        "@id": url + "#breadcrumb",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "ArakIce", item: SITE + "/" },
          { "@type": "ListItem", position: 2, name: route.heading, item: url },
        ],
      },
    ],
  };
  html = sub(html, "JSON-LD block", /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
    `<script type="application/ld+json">\n${JSON.stringify(jsonld, null, 2)}\n    </script>`);

  // Route-specific crawlable fallback, replacing the homepage's section list.
  const noscript =
    `<noscript>\n` +
    `      <nav class="no-js-nav" aria-label="${esc(route.heading)}">\n` +
    `        <h1>${esc(route.heading)}</h1>\n` +
    `        <p>${esc(route.blurb)}</p>\n` +
    `        <ul>\n` +
    `          <li><a href="/">ArakIce home</a>, all NHL predictions and tools</li>\n` +
    `          <li><a href="/about">About the model</a>, how our predictions are built</li>\n` +
    `        </ul>\n` +
    `      </nav>\n` +
    `    </noscript>`;
  html = sub(html, "<noscript> block", /<noscript>[\s\S]*?<\/noscript>/, noscript);

  return withStatic(html, route.loc, staticBlock(route, facts, tonight));
}

async function main() {
  const indexPath = path.join(DIST, "index.html");
  let base;
  try {
    base = await fs.readFile(indexPath, "utf-8");
  } catch {
    throw new Error(`route-shells: ${indexPath} not found — run \`vite build\` first.`);
  }

  assertAssetsAbsolute(base);

  const facts = await keyFacts();
  const tonight = await tonightsGames();
  console.log(`  static content: ${facts.facts.length} key facts, ${tonight.games.length} game(s) for ${tonight.date ?? "—"}`);

  const seen = new Set();
  for (const route of ROUTES) {
    if (seen.has(route.out)) throw new Error(`route-shells: duplicate output ${route.out}`);
    seen.add(route.out);

    const dest = path.join(DIST, route.out);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, shellFor(base, route, facts, tonight), "utf-8");
    console.log(`  ${route.loc.padEnd(26)} → dist/${route.out.split(path.sep).join("/")}`);
  }

  // Homepage last: the shells above were copied from the untouched base.
  await fs.writeFile(indexPath, withStatic(base, "/", staticBlock(null, facts, tonight)), "utf-8");
  console.log(`route-shells: wrote ${ROUTES.length} route shells + homepage static content.`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
