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
// Gate thin player pages. 20 GP (a quarter season) is the floor at which a
// player page has enough real data to say anything the template does not already
// say. Below it the page is ~750 words of boilerplate around a line of zeroes,
// which is what Google's scaled-content-abuse policy targets — and hundreds of
// those drag down the pages that DO deserve to rank.
const MIN_GP = Number(process.env.MIN_GP || 20);
// Seuil réduit pour les joueurs de la liste blanche (2026-10-21). Leurs pages
// ont déjà prouvé qu'elles attirent des impressions ; avec MIN_GP seul, aucun
// n'a de page avant ~décembre (saison commencée le 2026-09-29) et les 56 restent
// garés derrière la redirection temporaire tout l'automne.
const MIN_GP_ALLOWLIST = Number(process.env.MIN_GP_ALLOWLIST || 5);
const CONCURRENCY = 6;

// ── Longueurs de titre et de description ─────────────────────────────────────
// Google coupe le titre vers 60-65 caractères et la description vers 155-160.
// `fit` prend des variantes de la plus riche à la plus courte et rend la
// première qui tient ; la dernière sert de filet et est coupée proprement si
// même elle déborde. Exportée pour gameday-gen.mjs.
const TITLE_MAX = 65;
const DESC_MAX = 155;
function fit(max, ...candidates) {
  const list = candidates.filter(Boolean);
  for (const c of list) if (c.length <= max) return c;
  const last = list[list.length - 1] || "";
  return last.slice(0, max - 1).replace(/[\s,;:|·-]+\S*$/, "") + "…";
}

const STATIC_PAGES = [
  { loc: "/", changefreq: "daily", priority: "1.0" },
  { loc: "/nhl-predictions-today", changefreq: "daily", priority: "0.9" },
  { loc: "/best-nhl-picks-today", changefreq: "daily", priority: "0.9" },
  { loc: "/nhl-ai-predictions", changefreq: "weekly", priority: "0.8" },
  { loc: "/nhl-prediction-accuracy", changefreq: "monthly", priority: "0.8" },
  { loc: "/best-nhl-betting-software", changefreq: "monthly", priority: "0.7" },
  { loc: "/about", changefreq: "monthly", priority: "0.5" },

  // App routes made independently indexable by scripts/route-shells.mjs (each
  // gets its own title/description/canonical at build time). They must be in the
  // sitemap for Google to consider them as sitelink candidates. Keep this list in
  // sync with ROUTES in route-shells.mjs.
  { loc: "/nhl-predictions", changefreq: "daily", priority: "0.9" },
  { loc: "/schedule", changefreq: "daily", priority: "0.9" },
  { loc: "/stats", changefreq: "daily", priority: "0.8" },
  { loc: "/stats/chart/all-teams", changefreq: "daily", priority: "0.8" },
  { loc: "/bet", changefreq: "weekly", priority: "0.7" },
  { loc: "/league", changefreq: "daily", priority: "0.7" },
  // /login is deliberately absent: route-shells.mjs marks it `noindex`, and a
  // sitemap entry for a noindexed URL is a contradictory signal that shows up in
  // Search Console as "Submitted URL marked noindex".
];

// ── Liste blanche des pages joueur ───────────────────────────────────────────
// Le gabarit produisait 786 pages quasi identiques ; Search Console en a refusé
// 417 (« Crawled - currently not indexed »). On ne garde que celles dont la
// donnée montre qu'elles servent à quelque chose. La liste et sa provenance
// vivent dans scripts/props-allowlist.json, pour être remise à jour depuis
// Search Console sans toucher au code.
//
// ⚠️ MIN_GP ne suffisait pas : c'était un proxy de « page mince » et il se
// trompait. Sept pages sous 20 matchs joués rankaient réellement, dont une en
// position 4 avec un clic. C'est la donnée qui tranche, pas le nombre de matchs.
const ALLOWLIST_PATH = process.env.PROPS_ALLOWLIST
  || path.join(__dirname, "props-allowlist.json");

async function loadPropsAllowlist() {
  try {
    const raw = await fs.readFile(ALLOWLIST_PATH, "utf-8");
    const slugs = JSON.parse(raw).slugs;
    if (!Array.isArray(slugs) || !slugs.length) throw new Error("slugs vide");
    return new Set(slugs);
  } catch (e) {
    // Pas de repli silencieux sur « tout écrire » : ce serait republier les 786
    // pages sans que personne ne le remarque.
    throw new Error(`liste blanche des props illisible (${ALLOWLIST_PATH}) : ${e.message}`);
  }
}

// ── Head to head history ─────────────────────────────────────────────────────
// Les pages d'affiche ne servaient qu'un explicatif générique : Google en a
// refusé 417 sur 786 du même moule côté joueurs, et les pages d'affiche
// plafonnaient à 0 clic malgré des impressions réelles. Elles servent
// maintenant l'historique réel de la confrontation, tiré du jeu de données ML.
//
// ⚠️ COUPLAGE ASSUMÉ : ce générateur, qui ne lisait que l'API NHL, dépend
// désormais d'un fichier de `ml/`. Le couplage se limite aux 9 colonnes ci-
// dessous, qui sont stables. La lecture est tolérante : fichier absent ou
// illisible => les pages se génèrent sans le bloc plutôt que de casser le build.
const H2H_CSV = process.env.H2H_CSV || path.join(__dirname, "..", "..", "ml", "data", "nhl_games_v4.csv");
const H2H_SEASONS = new Set(["2021", "2022", "2023", "2024", "2025"]); // 5 dernières
// Sous ce nombre de rencontres on donne le décompte brut et jamais un
// pourcentage : « 100 % en prolongation » sur 4 matchs décrédibilise la page.
const H2H_MIN_PCT = 8;
// La franchise d'Utah n'existe que depuis 2024-25. Le jeu de données réécrit
// TOUTE l'histoire d'Arizona/Phoenix en UTA : sans ce plancher, la page
// attribuerait à Utah seize saisons qui ne sont pas les siennes.
const RELOCATED_SINCE = { UTA: "2024" };

