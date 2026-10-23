/**
 * parlayLog.service.ts
 * ------------------------------------------------------------------
 * Journal des combinés publiés en vidéo (migration 046, MARKETING_PLAN.md
 * Phase B). Ce qui est publié ne bouge plus : c'est la condition d'un bilan
 * public honnête.
 *
 *  • `freezeDailyParlays(date)`  — copie les `FREE_PARLAYS` premiers combinés de
 *                                  `getBestParlays` dans `parlay_log`, UNE fois
 *                                  par jour ; les appels suivants renvoient le gel.
 *  • `settlePendingParlays()`    — règle les jambes avec la logique des coupons
 *                                  (`settleStandaloneLegs` + `resolveSlipOutcome`).
 *  • `getParlaysForDate(date)`   — ce qui est gelé ce jour-là (route publique).
 *  • `getParlayRecord()`         — bilan cumulé depuis le premier gel.
 *  • `markParlaysPosted(…)`      — drapeaux de publication (idempotence).
 */

import { pool } from '../db/connection';
import { logger } from '../logger';
import { getBestParlays, FREE_PARLAYS, type BestParlay } from './bestParlays.service';
import type { BestBet } from './bestBets.service';
import { settleStandaloneLegs, resolveSlipOutcome, type LegResult } from './settlement.service';

export type ParlayStatus = 'pending' | 'won' | 'lost' | 'void';

export interface LoggedParlay {
  date:         string;
  rank:         number;
  parlayId:     string;
  kind:         'moneyline' | 'mixed';
  legs:         BestBet[];
  probability:  number;
  bookPrice:    number | null;
  firstStartUTC: string | null;
  frozenAt:     string;
  status:       ParlayStatus;
  legResults:   LegResult[] | null;
  settledAt:    string | null;
  youtubePickId:      string | null;
  youtubeResultId:    string | null;
  tiktokPickSentAt:   string | null;
  tiktokResultSentAt: string | null;
}

/** `'YYYY-MM-DD'` du jour NHL (heure de l'Est), décalé de `n` jours. */
export function etToday(now = new Date(), n = 0): string {
  const today = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as any).toISOString());
const num = (v: unknown): number | null => (v == null ? null : Number(v));

function rowToParlay(r: any): LoggedParlay {
  return {
    date:          r.date,
    rank:          Number(r.rank),
    parlayId:      r.parlay_id,
    kind:          r.kind,
    legs:          r.legs,
    probability:   Number(r.probability),
    bookPrice:     num(r.book_price),
    firstStartUTC: iso(r.first_start_utc),
    frozenAt:      iso(r.frozen_at)!,
    status:        r.status,
    legResults:    r.leg_results ?? null,
    settledAt:     iso(r.settled_at),
    youtubePickId:      r.youtube_pick_id ?? null,
    youtubeResultId:    r.youtube_result_id ?? null,
    tiktokPickSentAt:   iso(r.tiktok_pick_sent_at),
    tiktokResultSentAt: iso(r.tiktok_result_sent_at),
  };
}

const SELECT_COLS = `to_char(date, 'YYYY-MM-DD') AS date, rank, parlay_id, kind, legs, probability,
  book_price, first_start_utc, frozen_at, status, leg_results, settled_at,
  youtube_pick_id, youtube_result_id, tiktok_pick_sent_at, tiktok_result_sent_at`;

/** Les combinés gelés d'un jour NHL, par rang. Vide si rien n'a été gelé. */
export async function getParlaysForDate(date: string): Promise<LoggedParlay[]> {
  const { rows } = await pool.query(
    `SELECT ${SELECT_COLS} FROM parlay_log WHERE date = $1::date ORDER BY rank`, [date]);
  return rows.map(rowToParlay);
}

/** Première mise au jeu des jambes, ISO, ou `null`. */
function firstStart(p: BestParlay): string | null {
  let best: number | null = null;
  for (const l of p.legs) {
    const t = Date.parse(l.game?.startTimeUTC ?? '');
    if (Number.isFinite(t) && (best == null || t < best)) best = t;
  }
  return best == null ? null : new Date(best).toISOString();
}

