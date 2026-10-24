/**
 * pickem.service.ts — votes du pick'em (NEWS_CONSENSUS_PLAN.md, F3,
 * étape 5 session A). Logique pure dans `pickem.ts`.
 *
 * ── Coût (Neon facturé au compute) ──────────────────────────────────────────
 * • Totaux d'un match : cache mémoire 1 min par instance (`tallyCache`) ; un
 *   vote vide l'entrée de CE match sur l'instance qui l'a reçu. Sur une autre
 *   instance, le total peut avoir jusqu'à 1 min de retard — assumé.
 * • Vote de l'utilisateur connecté : 1 SELECT par clé primaire, seulement si
 *   connecté.
 * • Un vote : 1 UPSERT.
 * • Le match vient de `fetchGameById` (page `landing` LNH, déjà en cache 5 min).
 * • Votes du jour (section du chat) : le calendrier du jour (cache LNH 5 min),
 *   puis 1 SELECT groupé pour TOUS les matchs (cache 1 min, `dayCache`) et, si
 *   connecté, 1 SELECT de mes votes. Pas un appel par match.
 *
 * ── Fermeture du vote ───────────────────────────────────────────────────────
 * À la mise au jeu PRÉVUE, vérifiée ICI avec l'heure LNH, jamais celle du
 * client. Contrairement aux coupons (ouverts en cas de panne, voir
 * `slip.service.ts`), le pick'em est FERMÉ en cas de panne : l'API LNH muette
 * → 503 « réessayez ». Un vote de plus après la mise au jeu fausserait un
 * classement public ; un vote refusé ne coûte qu'un nouvel essai.
 */

import { pool } from '../db/connection';
import { TtlCache } from './ttlCache';
import { fetchGameById, fetchGamesByDate } from './nhlApiClient';
import { logger } from '../logger';
import { mapLimit } from './concurrency';
import { getJobState, setJobState } from './jobLock';
import { sendToUsers } from './push.service';
import {
  pickemLocked, pickemState, GAME_ID_RE, PICKEM_MIN_WEEK_PICKS,
  weekBoundsET, modelPick, rankWeek, reminderDue, reminderPayload,
  type PickemGame, type PickemState, type RankedRow, type WeekRow,
} from './pickem';

const tallyCache = new TtlCache<Record<string, number>>(60_000, 500, 'pickem');
/** Totaux de tous les matchs d'un jour : clé = liste des matchs. */
const dayCache = new TtlCache<Record<string, Record<string, number>>>(60_000, 20, 'pickem-day');

const httpError = (status: number, message: string, code?: string) =>
  Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

/** Le match, ou une erreur HTTP : 404 inconnu, 503 API LNH muette. */
export async function loadPickemGame(gameId: string): Promise<PickemGame> {
  let g: any;
  try {
    g = await fetchGameById(gameId);
  } catch (err: any) {
    if (err?.status === 404) throw httpError(404, 'Game not found');
    throw httpError(503, 'NHL schedule unavailable', 'schedule_unavailable');
  }
  const home = String(g?.homeTeam?.abbreviation ?? '').toUpperCase();
  const away = String(g?.awayTeam?.abbreviation ?? '').toUpperCase();
  if (!home || !away) throw httpError(503, 'NHL schedule unavailable', 'schedule_unavailable');
  return {
    home, away,
    startMs: g?.startTimeUTC ? Date.parse(g.startTimeUTC) : NaN,
    status: String(g?.status ?? ''),
  };
}

async function tally(gameId: string): Promise<Record<string, number>> {
  return tallyCache.wrap(gameId, async () => {
    const { rows } = await pool.query(
      `SELECT team_abbr, COUNT(*)::int AS n FROM pickem_votes WHERE game_id = $1 GROUP BY team_abbr`,
      [gameId],
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.team_abbr] = Number(r.n);
    return out;
  });
}

async function myVote(userId: string | undefined, gameId: string): Promise<string | null> {
  if (!userId) return null;
  const { rows } = await pool.query(
    'SELECT team_abbr FROM pickem_votes WHERE user_id = $1 AND game_id = $2',
    [userId, gameId],
  );
  return rows[0]?.team_abbr ?? null;
}