async function loadH2H() {
  let raw;
  try {
    raw = await fs.readFile(H2H_CSV, "utf-8");
  } catch {
    console.warn(`  ⚠️  ${H2H_CSV} illisible — les pages d'affiche seront générées sans historique.`);
    return new Map();
  }
  const lines = raw.split("\n");
  const head = lines[0].split(",");
  const ix = {};
  for (const c of ["season","date","home_team","away_team","home_score","away_score","home_win","total_goals","went_to_ot"]) {
    ix[c] = head.indexOf(c);
    if (ix[c] < 0) {
      console.warn(`  ⚠️  colonne « ${c} » absente de ${H2H_CSV} — historique désactivé.`);
      return new Map();
    }
  }
  // Le fichier est écrit par pandas : pas de champ entre guillemets, un split
  // suffit. Les booléens y sont sérialisés en "1.0"/"0.0" et non "1"/"0" —
  // comparer à "1" rendait 0 prolongation sur 129 pages, un chiffre inventé.
  const yes = (v) => v === "1" || v === "1.0";
  const games = new Map();
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(",");
    if (f.length < head.length) continue;
    const season = f[ix.season];
    if (!H2H_SEASONS.has(season)) continue;
    const total = f[ix.total_goals];
    if (!total) continue;
    const home = f[ix.home_team], away = f[ix.away_team];
    const floor = RELOCATED_SINCE[home] || RELOCATED_SINCE[away];
    if (floor && season < floor) continue;
    const key = [home, away].sort().join("|");
    if (!games.has(key)) games.set(key, []);
    games.get(key).push({
      date: f[ix.date], home, away,
      hs: Number(f[ix.home_score]), as: Number(f[ix.away_score]),
      homeWin: yes(f[ix.home_win]), total: Number(total), ot: yes(f[ix.went_to_ot]),
    });
  }
  for (const list of games.values()) list.sort((x, y) => x.date.localeCompare(y.date));
  return games;
}

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

// ── Chrome traduit ───────────────────────────────────────────────────────────
// Le gabarit servait un en-tête, un pied de page et un avertissement écrits en
// dur en anglais. Les pages de match (gameday-gen.mjs) existent dans les deux
// langues ; la chaîne anglaise de chaque entrée est reproduite au caractère
// près pour que les pages déjà indexées ne bougent pas d'un octet.
//
// L'avertissement français ne traduit PAS « 1-800-GAMBLER », qui est une ligne
// américaine : le lecteur francophone visé est au Québec, où la ligne est
// « Jeu : aide et référence » (1 800 461-0140, 24 h sur 24, gratuite et
// anonyme). Donner un numéro que le lecteur ne peut pas composer ne vaut pas
// mieux que ne rien donner.
const CHROME = {
  en: {
    home: "ArakIce home",
    openApp: "Open the app",
    disclaimer:
      "ArakIce provides statistical analysis and predictions for informational and entertainment purposes only. Nothing here is financial advice or a guarantee of results. Betting involves risk and you should never wager more than you can afford to lose. Must be of legal gambling age in your jurisdiction. If gambling stops being fun, help is available. In the US, call or text 1-800-GAMBLER.",
    tagline: "Statistical edge for smarter sports bets.",
    // Mention de non-affiliation : noms d'équipes et de ligue cités, logos jamais.
    notAffiliated: "Not affiliated with or endorsed by the NHL or its teams. NHL and team names are trademarks of their respective owners.",
    nav: [
      { href: "/match", label: "Tonight's Games" },
      { href: "/nhl-predictions-today", label: "NHL Predictions" },
      { href: "/nhl-player-props", label: "Player Props" },
      { href: "/nhl-matchups", label: "Matchups" },
      { href: "/best-nhl-picks-today", label: "Best Picks" },
    ],
  },
  fr: {
    home: "Accueil ArakIce",
    openApp: "Ouvrir l'application",
    disclaimer:
      "ArakIce publie des analyses statistiques et des projections à titre informatif et de divertissement seulement. Rien ici n'est un conseil financier ni une garantie de résultat. Parier comporte un risque : ne misez jamais plus que ce que vous pouvez perdre. Vous devez avoir l'âge légal pour parier dans votre juridiction. Si le jeu cesse d'être un plaisir, de l'aide existe. Au Québec, Jeu : aide et référence répond 24 h sur 24 au 1 800 461-0140, gratuitement et anonymement.",
    tagline: "L'avantage statistique, pour parier plus intelligemment.",
    notAffiliated: "Non affilié à la LNH ni à ses équipes, et non approuvé par elles. LNH et les noms d'équipes sont des marques de leurs propriétaires respectifs.",
    nav: [
      { href: "/fr/match", label: "Matchs du jour" },
      { href: "/nhl-predictions-today", label: "Prédictions LNH" },
      { href: "/nhl-matchups", label: "Confrontations" },
    ],
  },
};

