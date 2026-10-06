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
 * Body content stays client-rendered. That is fine: Google executes JS, and the
 * parts that drive the sitelink display — title and description — are static.
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
  },
  {
    out: "schedule.html",
    loc: "/schedule",
    title: "Tonight's NHL Games | Schedule and Model Picks | ArakIce",
    desc: "Every NHL game playing tonight with ArakIce's model probabilities, start times and the edges our model sees against the book.",
    heading: "Tonight's NHL Games",
    blurb: "Every game on today's slate with model probabilities, start times and the edges against the book.",
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

function shellFor(base, route) {
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

  return html;
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

  const seen = new Set();
  for (const route of ROUTES) {
    if (seen.has(route.out)) throw new Error(`route-shells: duplicate output ${route.out}`);
    seen.add(route.out);

    const dest = path.join(DIST, route.out);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, shellFor(base, route), "utf-8");
    console.log(`  ${route.loc.padEnd(26)} → dist/${route.out.split(path.sep).join("/")}`);
  }

  console.log(`route-shells: wrote ${ROUTES.length} route shells.`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
