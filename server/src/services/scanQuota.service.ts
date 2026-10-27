/**
 * scanQuota.service.ts — « Scanner un ticket » : 3 scans gratuits par jour, illimité en Pro.
 *
 * SCAN_TICKET_PLAN § 9 (D2), tranché par le user le 2026-10-27 : 3 PAR JOUR (jour UTC,
 * même horloge que les appels gratuits du Bet builder IA, `llm_free_daily`).
 *
 * Même construction que `consumeFreeParse` (llmQuota.service.ts) : l'incrément et le
 * contrôle dans le MÊME énoncé (`ON CONFLICT … WHERE count < limite`), donc deux
 * scans simultanés ne passent jamais tous les deux au-delà de la limite. Base
 * injoignable → refus (`reason: 'db'`) : on ne donne pas d'accès gratuit à l'aveugle.
 *
 * Pas de disjoncteur global : un scan ne coûte rien à l'opérateur (OCR sur l'appareil).
 * Le repli LLM des blocs illisibles passe par `parse_bet_command` et ses PROPRES quotas.
 */

import { pool } from '../db/connection';
import { logger } from '../logger';
import { currentDay, nextDayResetISO } from './llmQuota.service';

const n = Number(process.env.SCAN_FREE_DAILY);
/** Scans gratuits par jour et par compte (`SCAN_FREE_DAILY`, 3 par défaut). */
export const SCAN_FREE_DAILY = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;

export interface ScanVerdict {
  allowed: boolean;
  /** `user` = les scans gratuits du jour sont épuisés ; `db` = base injoignable. */
  reason?: 'user' | 'db';
  pro: boolean;
  /** Scans gratuits utilisés aujourd'hui (0 pour Pro). */
  used: number;
  /** null = illimité (Pro). */
  limit: number | null;
  resetsAt: string;
}

/** Consomme un scan. Pro : toujours permis, rien n'est compté. */
export async function consumeScan(userId: string, pro: boolean, now: Date = new Date()): Promise<ScanVerdict> {
  const resetsAt = nextDayResetISO(now);
  if (pro) return { allowed: true, pro: true, used: 0, limit: null, resetsAt };
  const day = currentDay(now);
  try {
    const r = await pool.query(
      `INSERT INTO slip_scan_daily (user_id, day, count, updated_at)
            VALUES ($1, $2, 1, NOW())
       ON CONFLICT (user_id, day) DO UPDATE
             SET count = slip_scan_daily.count + 1, updated_at = NOW()
           WHERE slip_scan_daily.count < $3
       RETURNING count`,
      [userId, day, SCAN_FREE_DAILY],
    );
    // Limite à 0 : l'INSERT passe toujours la première fois — on le refuse ici.
    if (r.rowCount === 0 || SCAN_FREE_DAILY === 0) {
      return { allowed: false, reason: 'user', pro: false, used: SCAN_FREE_DAILY, limit: SCAN_FREE_DAILY, resetsAt };
    }
    return { allowed: true, pro: false, used: r.rows[0].count, limit: SCAN_FREE_DAILY, resetsAt };
  } catch (err) {
    logger.error({ err }, '[scanQuota] compteur injoignable — scan gratuit refusé');
    return { allowed: false, reason: 'db', pro: false, used: 0, limit: SCAN_FREE_DAILY, resetsAt };
  }
}

/** Rend un scan (l'analyse n'a pas pu démarrer côté client). Best-effort. */
export async function refundScan(userId: string, now: Date = new Date()): Promise<void> {
  try {
    await pool.query(
      `UPDATE slip_scan_daily SET count = GREATEST(count - 1, 0), updated_at = NOW() WHERE user_id = $1 AND day = $2`,
      [userId, currentDay(now)],
    );
  } catch (err) {
    logger.warn({ err }, '[scanQuota] remboursement impossible');
  }
}

/** État du jour, pour l'écran (« 2 scans gratuits restants aujourd'hui »). */
export async function getScanUsage(userId: string, pro: boolean, now: Date = new Date()):
  Promise<{ pro: boolean; used: number; limit: number | null; remaining: number | null; resetsAt: string }> {
  const resetsAt = nextDayResetISO(now);
  if (pro) return { pro: true, used: 0, limit: null, remaining: null, resetsAt };
  const r = await pool.query('SELECT count FROM slip_scan_daily WHERE user_id = $1 AND day = $2', [userId, currentDay(now)]);
  const used = Math.min(r.rows[0]?.count ?? 0, SCAN_FREE_DAILY);
  return { pro: false, used, limit: SCAN_FREE_DAILY, remaining: SCAN_FREE_DAILY - used, resetsAt };
}