// ── Shared HTML shell ─────────────────────────────────────────────────────────
// `disclaimer` : l'avertissement de jeu responsable n'a de sens que sur une page
// qui parle de pari ou de cotes. Les pages d'affiche n'en parlent plus (elles ne
// servent que des statistiques de match) et le passent donc à false ; toutes les
// autres pages le gardent.
//
// `lang` / `alternates` : ajoutés pour les pages de match bilingues. Par défaut
// (`"en"`, aucune alternative) la sortie est identique à l'octet près à ce que
// ce fichier produisait avant — c'est la condition pour ne pas rejouer une
// réindexation complète des pages qui rankent déjà.
function layout({ title, desc, canonicalPath, jsonld, body, extraHead = "", disclaimer = true, lang = "en", alternates = null, ogLocale = null }) {
  const url = SITE + canonicalPath;
  const T = CHROME[lang] || CHROME.en;
  // hreflang : Google exige la réciprocité (chaque version pointe vers toutes
  // les autres, elle-même comprise) et un `x-default`. Une paire incomplète est
  // ignorée en silence, ce qui est pire qu'absente : on n'en écrit donc aucune
  // tant que l'appelant ne fournit pas la liste complète.
  const hreflang = alternates
    ? Object.entries(alternates)
        .map(([hl, p]) => `  <link rel="alternate" hreflang="${esc(hl)}" href="${SITE}${p}" />\n`)
        .join("")
    : "";
  return `<!DOCTYPE html>
<html lang="${esc(lang === "fr" ? "fr-CA" : lang)}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}" />
  <link rel="canonical" href="${url}" />
${hreflang}  <meta name="robots" content="index, follow, max-image-preview:large" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="ArakIce" />${ogLocale ? `\n  <meta property="og:locale" content="${esc(ogLocale)}" />` : ""}
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:url" content="${url}" />
  <meta property="og:image" content="${SITE}/arakice-og.png" />
  <meta property="og:image:secure_url" content="${SITE}/arakice-og.png" />
  <meta property="og:image:type" content="image/png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="ArakIce, NHL predictions powered by ML" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(desc)}" />
  <meta name="twitter:image" content="${SITE}/arakice-og.png" />
  <meta name="twitter:image:alt" content="ArakIce, NHL predictions powered by ML" />
  <link rel="icon" type="image/png" sizes="96x96" href="/arakice-icon-96.png" />
  <link rel="icon" type="image/png" sizes="192x192" href="/arakice-icon-192.png" />
  <link rel="icon" type="image/png" sizes="512x512" href="/arakice-icon-512.png" />
  <link rel="apple-touch-icon" sizes="180x180" href="/arakice-icon-180.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/seo.css" />
${jsonld ? `  <script type="application/ld+json">\n${JSON.stringify(jsonld, null, 2)}\n  </script>\n` : ""}${extraHead}</head>
<body>
  <header class="site-header">
    <div class="wrap">
      <a class="brand" href="${SITE}/" aria-label="${esc(T.home)}">
        <img class="brand-logo" src="/arakice-logo-80.png" alt="ArakIce" width="40" height="40" />
        <span class="brand-word">ArakIce</span>
      </a>
      <a class="nav-cta" href="${SITE}/">${esc(T.openApp)}</a>
    </div>
  </header>
  <main>
${body}
${disclaimer ? `    <div class="disclaimer">
      <p>${esc(T.disclaimer)}</p>
    </div>` : ""}
  </main>
  <footer class="site-footer">
    <div class="wrap">
      <nav>
${T.nav.map((n) => `        <a href="${SITE}${n.href}">${esc(n.label)}</a>`).join("\n")}
      </nav>
      <span>&copy; ArakIce. ${esc(T.tagline)} ${esc(T.notAffiliated)}</span>
    </div>
  </footer>
</body>
</html>
`;
}

function ctaBox(heading, text, label) {
  return `    <div class="cta-box">
      <p class="cta-title">${esc(heading)}</p>
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
  const gp = Number(s.gamesPlayed || 0);

  // Per-game rates → genuinely unique numbers per player (reduces duplicate-content risk).
  let rateBlock = "";
  if (!isGoalie && gp > 0) {
    const ppg = (Number(s.points || 0) / gp).toFixed(2);
    const spg = (Number(s.shots || 0) / gp).toFixed(1);
    const gpg = (Number(s.goals || 0) / gp).toFixed(2);
    rateBlock = `      <h2>What ${esc(p.name)}'s rates tell us</h2>
      <p>Across ${gp} games, ${esc(p.name)} is averaging about <strong>${ppg} points</strong> and <strong>${spg} shots on goal</strong> per game, at roughly ${gpg} goals a night. Rates matter more than raw totals for props, because a prop line is a single game question, and a pace of ${spg} shots is the base the model adjusts up or down for the specific matchup, ice time and pace. When ${esc(p.name)}'s role or linemates change, those rates are the first thing to move.</p>`;
  } else if (isGoalie && gp > 0) {
    const svp = s.savePctg != null ? Number(s.savePctg).toFixed(3) : null;
    rateBlock = `      <h2>What ${esc(p.name)}'s numbers tell us</h2>
      <p>Over ${gp} appearances${svp ? ` at a ${svp} save percentage` : ""}, ${esc(p.name)} gives the model a base workload and stopping rate to build on. For goaltender props, the swing factor is volume: the model estimates how many shots ${esc(team)}'s opponent is likely to generate, then pairs that with ${esc(p.name)}'s save rate to project saves. A busy opponent lifts the saves projection even when the win is in doubt. A quiet one suppresses it.</p>`;
  }
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
    ? `For a goaltender like ${esc(p.name)}, the props that matter most are saves and, on the totals side, the game's over/under. Both driven by how many shots the opposition is likely to generate. Our model estimates ${esc(p.name)}'s expected workload from the quality of shots ${esc(team)} tends to allow, the pace of the opponent, and rest, then compares that projection to the posted save line.`
    : `For a skater like ${esc(p.name)}, shots on goal and points are the headline props. Shots are the more stable of the two. They depend on ice time, role and how many attempts ${esc(team)} generates. Points swing more with linemates and finishing luck. The model projects each from ${esc(p.name)}'s usage and matchup, then flags where that number diverges from the sportsbook line.`;

  const stats = p.stats && p.stats.gamesPlayed
    ? `      <h2>${esc(p.name)}'s season at a glance</h2>
      <div class="stats-row">
${cardsHtml}
      </div>
      <p>These are ${esc(p.name)}'s current regular season totals. They form the base rate the model starts from before adjusting for tonight's specific matchup, opponent quality, rest and role.</p>`
    : "";

  // FAQPage retiré : Google ne l'affiche plus que pour les sites de santé et
  // gouvernementaux (août 2023). Le balisage n'apportait plus rien.
  const jsonld = null;

  const body = `    <section class="hero">
      <p class="eyebrow">${esc(team)} · ${esc(posName)}</p>
      <h1>${esc(p.name)} Prop Predictions</h1>
      <p class="lede">Projections and betting context for ${esc(p.name)} of the ${esc(team)}. See how ArakIce models ${esc(p.name)}'s props, ${isGoalie ? "saves and totals" : "shots and points included"}, and where the numbers point against the sportsbook line.</p>
    </section>
    <p>If you follow ${esc(p.name)}, you already know the box score only tells part of the story. Prop betting rewards understanding the <em>process</em> behind the numbers: the ice time, the role, the matchup and the pace that decide how many chances a ${esc(posName)} actually gets. This page explains how ArakIce turns that context into a projection for ${esc(p.name)}, and how to use it without fooling yourself.</p>
${ctaBox(`See ${p.name}'s live projection tonight`, `When ${p.name} is playing, ArakIce shows the projection and the edge against the current prop line, updated through the day.`, "Open ArakIce")}
${stats}
      <h2>How we project ${esc(p.name)}'s props</h2>
      <p>${propsFocus}</p>
      <p>The projection is not a season average dressed up. It weighs the specific game: the opponent ${esc(team)} faces, whether either team is playing a second night in a row or sitting deep in a road trip, the goaltending on the other side, and the referee crew where it affects scoring. Those factors are weighed per matchup, so ${esc(p.name)}'s number on a rested home night against a weak defense looks very different from a tired night against an elite one.</p>