export async function getPickem(gameId: string, userId?: string): Promise<PickemState> {
  const game = await loadPickemGame(gameId);
  const [counts, mine] = await Promise.all([tally(gameId), myVote(userId, gameId)]);
  return pickemState(gameId, game, counts, mine, Date.now());
}

/** Vote ou change de vote. 400 équipe hors match, 409 match commencé. */
export async function castPickem(userId: string, gameId: string, team: string): Promise<PickemState> {
  const game = await loadPickemGame(gameId);
  if (team !== game.home && team !== game.away) throw httpError(400, 'Team is not in this game', 'BAD_TEAM');
  if (pickemLocked(game, Date.now())) throw httpError(409, 'Game already started', 'GAME_STARTED');

  await pool.query(
    `INSERT INTO pickem_votes (user_id, game_id, team_abbr, game_start)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, game_id) DO UPDATE
       SET team_abbr = EXCLUDED.team_abbr, game_start = EXCLUDED.game_start, updated_at = NOW()
     WHERE pickem_votes.correct IS NULL`,
    [userId, gameId, team, new Date(game.startMs).toISOString()],
  );
  tallyCache.delete(gameId);
  dayCache.clear();
  const counts = await tally(gameId);
  return pickemState(gameId, game, counts, team, Date.now());
}

// ── Votes du jour (section « Votes » du chat) ─────────────────────────────

export interface PickemDayGame extends PickemState {
  status: string;
  /** Scores, une fois le match commencé (sinon null). */
  homeScore: number | null;
  awayScore: number | null;
  /** Match fini : l'équipe gagnante, sinon null. */
  winner: string | null;
}

export interface PickemDay { date: string; games: PickemDayGame[] }

const todayET = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/** Tous les matchs du jour (heure de l'Est) avec leurs votes. 503 si l'API LNH est muette. */
export async function getPickemDay(userId?: string): Promise<PickemDay> {
  const date = todayET();
  let raw: any[];
  try {
    raw = await fetchGamesByDate(date);
  } catch {
    throw httpError(503, 'NHL schedule unavailable', 'schedule_unavailable');
  }
  const games = raw
    .map((g) => ({
      id: String(g?.id ?? ''),
      home: String(g?.homeTeam?.abbreviation ?? '').toUpperCase(),
      away: String(g?.awayTeam?.abbreviation ?? '').toUpperCase(),
      startMs: g?.startTimeUTC ? Date.parse(g.startTimeUTC) : NaN,
      status: String(g?.status ?? ''),
      homeScore: typeof g?.homeTeam?.score === 'number' ? g.homeTeam.score : null,
      awayScore: typeof g?.awayTeam?.score === 'number' ? g.awayTeam.score : null,
    }))
    .filter((g) => GAME_ID_RE.test(g.id) && g.home && g.away);
  if (games.length === 0) return { date, games: [] };

  const ids = games.map((g) => g.id);
  const [counts, mine] = await Promise.all([
    dayCache.wrap(ids.join(','), async () => {
      const { rows } = await pool.query(
        `SELECT game_id, team_abbr, COUNT(*)::int AS n FROM pickem_votes
          WHERE game_id = ANY($1::text[]) GROUP BY game_id, team_abbr`,
        [ids],
      );
      const out: Record<string, Record<string, number>> = {};
      for (const r of rows) (out[r.game_id] ??= {})[r.team_abbr] = Number(r.n);
      return out;
    }),
    userId
      ? pool.query('SELECT game_id, team_abbr FROM pickem_votes WHERE user_id = $1 AND game_id = ANY($2::text[])', [userId, ids])
          .then(({ rows }) => new Map<string, string>(rows.map((r: any) => [r.game_id, r.team_abbr])))
      : Promise.resolve(new Map<string, string>()),
  ]);

  const now = Date.now();
  return {
    date,
    games: games
      .sort((a, b) => (a.startMs || 0) - (b.startMs || 0))
      .map((g) => {
        const final = g.status.toLowerCase() === 'final';
        const winner = final && g.homeScore != null && g.awayScore != null && g.homeScore !== g.awayScore
          ? (g.homeScore > g.awayScore ? g.home : g.away) : null;
        return {
          ...pickemState(g.id, g, counts[g.id] ?? {}, mine.get(g.id) ?? null, now),
          status: g.status, homeScore: g.homeScore, awayScore: g.awayScore, winner,
        };
      }),
  };
}

