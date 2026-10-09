/**
 * bestBetLog.service.ts
 * ------------------------------------------------------------------
 * Journal des Best Bets (migration 042) — ce qui alimente /dev/profit,
 * « combien j'aurais gagné en misant X $ sur chaque best bet du jour ».
 *
 *  • `logBestBets`        — appelé par `computeBestBets` à chaque recalcul
 *                           (au plus une fois par minute, cache 60 s).
 *  • `settlePendingBestBets` — règle les paris dont le match est fini, avec
 *                           la logique des coupons (`settleStandaloneLegs`).
 *  • `getBestBetLog`      — les lignes d'une période, pour la page admin.
 *
 * Le calcul du profit lui-même est fait côté client : mise, top N et cote des
 * paris sans prix y sont des curseurs, pas des paramètres de requête.
 */

import { pool } from '../db/connection';
import { logger } from '../logger';
import { settleStandaloneLegs } from './settlement.service';
import type { BestBet } from './bestBets.service';

/** Profondeur journalisée : ce que l'accueil demande (`limit: 30`). */
export const BEST_BET_LOG_DEPTH = 30;

/** `'YYYY-MM-DD'` du jour NHL (heure de l'Est) d'un instant ISO. */
function etDateOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * Écrit les best bets d'une liste, dans l'ordre (rang = position + 1).
 *
 * Jamais bloquant : un journal en panne (migration pas encore passée, base
 * indisponible) ne doit pas retirer les best bets de l'écran. Une ligne déjà
 * réglée n'est plus touchée.
 */
export async function logBestBets(bets: readonly BestBet[]): Promise<void> {
  const list = bets.slice(0, BEST_BET_LOG_DEPTH);
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const gameDate = b.game?.date ?? etDateOf(b.game?.startTimeUTC);
    if (!b.gameId || !gameDate) continue;          // ni match ni date : pas réglable
    const rank = i + 1;
    const subjectId = b.subjectType === 'player' ? (b.playerId ?? b.subjectId) : b.subjectId;
    try {
      await pool.query(
        `INSERT INTO best_bet_log
           (bet_id, game_id, game_date, start_time_utc, home_team, away_team,
            subject_type, subject_id, subject_name, market_type, market_label, label,
            selection_value, line, source,
            first_rank, first_score, first_price, last_rank, last_score, last_price,
            best_rank, book_title)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                 $16, $17, $18, $16, $17, $18, $16, $19)
         ON CONFLICT (game_id, bet_id) DO UPDATE
           SET last_seen_at   = NOW(),
               last_rank      = EXCLUDED.last_rank,
               last_score     = EXCLUDED.last_score,
               last_price     = COALESCE(EXCLUDED.last_price, best_bet_log.last_price),
               first_price    = COALESCE(best_bet_log.first_price, EXCLUDED.first_price),
               best_rank      = LEAST(best_bet_log.best_rank, EXCLUDED.best_rank),
               book_title     = COALESCE(best_bet_log.book_title, EXCLUDED.book_title),
               start_time_utc = COALESCE(EXCLUDED.start_time_utc, best_bet_log.start_time_utc),
               source         = EXCLUDED.source
         WHERE best_bet_log.outcome = 'pending'`,
        [b.id, String(b.gameId), gameDate, b.game?.startTimeUTC ?? null,
         b.game?.home ?? null, b.game?.away ?? null,
         b.subjectType, String(subjectId), b.subjectName, b.marketType, b.marketLabel, b.label,
         b.selectionValue, b.line, b.source,
         rank, b.score, b.bookPrice != null && b.bookPrice > 1 ? b.bookPrice : null,
         b.bookTitle],
      );
    } catch (err: any) {
      logger.warn({ err: err?.message, id: b.id }, '[bestBets] journal non écrit');
      return;   // même cause pour les suivantes : inutile d'insister
    }
  }
}

/** Délai après la mise au jeu avant de tenter un règlement. */
const SETTLE_AFTER_MS = 2.5 * 3_600_000;

export interface SettleBestBetsSummary { checked: number; settled: number }

