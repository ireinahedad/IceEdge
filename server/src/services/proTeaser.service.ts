/**
 * proTeaser.service.ts — agrégat PUBLIC des deux blocs de vente de /pro
 * (2026-11-22, demande du user).
 *
 * Depuis le 2026-11-20, `/api/predict/*` et `/api/leaderboard` exigent un
 * compte : un visiteur déconnecté de /pro — celui que la page doit convaincre —
 * ne voyait plus ni « les paris de ce soir » ni le top 3 du classement. Cette
 * route lui rend une vitrine, et RIEN qui ait de la valeur en soi :
 *
 *   tonight — le nombre de meilleurs paris à venir et les 3 plus probables :
 *             marché, match (« VIS @ DOM ») et probabilité. Jamais le choix,
 *             ni `label`/`selection`/`subjectName`/`teamAbbr`, ni `context` :
 *             « vs NYR » révèle de quel côté porte le pari. Le match est donc
 *             réécrit en neutre depuis `game`.
 *           + le nombre de combinés du jour et combien sont gratuits.
 *   leaders — le top 3 du classement : nom affiché, taux de réussite, nombre
 *             de paris. Pas d'identifiant, pas d'avatar, pas de coupon.
 *
 * Coût : lit les caches existants (best-bets, best-parlays, classement) ; le
 * résultat est identique pour tous, donc caché 60 s en mémoire et côté CDN.
 * Chaque moitié échoue seule : un ML en panne n'efface pas le classement.
 */

import { getBestBets } from './bestBets.service';
import { getBestParlays, gateBestParlays } from './bestParlays.service';
import { getLeaderboard } from './profile.service';
import { logger } from '../logger';

export interface TeaserBet {
  id:           string;
  marketType:   string;
  marketLabel:  string;
  /** « VIS @ DOM », neutre : ne dit pas de quel côté porte le pari. */
  matchup:      string | null;
  startTimeUTC: string | null;
  pct:          number;
}

export interface ProTeaser {
  tonight: { count: number; bets: TeaserBet[]; parlays: { total: number; free: number } | null } | null;
  leaders: { rank: number; name: string; hitRate: number; totalBets: number }[];
}

const TTL_MS = 60_000;
let cached: { at: number; value: ProTeaser } | null = null;
let inflight: Promise<ProTeaser> | null = null;

async function computeTonight(now: number): Promise<ProTeaser['tonight']> {
  const [bets, parlays] = await Promise.allSettled([
    getBestBets({ limit: 30, source: 'ml' }),
    getBestParlays(),
  ]);
  if (bets.status !== 'fulfilled') {
    logger.warn({ err: bets.reason }, '[pro-teaser] best-bets indisponible');
    return null;
  }
  const upcoming = bets.value.bets.filter((b) => {
    const start = b.game?.startTimeUTC ? Date.parse(b.game.startTimeUTC) : NaN;
    return !Number.isFinite(start) || start > now;
  });
  const top = [...upcoming]
    .sort((a, b) => (b.mlPct ?? b.rulePct) - (a.mlPct ?? a.rulePct))
    .slice(0, 3)
    .map((b): TeaserBet => ({
      id:           b.id,
      marketType:   b.marketType,
      marketLabel:  b.marketLabel,
      matchup:      b.game ? `${b.game.away} @ ${b.game.home}` : null,
      startTimeUTC: b.game?.startTimeUTC ?? null,
      pct:          Math.round(b.mlPct ?? b.rulePct),
    }));
  let p: { total: number; free: number } | null = null;
  if (parlays.status === 'fulfilled') {
    const meta = gateBestParlays(parlays.value, false).meta;
    if (typeof meta.total === 'number' && typeof meta.freeCount === 'number') {
      p = { total: meta.total, free: meta.freeCount };
    }
  }
  return { count: upcoming.length, bets: top, parlays: p };
}

async function computeLeaders(): Promise<ProTeaser['leaders']> {
  try {
    const list = await getLeaderboard();
    return list
      .filter((e) => e.totalBets > 0)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 3)
      .map((e) => ({
        rank:      e.rank,
        name:      e.displayName || e.username,
        hitRate:   e.hitRate,
        totalBets: e.totalBets,
      }));
  } catch (err) {
    logger.warn({ err }, '[pro-teaser] classement indisponible');
    return [];
  }
}

async function compute(): Promise<ProTeaser> {
  const now = Date.now();
  const [tonight, leaders] = await Promise.all([
    computeTonight(now).catch((err) => { logger.warn({ err }, '[pro-teaser] tonight'); return null; }),
    computeLeaders(),
  ]);
  return { tonight, leaders };
}

export async function getProTeaser(): Promise<ProTeaser> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  if (inflight) return inflight;
  inflight = compute()
    .then((value) => { cached = { at: Date.now(), value }; return value; })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Tests seulement. */
export function _resetProTeaserCache() { cached = null; inflight = null; }
