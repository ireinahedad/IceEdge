/**
 * trackRecord.service.ts — bilan PUBLIC des meilleurs paris (2026-11-21).
 *
 * Demande du user : sur /pro, montrer que les meilleurs paris marchent
 * « cette semaine », pas seulement sur l'historique d'évaluation. Version
 * prudente choisie : un TAUX DE RÉUSSITE sur les 7 derniers jours complets,
 * sans argent (pas de ROI, pas de mise) — la règle d'octobre « pas de ROI en
 * public » tient toujours.
 *
 * Ce qui compte : le top N de chaque jour (`best_rank <= N`, même définition
 * que /dev/profit), réglé win/loss par `settlePendingBestBets` sur les
 * résultats officiels. `void` et `pending` sont exclus du taux, et comptés à
 * part pour que rien ne soit caché. Aucun filtre sur le résultat : le chiffre
 * s'affiche qu'il soit bon ou mauvais (le client le masque seulement sous un
 * échantillon minimal, où il ne voudrait rien dire).
 *
 * Coût : un règlement borné + un agrégat, gardés 15 min en mémoire. La route
 * est publique et cachée côté CDN (agrégat identique pour tous).
 */

import { pool } from '../db/connection';
import { logger } from '../logger';
import { settlePendingBestBets } from './bestBetLog.service';

export const TRACK_TOP_N = 10;
export const TRACK_DAYS  = 7;
/** En dessous, le taux ne dit rien : le client n'affiche pas le bloc. */
export const TRACK_MIN_SAMPLE = 20;

export interface TrackRecord {
  from: string;            // AAAA-MM-JJ, jour NHL (heure de l'Est), inclus
  to:   string;
  topN: number;
  wins: number;
  losses: number;
  voids: number;
  pending: number;
  /** Probabilité moyenne annoncée (dernier affichage avant le match), en %. */
  avgSaidPct: number | null;
  /** Taux de réussite, en % (wins / (wins + losses)). */
  hitPct: number | null;
  enough: boolean;
  generatedAt: string;
  /** Diagnostic du dernier règlement (lignes examinées / réglées, erreur). */
  settle: { checked: number; settled: number; error?: string };
}

function etDay(offsetDays: number): string {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

const TTL_MS = 15 * 60_000;
let cached: { at: number; value: TrackRecord } | null = null;
let inflight: Promise<TrackRecord> | null = null;

async function compute(): Promise<TrackRecord> {
  // Les 7 derniers jours COMPLETS : hier et les 6 d'avant.
  const to   = etDay(-1);
  const from = etDay(-TRACK_DAYS);

  let settle: TrackRecord['settle'] = { checked: 0, settled: 0 };
  try {
    // Seulement la fenêtre affichée : voir `settlePendingBestBets`.
    settle = await settlePendingBestBets(300, { from, to });
  } catch (err) {
    // API NHL muette : on lit ce qui est déjà réglé.
    logger.warn({ err }, '[track-record] settlement failed');
    settle = { checked: 0, settled: 0, error: err instanceof Error ? err.message.slice(0, 120) : 'error' };
  }

  const { rows } = await pool.query<{ outcome: string; n: string; avg_said: string | null }>(
    `SELECT outcome, COUNT(*) AS n, AVG(last_score) AS avg_said
       FROM best_bet_log
      WHERE game_date BETWEEN $1::date AND $2::date
        AND best_rank <= $3
      GROUP BY outcome`,
    [from, to, TRACK_TOP_N],
  );

  const by = (o: string) => Number(rows.find((r) => r.outcome === o)?.n ?? 0);
  const wins = by('win'), losses = by('loss');
  const settled = wins + losses;
  let saidSum = 0;
  for (const r of rows) {
    if ((r.outcome === 'win' || r.outcome === 'loss') && r.avg_said != null) {
      saidSum += Number(r.avg_said) * Number(r.n);
    }
  }
  const round1 = (x: number) => Math.round(x * 10) / 10;

  return {
    from, to, topN: TRACK_TOP_N,
    wins, losses, voids: by('void'), pending: by('pending'),
    avgSaidPct: settled ? round1(saidSum / settled) : null,
    hitPct:     settled ? round1((wins / settled) * 100) : null,
    enough:     settled >= TRACK_MIN_SAMPLE,
    generatedAt: new Date().toISOString(),
    settle,
  };
}

export async function getTrackRecord(): Promise<TrackRecord> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  if (inflight) return inflight;
  inflight = compute()
    .then((value) => { cached = { at: Date.now(), value }; return value; })
    .finally(() => { inflight = null; });
  return inflight;
}
