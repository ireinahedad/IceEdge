/**
 * newsFeed.ts — la partie PURE du fil de nouvelles (NEWS_CONSENSUS_PLAN.md, F1).
 *
 * Tout ce qui se teste sans réseau ni base vit ici : la cadence du job, la
 * lecture d'une réponse Bluesky, la détection des équipes et des mots-clés.
 * `newsSync.service.ts` ne fait que les appels.
 *
 * ── Cadence (décision du user, 2026-10-23) ──────────────────────────────────
 * Toutes les heures. Toutes les 15 min à partir d'une heure avant le PREMIER
 * match du jour, jusqu'à la DERNIÈRE mise au jeu. Au-delà, retour à l'heure :
 * une nouvelle publiée pendant un match ne change plus rien au pari.
 */

import { NAME_TO_ABBR } from './oddsTeamNames';

export const HOUR_MS    = 60 * 60_000;
export const QUARTER_MS = 15 * 60_000;
const MIN_DELAY_MS      = 60_000;

/** Fenêtre « soirée de match » : [1re mise au jeu − 1 h, dernière mise au jeu]. */
export function gameWindow(startsUtc: number[]): { from: number; to: number } | null {
  const valid = startsUtc.filter((t) => Number.isFinite(t));
  if (valid.length === 0) return null;
  return { from: Math.min(...valid) - HOUR_MS, to: Math.max(...valid) };
}

export function inGameWindow(now: number, startsUtc: number[]): boolean {
  const w = gameWindow(startsUtc);
  return !!w && now >= w.from && now < w.to;
}

/**
 * Délai avant le prochain tour.
 *   • dans la fenêtre → 15 min ;
 *   • avant la fenêtre → 1 h, ou moins pour tomber pile à son ouverture ;
 *   • sinon → 1 h.
 */
export function nextDelayMs(now: number, startsUtc: number[]): number {
  const w = gameWindow(startsUtc);
  if (!w) return HOUR_MS;
  if (now >= w.from && now < w.to) return QUARTER_MS;
  if (now < w.from) return Math.max(MIN_DELAY_MS, Math.min(HOUR_MS, w.from - now));
  return HOUR_MS;
}

// ── Lecture d'une réponse Bluesky ──────────────────────────────────────────

export interface FeedPost {
  externalId: string;   // at://… (URI du post)
  url: string;          // https://bsky.app/profile/<handle>/post/<rkey>
  author: string;       // nom affiché, sinon le handle
  text: string;
  postedAt: Date;
}

/**
 * `app.bsky.feed.getAuthorFeed` → posts ORIGINAUX de l'auteur.
 * Les reposts (`reason`) sont écartés : la source à afficher serait l'auteur
 * repartagé, pas le compte suivi. Une entrée malformée est ignorée, pas fatale.
 */
export function parseAuthorFeed(json: unknown): FeedPost[] {
  const feed = (json as any)?.feed;
  if (!Array.isArray(feed)) return [];
  const out: FeedPost[] = [];
  for (const item of feed) {
    if (item?.reason) continue;
    const p = item?.post;
    const uri: unknown = p?.uri;
    const handle: unknown = p?.author?.handle;
    const text: unknown = p?.record?.text;
    const created = new Date(p?.record?.createdAt ?? p?.indexedAt ?? NaN);
    if (typeof uri !== 'string' || typeof handle !== 'string' || typeof text !== 'string') continue;
    if (Number.isNaN(created.getTime())) continue;
    const rkey = uri.split('/').pop();
    if (!rkey) continue;
    out.push({
      externalId: uri,
      url: `https://bsky.app/profile/${handle}/post/${rkey}`,
      author: (typeof p.author.displayName === 'string' && p.author.displayName.trim()) || handle,
      text,
      postedAt: created,
    });
  }
  return out;
}

// ── Équipes citées ─────────────────────────────────────────────────────────

/**
 * Surnoms et villes → abréviation. Les villes ambiguës (New York, Los Angeles
 * n'en est pas une, mais « New York » oui) ne sont PAS dans la table : mieux
 * vaut une nouvelle de ligue sans équipe qu'une nouvelle collée au mauvais club.
 */