${rateBlock}
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
    title: fit(TITLE_MAX,
      `${p.name} Prop Predictions & Projections | ArakIce`,
      `${p.name} Prop Predictions | ArakIce`),
    desc: fit(DESC_MAX,
      `${p.name} (${team}) prop predictions: ${isGoalie ? "save and totals" : "shots, points and more"} projections and betting context from ArakIce's NHL model.`,
      `${p.name} prop predictions: ${isGoalie ? "saves and totals" : "shots, points and more"}, from ArakIce's NHL model.`),
    canonicalPath: `/props/${p.slug}`,
    jsonld,
    body,
  });
}

function propsHubPage(players) {
  // WHY THE LIST IS RENDERED HERE AND NOT BY seo-search.js
  // This hub used to ship an empty <ul> plus a JSON blob, and let the browser
  // build the rows. That left ZERO <a href="/props/..."> in the served HTML, so
  // every player page was an orphan reachable only from sitemap.xml — and a
  // sitemap-only URL with no internal link is the lowest-priority thing Google
  // crawls. (The client build also capped the rendered list at 300 rows, so
  // even after JS ran, most players had no link pointing at them at all.)
  //
  // The rows are now emitted here, as real anchors, sorted by name. seo-search.js
  // filters the rows that already exist instead of creating them, so the search
  // box behaves identically and the CSS is untouched.
  const sorted = [...players].sort((a, b) => a.name.localeCompare(b.name));
  const rows = sorted
    .map((p) => {
      // Lower-cased, diacritic-free haystack so the filter never has to
      // normalize at keystroke time.
      const hay = `${p.name} ${p.teamName || p.team} ${p.pos}`
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "");
      return `        <li data-hay="${esc(hay)}"><a class="player-row" href="/props/${p.slug}"><span class="player-name">${esc(p.name)}</span><span class="player-meta">${esc([p.pos, p.team].filter(Boolean).join(" · "))}</span></a></li>`;
    })
    .join("\n");
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "NHL Player Prop Predictions",
    description: "Search any NHL player for prop projections and betting context.",
    url: `${SITE}/nhl-player-props`,
  };
  const body = `    <section class="hero">
      <p class="eyebrow">${players.length ? `Search ${players.length} NHL players` : "Player pages"}</p>
      <h1>NHL Player Prop Predictions</h1>
      <p class="lede">${players.length
        ? "Type any player's name to open their prop page. Shots, points and goaltender saves, each with the projection and the edge against the sportsbook line."
        : `Player pages appear once a player has ${MIN_GP} games this season, so the numbers behind them are this season's, not last year's. Until then, tonight's props are in the app.`}</p>
    </section>
    <div class="search-wrap">
      <input id="player-search" type="search" placeholder="Search a player, for example Connor McDavid" autocomplete="off" aria-label="Search NHL players" />
      <div id="player-count">${players.length} players</div>
    </div>
    <ul id="player-list">
${rows}
    </ul>
    <script src="/seo-search.js" defer></script>
${ctaBox("See tonight's prop edges", "The app ranks tonight's player props by how far the projection beats the line. Open it to see the biggest edges live.", "Open ArakIce")}
      <h2>How ArakIce projects player props</h2>
      <p>A player prop is a bet on an individual's output rather than on who wins: shots on goal, points, goaltender saves. The edge comes from projecting that output more accurately than the sportsbook's line. ArakIce builds each projection from usage and role, the pace and quality of the matchup, rest and travel, and the goaltending involved, then compares it to the posted number. Where the two disagree, there is value; where they agree, there is not.</p>
      <p>Props are fertile ground for edges because sportsbooks price hundreds of them every night and cannot sharpen each one. Use the search above to find any player, read the reasoning on their page, and open the app for tonight's live projection.</p>`;
  return layout({
    title: "NHL Player Prop Predictions | Search Any Player | ArakIce",
    desc: "Search any NHL player for prop projections, shots and points and goaltender saves, with the edge against the line, from ArakIce's model.",
    canonicalPath: "/nhl-player-props",
    jsonld,
    body,
  });
}

// ── Statistiques de confrontation ────────────────────────────────────────────
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function niceDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
}

// La ligne de total la plus courante à la LNH. Sert de repère au graphique et
// de pivot au décompte « en dessous / au dessus ».
const COMMON_LINE = 6;

function h2hStats(games, a, b) {
  if (!games || !games.length) return null;
  const totals = games.map((g) => g.total);
  const n = games.length;
  const aWins = games.filter((g) => (g.home === a.abbr) === g.homeWin).length;
  const roadWins = games.filter((g) => !g.homeWin);
  return {
    n, games, aWins, bWins: n - aWins,
    avg: totals.reduce((x, y) => x + y, 0) / n,
    homeWins: games.filter((g) => g.homeWin).length,
    ot: games.filter((g) => g.ot).length,
    under: totals.filter((t) => t < COMMON_LINE).length,
    over: totals.filter((t) => t > COMMON_LINE).length,
    onLine: totals.filter((t) => t === COMMON_LINE).length,
    lo: Math.min(...totals), hi: Math.max(...totals),
    biggest: games.reduce((m, g) => (g.total > m.total ? g : m), games[0]),
    last: games[games.length - 1],
    firstYear: games[0].date.slice(0, 4),
    roadWin: roadWins[0] || null,
    roadWinCount: roadWins.length,
  };
}

