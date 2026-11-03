/**
 * format.ts — réponses de l'API pour agents, en LISTE BLANCHE (X402_PLAN.md §5).
 *
 * Le paquet ML sert aussi le site et pourrait un jour porter des données
 * dérivées des cotes : il n'est JAMAIS relayé. Chaque champ rendu est nommé ici.
 * Logique pure : les accès (calendrier, paquet ML, base) sont dans `feed.service.ts`.
 */

import { preMatchProb, toScheduleGame, type ScheduleGame } from '../modelSnapshots';
import type { MLPredictionResult } from '../mlApiClient';

export const SOURCE = 'arakiceML, independent of market odds';
export const DISCLAIMER = 'Model estimate. Not financial, legal or betting advice.';
export const NOT_CHECKED = ['market prices', 'whether any bet is wise, legal or available'] as const;
export const MAX_GAMES = 20;
/** Jours servis par `/v1/nhl/games` : aujourd'hui (heure de l'Est) et les deux suivants. */
export const MAX_DAYS_AHEAD = 2;

const r4 = (p: number) => Math.round(p * 1e4) / 1e4;

export interface AgentGame {
  gameId: string;
  home: string;
  away: string;
  startTimeUTC: string;
  status: 'scheduled';
  probabilities: { homeWin: number; homeMinus1_5: number | null; awayMinus1_5: number | null };
  goalies: { home: string | null; away: string | null; confirmed: boolean };
  asOf: string;
}

export interface AgentGamesBody {
  date: string;
  games: AgentGame[];
  /** Matchs du jour non rendus : commencés, finis, reportés. Cette API est d'avant-match seulement. */
  excluded: Array<{ gameId: string; home: string; away: string; reason: 'started' | 'not_scheduled' }>;
  modelVersion: string | null;
  asOf: string;
  source: typeof SOURCE;
  notChecked: readonly string[];
  disclaimer: typeof DISCLAIMER;
}

type Key = (market: string, line: number | null, selection: string | null, subjectIsHome: boolean) => string;
interface BundleLike { live?: unknown; generatedAt: string; byKey: Record<string, MLPredictionResult | null> }

/** Le calendrier du jour, coupé entre matchs à rendre et matchs exclus. */
export function splitSchedule(raw: any[], now: number): { upcoming: ScheduleGame[]; excluded: AgentGamesBody['excluded'] } {
  const upcoming: ScheduleGame[] = [];
  const excluded: AgentGamesBody['excluded'] = [];
  for (const g of raw.map(toScheduleGame)) {
    if (!g) continue;
    if (g.status === 'live' || g.status === 'final' || g.startMs <= now) {
      excluded.push({ gameId: g.id, home: g.home, away: g.away, reason: 'started' });
    } else if (g.status !== 'scheduled') {
      excluded.push({ gameId: g.id, home: g.home, away: g.away, reason: 'not_scheduled' });
    } else {
      upcoming.push(g);
    }
  }
  upcoming.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
  return { upcoming, excluded };
}

/**
 * Un match, ou `null` si le modèle ne peut pas le chiffrer proprement : paquet
 * en direct, victoire absente, ou chiffre de REPLI (classifieur qui lit les
 * cotes — `preMatchProb` le refuse). Un `null` fait échouer toute la réponse
 * (503, donc aucun débit) : on ne vend pas une journée incomplète.
 */
export function agentGame(
  g: ScheduleGame, bundle: BundleLike, key: Key,
  goalies: { home?: string | null; away?: string | null },
): { game: AgentGame; modelVersion: string | null } | null {
  if (bundle.live) return null;
  const ml = bundle.byKey[key('moneyline', null, null, true)];
  const homeWin = preMatchProb(ml);
  if (homeWin == null) return null;
  const minus = (isHome: boolean) => {
    const p = preMatchProb(bundle.byKey[key('puck_line', -1.5, null, isHome)]);
    return p == null ? null : r4(p);
  };
  const home = goalies.home ? String(goalies.home).slice(0, 60) : null;
  const away = goalies.away ? String(goalies.away).slice(0, 60) : null;
  return {
    game: {
      gameId: g.id, home: g.home, away: g.away,
      startTimeUTC: new Date(g.startMs).toISOString(),
      status: 'scheduled',
      probabilities: { homeWin: r4(homeWin), homeMinus1_5: minus(true), awayMinus1_5: minus(false) },
      goalies: { home, away, confirmed: Boolean(home && away) },
      asOf: new Date(bundle.generatedAt).toISOString(),
    },
    modelVersion: ml?.model_version ? String(ml.model_version).slice(0, 64) : null,
  };
}

