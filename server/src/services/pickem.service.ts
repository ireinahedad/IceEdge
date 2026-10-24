/**
 * pickem.service.ts — votes du pick'em ICEEDGE (NEWS_CONSENSUS_PLAN.md, F3,
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
import { pickemLocked, pickemState, GAME_ID_RE, type PickemGame, type PickemState } from './pickem';

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
export function clearPickemCache(): void { tallyCache.clear(); dayCache.clear(); }