// Figure : un point par rencontre sur l'axe des buts. Le SVG est écrit à la
// main plutôt que dessiné par une bibliothèque parce que ces pages n'exécutent
// aucun JS et n'ont le droit de charger aucune ressource externe (CSP).
// Une seule couleur : c'est une seule série, une deuxième teinte ne coderait rien.
function h2hFigure(st, a, b) {
  const X0 = 62, X1 = 676, BASE = 126, STEP = 19, R = 7;
  const span = Math.max(1, st.hi - st.lo);
  const x = (g) => X0 + ((g - st.lo) * (X1 - X0)) / span;
  const counts = new Map();
  for (const g of st.games) counts.set(g.total, (counts.get(g.total) || 0) + 1);
  let dots = "";
  for (const g of [...counts.keys()].sort((m, n) => m - n)) {
    for (let i = 0; i < counts.get(g); i++) {
      // L'anneau couleur surface évite que deux points empilés se confondent.
      dots += `<circle cx="${x(g).toFixed(1)}" cy="${(BASE - 10 - i * STEP).toFixed(1)}" r="${R}" fill="#1A8AFF" stroke="#131A12" stroke-width="2"/>`;
    }
  }
  let ticks = "";
  for (let g = st.lo; g <= st.hi; g++) {
    ticks += `<line x1="${x(g).toFixed(1)}" y1="${BASE}" x2="${x(g).toFixed(1)}" y2="${BASE + 6}" stroke="#283323" stroke-width="1"/>`
           + `<text x="${x(g).toFixed(1)}" y="${BASE + 24}" fill="#92A08A" font-size="13" text-anchor="middle" font-family="Inter, system-ui, sans-serif">${g}</text>`;
  }
  const refx = x(COMMON_LINE + 0.5).toFixed(1);
  const alt = `Total goals in each of the ${st.n} meetings between ${a.name} and ${b.name} since ${st.firstYear}. `
            + `${st.under} finished below ${COMMON_LINE + 1} goals, ${st.over} above, ${st.onLine} on ${COMMON_LINE}.`;
  return `      <figure class="h2h-fig">
        <svg viewBox="0 0 720 186" width="100%" role="img" xmlns="http://www.w3.org/2000/svg" aria-label="${esc(alt)}">
          <rect x="0" y="0" width="720" height="186" fill="#131A12" rx="10"/>
          <line x1="${refx}" y1="24" x2="${refx}" y2="${BASE}" stroke="#3B4A36" stroke-width="2" stroke-dasharray="3 4"/>
          <text x="${(Number(refx) + 10).toFixed(1)}" y="36" fill="#92A08A" font-size="12.5" font-family="Inter, system-ui, sans-serif">common line ${COMMON_LINE}.5</text>
          <line x1="${X0 - 26}" y1="${BASE}" x2="${X1 + 26}" y2="${BASE}" stroke="#283323" stroke-width="1"/>
          ${ticks}${dots}
          <text x="360" y="${BASE + 52}" fill="#92A08A" font-size="13" text-anchor="middle" font-family="Inter, system-ui, sans-serif">total goals, one dot per meeting</text>
        </svg>
        <figcaption>${st.n} meetings since ${st.firstYear}. ${st.under} finished at ${COMMON_LINE - 1} goals or fewer, ${st.over} at ${COMMON_LINE + 1} or more, and ${st.onLine === 0 ? `none landed on ${COMMON_LINE}` : `${st.onLine} landed on ${COMMON_LINE}`}.</figcaption>
      </figure>`;
}

