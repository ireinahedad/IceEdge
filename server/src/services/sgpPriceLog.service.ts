/**
 * sgpPriceLog.service.ts — journal ANONYME des prix SGP (plan « The Parlay Tax Engine »).
 *
 * Après « Analyser ce ticket », le client envoie chaque SGP entièrement chiffré :
 * match, bookmaker, cote payée, marchés des jambes, probabilité du modèle. Une ligne
 * par SGP dans `sgp_price_log` (migration 052).
 *
 * Sans lien avec le compte : la route exige d'être connecté (sinon n'importe qui
 * remplit la table), mais RIEN de l'utilisateur n'arrive ici — ni id, ni IP, ni
 * mise. L'heure est arrondie à l'heure. Voir l'en-tête de la migration.
 *
 * Le serveur recalcule ce qui se recalcule (cote décimale, proba implicite, taxe,
 * produit naïf des jambes) ; il ne reprend du client que la probabilité du modèle,
 * qu'il ne peut pas refaire sans rappeler le ML.
 *
 * Best-effort : une base injoignable ne casse jamais le scan (le client n'attend rien).
 */

import crypto from 'crypto';
import { z } from 'zod';
import { pool } from '../db/connection';
import { logger } from '../logger';
import { oddsToDecimal, oddsFormatOf } from './slipScan';
import { priceVerdict } from './slipScanValue';

const id = z.string().trim().regex(/^[A-Za-z0-9_.-]{1,40}$/);
const pct = z.number().finite().gt(0).lt(100);

const legSchema = z.object({
  market: z.string().regex(/^[a-z0-9_]{2,40}$/),
  subjectType: z.enum(['team', 'player', 'game']),
  subjectId: id,
  selection: z.string().trim().min(1).max(40),
  line: z.number().finite().min(-50).max(500).optional(),
  modelPct: pct,
});

const groupSchema = z.object({
  gameId: id,
  odds: z.string().trim().min(2).max(12),
  modelPct: pct,
  modelSource: z.enum(['server', 'local']),
  legs: z.array(legSchema).min(2).max(12),
});

export const sgpPriceLogSchema = z.object({
  book: z.enum(['bet365', 'draftkings', 'other']),
  lang: z.enum(['fr', 'en']).nullable().optional(),
  oddsFormat: z.enum(['american', 'decimal', 'fractional']).nullable().optional(),
  groups: z.array(groupSchema).min(1).max(10),
});

export type SgpPriceLogBody = z.infer<typeof sgpPriceLogSchema>;
type Group = SgpPriceLogBody['groups'][number];

export interface SgpPriceRow {
  fingerprint: string;
  loggedHour: string;
  gameId: string;
  bookmaker: SgpPriceLogBody['book'];
  lang: 'fr' | 'en' | null;
  oddsFormat: 'american' | 'decimal' | 'fractional' | null;
  paidOdds: string;
  paidDecimal: number;
  impliedPct: number;
  modelPct: number;
  modelSource: 'server' | 'local';
  independentPct: number;
  taxPct: number;
  nLegs: number;
  marketKey: string;
  legs: Group['legs'];
}

/** Début de l'heure UTC (anonymat : pas de recoupement à la minute). */
export function hourOf(now: Date): string {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

const legKey = (l: Group['legs'][number]) =>
  [l.market, l.subjectType, l.subjectId.toLowerCase(), l.selection.toLowerCase(), l.line ?? ''].join('|');

/** Empreinte du SGP : même match, même livre, même cote, mêmes jambes (dans n'importe quel ordre). */
export function fingerprintOf(book: string, g: Group, paidDecimal: number): string {
  const legs = g.legs.map(legKey).sort();
  return crypto.createHash('sha256')
    .update(JSON.stringify([g.gameId, book, paidDecimal.toFixed(3), legs]))
    .digest('hex');
}

/** Un groupe → une ligne, ou null si la cote est illisible ou le verdict impossible. Pur. */
export function toRow(body: SgpPriceLogBody, g: Group, now: Date = new Date()): SgpPriceRow | null {
  const paidDecimal = oddsToDecimal(g.odds);
  if (!paidDecimal || paidDecimal <= 1 || paidDecimal > 100_000) return null;
  const v = priceVerdict(g.modelPct, paidDecimal);
  if (!v) return null;
  const independent = g.legs.reduce((acc, l) => acc * (l.modelPct / 100), 1) * 100;
  return {
    fingerprint: fingerprintOf(body.book, g, paidDecimal),
    loggedHour: hourOf(now),
    gameId: g.gameId,
    bookmaker: body.book,
    lang: body.lang ?? null,
    oddsFormat: body.oddsFormat ?? oddsFormatOf(g.odds),
    paidOdds: g.odds,
    paidDecimal: Math.round(paidDecimal * 1000) / 1000,
    impliedPct: v.impliedPct,
    modelPct: Math.round(g.modelPct * 100) / 100,
    modelSource: g.modelSource,
    independentPct: Math.round(independent * 1000) / 1000,
    taxPct: v.taxPct,
    nLegs: g.legs.length,
    marketKey: [...new Set(g.legs.map((l) => l.market))].sort().join('+'),
    legs: g.legs.map((l) => ({
      market: l.market, subjectType: l.subjectType, subjectId: l.subjectId, selection: l.selection,
      ...(l.line !== undefined ? { line: l.line } : {}), modelPct: l.modelPct,
    })),
  };
}

/** Écrit les SGP du ticket. Même SGP au même prix déjà vu → `seen_count` + 1. */
export async function logSgpPrices(body: SgpPriceLogBody, now: Date = new Date()): Promise<{ logged: number; skipped: number }> {
  const rows = body.groups.map((g) => toRow(body, g, now)).filter((r): r is SgpPriceRow => !!r);
  let logged = 0;
  for (const r of rows) {
    try {
      await pool.query(
        `INSERT INTO sgp_price_log
           (fingerprint, logged_hour, game_id, bookmaker, lang, odds_format, paid_odds, paid_decimal,
            implied_pct, model_pct, model_source, independent_pct, tax_pct, n_legs, market_key, legs, last_seen_hour)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$2)
         ON CONFLICT (fingerprint) DO UPDATE
           SET seen_count = sgp_price_log.seen_count + 1, last_seen_hour = EXCLUDED.last_seen_hour`,
        [r.fingerprint, r.loggedHour, r.gameId, r.bookmaker, r.lang, r.oddsFormat, r.paidOdds, r.paidDecimal,
         r.impliedPct, r.modelPct, r.modelSource, r.independentPct, r.taxPct, r.nLegs, r.marketKey, JSON.stringify(r.legs)],
      );
      logged++;
    } catch (err) {
      logger.warn({ err }, '[sgpPriceLog] ligne non écrite');
    }
  }
  return { logged, skipped: body.groups.length - logged };
}