export function gamesBody(date: string, games: Array<{ game: AgentGame; modelVersion: string | null }>,
                          excluded: AgentGamesBody['excluded']): AgentGamesBody {
  const asOf = games.reduce((m, g) => (g.game.asOf > m ? g.game.asOf : m), games[0]?.game.asOf ?? new Date(0).toISOString());
  return {
    date,
    games: games.map((g) => g.game),
    excluded,
    modelVersion: games.find((g) => g.modelVersion)?.modelVersion ?? null,
    asOf,
    source: SOURCE,
    notChecked: NOT_CHECKED,
    disclaimer: DISCLAIMER,
  };
}

/** Dates admises : aujourd'hui (heure de l'Est) à +MAX_DAYS_AHEAD jours. */
export function allowedDates(todayET: string): string[] {
  const out: string[] = [];
  for (let i = 0; i <= MAX_DAYS_AHEAD; i++) {
    const d = new Date(`${todayET}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// ── /v1/nhl/results ─────────────────────────────────────────────────────────

export interface SettledRow {
  gameId: string; home: string; away: string; startTimeUTC: string; recordedAt: string;
  homeWin: number; homeMinus: number | null; awayMinus: number | null;
  homeScore: number; awayScore: number; proofCommit: string | null;
}

export interface Metric { n: number; logLoss: number | null; brier: number | null }
const EPS = 1e-6;

function metric(pairs: Array<[number, boolean]>): Metric {
  if (pairs.length === 0) return { n: 0, logLoss: null, brier: null };
  let ll = 0, br = 0;
  for (const [p0, y] of pairs) {
    const p = Math.min(1 - EPS, Math.max(EPS, p0));
    ll += -(y ? Math.log(p) : Math.log(1 - p));
    br += (p - (y ? 1 : 0)) ** 2;
  }
  const n = pairs.length;
  return { n, logLoss: Math.round((ll / n) * 1e5) / 1e5, brier: Math.round((br / n) * 1e5) / 1e5 };
}

/** Calibration de la victoire domicile en 10 tranches de 0,1 (tranches vides omises). */
function calibration(pairs: Array<[number, boolean]>) {
  const bins = Array.from({ length: 10 }, () => ({ n: 0, sumP: 0, wins: 0 }));
  for (const [p, y] of pairs) {
    const b = bins[Math.min(9, Math.floor(p * 10))];
    b.n++; b.sumP += p; if (y) b.wins++;
  }
  return bins.flatMap((b, i) => (b.n === 0 ? [] : [{
    bin: `${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}`,
    n: b.n,
    meanPredicted: Math.round((b.sumP / b.n) * 1e4) / 1e4,
    observed: Math.round((b.wins / b.n) * 1e4) / 1e4,
  }]));
}

/**
 * Bilan : précision et calibration seulement. Pas de cote, pas de ROI, pas de
 * comparaison au marché (décision D4, X402_PLAN.md §3).
 */
export function resultsBody(kind: 'morning' | 'pregame', rows: SettledRow[], proofRepo: string, limit: number) {
  const win: Array<[number, boolean]> = rows.map((r) => [r.homeWin, r.homeScore > r.awayScore]);
  const hm: Array<[number, boolean]> = rows.flatMap((r) => (r.homeMinus == null ? [] : [[r.homeMinus, r.homeScore - r.awayScore >= 2] as [number, boolean]]));
  const am: Array<[number, boolean]> = rows.flatMap((r) => (r.awayMinus == null ? [] : [[r.awayMinus, r.awayScore - r.homeScore >= 2] as [number, boolean]]));
  const correct = win.filter(([p, y]) => (p >= 0.5) === y).length;
  return {
    kind,
    description: kind === 'morning'
      ? 'Probabilities committed to a public git repository before each game; only games still upcoming at push time.'
      : 'Last model update in the hour before each game (not publicly timestamped).',
    proofRepository: kind === 'morning' ? `https://github.com/${proofRepo}` : null,
    summary: {
      games: rows.length,
      homeWin: { ...metric(win), accuracy: rows.length ? Math.round((correct / rows.length) * 1e4) / 1e4 : null },
      homeMinus1_5: metric(hm),
      awayMinus1_5: metric(am),
      calibrationHomeWin: calibration(win),
    },
    games: rows.slice(0, limit).map((r) => ({
      gameId: r.gameId, home: r.home, away: r.away, startTimeUTC: r.startTimeUTC, recordedAt: r.recordedAt,
      probabilities: { homeWin: r.homeWin, homeMinus1_5: r.homeMinus, awayMinus1_5: r.awayMinus },
      result: { homeScore: r.homeScore, awayScore: r.awayScore },
      proof: r.proofCommit ? `https://github.com/${proofRepo}/commit/${r.proofCommit}` : null,
    })),
    source: SOURCE,
    disclaimer: DISCLAIMER,
  };
}
