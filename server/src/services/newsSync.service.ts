/**
 * newsSync.service.ts — fil de nouvelles (NEWS_CONSENSUS_PLAN.md, F1).
 *
 * Lit les comptes Bluesky de `data/newsSources.ts` (API publique, sans clé),
 * range les publications récentes dans `news_items`, et prévient les admins
 * quand une nouvelle parle d'un absent ou d'un gardien pour un match du jour.
 *
 * ── Coût (Neon facturé au compute) ──────────────────────────────────────────
 * • Cadence : 1 h, et 15 min seulement dans la fenêtre des matchs (`newsFeed.ts`).
 * • Dans la fenêtre, seules les sources des équipes qui jouent (+ ligue) sont lues.
 * • Un tour sans publication nouvelle ne fait que le verrou + 1 INSERT vide.
 * • La lecture publique (`listNews`) passe par un cache mémoire de 2 min.
 * • Opt-in : `NEWS_SYNC_ENABLED=true`, et rien en mode DORMANT (server.ts).
 *
 * Le calendrier est un `setTimeout` réarmé à chaque tour, et non un
 * `setInterval` : la cadence change selon l'heure.
 */

import { pool } from '../db/connection';
import { logger } from '../logger';
import { withJobLock } from './jobLock';
import { mapLimit } from './concurrency';
import { TtlCache } from './ttlCache';
import { fetchGamesByDate } from './nhlApiClient';
import { sendToUsers, pushEnabled } from './push.service';
import { NEWS_SOURCES, type NewsSource } from '../data/newsSources';
import {
  parseAuthorFeed, teamsForPost, flagsOf, excerptOf, nextDelayMs, inGameWindow,
  type FeedPost, type NewsFlag,
} from './newsFeed';

const BSKY_FEED = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed';
const USER_AGENT = 'IceEdge/1.0 (+https://arakice.com)';
const FETCH_TIMEOUT_MS = 10_000;
const CONCURRENCY = 4;
/** On ne garde que les publications de moins de 36 h : au-delà, ce n'est plus « avant le match ». */
const MAX_AGE_MS = 36 * 60 * 60_000;
const RETENTION_DAYS = 14;
const LOCK_TTL_MS = 5 * 60_000;

const todayET = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// ── Lecture des sources ────────────────────────────────────────────────────

