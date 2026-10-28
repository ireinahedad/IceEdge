#!/usr/bin/env node
/**
 * gameday-gen.mjs — une page par match, datée, en français et en anglais.
 *
 * POURQUOI CETTE PAGE N'EST PAS UNE PAGE D'AFFICHE DE PLUS
 * `seo-gen.mjs` produit des pages PERPÉTUELLES (`/matchup/a-vs-b`) : l'historique
 * de la confrontation, vrai toute la saison, réécrit à chaque run. Elles ne
 * peuvent structurellement pas répondre à « Canadiens Bruins ce soir », parce
 * qu'elles ne savent pas quel soir on est. Les pages d'ici sont l'inverse :
 * datées, éphémères dans leur intérêt, mais porteuses du seul contenu que
 * personne ne peut recopier d'avance — repos, back-to-back, fin de voyage,
 * forme du moment, puis le résultat.
 *
 * LE CYCLE DE VIE EST LE CŒUR DU TRUC
 * `route-shells.mjs` refuse déjà d'indexer « toute URL dont le contenu meurt
 * dans la journée ». C'est la bonne objection, et elle est traitée ici : une
 * page de match n'est jamais supprimée, elle CHANGE D'ÉTAT. Le matin, c'est un
 * avant-match. Le lendemain, la même URL sert le résultat, les tirs, les trois
 * étoiles et le sommaire des buts. Rien ne meurt, rien ne 404, et la série des
 * pages passées devient l'historique public du modèle.
 *
 * CE QUI EST PUBLIÉ, CE QUI NE L'EST PAS
 * Tout le factuel est public : fiches, forme, repos, déplacements, confrontation,
 * résultat. La probabilité du modèle ne l'est pas — elle s'ouvre dans
 * l'application. La page doit donc tenir debout SANS elle : si elle n'a rien à
 * dire d'autre que « ouvrez l'app », elle n'est pas écrite (voir `enoughToSay`).
 * C'est la leçon des 417 pages joueur refusées par Search Console.
 *
 * DONNÉES — et pourquoi aucune clé d'API n'est nécessaire
 *   · api-web.nhle.com  : calendrier, classement, calendrier par club, feuille
 *                         de match. Public, sans clé, donc utilisable en CI.
 *   · h2h-compact.json  : historique figé par `scripts/h2h-export.mjs`, suivi
 *                         par git (le CSV de 43 Mo, lui, est gitignoré).
 * Rien d'autre. Pas de cotes : The Odds API a un quota, et une page publique
 * qui affiche une cote périmée est pire qu'une page qui n'en affiche pas.
 *
 * SORTIE
 *   /match/<AAAA-MM-JJ>/<visiteur>-vs-<domicile>      (en)
 *   /fr/match/<AAAA-MM-JJ>/<visiteur>-vs-<domicile>   (fr-CA)
 *   /match           et  /fr/match                    (le programme du jour)
 *   /sitemap-games.xml                                (balayé sur le disque)
 *
 * Les slugs d'équipe sont les MÊMES dans les deux langues, et les mêmes que
 * ceux de `/matchup/` : une seule forme d'URL à maintenir, et les paires
 * hreflang ne peuvent pas se désaligner.
 *
 * Usage:
 *   node scripts/gameday-gen.mjs                 # fenêtre par défaut
 *   node scripts/gameday-gen.mjs --dry           # écrit dans scripts/_sample_out
 *   MATCH_DAYS_BACK=7 MATCH_DAYS_AHEAD=3 node scripts/gameday-gen.mjs
 *   MATCH_PRUNE_DAYS=120 node scripts/gameday-gen.mjs   # supprime au-delà
 *
 * Aucune dépendance — Node 18+ (fetch global, ICU complet pour le français).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { layout, slugify, esc, nhlLogo, getJSON, pMap, SITE, API, fit, TITLE_MAX, DESC_MAX } from "./seo-gen.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes("--dry");
const OUT_DIR = DRY
  ? path.join(__dirname, "_sample_out")
  : path.join(__dirname, "..", "public");

// Fenêtre. En arrière : le temps que les matchs de la veille (et de l'avant-
// veille, si un run a échoué) passent en résultat. En avant : de quoi laisser
// Google découvrir la page avant la mise au jeu, sans publier une semaine de
// pages vides de tout contexte du jour.
const DAYS_BACK = Number(process.env.MATCH_DAYS_BACK || 3);
const DAYS_AHEAD = Number(process.env.MATCH_DAYS_AHEAD || 2);

// 0 = on ne supprime jamais. Les pages passées sont l'historique public du
// modèle et ne coûtent qu'un fichier ; les supprimer fabriquerait des 404 en
// masse dans Search Console. À n'activer que si le dépôt devient ingérable.
const PRUNE_DAYS = Number(process.env.MATCH_PRUNE_DAYS || 0);

// Les matchs préparatoires (gameType 1) sont exclus : alignements de juniors,
// gardiens annoncés nulle part, aucune valeur de recherche. Saison régulière
// (2) et séries (3) seulement.
const GAME_TYPES = new Set([2, 3]);

const H2H_JSON = process.env.H2H_JSON || path.join(__dirname, "h2h-compact.json");

// Base de l'API surchargeable : c'est ce qui permet de rejouer un programme
// complet contre des fixtures locales sans toucher au réseau, donc de tester
// les deux états de la page (avant-match et résultat) hors saison.
const API_BASE = process.env.NHL_API || API;

// ── Noms français des 32 clubs ───────────────────────────────────────────────
// Écrits à la main parce que la règle « surnom + de + ville » se casse sur la
// moitié de la ligue (du Colorado, de la Floride, d'Ottawa, de l'Utah) et
// qu'une contraction fautive dans un <h1> est ce qui fait fermer l'onglet à un
// lecteur québécois. Usage RDS / LNH.com.
const TEAM_FR = {
  ANA: "Ducks d'Anaheim",        BOS: "Bruins de Boston",
  BUF: "Sabres de Buffalo",      CGY: "Flames de Calgary",
  CAR: "Hurricanes de la Caroline", CHI: "Blackhawks de Chicago",
  COL: "Avalanche du Colorado",  CBJ: "Blue Jackets de Columbus",
  DAL: "Stars de Dallas",        DET: "Red Wings de Détroit",
  EDM: "Oilers d'Edmonton",      FLA: "Panthers de la Floride",
  LAK: "Kings de Los Angeles",   MIN: "Wild du Minnesota",
  MTL: "Canadiens de Montréal",  NSH: "Predators de Nashville",
  NJD: "Devils du New Jersey",   NYI: "Islanders de New York",
  NYR: "Rangers de New York",    OTT: "Sénateurs d'Ottawa",
  PHI: "Flyers de Philadelphie", PIT: "Penguins de Pittsburgh",
  SJS: "Sharks de San Jose",     SEA: "Kraken de Seattle",
  STL: "Blues de St. Louis",     TBL: "Lightning de Tampa Bay",
  TOR: "Maple Leafs de Toronto", UTA: "Mammoth de l'Utah",
  VAN: "Canucks de Vancouver",   VGK: "Golden Knights de Vegas",
  WSH: "Capitals de Washington", WPG: "Jets de Winnipeg",
};

// ── Chaînes ──────────────────────────────────────────────────────────────────
const L = {
  en: {
    locale: "en-CA", ogLocale: "en_CA", vs: "vs",
    hubPath: "/match", matchPath: "/match",
    hubTitle: (d) => `NHL Games ${d} | Matchups, Form and Rest | ArakIce`,
    hubH1: (d) => `NHL games, ${d}`,
    hubDesc: (n, d) => `All ${n} NHL games on ${d}: records, last ten, rest days, back-to-backs and the head to head history for each matchup.`,
    hubLede: "Every game on the slate, with the context that is only true today: who is rested, who is on the second night of a back to back, and how the two clubs have gone against each other.",
    hubEmpty: "No NHL games scheduled.",
    preview: "Preview", final: "Final", live: "In progress",
    record: "record", lastTen: "last 10", gfpg: "goals for / game",
    ctxH: "What is true about this game today",
    restRested: (t, n) => `${t} come in on ${n} days of rest.`,
    restB2B: (t) => `${t} are playing their second game in two nights.`,
    restB2Bboth: "Both clubs are playing their second game in two nights.",
    roadTrip: (t, n) => `${t} are ${n} games into a road trip.`,
    homestand: (t, n) => `${t} are ${n} games into a homestand.`,
    h2hH: "The recent history between these two",
    h2hNone: "These clubs have no meeting on record in the last five seasons, so there is no series to read into.",
    h2hIntro: (n, y) => `Their last ${n} meetings, going back to ${y}.`,
    thDate: "Date", thResult: "Result", thHost: "Host", thGoals: "Goals",
    period: (n) => (n === "OT" ? "OT" : `P${n}`),
    modelH: "What the model weighs here",
    modelP: "The projection starts from expected goals, meaning the quality of chances each club creates and gives up, which holds up better than goals scored. It then adjusts for what is only true of this game: who is confirmed in net, rest and travel, whether either club is on the second night of a back to back, and the referee crew where it moves the total.",
    ctaH: "See the projection for this game",
    ctaP: (a, b) => `ArakIce projects a win probability and a total for ${a} against ${b}, and flags where the number sits against the book.`,
    // Un match joué n'a plus de projection à vendre : proposer d'« ouvrir la
    // projection » d'un résultat déjà connu est la promesse la plus facile à
    // prendre pour un appât. La page de résultat renvoie donc vers ce soir.
    ctaFinalH: "Tonight's slate",
    ctaFinalP: "ArakIce projects a win probability and a total for every game on tonight's schedule, and flags where the number sits against the book.",
    hubCtaH: "Every game, with the model's number",
    hubCtaP: "ArakIce projects a win probability and a total for each of these games, and flags the ones where the number sits away from the book.",
    ctaBtn: "Open ArakIce",
    resultH: "How it finished",
    shots: "shots on goal",
    stars: "Three stars",
    goalsH: "Goal summary",
    afterP: (w, l, ws, ls, extra) => `${w} beat ${l} ${ws}-${ls}${extra}.`,
    inOT: " in overtime", inSO: " in a shootout",
    relatedH: "Explore more",
    relAll: "Today's NHL games",
    relMatchup: (a, b) => `${a} vs ${b} head to head record`,
    relApp: "Open the ArakIce app",
    relFr: "Cette page en français",
    other: "Also on this date",
    srcNote: "Schedule, standings and results from the NHL public API. Head to head history from ArakIce's own game database.",
    breadcrumbHome: "Home", breadcrumbGames: "NHL games",
  },
  fr: {
    locale: "fr-CA", ogLocale: "fr_CA", vs: "c.",
    hubPath: "/fr/match", matchPath: "/fr/match",
    hubTitle: (d) => `Matchs de la LNH du ${d} | Fiches et forme | ArakIce`,
    hubH1: (d) => `Les matchs de la LNH du ${d}`,
    hubDesc: (n, d) => `Les ${n} matchs de la LNH du ${d} : fiches, dix derniers, jours de repos, matchs en deux soirs et l'historique de chaque confrontation.`,
    hubLede: "Tout le programme, avec ce qui n'est vrai qu'aujourd'hui : qui arrive reposé, qui dispute un deuxième match en deux soirs, et ce que donne l'historique entre les deux clubs.",
    hubEmpty: "Aucun match de la LNH au programme.",
    preview: "Avant-match", final: "Terminé", live: "En cours",
    record: "fiche", lastTen: "10 derniers", gfpg: "buts marqués / match",
    ctxH: "Ce qui n'est vrai que ce soir",
    restRested: (t, n) => `${t} arrivent avec ${n} jours de repos.`,
    restB2B: (t) => `${t} disputent un deuxième match en deux soirs.`,
    restB2Bboth: "Les deux clubs disputent un deuxième match en deux soirs.",
    roadTrip: (t, n) => `${t} en sont à leur ${n}e match d'un voyage.`,
    homestand: (t, n) => `${t} en sont à leur ${n}e match d'une série à domicile.`,
    h2hH: "L'historique récent entre les deux",
    h2hNone: "Aucune rencontre entre ces deux clubs dans les cinq dernières saisons : il n'y a pas de série à interpréter.",
    h2hIntro: (n, y) => `Leurs ${n} dernières rencontres, depuis ${y}.`,
    thDate: "Date", thResult: "Résultat", thHost: "Hôte", thGoals: "Buts",
    period: (n) => (n === "OT" ? "Prol." : n === "1" ? "1re" : `${n}e`),
    modelH: "Ce que le modèle regarde ici",
    modelP: "La projection part des buts attendus, c'est-à-dire la qualité des chances que chaque club crée et concède, qui tient mieux la route que les buts marqués. Elle ajuste ensuite pour ce qui n'est vrai que de ce match : le gardien confirmé, le repos et les déplacements, un deuxième match en deux soirs, et le trio d'arbitres là où il déplace le total.",
    ctaH: "Voir la projection pour ce match",
    ctaP: (a, b) => `ArakIce projette une probabilité de victoire et un total pour ${a} contre ${b}, et signale où le chiffre se situe par rapport au preneur aux livres.`,
    ctaFinalH: "Le programme de ce soir",
    ctaFinalP: "ArakIce projette une probabilité de victoire et un total pour chaque match au programme ce soir, et signale où le chiffre se situe par rapport au preneur aux livres.",
    hubCtaH: "Chaque match, avec le chiffre du modèle",
    hubCtaP: "ArakIce projette une probabilité de victoire et un total pour chacun de ces matchs, et signale ceux où le chiffre s'éloigne du preneur aux livres.",
    ctaBtn: "Ouvrir ArakIce",
    resultH: "Comment ça s'est terminé",
    shots: "tirs au but",
    stars: "Trois étoiles",
    goalsH: "Sommaire des buts",
    afterP: (w, l, ws, ls, extra) => `${w} l'emportent ${ws}-${ls} contre ${l}${extra}.`,
    inOT: " en prolongation", inSO: " en tirs de barrage",
    relatedH: "Pour aller plus loin",
    relAll: "Les matchs de la LNH du jour",
    relMatchup: (a, b) => `Historique ${a} c. ${b}`,
    relApp: "Ouvrir l'application ArakIce",
    relFr: "This page in English",
    other: "Aussi à l'affiche",
    srcNote: "Calendrier, classement et résultats : API publique de la LNH. Historique des confrontations : base de matchs d'ArakIce.",
    breadcrumbHome: "Accueil", breadcrumbGames: "Matchs de la LNH",
  },
};

// ── Dates ────────────────────────────────────────────────────────────────────
// Tout est daté en heure de l'Est, comme la LNH et comme le reste du produit
// (`scratches.json`, `starting_goalies.json`). Un match de 22 h à Vancouver
// appartient à la date de l'Est, pas à celle du serveur qui génère la page.
function etToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function shiftDate(iso, days) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function windowDates() {
  const t = etToday();
  const out = [];
  for (let i = -DAYS_BACK; i <= DAYS_AHEAD; i++) out.push(shiftDate(t, i));
  return out;
}

function longDate(iso, lang) {
  return new Intl.DateTimeFormat(L[lang].locale, {
    timeZone: "America/Toronto", weekday: "long", day: "numeric", month: "long", year: "numeric",
  }).format(new Date(iso + "T12:00:00Z"));
}

function shortDate(iso, lang) {
  return new Intl.DateTimeFormat(L[lang].locale, {
    timeZone: "America/Toronto", day: "numeric", month: "short", year: "numeric",
  }).format(new Date(iso + "T12:00:00Z"));
}

// Date sans l'année, pour les titres : « Oct 5 » / « 5 oct. ». L'année est
// déjà dans l'URL et dans le h1 ; dans le titre elle coûte 6 caractères.
function dayMonth(iso, lang) {
  return new Intl.DateTimeFormat(L[lang].locale, {
    timeZone: "America/Toronto", day: "numeric", month: "short",
  }).format(new Date(iso + "T12:00:00Z"));
}

function faceoffTime(startTimeUTC, lang) {
  if (!startTimeUTC) return "";
  const t = new Intl.DateTimeFormat(L[lang].locale, {
    timeZone: "America/Toronto", hour: "numeric", minute: "2-digit",
  }).format(new Date(startTimeUTC));
  return lang === "fr" ? `${t} (HE)` : `${t} ET`;
}

// ── Historique figé ──────────────────────────────────────────────────────────
async function loadCompactH2H() {
  try {
    const raw = await fs.readFile(H2H_JSON, "utf-8");
    const pairs = JSON.parse(raw).pairs || {};
    const map = new Map();
    for (const [key, rows] of Object.entries(pairs)) {
      map.set(key, rows.map(([date, home, away, hs, as, ot]) => ({
        date, home, away, hs, as, ot: ot === 1, total: hs + as, homeWin: hs > as,
      })));
    }
    return map;
  } catch {
    // Tolérant, comme `loadH2H()` : les pages sortent sans le bloc historique
    // plutôt que de ne pas sortir du tout. Le garde-fou `enoughToSay()` refusera
    // quand même celles qui n'ont plus rien à dire.
    console.warn(`  ⚠️  ${H2H_JSON} illisible — pages générées sans historique. Lancer « npm run seo:h2h ».`);
    return new Map();
  }
}

// ── Données NHL ──────────────────────────────────────────────────────────────
async function fetchTeams() {
  const data = await getJSON(`${API_BASE}/standings/now`);
  const teams = {};
  for (const s of data.standings || []) {
    const abbr = s.teamAbbrev?.default;
    if (!abbr) continue;
    const common = s.teamCommonName?.default || s.teamName?.default || abbr;
    const gp = s.gamesPlayed || 0;
    teams[abbr] = {
      abbr,
      name: s.teamName?.default || `${s.placeName?.default || ""} ${common}`.trim(),
      nameFr: TEAM_FR[abbr] || s.teamName?.default || abbr,
      common,
      slug: slugify(common),
      division: s.divisionName || "",
      conference: s.conferenceName || "",
      gp,
      wins: s.wins ?? 0, losses: s.losses ?? 0, otl: s.otLosses ?? 0,
      points: s.points ?? 0,
      last10: `${s.l10Wins ?? 0}-${s.l10Losses ?? 0}-${s.l10OtLosses ?? 0}`,
      streak: s.streakCode && s.streakCount ? `${s.streakCode}${s.streakCount}` : "",
      homeRec: `${s.homeWins ?? 0}-${s.homeLosses ?? 0}-${s.homeOtLosses ?? 0}`,
      roadRec: `${s.roadWins ?? 0}-${s.roadLosses ?? 0}-${s.roadOtLosses ?? 0}`,
      gf: s.goalFor ?? 0, ga: s.goalAgainst ?? 0,
      gfpg: gp ? +((s.goalFor ?? 0) / gp).toFixed(2) : null,
      gapg: gp ? +((s.goalAgainst ?? 0) / gp).toFixed(2) : null,
    };
  }
  return teams;
}

/** Tous les matchs de la fenêtre. `/schedule/{date}` rend une semaine entière,
 *  donc deux appels couvrent toujours une fenêtre de six jours. */