function matchupPage(a, b, games) {
  const sameDiv = a.division && a.division === b.division;
  const sameConf = a.conference && a.conference === b.conference;
  const rel = sameDiv ? `a ${esc(a.division)} Division matchup`
            : sameConf ? `a ${esc(a.conference)} Conference matchup`
            : "a matchup between the conferences";
  const st = h2hStats(games, a, b);

  // Décompte plutôt que pourcentage sous le plancher.
  const pct = (k) => (st.n >= H2H_MIN_PCT ? ` (${Math.round((100 * k) / st.n)}%)` : "");
  const city = (t) => t.common || t.name;
  const byAbbr = { [a.abbr]: a, [b.abbr]: b };
  const winTxt = (g) => {
    const w = g.homeWin ? g.home : g.away, l = g.homeWin ? g.away : g.home;
    const ws = g.homeWin ? g.hs : g.as, ls = g.homeWin ? g.as : g.hs;
    return `${esc(city(byAbbr[w]))} ${ws}, ${esc(city(byAbbr[l]))} ${ls}`;
  };

  // FAQPage retiré (Google ne l'affiche plus pour ce type de site).
  const jsonld = null;

  const table = [...st.games].reverse().map((g) =>
    `        <tr><td>${niceDate(g.date)}</td><td>${winTxt(g)}${g.ot ? " (OT)" : ""}</td><td>${esc(city(byAbbr[g.home]))}</td><td class="num">${g.total}</td></tr>`
  ).join("\n");

  const leader = st.aWins > st.bWins ? a : b;

  const body = `    <section class="hero">
      <p class="eyebrow">${rel}</p>
      <h1>${esc(a.name)} vs ${esc(b.name)} Head to Head</h1>
      <div class="matchup-teams">
        <div class="team"><img src="${nhlLogo(a.abbr)}" alt="${esc(a.name)} logo" width="72" height="72" /><div class="abbr">${esc(a.abbr)}</div></div>
        <div class="vs">vs</div>
        <div class="team"><img src="${nhlLogo(b.abbr)}" alt="${esc(b.name)} logo" width="72" height="72" /><div class="abbr">${esc(b.abbr)}</div></div>
      </div>
${h2hFigure(st, a, b)}
    </section>
    <p>Here is what the record between these two clubs looks like, and how ArakIce reads their next meeting.</p>
      <h2>The last ${st.n} meetings</h2>
      <div class="stats-row">
        <div class="stat"><div class="value">${st.n}</div><div class="label">meetings since ${st.firstYear}</div></div>
        <div class="stat"><div class="value">${st.avg.toFixed(2)}</div><div class="label">goals per game</div></div>
        <div class="stat"><div class="value">${st.homeWins} of ${st.n}</div><div class="label">won by the home team</div></div>
        <div class="stat"><div class="value">${st.over} of ${st.n}</div><div class="label">over ${COMMON_LINE}.5</div></div>
      </div>
      <p>${esc(city(leader))} lead the recent series ${Math.max(st.aWins, st.bWins)} wins to ${Math.min(st.aWins, st.bWins)}. ${st.n >= H2H_MIN_PCT && st.homeWins / st.n >= 0.65 ? `Where the game is played has mattered more than who is better. ` : ``}The home team won ${st.homeWins} of the ${st.n}${pct(st.homeWins)}.${st.roadWinCount === 1 ? ` The only road win by either club was ${winTxt(st.roadWin)} on ${niceDate(st.roadWin.date)}.` : ""}</p>
      <p>${st.n >= H2H_MIN_PCT && st.onLine === 0 ? `Totals have split rather than clustered. ` : ``}${st.under} of the ${st.n} finished at ${COMMON_LINE - 1} goals or fewer. ${st.over} finished at ${COMMON_LINE + 1} or more. ${st.onLine === 0 ? `The number never landed on ${COMMON_LINE}.` : `${st.onLine} landed on ${COMMON_LINE}.`} The busiest was ${niceDate(st.biggest.date)}, ${winTxt(st.biggest)}, ${st.biggest.total} goals between them. ${st.ot} of the ${st.n} needed overtime. Most recent meeting: ${niceDate(st.last.date)}, ${winTxt(st.last)}.</p>
      <div class="h2h-wrap">
        <table class="h2h">
          <caption>Every ${esc(a.name)} and ${esc(b.name)} meeting since ${st.firstYear}</caption>
          <thead><tr><th>Date</th><th>Result</th><th>Host</th><th class="num">Goals</th></tr></thead>
          <tbody>
${table}
          </tbody>
        </table>
      </div>
      <p class="src">Compiled from ArakIce's own game database, covering every meeting between these clubs since ${st.firstYear}. Percentages appear only for matchups with at least ${H2H_MIN_PCT} meetings.</p>
${ctaBox("See the projection for this game", `When ${esc(a.name)} and ${esc(b.name)} are on the slate, ArakIce projects a win probability and a total for the game.`, "Open ArakIce")}
      <h2>How the model reads ${esc(a.name)} vs ${esc(b.name)}</h2>
      <p>The projection starts with expected goals, meaning the quality of chances each club creates and gives up. That holds up better than goals scored, which swing on shooting luck. From there it adjusts for what is true only of this game: who is confirmed in net, whether either club is playing a second night in a row or sitting deep in a road trip, the travel and the time zones, and the referee crew where it moves the total.</p>
      <h2>What tends to move ${esc(a.name)} vs ${esc(b.name)}</h2>
      <p>${sameDiv
        ? `Division rivals meet several times a year and know each other well. Those games tend to be tighter and more defensive, which is part of why the totals above sit where they do.`
        : sameConf
        ? `Conference games carry playoff seeding weight. The intensity tightens the checking and pulls event rates down compared with a casual date against the other conference.`
        : `These clubs meet rarely, so unfamiliarity, travel and scheduling quirks carry more weight than usual. Those are exactly the situations the model is built to read.`}
        Beyond that, the biggest movers are goaltending confirmations, home ice, and whether either side is playing a second night in a row or finishing a long trip.</p>
      <section class="related">
        <h2>Explore more</h2>
        <ul>
          <li><a href="${SITE}/nhl-matchups">All NHL matchup pages</a></li>
          <li><a href="${SITE}/nhl-predictions-today">NHL predictions today</a></li>
          <li><a href="${SITE}/">Open the ArakIce app</a></li>
        </ul>
      </section>`;

  return layout({
    title: fit(TITLE_MAX,
      `${a.name} vs ${b.name} Head to Head Record | ArakIce`,
      `${city(a)} vs ${city(b)} Head to Head Record and Totals | ArakIce`,
      `${city(a)} vs ${city(b)} Head to Head Record | ArakIce`),
    desc: fit(DESC_MAX,
      `${a.name} against ${b.name}: the last ${st.n} meetings, ${st.avg.toFixed(2)} goals a game, ${st.homeWins} of ${st.n} won by the home team, with every result listed.`,
      `${city(a)} vs ${city(b)}: the last ${st.n} meetings, ${st.avg.toFixed(2)} goals a game, ${st.homeWins} of ${st.n} won by the home team, every result listed.`),
    canonicalPath: `/matchup/${a.slug}-vs-${b.slug}`,
    jsonld,
    body,
    // Cette page ne parle plus de moneyline, de cotes ni de mise : elle ne sert
    // que des résultats de matchs. L'avertissement de jeu responsable reste sur
    // toutes les pages qui, elles, parlent de pari.
    disclaimer: false,
  });
}