/** Pour les tests. */
export function clearPickemCache(): void { tallyCache.clear(); dayCache.clear(); leaderboardCache.clear(); }


// ── Session B : choix du modèle figé avant le match ────────────────────────

/** Fenêtre de capture : la dernière heure (et quart) avant la mise au jeu. */
const MODEL_WINDOW_MS = 75 * 60_000;

/**
 * Fige le choix du modèle pour les matchs votés qui commencent dans l'heure.
 * Appelé à chaque tour de NewsSync (15 min dans la fenêtre des matchs) : le
 * dernier tour avant la mise au jeu gagne. Rend le nombre de matchs figés.
 * Ne lève jamais : un modèle indisponible = pas de ligne, le classement
 * affiche alors le modèle sur moins de matchs.
 */
export async function snapshotModelPicks(now = Date.now()): Promise<number> {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT game_id FROM pickem_votes WHERE game_start > $1 AND game_start <= $2`,
      [new Date(now).toISOString(), new Date(now + MODEL_WINDOW_MS).toISOString()],
    );
    if (rows.length === 0) return 0;
    // Import paresseux : le paquet ML tire tout le client NHL et le service Python.
    const { getGameMlBundle, mlBundleKey } = await import('./gameMlBundle');
    const done = await mapLimit(rows.map((r: any) => String(r.game_id)), 2, async (gameId) => {
      try {
        const game = await loadPickemGame(gameId);
        if (pickemLocked(game, Date.now())) return false;           // trop tard : on garde la dernière capture
        const bundle = await getGameMlBundle(gameId);
        if (bundle.live) return false;
        const p = bundle.byKey[mlBundleKey('moneyline', null, null, true)]?.probability;
        if (typeof p !== 'number' || !Number.isFinite(p)) return false;
        const homePct = Math.min(100, Math.max(0, p));
        await pool.query(
          `INSERT INTO pickem_model (game_id, home_team, away_team, game_start, home_pct, pick, recorded_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (game_id) DO UPDATE
             SET home_pct = EXCLUDED.home_pct, pick = EXCLUDED.pick, game_start = EXCLUDED.game_start, recorded_at = NOW()
           WHERE pickem_model.correct IS NULL`,
          [gameId, game.home, game.away, new Date(game.startMs).toISOString(), homePct.toFixed(2), modelPick(homePct, game.home, game.away)],
        );
        return true;
      } catch (err: any) {
        logger.warn({ err: err?.message, gameId }, '[Pickem] choix du modèle non figé');
        return false;
      }
    });
    return done.filter(Boolean).length;
  } catch (err: any) {
    logger.warn({ err: err?.message }, '[Pickem] capture du modèle échouée');
    return 0;
  }
}

// ── Session B : règlement ───────────────────────────────────────────────────

/** Un match n'est pas réglable avant ~2 h 30 après la mise au jeu prévue. */
const SETTLE_AFTER_MS = 2.5 * 60 * 60_000;
const SETTLE_BATCH = 60;

/**
 * Règle les votes (et le choix du modèle) des matchs finis. Appelé par la passe
 * de rattrapage horaire de `settlement.service.ts` — pas un job de plus.
 * Idempotent : ne touche que `correct IS NULL`. Un match pas encore final (ou
 * reporté) est simplement repris à la passe suivante.
 */
export async function settlePendingPickems(now = Date.now()): Promise<{ games: number; votes: number }> {
  const { rows } = await pool.query(
    `SELECT DISTINCT game_id FROM pickem_votes
      WHERE correct IS NULL AND game_start < $1
      LIMIT ${SETTLE_BATCH}`,
    [new Date(now - SETTLE_AFTER_MS).toISOString()],
  );
  let games = 0, votes = 0;
  for (const r of rows) {
    const gameId = String(r.game_id);
    let g: any;
    try { g = await fetchGameById(gameId); } catch { continue; }
    const hs = g?.homeTeam?.score, as = g?.awayTeam?.score;
    if (g?.status !== 'final' || typeof hs !== 'number' || typeof as !== 'number' || hs === as) continue;
    const winner = String(hs > as ? g.homeTeam.abbreviation : g.awayTeam.abbreviation).toUpperCase();
    const res = await pool.query(
      `UPDATE pickem_votes SET correct = (team_abbr = $2) WHERE game_id = $1 AND correct IS NULL`,
      [gameId, winner],
    );
    await pool.query(
      `UPDATE pickem_model SET correct = (pick = $2) WHERE game_id = $1 AND correct IS NULL`,
      [gameId, winner],
    );
    games++;
    votes += res.rowCount ?? 0;
  }
  if (games > 0) leaderboardCache.clear();
  return { games, votes };
}

// ── Session B : classement de la semaine ───────────────────────────────────

export interface PickemLeaderboard {
  /** Lundi et dimanche (heure de l'Est), AAAA-MM-JJ. */
  weekStart: string;
  weekEnd: string;
  minPicks: number;
  /** Les 20 premiers classés. */
  ranked: RankedRow[];
  /** Nombre total de classés (au-delà des 20 affichés). */
  rankedCount: number;
  /** La personne connectée, classée ou non (null si anonyme ou sans pick réglé). */
  me: { rank: number | null; picks: number; wins: number; pct: number | null } | null;
  /** Le modèle sur les mêmes matchs (ceux qui ont au moins un vote réglé). */
  model: { games: number; wins: number; pct: number | null };
  /** Le public : son choix majoritaire par match (égalité = non compté). */
  crowd: { games: number; wins: number; pct: number | null };
}

interface WeekData { rows: WeekRow[]; model: { games: number; wins: number }; crowd: { games: number; wins: number } }

const leaderboardCache = new TtlCache<WeekData>(5 * 60_000, 10, 'pickem-week');

async function weekData(start: number, end: number): Promise<WeekData> {
  return leaderboardCache.wrap(`${start}`, async () => {
    const range = [new Date(start).toISOString(), new Date(end).toISOString()];
    const [users, model, crowd] = await Promise.all([
      pool.query(
        `SELECT v.user_id AS "userId", u.username,
                up.display_name AS "displayName", up.avatar,
                COALESCE(up.avatar_url, u.avatar_url) AS "avatarUrl",
                COUNT(*)::int AS picks, COUNT(*) FILTER (WHERE v.correct)::int AS wins
           FROM pickem_votes v
           JOIN users u ON u.id = v.user_id
           LEFT JOIN user_profiles up ON up.user_id = v.user_id
          WHERE v.game_start >= $1 AND v.game_start < $2 AND v.correct IS NOT NULL
          GROUP BY v.user_id, u.username, up.display_name, up.avatar, up.avatar_url, u.avatar_url`,
        range,
      ),
      pool.query(
        `SELECT COUNT(*)::int AS games, COUNT(*) FILTER (WHERE m.correct)::int AS wins
           FROM pickem_model m
          WHERE m.correct IS NOT NULL
            AND m.game_id IN (SELECT DISTINCT game_id FROM pickem_votes
                               WHERE game_start >= $1 AND game_start < $2 AND correct IS NOT NULL)`,
        range,
      ),
      pool.query(
        `WITH t AS (
           SELECT game_id, COUNT(*) FILTER (WHERE correct) AS right_n, COUNT(*) FILTER (WHERE NOT correct) AS wrong_n
             FROM pickem_votes
            WHERE game_start >= $1 AND game_start < $2 AND correct IS NOT NULL
            GROUP BY game_id)
         SELECT COUNT(*) FILTER (WHERE right_n <> wrong_n)::int AS games,
                COUNT(*) FILTER (WHERE right_n > wrong_n)::int AS wins
           FROM t`,
        range,
      ),
    ]);
    return {
      rows: users.rows.map((r: any) => ({
        userId: String(r.userId), username: r.username, displayName: r.displayName ?? null,
        avatar: r.avatar ?? null, avatarUrl: r.avatarUrl ?? null, picks: Number(r.picks), wins: Number(r.wins),
      })),
      model: { games: Number(model.rows[0]?.games ?? 0), wins: Number(model.rows[0]?.wins ?? 0) },
      crowd: { games: Number(crowd.rows[0]?.games ?? 0), wins: Number(crowd.rows[0]?.wins ?? 0) },
    };
  });
}

const rate = (s: { games: number; wins: number }) => ({ ...s, pct: s.games > 0 ? Math.round((s.wins / s.games) * 100) : null });

/** Classement de la semaine en cours (`offset` 0) ou de la précédente (−1). Cache 5 min. */
export async function getPickemLeaderboard(offset: 0 | -1, userId?: string, now = Date.now()): Promise<PickemLeaderboard> {
  const week = weekBoundsET(now, offset);
  const data = await weekData(week.start, week.end);
  const ranked = rankWeek(data.rows);
  const mineRow = userId ? data.rows.find((r) => r.userId === userId) : undefined;
  const mineRank = userId ? ranked.find((r) => r.userId === userId) : undefined;
  return {
    weekStart: week.monday,
    weekEnd: week.sunday,
    minPicks: PICKEM_MIN_WEEK_PICKS,
    ranked: ranked.slice(0, 20),
    rankedCount: ranked.length,
    me: mineRow ? {
      rank: mineRank?.rank ?? null, picks: mineRow.picks, wins: mineRow.wins,
      pct: mineRow.picks > 0 ? Math.round((mineRow.wins / mineRow.picks) * 100) : null,
    } : null,
    model: rate(data.model),
    crowd: rate(data.crowd),
  };
}

// ── Session C : rappel « votes fermés dans 1 h » ──────────────────────────────

const REMINDER_KEY = 'pickem-reminder-day';

/**
 * Une fois par jour, une heure avant le PREMIER match de la soirée, rappelle de
 * voter à ceux qui ont voté au moins une fois dans les 30 derniers jours, qui
 * ont activé les notifications sur iPhone, et qui n'ont encore voté pour aucun
 * match du jour. Appelé à chaque tour de NewsSync ; hors de la fenêtre, ne lit
 * que le calendrier (en cache), sans toucher la base.
 *
 * Canal APNs seulement, comme « pari réglé » : l'abonnement Web Push a été pris
 * pour les alertes value bets. Le jour est marqué AVANT l'envoi : mieux vaut un
 * rappel manqué qu'un rappel en double. Ne lève jamais. Rend le nombre de
 * destinataires (0 si rien n'est parti).
 */
export async function remindPickemLock(now = Date.now()): Promise<number> {
  try {
    const raw = await fetchGamesByDate(new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }));
    const upcoming = raw
      .map((g: any) => ({
        id: String(g?.id ?? ''),
        home: String(g?.homeTeam?.abbreviation ?? ''), away: String(g?.awayTeam?.abbreviation ?? ''),
        startMs: g?.startTimeUTC ? Date.parse(g.startTimeUTC) : NaN,
      }))
      .filter((g) => GAME_ID_RE.test(g.id) && Number.isFinite(g.startMs))
      .sort((a, b) => a.startMs - b.startMs);
    if (upcoming.length === 0) return 0;
    const first = upcoming[0];

    // Garde horaire d'abord (gratuite), la mémoire partagée ensuite.
    if (!reminderDue(now, first.startMs, null).due) return 0;
    const { due, day } = reminderDue(now, first.startMs, await getJobState(REMINDER_KEY));
    if (!due) return 0;
    if (!(await setJobState(REMINDER_KEY, day))) return 0;

    const { rows } = await pool.query(
      `SELECT DISTINCT v.user_id AS "userId"
         FROM pickem_votes v
        WHERE v.created_at > $1
          AND EXISTS (SELECT 1 FROM apns_device_tokens t WHERE t.user_id = v.user_id)
          AND NOT EXISTS (SELECT 1 FROM pickem_votes w WHERE w.user_id = v.user_id AND w.game_id = ANY($2::text[]))`,
      [new Date(now - 30 * 24 * 3600_000).toISOString(), upcoming.map((g) => g.id)],
    );
    const userIds = rows.map((r: any) => String(r.userId));
    if (userIds.length === 0) return 0;
    const res = await sendToUsers(userIds, reminderPayload(first, upcoming.length), { channels: ['apns'] });
    logger.info({ day, users: userIds.length, ...res }, '[Pickem] rappel envoyé');
    return userIds.length;
  } catch (err: any) {
    logger.warn({ err: err?.message }, '[Pickem] rappel échoué');
    return 0;
  }
}