async function fetchGames(dates) {
  const want = new Set(dates);
  const seen = new Map();
  let cursor = dates[0];
  for (let guard = 0; guard < 4; guard++) {
    let data;
    try { data = await getJSON(`${API_BASE}/schedule/${cursor}`); } catch { break; }
    for (const day of data.gameWeek || []) {
      if (!want.has(day.date)) continue;
      for (const g of day.games || []) {
        if (!GAME_TYPES.has(Number(g.gameType))) continue;
        if (!g.id || !g.homeTeam?.abbrev || !g.awayTeam?.abbrev) continue;
        seen.set(String(g.id), {
          id: String(g.id),
          date: day.date,
          home: g.homeTeam.abbrev,
          away: g.awayTeam.abbrev,
          startTimeUTC: g.startTimeUTC || null,
          venue: g.venue?.default || "",
          state: String(g.gameState || "FUT"),
          type: Number(g.gameType),
        });
      }
    }
    const next = data.nextStartDate;
    if (!next || next > dates[dates.length - 1]) break;
    cursor = next;
  }
  return [...seen.values()].sort((a, b) =>
    a.date.localeCompare(b.date) || String(a.startTimeUTC).localeCompare(String(b.startTimeUTC)));
}

/** Calendrier complet d'un club : sert à calculer repos, back-to-back et
 *  longueur du voyage. C'est le contenu que personne ne peut pré-écrire. */