function matchupHubPage(pairs, others = []) {
  const li = (pr) => `          <li><a href="${SITE}/matchup/${pr.a.slug}-vs-${pr.b.slug}">${esc(pr.a.name)} vs ${esc(pr.b.name)}</a></li>`;
  const items = pairs.map(li).join("\n");
  // Les pages d'affiche sont perpétuelles : une paire qui ne joue pas dans la
  // fenêtre du calendrier garde sa page, et le hub doit continuer d'y mener.
  const more = [...others].sort((x, y) => `${x.a.name} ${x.b.name}`.localeCompare(`${y.a.name} ${y.b.name}`)).map(li).join("\n");
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "NHL Head to Head Records",
    url: `${SITE}/nhl-matchups`,
  };
  const body = `    <section class="hero">
      <p class="eyebrow">${pairs.length + others.length} NHL matchups</p>
      <h1>NHL Head to Head Records</h1>
      <p class="lede">NHL matchups with the record between the two clubs over the last five seasons: how the meetings have gone, how many goals they produce, and how much home ice has mattered.</p>
    </section>
${ctaBox("See tonight's full slate", "ArakIce projects a win probability and a total for every game on tonight's schedule.", "Open ArakIce")}
      <section class="related">
        <h2>Upcoming matchups</h2>
        <ul>
${items}
        </ul>
${more ? `        <h2>More head to head records</h2>\n        <ul>\n${more}\n        </ul>\n` : ""}      </section>`;
  return layout({
    title: "NHL Head to Head Records | Every Matchup | ArakIce",
    desc: "Head to head records for NHL matchups: recent meetings, goals per game and how often the home team wins.",
    canonicalPath: "/nhl-matchups",
    jsonld,
    body,
    disclaimer: false,   // ce hub n'ouvre que sur des pages de statistiques
  });
}

// ── Sitemap ──────────────────────────────────────────────────────────────────
async function writeSitemap(dynamicLocs) {
  // Google ignores <changefreq> and <priority> entirely, but it does read
  // <lastmod> — and only trusts it if it is accurate. A generator run is the
  // only thing that rewrites these pages, so the run date is the honest value.
  const lastmod = new Date().toISOString().slice(0, 10);
  const rows = [];
  for (const p of STATIC_PAGES) {
    rows.push(`  <url>\n    <loc>${SITE}${p.loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`);
  }
  for (const loc of dynamicLocs) {
    rows.push(`  <url>\n    <loc>${SITE}${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>`);
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

async function fetchPlayers(teams, allow = new Set()) {
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
      p.season = Number(l.featuredStats?.season || 0);
    } catch { p.stats = {}; p.season = 0; }
  });

  // « Cette saison » seulement. L'API renvoie comme saison vedette la dernière
  // où le joueur a joué : un joueur blessé ou pas encore aligné garde donc ses
  // chiffres de l'an dernier. La saison en cours est la plus récente vue sur
  // l'ensemble des effectifs ; tout joueur dont la saison vedette est plus
  // ancienne n'a pas de page tant qu'il n'a pas MIN_GP matchs cette saison.
  const currentSeason = Math.max(0, ...players.map((p) => p.season || 0));
  // Garde-fou : une panne d'API ressemblerait à « personne n'a assez de
  // matchs » et effacerait toutes les pages joueur. On s'arrête plutôt.
  if (!players.length || !currentSeason) throw new Error("effectifs ou statistiques introuvables via l'API NHL : rien n'est modifié");
  for (const p of players) if (p.season !== currentSeason) p.stats = {};
  console.log(`  saison en cours : ${currentSeason}`);

  // Slug + de-dup. Le filtrage par liste blanche est fait dans main(), pour que
  // le mode --sample (qui ne passe jamais ici) obéisse à la même règle.
  const usedSlugs = new Set();
  const out = [];
  for (const p of players) {
    const gp = Number(p.stats?.gamesPlayed || 0);
    const base = slugify(p.name);
    const listed = allow.has(base) || allow.has(`${base}-${p.id}`);
    if (gp < (listed ? MIN_GP_ALLOWLIST : MIN_GP)) continue;
    let slug = base;
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
  // ⚠️ Chiffres INVENTÉS : ce sont des fixtures hors ligne, pas des statistiques.
  // Les slugs, eux, doivent appartenir à props-allowlist.json, sinon --sample
  // n'écrit plus aucune page joueur et ne teste donc plus playerPage().
  // Un patineur, un ailier et un gardien, pour couvrir les deux branches.
  const players = [
    { id: 8479318, name: "Auston Matthews", pos: "C", team: "TOR", teamName: "Toronto Maple Leafs", slug: "auston-matthews", stats: { gamesPlayed: 70, goals: 40, assists: 30, points: 70, shots: 250 } },
    { id: 8478420, name: "Mikko Rantanen", pos: "R", team: "DAL", teamName: "Dallas Stars", slug: "mikko-rantanen", stats: { gamesPlayed: 70, goals: 30, assists: 50, points: 80, shots: 220 } },
    { id: 8481691, name: "Yaroslav Askarov", pos: "G", team: "SJS", teamName: "San Jose Sharks", slug: "yaroslav-askarov", stats: { gamesPlayed: 40, wins: 18, goalsAgainstAvg: 2.80, savePctg: 0.905, shutouts: 2 } },
  ];
  const pairs = [{ a: teams.CGY, b: teams.EDM }];
  return { teams, players, pairs };
}

// ── Fichiers sur le disque ───────────────────────────────────────────────────
async function listHtml(dir) {
  try {
    return (await fs.readdir(dir))
      .filter((f) => f.endsWith(".html") && f !== "index.html")
      .map((f) => f.slice(0, -5))
      .sort();
  } catch { return []; }
}

async function pruneDir(dir, keep) {
  const removed = [];
  for (const slug of await listHtml(dir)) {
    if (keep.has(slug)) continue;
    await fs.unlink(path.join(dir, `${slug}.html`));
    removed.push(slug);
  }
  return removed;
}