export async function fetchAuthorFeed(handle: string): Promise<FeedPost[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${BSKY_FEED}?actor=${encodeURIComponent(handle)}&limit=20&filter=posts_no_replies`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`Bluesky ${res.status} pour ${handle}`);
    return parseAuthorFeed(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

interface TodayGames { teams: Set<string>; startsUtc: number[]; }

async function todaysGames(): Promise<TodayGames> {
  try {
    const games = await fetchGamesByDate(todayET());
    const teams = new Set<string>();
    const startsUtc: number[] = [];
    for (const g of games) {
      const home = g.homeTeam?.abbreviation;
      const away = g.awayTeam?.abbreviation;
      if (home) teams.add(String(home));
      if (away) teams.add(String(away));
      const t = Date.parse(g.startTimeUTC ?? '');
      if (Number.isFinite(t)) startsUtc.push(t);
    }
    return { teams, startsUtc };
  } catch (err: any) {
    // Sans calendrier : cadence d'une heure, toutes les sources. Pas d'arrêt.
    logger.warn({ err: err?.message }, '[NewsSync] calendrier LNH indisponible');
    return { teams: new Set(), startsUtc: [] };
  }
}

/** Dans la fenêtre des matchs : sources de ligue + équipes qui jouent. Sinon : toutes. */
export function sourcesFor(all: NewsSource[], windowOpen: boolean, playing: Set<string>): NewsSource[] {
  if (!windowOpen) return all;
  return all.filter((s) => s.team === null || playing.has(s.team));
}

// ── Écriture ───────────────────────────────────────────────────────────────

interface NewRow { id: number; team_abbrs: string[]; flags: NewsFlag[]; author: string; excerpt: string; url: string; }

async function insertPosts(rows: Array<{ post: FeedPost; teams: string[]; flags: NewsFlag[] }>): Promise<NewRow[]> {
  if (rows.length === 0) return [];
  // Un seul INSERT pour tout le tour ; ON CONFLICT DO NOTHING + RETURNING
  // renvoie exactement les publications NOUVELLES — c'est l'anti-doublon de l'alerte.
  const values: string[] = [];
  const params: unknown[] = [];
  rows.forEach(({ post, teams, flags }, i) => {
    const b = i * 7;
    values.push(`('bluesky', $${b + 1}, $${b + 2}::text[], $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}::text[], $${b + 7})`);
    params.push(post.externalId, teams, post.author, post.url, excerptOf(post.text), flags, post.postedAt.toISOString());
  });
  const { rows: inserted } = await pool.query(
    `INSERT INTO news_items (source, external_id, team_abbrs, author, url, excerpt, flags, posted_at)
     VALUES ${values.join(', ')}
     ON CONFLICT (source, external_id) DO NOTHING
     RETURNING id, team_abbrs, flags, author, excerpt, url`,
    params,
  );
  return inserted;
}

let lastPurgeDay = '';
async function purgeOnceADay(): Promise<void> {
  const day = todayET();
  if (day === lastPurgeDay) return;
  lastPurgeDay = day;
  await pool.query(`DELETE FROM news_items WHERE posted_at < NOW() - ($1 || ' days')::interval`, [String(RETENTION_DAYS)]);
}

// ── Alerte admin ───────────────────────────────────────────────────────────

/** Ne mérite une alerte que ce qui touche un match d'AUJOURD'HUI et l'alignement. */
export function alertWorthy(row: { team_abbrs: string[]; flags: string[] }, playing: Set<string>): boolean {
  const relevant = row.flags.includes('goalie') || row.flags.includes('lineup');
  return relevant && row.team_abbrs.some((t) => playing.has(t));
}

async function notifyAdmins(rows: NewRow[]): Promise<void> {
  if (rows.length === 0 || !pushEnabled()) return;
  const { rows: admins } = await pool.query(`SELECT id FROM users WHERE role = 'admin'`);
  if (admins.length === 0) return;
  const first = rows[0];
  const more = rows.length > 1 ? ` (+${rows.length - 1})` : '';
  await sendToUsers(admins.map((a: any) => a.id), {
    title: `${first.team_abbrs.join('/')} · ${first.flags.includes('goalie') ? 'Gardien' : 'Alignement'}${more}`,
    body: `${first.author} : ${first.excerpt}`,
    url: '/dev/saisie',
  });
}

// ── Un tour ────────────────────────────────────────────────────────────────

export async function runNewsSync(): Promise<{ read: number; inserted: number; alerted: number; nextMs: number }> {
  const { teams: playing, startsUtc } = await todaysGames();
  const now = Date.now();
  const windowOpen = inGameWindow(now, startsUtc);
  const sources = sourcesFor(NEWS_SOURCES, windowOpen, playing);

  const perSource = await mapLimit(sources, CONCURRENCY, async (src) => {
    try {
      return { src, posts: await fetchAuthorFeed(src.handle) };
    } catch (err: any) {
      logger.warn({ err: err?.message, handle: src.handle }, '[NewsSync] source illisible');
      return { src, posts: [] as FeedPost[] };
    }
  });

  const rows: Array<{ post: FeedPost; teams: string[]; flags: NewsFlag[] }> = [];
  const seen = new Set<string>();
  for (const { src, posts } of perSource) {
    for (const post of posts) {
      if (now - post.postedAt.getTime() > MAX_AGE_MS || seen.has(post.externalId)) continue;
      seen.add(post.externalId);
      const teams = teamsForPost(src.team, post.text);
      // Une source de ligue qui ne cite aucune équipe : rien à rattacher à un match.
      if (teams.length === 0) continue;
      rows.push({ post, teams, flags: flagsOf(post.text) });
    }
  }

  const inserted = await insertPosts(rows);
  const toAlert = inserted.filter((r) => alertWorthy(r, playing));
  await notifyAdmins(toAlert).catch((err: any) => logger.warn({ err: err?.message }, '[NewsSync] alerte admin échouée'));
  await purgeOnceADay().catch((err: any) => logger.warn({ err: err?.message }, '[NewsSync] purge échouée'));
  if (inserted.length > 0) cache.clear();

  return { read: sources.length, inserted: inserted.length, alerted: toAlert.length, nextMs: nextDelayMs(Date.now(), startsUtc) };
}

// ── Calendrier ─────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  let nextMs = 60 * 60_000;
  try {
    const out = await withJobLock('news-sync', LOCK_TTL_MS, runNewsSync);
    if (out.ran) {
      nextMs = out.result.nextMs;
      logger.info({ ...out.result, nextMin: Math.round(nextMs / 60_000) }, '[NewsSync] tour terminé');
    } else {
      // Une autre instance a fait le tour : on recalcule seulement la cadence.
      nextMs = nextDelayMs(Date.now(), (await todaysGames()).startsUtc);
    }
  } catch (err: any) {
    logger.warn({ err: err?.message }, '[NewsSync] tour échoué');
  } finally {
    timer = setTimeout(() => void tick(), nextMs);
    timer.unref();
  }
}

export function startNewsSync(): void {
  if (process.env.NEWS_SYNC_ENABLED !== 'true') return;
  if (timer) return;
  timer = setTimeout(() => void tick(), 20_000);
  timer.unref();
  logger.info({ sources: NEWS_SOURCES.length }, '[NewsSync] démarré (1 h, 15 min dans la fenêtre des matchs)');
}

// ── Lecture publique ───────────────────────────────────────────────────────

export interface NewsItem {
  id: number;
  source: 'bluesky' | 'manual';
  teams: string[];
  author: string;
  url: string;
  excerpt: string;
  flags: NewsFlag[];
  postedAt: string;
}

const cache = new TtlCache<NewsItem[]>(2 * 60_000, 200, 'news');

/** Nouvelles des équipes données, des `hours` dernières heures, les plus récentes d'abord. */
export async function listNews(teams: string[], hours = 36, limit = 20): Promise<NewsItem[]> {
  const key = `${[...teams].sort().join(',')}|${hours}|${limit}`;
  return cache.wrap(key, async () => {
    const { rows } = await pool.query(
      `SELECT id, source, team_abbrs, author, url, excerpt, flags, posted_at
         FROM news_items
        WHERE team_abbrs && $1::text[]
          AND posted_at > NOW() - ($2 || ' hours')::interval
        ORDER BY posted_at DESC
        LIMIT $3`,
      [teams, String(hours), limit],
    );
    return rows.map((r: any) => ({
      id: Number(r.id), source: r.source, teams: r.team_abbrs, author: r.author, url: r.url,
      excerpt: r.excerpt, flags: r.flags, postedAt: new Date(r.posted_at).toISOString(),
    }));
  });
}

/** Lien collé par un admin. `null` si déjà présent. */
export async function addManualNews(input: {
  url: string; teams: string[]; author: string; excerpt: string; flags: NewsFlag[]; userId?: string;
}): Promise<number | null> {
  const { rows } = await pool.query(
    `INSERT INTO news_items (source, external_id, team_abbrs, author, url, excerpt, flags, posted_at, created_by)
     VALUES ('manual', $1, $2::text[], $3, $1, $4, $5::text[], NOW(), $6)
     ON CONFLICT (source, external_id) DO NOTHING
     RETURNING id`,
    [input.url, input.teams, input.author, excerptOf(input.excerpt), input.flags, input.userId ?? null],
  );
  cache.clear();
  return rows[0] ? Number(rows[0].id) : null;
}

export async function deleteNews(id: number): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM news_items WHERE id = $1', [id]);
  cache.clear();
  return (rowCount ?? 0) > 0;
}