async function fetchClubSeason(abbr) {
  try {
    const d = await getJSON(`${API_BASE}/club-schedule-season/${abbr}/now`);
    return (d.games || [])
      .filter((g) => GAME_TYPES.has(Number(g.gameType)))
      .map((g) => ({
        date: g.gameDate,
        home: g.homeTeam?.abbrev === abbr,
        state: String(g.gameState || "FUT"),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch { return []; }
}

function restContext(season, date, abbr) {
  if (!season.length) return null;
  const idx = season.findIndex((g) => g.date === date);
  if (idx < 0) return null;
  const prev = season[idx - 1];
  const cur = season[idx];
  const out = { rest: null, b2b: false, tripLen: 0, atHome: cur.home };
  if (prev) {
    const days = Math.round(
      (Date.parse(date + "T12:00:00Z") - Date.parse(prev.date + "T12:00:00Z")) / 86_400_000);
    out.rest = days;
    out.b2b = days === 1;
  }
  // Longueur de la séquence en cours (voyage ou série à domicile), match du
  // jour compris. Un « 5e match d'un voyage de l'Ouest » explique une ligne de
  // total mieux que n'importe quelle moyenne de saison.
  let n = 1;
  for (let i = idx - 1; i >= 0; i--) {
    if (season[i].home !== cur.home) break;
    n++;
  }
  out.tripLen = n;
  return out;
}

/** Feuille de match, uniquement pour les matchs terminés. */
async function fetchFinal(gameId) {
  let d;
  try { d = await getJSON(`${API_BASE}/gamecenter/${gameId}/landing`); } catch { return null; }
  const state = String(d.gameState || "");
  if (!["FINAL", "OFF", "OVER"].includes(state)) return null;
  const goals = [];
  for (const period of d.summary?.scoring || []) {
    const type = String(period?.periodDescriptor?.periodType || "REG");
    if (type === "SO") continue;
    const num = Number(period?.periodDescriptor?.number || 0);
    for (const g of period.goals || []) {
      const first = g.firstName?.default || "";
      const last = g.lastName?.default || "";
      goals.push({
        period: type === "OT" ? "OT" : String(num),
        time: g.timeInPeriod || "",
        team: g.teamAbbrev?.default || g.teamAbbrev || "",
        who: `${first} ${last}`.trim(),
        strength: String(g.strength || "ev"),
        away: g.awayScore ?? null,
        home: g.homeScore ?? null,
      });
    }
  }
  const stars = (d.summary?.threeStars || []).map((s) => ({
    star: s.star ?? null,
    name: [s.firstName?.default || s.name?.default || "", s.lastName?.default || ""].join(" ").trim(),
    team: s.teamAbbrev || "",
  })).filter((s) => s.name);
  return {
    homeScore: d.homeTeam?.score ?? null,
    awayScore: d.awayTeam?.score ?? null,
    homeSog: d.homeTeam?.sog ?? null,
    awaySog: d.awayTeam?.sog ?? null,
    lastPeriod: String(d.gameOutcome?.lastPeriodType || "REG"),
    goals, stars,
  };
}

// ── Fabrique de page ─────────────────────────────────────────────────────────
const teamName = (t, lang) => (lang === "fr" ? t.nameFr : t.name);
// Dans un tableau, « Maple Leafs de Toronto 6, Canadiens de Montréal 5 » déborde
// sur deux lignes à chaque rangée. Le nom court est le surnom seul : en français
// c'est tout ce qui précède « de / du / d\' », qui est aussi la forme qu'emploie
// un lecteur ("les Leafs l\'emportent").
const shortName = (t, lang) =>
  lang === "fr" ? String(t.nameFr).split(/ (?:de la |du |de l\'|d\'|de )/)[0] : t.common;

// Les pages perpétuelles nomment le fichier depuis les abréviations TRIÉES
// (`[a, b].sort()` dans seo-gen.mjs), pas depuis visiteur-domicile. Reconstruire
// le lien dans l\'ordre du match pointerait une fois sur deux vers une URL qui
// n\'existe pas — et la réécriture SPA de Vercel rendrait un 200 au lieu d\'un
// 404, donc un soft 404 invisible.
const evergreenSlug = (a, b) => {
  const [x, y] = [a, b].sort((m, n) => m.abbr.localeCompare(n.abbr));
  return `${x.slug}-vs-${y.slug}`;
};
const gameSlug = (away, home) => `${away.slug}-vs-${home.slug}`;
const pagePath = (lang, date, slug) => `${L[lang].matchPath}/${date}/${slug}`;

/**
 * Le garde-fou. Une page de match n'existe que si elle porte au moins deux
 * choses vraies de ce match-là : un résultat, un historique, ou du contexte de
 * calendrier. Sans ça c'est un gabarit autour de deux logos — exactement ce que
 * Search Console a refusé 417 fois côté joueurs.
 */
function enoughToSay({ final, series, restA, restB, a, b }) {
  if (final) return true;
  let n = 0;
  if (series && series.length >= 3) n++;
  if ((restA && (restA.b2b || restA.tripLen >= 3 || restA.rest != null)) ||
      (restB && (restB.b2b || restB.tripLen >= 3 || restB.rest != null))) n++;
  if (a.gp >= 5 && b.gp >= 5) n++;
  return n >= 2;
}

function statsRow(lang, a, b) {
  const T = L[lang];
  const cell = (v, lab) => `        <div class="stat"><div class="value">${esc(v)}</div><div class="label">${esc(lab)}</div></div>`;
  const rec = (t) => `${t.wins}-${t.losses}-${t.otl}`;
  const rows = [
    cell(rec(a), `${a.abbr} ${T.record}`),
    cell(rec(b), `${b.abbr} ${T.record}`),
    cell(a.last10, `${a.abbr} ${T.lastTen}`),
    cell(b.last10, `${b.abbr} ${T.lastTen}`),
  ];
  if (a.gfpg != null && b.gfpg != null) {
    rows.push(cell(a.gfpg, `${a.abbr} ${T.gfpg}`), cell(b.gfpg, `${b.abbr} ${T.gfpg}`));
  }
  return `      <div class="stats-row">\n${rows.join("\n")}\n      </div>`;
}

function contextBlock(lang, a, b, ra, rb) {
  const T = L[lang];
  const lines = [];
  const one = (t, r) => {
    if (!r) return;
    const nm = teamName(t, lang);
    // `rest === 1` EST le back-to-back : une seule des deux phrases peut sortir,
    // sinon la page dit deux fois la même chose en deux formulations.
    if (r.b2b) lines.push(T.restB2B(nm));
    else if (r.rest != null && r.rest >= 2) lines.push(T.restRested(nm, r.rest));
    if (r.tripLen >= 3) lines.push(r.atHome ? T.homestand(nm, r.tripLen) : T.roadTrip(nm, r.tripLen));
  };
  if (ra?.b2b && rb?.b2b) {
    lines.push(T.restB2Bboth);
    if (ra.tripLen >= 3) lines.push(ra.atHome ? T.homestand(teamName(a, lang), ra.tripLen) : T.roadTrip(teamName(a, lang), ra.tripLen));
    if (rb.tripLen >= 3) lines.push(rb.atHome ? T.homestand(teamName(b, lang), rb.tripLen) : T.roadTrip(teamName(b, lang), rb.tripLen));
  } else {
    one(a, ra); one(b, rb);
  }
  // Les splits domicile/étranger ne valent que sur un échantillon : sous dix
  // matchs joués, « 1-0-0 à domicile » est du bruit présenté comme un fait.
  if (a.gp >= 10 && b.gp >= 10) {
    lines.push(lang === "fr"
      ? `${teamName(a, lang)} affichent ${a.roadRec} à l'étranger, ${teamName(b, lang)} ${b.homeRec} à domicile.`
      : `${teamName(a, lang)} are ${a.roadRec} on the road, ${teamName(b, lang)} ${b.homeRec} at home.`);
  }
  if (!lines.length) return "";
  return `      <h2>${esc(T.ctxH)}</h2>\n      <p>${lines.map(esc).join(" ")}</p>`;
}

function seriesBlock(lang, a, b, series) {
  const T = L[lang];
  if (!series || !series.length) return `      <h2>${esc(T.h2hH)}</h2>\n      <p>${esc(T.h2hNone)}</p>`;
  const byAbbr = { [a.abbr]: a, [b.abbr]: b };
  const shown = series.slice(-8).reverse();
  const rows = shown.map((g) => {
    const w = g.homeWin ? g.home : g.away, l = g.homeWin ? g.away : g.home;
    const ws = g.homeWin ? g.hs : g.as, ls = g.homeWin ? g.as : g.hs;
    const nm = (ab) => esc(byAbbr[ab] ? shortName(byAbbr[ab], lang) : ab);
    return `          <tr><td>${esc(shortDate(g.date, lang))}</td><td>${nm(w)} ${ws}, ${nm(l)} ${ls}${g.ot ? (lang === "fr" ? " (P)" : " (OT)") : ""}</td><td>${esc(byAbbr[g.home] ? byAbbr[g.home].abbr : g.home)}</td><td class="num">${g.total}</td></tr>`;
  }).join("\n");
  const aWins = series.filter((g) => (g.home === a.abbr) === g.homeWin).length;
  const avg = (series.reduce((s, g) => s + g.total, 0) / series.length).toFixed(2);
  const lead = aWins >= series.length - aWins ? a : b;
  const intro = lang === "fr"
    ? `${T.h2hIntro(series.length, series[0].date.slice(0, 4))} ${esc(teamName(lead, lang))} mènent ${Math.max(aWins, series.length - aWins)} à ${Math.min(aWins, series.length - aWins)}, pour une moyenne de ${avg} buts par match.`
    : `${T.h2hIntro(series.length, series[0].date.slice(0, 4))} ${esc(teamName(lead, lang))} lead ${Math.max(aWins, series.length - aWins)} to ${Math.min(aWins, series.length - aWins)}, at ${avg} goals a game.`;
  return `      <h2>${esc(T.h2hH)}</h2>
      <p>${intro}</p>
      <div class="h2h-wrap">
        <table class="h2h">
          <thead><tr><th>${esc(T.thDate)}</th><th>${esc(T.thResult)}</th><th>${esc(T.thHost)}</th><th class="num">${esc(T.thGoals)}</th></tr></thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </div>`;
}

function resultBlock(lang, a, b, f) {
  const T = L[lang];
  if (!f || f.homeScore == null || f.awayScore == null) return "";
  const homeWon = f.homeScore > f.awayScore;
  const w = homeWon ? b : a, lo = homeWon ? a : b;
  const ws = homeWon ? f.homeScore : f.awayScore;
  const ls = homeWon ? f.awayScore : f.homeScore;
  const extra = f.lastPeriod === "OT" ? T.inOT : f.lastPeriod === "SO" ? T.inSO : "";
  let out = `      <h2>${esc(T.resultH)}</h2>
      <p>${esc(T.afterP(teamName(w, lang), teamName(lo, lang), ws, ls, extra))}</p>
      <div class="stats-row">
        <div class="stat"><div class="value">${f.awayScore}-${f.homeScore}</div><div class="label">${esc(a.abbr)} @ ${esc(b.abbr)}</div></div>`;
  if (f.awaySog != null && f.homeSog != null) {
    out += `
        <div class="stat"><div class="value">${f.awaySog}</div><div class="label">${esc(a.abbr)} ${esc(T.shots)}</div></div>
        <div class="stat"><div class="value">${f.homeSog}</div><div class="label">${esc(b.abbr)} ${esc(T.shots)}</div></div>`;
  }
  out += `\n      </div>`;
  if (f.goals.length) {
    const rows = f.goals.map((g) =>
      `          <tr><td>${esc(T.period(g.period))} ${esc(g.time)}</td><td>${esc(g.who)}</td><td>${esc(g.team)}</td><td class="num">${g.away ?? ""}-${g.home ?? ""}</td></tr>`).join("\n");
    out += `
      <h3>${esc(T.goalsH)}</h3>
      <div class="h2h-wrap">
        <table class="h2h">
          <tbody>
${rows}
          </tbody>
        </table>
      </div>`;
  }
  if (f.stars.length) {
    out += `\n      <p><strong>${esc(T.stars)} :</strong> ${f.stars.map((s) => esc(`${s.star ? s.star + ". " : ""}${s.name}${s.team ? ` (${s.team})` : ""}`)).join(" · ")}</p>`;
  }
  return out;
}

function gamePage({ lang, game, a, b, series, ra, rb, final, sameDay }) {
  const T = L[lang];
  const slug = gameSlug(a, b);
  const canonical = pagePath(lang, game.date, slug);
  const alternates = {
    en: pagePath("en", game.date, slug),
    "fr-ca": pagePath("fr", game.date, slug),
    "x-default": pagePath("en", game.date, slug),
  };
  const an = teamName(a, lang), bn = teamName(b, lang);
  const dLong = longDate(game.date, lang);
  const dShort = shortDate(game.date, lang);
  const isFinal = !!final;
  const state = isFinal ? T.final : ["LIVE", "CRIT"].includes(game.state) ? T.live : T.preview;

  // Titres : surnoms d'équipe (« Flyers vs Lightning ») et date sans l'année,
  // pour tenir sous TITLE_MAX ; la variante courte prend le relais quand deux
  // longs surnoms se rencontrent (Blue Jackets c. Golden Knights).
  const sa = shortName(a, lang), sb = shortName(b, lang);
  const dm = dayMonth(game.date, lang);
  const title = isFinal
    ? (lang === "fr"
        ? fit(TITLE_MAX, `${sa} c. ${sb} : résultat et sommaire, ${dm} | ArakIce`, `${sa} c. ${sb} : résultat, ${dm} | ArakIce`)
        : fit(TITLE_MAX, `${sa} vs ${sb} Final Score & Recap, ${dm} | ArakIce`, `${sa} vs ${sb} Final Score, ${dm} | ArakIce`))
    : (lang === "fr"
        ? fit(TITLE_MAX, `${sa} c. ${sb} : pronostic et avant-match, ${dm} | ArakIce`, `${sa} c. ${sb} : pronostic, ${dm} | ArakIce`)
        : fit(TITLE_MAX, `${sa} vs ${sb} Prediction & Preview, ${dm} | ArakIce`, `${sa} vs ${sb} Prediction, ${dm} | ArakIce`));

  const desc = isFinal
    ? (lang === "fr"
        ? fit(DESC_MAX, `${an} c. ${bn} du ${dShort} : pointage final, tirs au but, sommaire des buts et les trois étoiles.`,
                        `${sa} c. ${sb} du ${dShort} : pointage final, tirs, sommaire des buts et trois étoiles.`)
        : fit(DESC_MAX, `${an} vs ${bn} on ${dShort}: final score, shots on goal, the goal summary and the three stars.`,
                        `${sa} vs ${sb} on ${dShort}: final score, shots, goal summary and three stars.`))
    : (lang === "fr"
        ? fit(DESC_MAX, `${an} c. ${bn} le ${dShort} : fiches, dix derniers, repos et historique. Le pronostic d'ArakIce est dans l'application.`,
                        `${sa} c. ${sb} le ${dShort} : fiches, dix derniers, repos et historique. Le pronostic d'ArakIce est dans l'application.`)
        : fit(DESC_MAX, `${an} vs ${bn} on ${dShort}: records, last ten, rest and head to head. The ArakIce model projection is in the app.`,
                        `${sa} vs ${sb} on ${dShort}: records, last ten, rest and head to head. The ArakIce projection is in the app.`));

  const eyebrow = [state, faceoffTime(game.startTimeUTC, lang), game.venue].filter(Boolean).join(" · ");

  // Schema : la page (WebPage) parle d'un match (SportsEvent) et se range dans le
  // site (WebSite déclaré dans index.html). Les @id relient les trois nœuds pour
  // que Google lise une seule entité par match, pas trois blocs isolés.
  const pageUrl = SITE + canonical;
  const startDate = game.startTimeUTC || `${game.date}T23:00:00Z`;
  // Un match de LNH dure ~2 h 30 ; endDate est « recommandé » par Google pour un
  // Event. Prolongation et tirs au but compris, 3 h reste une borne honnête.
  const endDate = new Date(Date.parse(startDate) + 3 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const team = (t, name) => ({
    "@type": "SportsTeam",
    name,
    sport: "Ice hockey",
    logo: nhlLogo(t.abbr),
    memberOf: { "@type": "SportsOrganization", name: "National Hockey League" },
  });

  const jsonld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": `${pageUrl}#webpage`,
        url: pageUrl,
        name: title,
        description: desc,
        inLanguage: T.locale,
        isPartOf: { "@type": "WebSite", "@id": `${SITE}/#website`, name: "ArakIce", url: `${SITE}/` },
        about: { "@id": `${pageUrl}#event` },
        breadcrumb: { "@id": `${pageUrl}#breadcrumb` },
        primaryImageOfPage: { "@type": "ImageObject", url: `${SITE}/arakice-og.png`, width: 1200, height: 630 },
        dateModified: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      },
      {
        "@type": "SportsEvent",
        "@id": `${pageUrl}#event`,
        name: `${an} ${T.vs} ${bn}`,
        description: desc,
        sport: "Ice hockey",
        image: `${SITE}/arakice-og.png`,
        startDate,
        endDate,
        // `eventStatus` n'a pas de valeur « terminé » chez schema.org : la
        // mettre à EventScheduled sur un match joué serait faux, et un statut
        // inventé fait rejeter tout le bloc. On l'omet une fois le match fini.
        eventStatus: isFinal ? undefined : "https://schema.org/EventScheduled",
        eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
        url: pageUrl,
        inLanguage: T.locale,
        location: game.venue ? { "@type": "Place", name: game.venue } : undefined,
        homeTeam: team(b, bn),
        awayTeam: team(a, an),
        organizer: { "@type": "SportsOrganization", name: "National Hockey League" },
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${pageUrl}#breadcrumb`,
        itemListElement: [
          { "@type": "ListItem", position: 1, name: T.breadcrumbHome, item: `${SITE}/` },
          { "@type": "ListItem", position: 2, name: T.breadcrumbGames, item: SITE + T.hubPath },
          { "@type": "ListItem", position: 3, name: `${an} ${T.vs} ${bn}`, item: pageUrl },
        ],
      },
    ],
  };

  const others = sameDay
    .filter((g) => g.id !== game.id)
    .slice(0, 8)
    .map((g) => `          <li><a href="${SITE}${pagePath(lang, g.date, g.slug)}">${esc(g.awayName)} ${esc(T.vs)} ${esc(g.homeName)}</a></li>`)
    .join("\n");

  const body = `    <section class="hero">
      <p class="eyebrow">${esc(eyebrow)}</p>
      <h1>${esc(an)} ${esc(T.vs)} ${esc(bn)} — ${esc(dLong)}</h1>
      <div class="matchup-teams">
        <div class="team"><img src="${nhlLogo(a.abbr)}" alt="${esc(an)}" width="72" height="72" /><div class="abbr">${esc(a.abbr)}</div></div>
        <div class="vs">${esc(isFinal && final.awayScore != null ? `${final.awayScore} – ${final.homeScore}` : T.vs)}</div>
        <div class="team"><img src="${nhlLogo(b.abbr)}" alt="${esc(bn)}" width="72" height="72" /><div class="abbr">${esc(b.abbr)}</div></div>
      </div>
    </section>
${statsRow(lang, a, b)}
${isFinal ? resultBlock(lang, a, b, final) : contextBlock(lang, a, b, ra, rb)}
${seriesBlock(lang, a, b, series)}
    <div class="cta-box">
      <p class="cta-title">${esc(isFinal ? T.ctaFinalH : T.ctaH)}</p>
      <p>${esc(isFinal ? T.ctaFinalP : T.ctaP(an, bn))}</p>
      <a class="btn" href="${SITE}/">${esc(T.ctaBtn)}</a>
    </div>
      <h2>${esc(T.modelH)}</h2>
      <p>${esc(T.modelP)}</p>
      <p class="src">${esc(T.srcNote)}</p>
      <section class="related">
        <h2>${esc(T.relatedH)}</h2>
        <ul>
          <li><a href="${SITE}${T.hubPath}">${esc(T.relAll)}</a></li>
          <li><a href="${SITE}/matchup/${esc(evergreenSlug(a, b))}">${esc(T.relMatchup(shortName(a, lang), shortName(b, lang)))}</a></li>
          <li><a href="${SITE}${pagePath(lang === "fr" ? "en" : "fr", game.date, slug)}" hreflang="${lang === "fr" ? "en" : "fr-CA"}">${esc(T.relFr)}</a></li>
          <li><a href="${SITE}/">${esc(T.relApp)}</a></li>
        </ul>
${others ? `        <h3>${esc(T.other)}</h3>\n        <ul>\n${others}\n        </ul>\n` : ""}      </section>`;

  return layout({
    title, desc, canonicalPath: canonical, jsonld, body,
    lang, alternates, ogLocale: T.ogLocale,
  });
}

// `dated` : la variante datée `/match/<AAAA-MM-JJ>` — l'adresse que les posts
// sociaux (server/src/services/content/parlayPosts.ts) partagent. Sans elle,
// le lien d'un post tombait sur la 404 de l'app. Contrairement au hub du jour,
// elle ne change jamais de programme : le lien d'hier reste juste demain.
function hubPage({ lang, date, games, dated = false }) {
  const T = L[lang];
  const dLong = longDate(date, lang);
  const dShort = shortDate(date, lang);
  const sfx = dated ? `/${date}` : "";
  const canonical = T.hubPath + sfx;
  const alternates = { en: L.en.hubPath + sfx, "fr-ca": L.fr.hubPath + sfx, "x-default": L.en.hubPath + sfx };
  const items = games.map((g) =>
    `          <li><a href="${SITE}${pagePath(lang, g.date, g.slug)}">${esc(g.awayName)} ${esc(T.vs)} ${esc(g.homeName)}</a>${g.time ? ` — ${esc(g.time)}` : ""}</li>`).join("\n");
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: T.hubH1(dLong),
    url: SITE + canonical,
    inLanguage: T.locale,
  };
  const body = `    <section class="hero">
      <p class="eyebrow">${esc(dLong)}</p>
      <h1>${esc(T.hubH1(dLong))}</h1>
      <p class="lede">${esc(T.hubLede)}</p>
    </section>
      <section class="related">
        <h2>${esc(T.breadcrumbGames)}</h2>
${games.length ? `        <ul>\n${items}\n        </ul>` : `        <p>${esc(T.hubEmpty)}</p>`}
      </section>
    <div class="cta-box">
      <p class="cta-title">${esc(T.hubCtaH)}</p>
      <p>${esc(T.hubCtaP)}</p>
      <a class="btn" href="${SITE}/">${esc(T.ctaBtn)}</a>
    </div>
      <section class="related">
        <ul>
          <li><a href="${SITE}${(lang === "fr" ? L.en.hubPath : L.fr.hubPath) + sfx}" hreflang="${lang === "fr" ? "en" : "fr-CA"}">${esc(T.relFr)}</a></li>
          <li><a href="${SITE}/nhl-matchups">${esc(lang === "fr" ? "Toutes les confrontations" : "All NHL matchup pages")}</a></li>
          <li><a href="${SITE}/">${esc(T.relApp)}</a></li>
        </ul>
      </section>`;
  return layout({
    title: T.hubTitle(dShort),
    desc: T.hubDesc(games.length, dShort),
    canonicalPath: canonical, jsonld, body,
    lang, alternates, ogLocale: T.ogLocale,
  });
}

// ── Sitemap des pages de match ───────────────────────────────────────────────
// Balayé SUR LE DISQUE et non construit depuis le run : les pages écrites les
// jours précédents doivent rester dans le sitemap alors que ce run ne les
// régénère pas. Un sitemap qui ne liste que la fenêtre du jour désindexerait
// tout l'historique à chaque passage.
async function writeGamesSitemap(outDir) {
  const locs = [];
  const walk = async (dir, prefix) => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(dir, e.name), `${prefix}/${e.name}`);
      else if (e.name.endsWith(".html")) {
        const st = await fs.stat(path.join(dir, e.name));
        const loc = e.name === "index.html" ? prefix : `${prefix}/${e.name.slice(0, -5)}`;
        locs.push({ loc, lastmod: st.mtime.toISOString().slice(0, 10) });
      }
    }
  };
  await walk(path.join(outDir, "match"), "/match");
  await walk(path.join(outDir, "fr", "match"), "/fr/match");
  locs.sort((x, y) => x.loc.localeCompare(y.loc));
  const rows = locs.map((u) =>
    `  <url>\n    <loc>${SITE}${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n  </url>`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows}\n</urlset>\n`;
  await fs.writeFile(path.join(outDir, "sitemap-games.xml"), xml, "utf-8");
  return locs.length;
}

async function prune(outDir, cutoff) {
  let removed = 0;
  for (const base of [path.join(outDir, "match"), path.join(outDir, "fr", "match")]) {
    let dirs;
    try { dirs = await fs.readdir(base, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(d.name)) continue;
      if (d.name >= cutoff) continue;
      await fs.rm(path.join(base, d.name), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const dates = windowDates();
  console.log(`ArakIce gameday — ${dates[0]} → ${dates[dates.length - 1]} (ET) → ${OUT_DIR}`);

  const [teams, h2h] = await Promise.all([fetchTeams(), loadCompactH2H()]);
  console.log(`  ${Object.keys(teams).length} équipes, ${h2h.size} paires d'historique`);

  const games = await fetchGames(dates);
  console.log(`  ${games.length} matchs dans la fenêtre`);
  if (!games.length) {
    // Hors saison : on réécrit quand même les deux hubs (sinon ils annoncent
    // éternellement le programme du dernier jour de la saison) et on laisse le
    // sitemap intact.
    const today = etToday();
    for (const lang of ["en", "fr"]) {
      const rel = lang === "fr" ? path.join("fr", "match", "index.html") : path.join("match", "index.html");
      await write(path.join(OUT_DIR, rel), hubPage({ lang, date: today, games: [] }));
    }
    await writeGamesSitemap(OUT_DIR);
    console.log("  Aucun match : hubs mis à jour, rien d'autre touché.");
    return;
  }

  // Calendriers de club : un appel par équipe qui joue, pas par match.
  const abbrs = [...new Set(games.flatMap((g) => [g.home, g.away]))];
  const seasons = new Map();
  await pMap(abbrs, async (ab) => { seasons.set(ab, await fetchClubSeason(ab)); }, 6);

  // Feuilles de match, seulement pour ce qui est censé être terminé.
  const finals = new Map();
  const done = games.filter((g) => ["FINAL", "OFF", "OVER"].includes(g.state));
  await pMap(done, async (g) => { const f = await fetchFinal(g.id); if (f) finals.set(g.id, f); }, 4);
  console.log(`  ${finals.size} match(s) avec résultat`);

  // Index par date, pour les liens « aussi à l'affiche » et les hubs.
  const byDate = new Map();
  for (const g of games) {
    const a = teams[g.away], b = teams[g.home];
    if (!a || !b) continue;
    if (!byDate.has(g.date)) byDate.set(g.date, []);
    byDate.get(g.date).push({
      id: g.id, date: g.date, slug: gameSlug(a, b),
      homeName: b.name, awayName: a.name,
      homeNameFr: b.nameFr, awayNameFr: a.nameFr,
      startTimeUTC: g.startTimeUTC,
    });
  }

  let written = 0, skipped = 0;
  for (const g of games) {
    const a = teams[g.away], b = teams[g.home];
    if (!a || !b) { skipped++; continue; }
    const series = h2h.get([a.abbr, b.abbr].sort().join("|")) || [];
    const ra = restContext(seasons.get(a.abbr) || [], g.date, a.abbr);
    const rb = restContext(seasons.get(b.abbr) || [], g.date, b.abbr);
    const final = finals.get(g.id) || null;
    if (!enoughToSay({ final, series, restA: ra, restB: rb, a, b })) { skipped++; continue; }

    for (const lang of ["en", "fr"]) {
      const sameDay = (byDate.get(g.date) || []).map((x) => ({
        ...x,
        homeName: lang === "fr" ? x.homeNameFr : x.homeName,
        awayName: lang === "fr" ? x.awayNameFr : x.awayName,
      }));
      const html = gamePage({ lang, game: g, a, b, series, ra, rb, final, sameDay });
      const rel = lang === "fr"
        ? path.join("fr", "match", g.date, `${gameSlug(a, b)}.html`)
        : path.join("match", g.date, `${gameSlug(a, b)}.html`);
      await write(path.join(OUT_DIR, rel), html);
      written++;
    }
  }

  // Hubs datés : un par journée de la fenêtre, à `/match/<date>`.
  for (const [date, day] of byDate) {
    for (const lang of ["en", "fr"]) {
      const list = day.map((x) => ({
        ...x,
        homeName: lang === "fr" ? x.homeNameFr : x.homeName,
        awayName: lang === "fr" ? x.awayNameFr : x.awayName,
        time: faceoffTime(x.startTimeUTC, lang),
      }));
      const rel = lang === "fr" ? path.join("fr", "match", date, "index.html") : path.join("match", date, "index.html");
      await write(path.join(OUT_DIR, rel), hubPage({ lang, date, games: list, dated: true }));
    }
  }

  // Hubs : le programme du jour, pas celui de la fenêtre.
  const today = etToday();
  for (const lang of ["en", "fr"]) {
    const list = (byDate.get(today) || []).map((x) => ({
      ...x,
      homeName: lang === "fr" ? x.homeNameFr : x.homeName,
      awayName: lang === "fr" ? x.awayNameFr : x.awayName,
      time: faceoffTime(x.startTimeUTC, lang),
    }));
    const rel = lang === "fr" ? path.join("fr", "match", "index.html") : path.join("match", "index.html");
    await write(path.join(OUT_DIR, rel), hubPage({ lang, date: today, games: list }));
  }

  if (PRUNE_DAYS > 0) {
    const removed = await prune(OUT_DIR, shiftDate(today, -PRUNE_DAYS));
    if (removed) console.log(`  ${removed} journée(s) supprimée(s) au-delà de ${PRUNE_DAYS} jours`);
  }

  const n = await writeGamesSitemap(OUT_DIR);
  console.log(`Terminé. ${written} page(s) écrite(s), ${skipped} match(s) sans assez de matière, ${n} URL dans sitemap-games.xml.`);
}

async function write(full, html) {
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, html, "utf-8");
}

main().catch((e) => { console.error("gameday-gen a échoué :", e); process.exit(1); });