const NICKNAMES: Record<string, string> = {
  ducks: 'ANA', bruins: 'BOS', sabres: 'BUF', flames: 'CGY', hurricanes: 'CAR', canes: 'CAR',
  blackhawks: 'CHI', avalanche: 'COL', avs: 'COL', 'blue jackets': 'CBJ', stars: 'DAL',
  'red wings': 'DET', oilers: 'EDM', panthers: 'FLA', kings: 'LAK', wild: 'MIN',
  canadiens: 'MTL', habs: 'MTL', predators: 'NSH', preds: 'NSH', devils: 'NJD',
  islanders: 'NYI', isles: 'NYI', rangers: 'NYR', senators: 'OTT', sens: 'OTT',
  flyers: 'PHI', penguins: 'PIT', pens: 'PIT', sharks: 'SJS', kraken: 'SEA', blues: 'STL',
  lightning: 'TBL', bolts: 'TBL', 'maple leafs': 'TOR', leafs: 'TOR', canucks: 'VAN',
  'golden knights': 'VGK', capitals: 'WSH', caps: 'WSH', jets: 'WPG', mammoth: 'UTA',
  anaheim: 'ANA', boston: 'BOS', buffalo: 'BUF', calgary: 'CGY', carolina: 'CAR',
  chicago: 'CHI', colorado: 'COL', columbus: 'CBJ', dallas: 'DAL', detroit: 'DET',
  edmonton: 'EDM', florida: 'FLA', minnesota: 'MIN', montreal: 'MTL', 'montréal': 'MTL',
  nashville: 'NSH', ottawa: 'OTT', philadelphia: 'PHI', pittsburgh: 'PIT', 'san jose': 'SJS',
  seattle: 'SEA', 'st. louis': 'STL', 'st louis': 'STL', 'tampa bay': 'TBL', toronto: 'TOR',
  vancouver: 'VAN', vegas: 'VGK', washington: 'WSH', winnipeg: 'WPG', utah: 'UTA',
};

/** Hashtags d'équipe usuels (#LetsGoPens, #GoAvsGo…) : on garde l'abréviation nue. */
const ABBRS = new Set(Object.values(NAME_TO_ABBR));

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** « st. louis blues » → « St. Louis Blues ». */
const titleCase = (s: string) => s.replace(/(^|[\s.])(\p{L})/gu, (_m, sep: string, c: string) => sep + c.toUpperCase());
/**
 * SENSIBLE À LA CASSE, volontairement : « wild », « stars », « blues »,
 * « kings », « jets » sont aussi des mots courants. Seule la forme avec
 * majuscule (« the Wild », « Blues ») compte comme une équipe.
 */
const NAME_RE = new RegExp(
  `(?<![\\p{L}])(${[...Object.keys(NAME_TO_ABBR), ...Object.keys(NICKNAMES)]
    .map(titleCase).sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?![\\p{L}])`,
  'gu',
);
const ABBR_RE = /(?:^|[^A-Za-z#])#?([A-Z]{3})(?![A-Za-z])/g;

/** Équipes citées dans un texte, sans doublon, dans l'ordre d'apparition. */
export function teamsInText(text: string): string[] {
  const found: string[] = [];
  const add = (a: string | undefined) => { if (a && !found.includes(a)) found.push(a); };
  for (const m of text.matchAll(NAME_RE)) {
    const k = m[1].toLowerCase();
    add(NAME_TO_ABBR[k] ?? NICKNAMES[k]);
  }
  for (const m of text.matchAll(ABBR_RE)) if (ABBRS.has(m[1])) add(m[1]);
  return found;
}

// ── Drapeaux ───────────────────────────────────────────────────────────────

export type NewsFlag = 'goalie' | 'lineup' | 'transaction';

const FLAG_RES: Record<NewsFlag, RegExp> = {
  goalie: /\b(starts? in (goal|net)|in goal (tonight|vs|against)|will start (in goal|tonight)|gets the (start|nod)|starting goalie|starter tonight|between the pipes)\b/i,
  lineup: /\b(will not play|won'?t play|ruled out|is out|out (tonight|for|indefinitely)|scratch(ed)?|day[- ]to[- ]day|week[- ]to[- ]week|game[- ]time decision|(placed|put) on (the )?(ltir|ir|injured reserve)|returns? (to|tonight)|will return|back in the lineup|activated|unavailable|lower[- ]body|upper[- ]body)\b/i,
  transaction: /\b(trade[ds]?|acquire[ds]?|signs?|signed|(placed )?on waivers|claimed|recall(ed|s)?|assigned|loaned|agreed to terms|extension)\b/i,
};

export function flagsOf(text: string): NewsFlag[] {
  return (Object.keys(FLAG_RES) as NewsFlag[]).filter((f) => FLAG_RES[f].test(text));
}

/** Extrait stocké : une ligne, ≤ 200 caractères (contrainte de la table). */
export function excerptOf(text: string, max = 200): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Équipes à rattacher : celle de la source si elle en a une (plus les autres
 * citées, pour un échange), sinon celles trouvées dans le texte.
 */
export function teamsForPost(sourceTeam: string | null, text: string): string[] {
  const cited = teamsInText(text);
  if (!sourceTeam) return cited;
  return [sourceTeam, ...cited.filter((t) => t !== sourceTeam)];
}

/** Lien collé à la main : seuls ces hôtes sont acceptés. */
const MANUAL_HOSTS = new Set(['x.com', 'twitter.com', 'bsky.app', 'www.nhl.com', 'nhl.com']);

export function normalizeManualUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^mobile\./, '');
  if (!MANUAL_HOSTS.has(host)) return null;
  // Les paramètres de suivi (?s=20, ?t=…) ne font pas partie de l'identité du post.
  return `https://${host === 'twitter.com' ? 'x.com' : host}${u.pathname.replace(/\/+$/, '')}`;
}

export function authorFromManualUrl(url: string): string {
  const m = /^https:\/\/(?:x\.com|bsky\.app\/profile)\/([^/]+)/.exec(url);
  return m ? `@${m[1]}` : new URL(url).hostname;
}
