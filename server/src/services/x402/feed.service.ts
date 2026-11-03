/**
 * feed.service.ts — données de l'API pour agents (X402_PLAN.md, phase 2).
 *
 * N'est appelé QU'APRÈS un paiement vérifié (`/v1/nhl/games`) ou sur la route
 * gratuite (`/v1/nhl/results`). Une 402 n'arrive jamais jusqu'ici : ni ML, ni Neon.
 *
 * ── Coût ────────────────────────────────────────────────────────────────────
 * • games : le calendrier (cache LNH 5 min) et les paquets ML (cache mémoire
 *   10 min, partagé avec le site) — aucune requête Neon. 4 calculs simultanés au
 *   plus, comme `/api/predict/summary`.
 * • results : 1 SELECT, gardé 1 h en mémoire par instance.
 */

import { pool } from '../../db/connection';
import { logger } from '../../logger';
import { mapLimit } from '../concurrency';
import { fetchGamesByDate } from '../nhlApiClient';
import { TtlCache } from '../ttlCache';
import { etDate } from '../modelSnapshots.service';
import {
  splitSchedule, agentGame, gamesBody, resultsBody, MAX_GAMES,
  type AgentGamesBody, type SettledRow,
} from './format';

const httpError = (status: number, message: string, code: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { status, code, ...extra });

export { etDate };

/**
 * Probabilités d'avant-match de tous les matchs à venir de `date`.
 * Lève (donc aucun débit) :
 *   • 404 `no_games`  — aucun match à venir ce jour-là ;
 *   • 503 `schedule_unavailable` — API LNH muette ;
 *   • 503 `model_unavailable`    — un match au moins n'a pas de chiffre du modèle
 *     de score : on ne vend pas une journée incomplète ni un chiffre de repli.
 */
export async function getAgentGames(date: string, now = Date.now()): Promise<AgentGamesBody> {
  let raw: any[];
  try {
    raw = await fetchGamesByDate(date);
  } catch {
    throw httpError(503, 'NHL schedule unavailable, retry later', 'schedule_unavailable');
  }
  const { upcoming, excluded } = splitSchedule(raw, now);
  if (upcoming.length === 0) throw httpError(404, 'No upcoming NHL games on this date', 'no_games', { excluded });

  // Import paresseux : le paquet ML tire tout le client NHL et le service Python.
  const ml = await import('../gameMlBundle');
  const out = await mapLimit(upcoming.slice(0, MAX_GAMES), 4, async (g) => {
    try {
      const [bundle, features] = await Promise.all([
        ml.getGameMlBundle(g.id),
        ml.getGameFeatures(g.id).catch(() => null),
      ]);
      return agentGame(g, bundle, ml.mlBundleKey, { home: features?.home_goalie, away: features?.away_goalie });
    } catch (err: any) {
      logger.warn({ err: err?.message, gameId: g.id }, '[x402] paquet ML indisponible');
      return null;
    }
  });
  if (out.some((g) => g === null)) {
    throw httpError(503, 'Model temporarily unavailable for at least one game, retry later', 'model_unavailable');
  }
  // Revérifié après le calcul : un match commencé pendant ce temps ne sort pas.
  const fresh = out.filter((g) => Date.parse(g!.game.startTimeUTC) > Date.now());
  if (fresh.length === 0) throw httpError(404, 'No upcoming NHL games on this date', 'no_games', { excluded });
  return gamesBody(date, fresh as NonNullable<(typeof out)[number]>[], excluded);
}

// ── Bilan (gratuit) ─────────────────────────────────────────────────────────

const RESULTS_ROWS = 2000;
const resultsCache = new TtlCache<SettledRow[]>(60 * 60_000, 4, 'x402-results');

async function settledRows(kind: 'morning' | 'pregame'): Promise<SettledRow[]> {
  return resultsCache.wrap(kind, async () => {
    const { rows } = await pool.query(
      `SELECT game_id, home_team, away_team, start_time, recorded_at, home_win, home_minus, away_minus,
              home_score, away_score, proof_commit
         FROM model_snapshots
        WHERE kind = $1 AND outcome IS NOT NULL
          ${kind === 'morning' ? 'AND proof_commit IS NOT NULL' : ''}
        ORDER BY start_time DESC
        LIMIT ${RESULTS_ROWS}`,
      [kind],
    );
    const n = (v: unknown) => (v == null ? null : Number(v));
    return rows.map((r: any) => ({
      gameId: String(r.game_id), home: r.home_team, away: r.away_team,
      startTimeUTC: new Date(r.start_time).toISOString(), recordedAt: new Date(r.recorded_at).toISOString(),
      homeWin: Number(r.home_win), homeMinus: n(r.home_minus), awayMinus: n(r.away_minus),
      homeScore: Number(r.home_score), awayScore: Number(r.away_score), proofCommit: r.proof_commit ?? null,
    }));
  });
}

export async function getAgentResults(kind: 'morning' | 'pregame', proofRepo: string, limit = 200) {
  return resultsBody(kind, await settledRows(kind), proofRepo, limit);
}

/** Pour les tests. */
export function clearAgentCaches(): void { resultsCache.clear(); }
