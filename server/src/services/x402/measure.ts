/**
 * measure.ts — décision à 60 jours (X402_PLAN.md, phase 5). Logique pure : les
 * paiements reçus sur la chaîne → qui paie, combien, à quel rythme, et ce que
 * dit le tableau de décision du plan. Le script `scripts/x402-measure.ts` lit la
 * chaîne et appelle `analyze`.
 *
 * Règles (jugement, pas référence du marché — plan §6, phase 5) :
 *   • seuls comptent les paiements x402 (USDC `transferWithAuthorization`, EIP-3009) ;
 *     les autres virements vers le portefeuille vendeur sont listés à part ;
 *   • les portefeuilles d'Ireina sont exclus de tout ;
 *   • un payeur unique = « une fois » ; un payeur à rythme fixe (écart régulier entre
 *     paiements) ou concentré sur un seul jour = « contrôleur » ; sinon « revient » ;
 *   • continuer si un payeur qui revient est actif sur ≥ 10 jours de match, ou si les
 *     4 dernières semaines complètes font ≥ 10 $/semaine en moyenne.
 */

export const USDC_DECIMALS = 6;

export interface Payment {
  tx: string;
  block: number;
  timeMs: number;
  from: string;       // minuscules
  amount: bigint;     // unités atomiques USDC
  x402: boolean;      // transferWithAuthorization (AuthorizationUsed dans la même transaction)
}

export type PayerKind = 'single' | 'checker' | 'returning';

export interface PayerStats {
  address: string;
  kind: PayerKind;
  payments: number;
  usd: number;
  activeDays: number;   // jours de match distincts (heure de l'Est)
  first: string;
  last: string;
  medianIntervalHours: number | null;
  intervalCv: number | null;  // écart-type / moyenne des intervalles : bas = rythme fixe
}

export type Verdict = 'continue' | 'keep_running_review_in_6_months' | 'cut_paid_routes_keep_record';

const usd = (a: bigint) => Number(a) / 10 ** USDC_DECIMALS;
const r2 = (x: number) => Math.round(x * 100) / 100;
export const etDay = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/** Coefficient de variation sous lequel un rythme est jugé « fixe ». */
export const REGULAR_CV = 0.15;
export const CONTINUE_ACTIVE_DAYS = 10;
export const CONTINUE_USD_PER_WEEK = 10;

function intervals(times: number[]) {
  const out: number[] = [];
  for (let i = 1; i < times.length; i++) out.push(times[i] - times[i - 1]);
  return out;
}
function median(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function cv(xs: number[]) {
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (mean === 0) return 0;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return sd / mean;
}

export function classify(times: number[]): Pick<PayerStats, 'kind' | 'medianIntervalHours' | 'intervalCv' | 'activeDays'> {
  const sorted = [...times].sort((a, b) => a - b);
  const days = new Set(sorted.map(etDay)).size;
  const iv = intervals(sorted);
  const c = cv(iv);
  const med = median(iv);
  let kind: PayerKind;
  if (sorted.length === 1) kind = 'single';
  else if (days <= 1 || (sorted.length >= 3 && c != null && c < REGULAR_CV)) kind = 'checker';
  else kind = 'returning';
  return { kind, activeDays: days, medianIntervalHours: med == null ? null : r2(med / 3_600_000), intervalCv: c == null ? null : Math.round(c * 1000) / 1000 };
}

/** Lundi 00:00 UTC de la semaine du timestamp. */
const weekStart = (ms: number) => {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.getTime();
};

export function analyze(payments: Payment[], opts: { exclude: string[]; nowMs: number }) {
  const exclude = new Set(opts.exclude.map((a) => a.toLowerCase()));
  const x402 = payments.filter((p) => p.x402);
  const other = payments.filter((p) => !p.x402);
  const own = x402.filter((p) => exclude.has(p.from));
  const ext = x402.filter((p) => !exclude.has(p.from));

  const byPayer = new Map<string, Payment[]>();
  for (const p of ext) byPayer.set(p.from, [...(byPayer.get(p.from) ?? []), p]);
  const payers: PayerStats[] = [...byPayer].map(([address, ps]) => {
    const times = ps.map((p) => p.timeMs).sort((a, b) => a - b);
    return {
      address,
      ...classify(times),
      payments: ps.length,
      usd: r2(usd(ps.reduce((a, p) => a + p.amount, 0n))),
      first: new Date(times[0]).toISOString(),
      last: new Date(times[times.length - 1]).toISOString(),
    };
  }).sort((a, b) => b.usd - a.usd || b.payments - a.payments);

  // 4 dernières semaines COMPLÈTES (la semaine en cours est exclue).
  const thisWeek = weekStart(opts.nowMs);
  const weeks = [4, 3, 2, 1].map((k) => {
    const start = thisWeek - k * 7 * 86_400_000;
    const ps = ext.filter((p) => p.timeMs >= start && p.timeMs < start + 7 * 86_400_000);
    return { weekStart: new Date(start).toISOString().slice(0, 10), payments: ps.length, payers: new Set(ps.map((p) => p.from)).size, usd: r2(usd(ps.reduce((a, p) => a + p.amount, 0n))) };
  });
  const avgWeekUsd = r2(weeks.reduce((a, w) => a + w.usd, 0) / weeks.length);

  const returning = payers.filter((p) => p.kind === 'returning');
  let verdict: Verdict;
  let reason: string;
  if (returning.some((p) => p.activeDays >= CONTINUE_ACTIVE_DAYS) || avgWeekUsd >= CONTINUE_USD_PER_WEEK) {
    verdict = 'continue';
    reason = avgWeekUsd >= CONTINUE_USD_PER_WEEK
      ? `${avgWeekUsd} $/semaine en moyenne sur 4 semaines (seuil ${CONTINUE_USD_PER_WEEK} $)`
      : `un payeur qui revient est actif sur ≥ ${CONTINUE_ACTIVE_DAYS} jours de match`;
  } else if (payers.length > 0) {
    verdict = 'keep_running_review_in_6_months';
    reason = `${payers.length} payeur(s) extérieur(s), dont ${returning.length} qui revien(nen)t, aucun seuil atteint`;
  } else {
    verdict = 'cut_paid_routes_keep_record';
    reason = 'aucun payeur extérieur';
  }

  return {
    totals: { payments: ext.length, usd: r2(usd(ext.reduce((a, p) => a + p.amount, 0n))), payers: payers.length,
      byKind: { returning: returning.length, checker: payers.filter((p) => p.kind === 'checker').length, single: payers.filter((p) => p.kind === 'single').length } },
    excluded: { payments: own.length, usd: r2(usd(own.reduce((a, p) => a + p.amount, 0n))) },
    nonX402Transfers: other.map((p) => ({ tx: p.tx, from: p.from, usd: usd(p.amount), at: new Date(p.timeMs).toISOString() })),
    weeks,
    avgWeekUsd,
    payers,
    verdict,
    reason,
    note: 'Le coût d\'entretien (3e ligne du tableau du plan) ne se mesure pas sur la chaîne : à juger par Ireina.',
  };
}