// vercel.json porte deux redirections /props/ :
//   · temporaire (307) : joueur de la liste blanche sans page ce passage. Il
//     reviendra ; une 301 dirait à Google d'oublier l'URL pour de bon.
//   · permanente (301, existante) : tout ce qui n'est pas dans la liste blanche.
// Sans la première, l'URL tomberait sur la réécriture SPA et rendrait l'accueil
// en 200 — une soft 404.
const VERCEL_JSON = path.join(__dirname, "..", "vercel.json");
async function syncPropsRedirects(allow, keep) {
  const cfg = JSON.parse(await fs.readFile(VERCEL_JSON, "utf-8"));
  const isTemp = (r) => r.source?.startsWith("/props/") && r.permanent === false;
  const redirects = (cfg.redirects || []).filter((r) => !isTemp(r));
  const parked = [...allow].filter((sl) => !keep.has(sl)).sort();
  if (parked.length) {
    redirects.unshift({
      source: `/props/:slug(${parked.join("|")})`,
      destination: "/nhl-player-props",
      permanent: false,
    });
  }
  cfg.redirects = redirects;
  await fs.writeFile(VERCEL_JSON, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  console.log(`  vercel.json : ${parked.length} page(s) joueur en redirection temporaire`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`ArakIce SEO generator — ${SAMPLE ? "SAMPLE (offline)" : "LIVE (NHL API)"} → ${OUT_DIR}`);
  let teams, players, pairs;

  const allow = await loadPropsAllowlist();

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
    players = await fetchPlayers(teams, allow);
    console.log(`  ${players.length} players before the allowlist`);
  }

  // Un seul endroit décide quelles pages joueur existent, mode --sample compris.
  const beforeAllow = players.length;
  players = players.filter((p) => allow.has(p.slug));
  const missing = [...allow].filter((sl) => !players.some((p) => p.slug === sl));
  console.log(`  ${players.length} player pages after the allowlist (${beforeAllow} candidates, allowlist of ${allow.size})`);
  if (missing.length) {
    // Slug de la liste sans page ce passage : sous MIN_GP cette saison (cas
    // normal en début de saison), ou échangé, retraité, renommé.
    console.warn(`  ⚠️  ${missing.length} joueur(s) de la liste sans page (moins de ${MIN_GP} matchs cette saison, ou introuvable) : ${missing.join(", ")}`);
  }

  const dynamicLocs = [];

  // Player pages + hub
  for (const p of players) {
    await writePage(`props/${p.slug}.html`, playerPage(p));
    dynamicLocs.push(`/props/${p.slug}`);
  }
  await writePage("nhl-player-props.html", propsHubPage(players));
  dynamicLocs.push("/nhl-player-props");

  // Une page joueur qui n'a pas été réécrite ce passage n'a plus lieu d'être :
  // ses chiffres sont ceux d'une autre saison. On la retire du disque et on
  // redirige temporairement son URL vers le hub, pour qu'elle revienne sans
  // perte le jour où le joueur repasse la barre.
  const keep = new Set(players.map((p) => p.slug));
  const removedProps = await pruneDir(path.join(OUT_DIR, "props"), keep);
  if (removedProps.length) console.log(`  ${removedProps.length} page(s) joueur retirée(s) : pas encore ${MIN_GP} matchs cette saison`);
  if (!SAMPLE) await syncPropsRedirects(allow, keep);

  // Matchup pages + hub
  console.log("Loading head to head history…");
  const h2h = await loadH2H();
  console.log(`  ${h2h.size} team pairs with recent meetings`);

  let noHistory = 0;
  const written = [];   // le hub ne doit lister que les pages réellement écrites
  for (const pr of pairs) {
    const games = h2h.get([pr.a.abbr, pr.b.abbr].sort().join("|")) || [];
    if (!games.length) { noHistory++; continue; }   // pas d'invention : pas de page
    await writePage(`matchup/${pr.a.slug}-vs-${pr.b.slug}.html`, matchupPage(pr.a, pr.b, games));
    dynamicLocs.push(`/matchup/${pr.a.slug}-vs-${pr.b.slug}`);
    written.push(pr);
  }
  // Les pages d'affiche écrites lors des passages précédents restent valides
  // (l'historique ne périme pas) : elles restent dans le sitemap et dans le hub.
  const writtenSlugs = new Set(written.map((pr) => `${pr.a.slug}-vs-${pr.b.slug}`));
  const bySlug = Object.fromEntries(Object.values(teams).map((t) => [t.slug, t]));
  const others = [];
  for (const slug of await listHtml(path.join(OUT_DIR, "matchup"))) {
    if (writtenSlugs.has(slug)) continue;
    const [sa, sb] = slug.split("-vs-");
    dynamicLocs.push(`/matchup/${slug}`);
    if (!bySlug[sa] || !bySlug[sb]) continue;
    const pr = { a: bySlug[sa], b: bySlug[sb] };
    // Re-rendue avec le gabarit courant : sans ça, une page hors fenêtre
    // garderait indéfiniment l'ancien titre, l'ancien balisage, etc.
    const games = h2h.get([pr.a.abbr, pr.b.abbr].sort().join("|")) || [];
    if (games.length) await writePage(`matchup/${slug}.html`, matchupPage(pr.a, pr.b, games));
    others.push(pr);
  }
  await writePage("nhl-matchups.html", matchupHubPage(written, others));
  dynamicLocs.push("/nhl-matchups");

  await writeSitemap(dynamicLocs);

  if (noHistory) console.log(`  ⚠️  ${noHistory} pair(s) skipped: no meeting in the last five seasons.`);
  console.log(`Done. Wrote ${players.length} player pages, ${pairs.length - noHistory} matchup pages, 2 hubs, sitemap.xml.`);
}

// `main()` ne s'exécute que si ce fichier est lancé directement. Importé, il
// n'expose que ses fabriques de pages : c'est ce qui permet de régénérer un
// sous-ensemble de pages hors ligne (ou de tester une page) sans déclencher une
// campagne complète d'appels à l'API NHL.
const RUN_DIRECTLY = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (RUN_DIRECTLY) {
  main().catch((e) => { console.error("Generator failed:", e); process.exit(1); });
}

export { layout, matchupPage, playerPage, propsHubPage, matchupHubPage, loadH2H, h2hStats, writeSitemap };
// Réexports pour gameday-gen.mjs : il écrit des pages dans le même habillage et
// doit donc partager exactement ces fonctions, pas des copies qui dérivent.
export { slugify, esc, nhlLogo, getJSON, pMap, SITE, API, H2H_MIN_PCT, COMMON_LINE, fit, TITLE_MAX, DESC_MAX };