export interface FreezeResult {
  date:    string;
  /** Vrai si CET appel a gelé ; faux si le jour l'était déjà (ou sans combiné). */
  created: boolean;
  parlays: LoggedParlay[];
}

/** Erreur 4xx lisible par `sendError`. */
function httpErr(status: number, message: string, code?: string): Error {
  return Object.assign(new Error(message), { status, code });
}

/**
 * Gèle les combinés gratuits du jour. Idempotent : si le jour a déjà au moins
 * une ligne, rien n'est écrit et le gel existant est renvoyé tel quel — un
 * deuxième appel ne peut ni ajouter ni remplacer un combiné déjà publié.
 *
 * Le verrou consultatif (par jour) sérialise deux appels simultanés : sans lui,
 * deux runs pourraient chacun voir « rien de gelé » et écrire des combinés
 * différents si le cache a tourné entre les deux.
 */
export async function freezeDailyParlays(date: string = etToday()): Promise<FreezeResult> {
  const existing = await getParlaysForDate(date);
  if (existing.length > 0) return { date, created: false, parlays: existing };

  const built = await getBestParlays(date);
  if (built.meta.day && built.meta.day !== date) {
    throw httpErr(409, `Best parlays are for ${built.meta.day}, not ${date}`, 'DAY_MISMATCH');
  }
  const picks = built.parlays.slice(0, FREE_PARLAYS);
  if (picks.length === 0) return { date, created: false, parlays: [] };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('parlay_log:' || $1))`, [date]);
    const { rows } = await client.query('SELECT 1 FROM parlay_log WHERE date = $1::date LIMIT 1', [date]);
    if (rows.length === 0) {
      for (let i = 0; i < picks.length; i++) {
        const p = picks[i];
        await client.query(
          `INSERT INTO parlay_log (date, rank, parlay_id, kind, legs, probability, book_price, first_start_utc)
           VALUES ($1::date, $2, $3, $4, $5::jsonb, $6, $7, $8)
           ON CONFLICT (date, rank) DO NOTHING`,
          [date, i + 1, p.id, p.kind, JSON.stringify(p.legs), p.probability,
           p.bookPrice != null && p.bookPrice > 1 ? p.bookPrice : null, firstStart(p)],
        );
      }
    }
    await client.query('COMMIT');
    const parlays = await getParlaysForDate(date);
    if (rows.length === 0) logger.info({ date, count: picks.length }, '[parlayLog] combinés gelés');
    return { date, created: rows.length === 0, parlays };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Délai après la première mise au jeu avant de tenter un règlement. */
const SETTLE_AFTER_MS = 2.5 * 3_600_000;

const STATUS_OF: Record<'win' | 'loss' | 'void', ParlayStatus> = { win: 'won', loss: 'lost', void: 'void' };

export interface SettleParlaysSummary { checked: number; settled: number }

/**
 * Règle les combinés en attente. Les verdicts de jambes sont écrits même quand
 * le combiné reste en attente (la vidéo résultat peut ainsi montrer l'état), et
 * le statut seulement quand `resolveSlipOutcome` tranche — exactement la règle
 * d'un coupon : une jambe perdue suffit, une jambe annulée sort du calcul.
 * Gardé par `status = 'pending'` : deux passes simultanées ne règlent rien deux fois.
 */
export async function settlePendingParlays(now = Date.now()): Promise<SettleParlaysSummary> {
  const { rows } = await pool.query<{ id: string; legs: any[] }>(
    `SELECT id, legs FROM parlay_log
      WHERE status = 'pending'
        AND (first_start_utc < $1 OR (first_start_utc IS NULL AND date < CURRENT_DATE - 1))
      ORDER BY date, rank
      LIMIT 100`,
    [new Date(now - SETTLE_AFTER_MS)],
  );
  if (rows.length === 0) return { checked: 0, settled: 0 };

  // Toutes les jambes en un seul appel : les caches de match sont partagés.
  const flat = rows.flatMap((r) => (r.legs ?? []).map((l: BestBet) => ({
    gameId:         l.gameId,
    marketType:     l.marketType,
    selectionValue: l.selectionValue,
    line:           l.line,
    subjectId:      l.subjectType === 'player' ? (l.playerId ?? l.subjectId) : l.subjectId,
  })));
  const results = await settleStandaloneLegs(flat);

  let settled = 0;
  let k = 0;
  for (const r of rows) {
    const n = (r.legs ?? []).length;
    const legResults = results.slice(k, k + n) as LegResult[];
    k += n;
    const outcome = resolveSlipOutcome(legResults);
    const status = outcome ? STATUS_OF[outcome] : 'pending';
    const { rowCount } = await pool.query(
      `UPDATE parlay_log
          SET leg_results = $2::jsonb,
              status      = $3,
              settled_at  = CASE WHEN $3 = 'pending' THEN NULL ELSE NOW() END
        WHERE id = $1 AND status = 'pending'`,
      [r.id, JSON.stringify(legResults), status],
    );
    if (status !== 'pending') settled += rowCount ?? 0;
  }
  return { checked: rows.length, settled };
}

export interface ParlayRecord {
  /** Premier jour gelé (`YYYY-MM-DD`), ou `null` avant le lancement. */
  since:   string | null;
  won:     number;
  lost:    number;
  void:    number;
  pending: number;
  /** won / (won + lost), en %, au dixième ; `null` sans combiné décidé. */
  winPct:  number | null;
}

/** Bilan cumulé. Sans ROI, exprès (même règle que la page de résultats publique). */
export async function getParlayRecord(): Promise<ParlayRecord> {
  const { rows } = await pool.query(
    `SELECT to_char(MIN(date), 'YYYY-MM-DD') AS since,
            COUNT(*) FILTER (WHERE status = 'won')     AS won,
            COUNT(*) FILTER (WHERE status = 'lost')    AS lost,
            COUNT(*) FILTER (WHERE status = 'void')    AS void,
            COUNT(*) FILTER (WHERE status = 'pending') AS pending
       FROM parlay_log`);
  const r = rows[0] ?? {};
  const won = Number(r.won ?? 0), lost = Number(r.lost ?? 0);
  return {
    since:   r.since ?? null,
    won, lost,
    void:    Number(r.void ?? 0),
    pending: Number(r.pending ?? 0),
    winPct:  won + lost > 0 ? Math.round((won / (won + lost)) * 1000) / 10 : null,
  };
}

export type PostedKind = 'youtube_pick' | 'youtube_result' | 'tiktok_pick' | 'tiktok_result';

/**
 * Pose un drapeau de publication sur TOUS les combinés du jour (une vidéo par
 * jour et par mode). Jamais écrasé : le premier id / horodatage reste.
 * Renvoie `alreadySet: true` si le drapeau existait déjà — le workflow s'arrête.
 */
export async function markParlaysPosted(
  date: string, kind: PostedKind, videoId?: string,
): Promise<{ updated: number; alreadySet: boolean }> {
  const col = ({
    youtube_pick: 'youtube_pick_id', youtube_result: 'youtube_result_id',
    tiktok_pick: 'tiktok_pick_sent_at', tiktok_result: 'tiktok_result_sent_at',
  } as const)[kind];
  const isYoutube = kind.startsWith('youtube');
  if (isYoutube && !videoId) throw httpErr(400, 'videoId is required for YouTube', 'VIDEO_ID_REQUIRED');

  const { rowCount } = await pool.query(
    `UPDATE parlay_log SET ${col} = ${isYoutube ? '$2' : 'NOW()'}
      WHERE date = $1::date AND ${col} IS NULL`,
    isYoutube ? [date, videoId] : [date],
  );
  if ((rowCount ?? 0) > 0) return { updated: rowCount ?? 0, alreadySet: false };
  const { rows } = await pool.query('SELECT COUNT(*) AS n FROM parlay_log WHERE date = $1::date', [date]);
  if (Number(rows[0]?.n ?? 0) === 0) throw httpErr(404, `No frozen parlays for ${date}`, 'NOT_FROZEN');
  return { updated: 0, alreadySet: true };
}