/**
 * Règle les best bets en attente dont le match a commencé il y a plus de 2 h 30.
 * Idempotent (l'UPDATE est gardé par `outcome = 'pending'`) : deux appels
 * simultanés ne règlent rien deux fois.
 */
export async function settlePendingBestBets(max = 300): Promise<SettleBestBetsSummary> {
  const { rows } = await pool.query<{
    id: string; game_id: string; market_type: string; selection_value: string;
    line: string | null; subject_id: string;
  }>(
    `SELECT id, game_id, market_type, selection_value, line, subject_id
       FROM best_bet_log
      WHERE outcome = 'pending'
        AND (start_time_utc < $1 OR (start_time_utc IS NULL AND game_date < CURRENT_DATE - 1))
      ORDER BY start_time_utc NULLS FIRST
      LIMIT $2`,
    [new Date(Date.now() - SETTLE_AFTER_MS), max],
  );
  if (rows.length === 0) return { checked: 0, settled: 0 };

  const results = await settleStandaloneLegs(rows.map((r) => ({
    gameId:         r.game_id,
    marketType:     r.market_type,
    selectionValue: r.selection_value,
    line:           r.line == null ? null : Number(r.line),
    subjectId:      r.subject_id,
  })));

  let settled = 0;
  for (let i = 0; i < rows.length; i++) {
    const outcome = results[i];
    if (outcome === 'unknown') continue;
    const { rowCount } = await pool.query(
      `UPDATE best_bet_log SET outcome = $2, settled_at = NOW()
        WHERE id = $1 AND outcome = 'pending'`,
      [rows[i].id, outcome],
    );
    settled += rowCount ?? 0;
  }
  return { checked: rows.length, settled };
}

export interface BestBetLogRow {
  id:             number;
  betId:          string;
  gameId:         string;
  gameDate:       string;
  startTimeUTC:   string | null;
  homeTeam:       string | null;
  awayTeam:       string | null;
  subjectType:    'game' | 'player';
  subjectName:    string;
  marketType:     string;
  marketLabel:    string;
  label:          string;
  line:           number | null;
  source:         string;
  firstSeenAt:    string;
  firstRank:      number;
  firstScore:     number;
  firstPrice:     number | null;
  lastRank:       number;
  lastScore:      number;
  lastPrice:      number | null;
  bestRank:       number;
  bookTitle:      string | null;
  outcome:        'pending' | 'win' | 'loss' | 'void';
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));

/** Les lignes d'une période `[from, to]` (jours NHL inclus), plus récentes d'abord. */
export async function getBestBetLog(from: string, to: string, limit = 20_000): Promise<BestBetLogRow[]> {
  const { rows } = await pool.query(
    `SELECT id, bet_id, game_id, to_char(game_date, 'YYYY-MM-DD') AS game_date, start_time_utc,
            home_team, away_team, subject_type, subject_name, market_type, market_label, label,
            line, source, first_seen_at, first_rank, first_score, first_price,
            last_rank, last_score, last_price, best_rank, book_title, outcome
       FROM best_bet_log
      WHERE game_date BETWEEN $1::date AND $2::date
      ORDER BY game_date DESC, best_rank ASC, id ASC
      LIMIT $3`,
    [from, to, limit],
  );
  return rows.map((r: any) => ({
    id:           Number(r.id),
    betId:        r.bet_id,
    gameId:       r.game_id,
    gameDate:     r.game_date,
    startTimeUTC: r.start_time_utc ? new Date(r.start_time_utc).toISOString() : null,
    homeTeam:     r.home_team,
    awayTeam:     r.away_team,
    subjectType:  r.subject_type,
    subjectName:  r.subject_name,
    marketType:   r.market_type,
    marketLabel:  r.market_label,
    label:        r.label,
    line:         num(r.line),
    source:       r.source,
    firstSeenAt:  new Date(r.first_seen_at).toISOString(),
    firstRank:    Number(r.first_rank),
    firstScore:   Number(r.first_score),
    firstPrice:   num(r.first_price),
    lastRank:     Number(r.last_rank),
    lastScore:    Number(r.last_score),
    lastPrice:    num(r.last_price),
    bestRank:     Number(r.best_rank),
    bookTitle:    r.book_title,
    outcome:      r.outcome,
  }));
}
