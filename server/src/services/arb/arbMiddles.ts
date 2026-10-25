/**
 * arbMiddles.ts — « Middles » : deux paris opposés à des lignes DIFFÉRENTES,
 * qui gagnent TOUS LES DEUX si le score tombe dans la fenêtre entre les lignes.
 *
 *   Over 5.5 (livre A) + Under 6.5 (livre B)   → les deux gagnent à 6 buts pile
 *   Toronto −1.5 (A)   + Boston +2.5 (B)       → les deux gagnent si TOR gagne par 2 pile
 *
 * Hors de la fenêtre, un seul pari gagne : avec des mises qui égalisent les
 * paiements, on perd un peu (Σ − 1 de la mise) — sauf si Σ < 1, et alors c'est
 * un arbitrage SANS RISQUE avec un bonus si la fenêtre tombe (le scanner
 * d'arbitrages, qui n'apparie que des lignes identiques, ne le voit pas).
 *
 * PAS SANS RISQUE en général : ce qui décide, c'est la probabilité de la
 * fenêtre. Avec des mises à paiements égaux et des demi-lignes,
 *
 *   seuil de rentabilité :  P(fenêtre) > Σ − 1
 *
 * (Σ = 1.07 → il faut plus de 7 % de chances que le score tombe pile dedans.)
 *
 * PROBABILITÉS. Deux sources, au choix de l'appelant :
 *   • arakiceML (`iceedgeDists`) — les probabilités PUBLIÉES par l'app
 *     (`GET /api/nhl/predictions/game/:id`) : P(Over 2.5…7.5), moneyline et
 *     puck lines ±1.5/2.5/3.5, score FINAL prolongation et fusillade comprises.
 *     Les différences donnent P(total = k) et P(écart = d).
 *   • marché (`marketDists`) — loi « juste » des livres eux-mêmes : λ ajusté sur
 *     le total principal et la moneyline dé-viggés (médiane des livres), puis
 *     grille du score final de `prediction/finalScore.ts` (même moteur que l'app).
 *     Hors ligne, 0 appel réseau.
 *
 * Module pur.
 */

import { finalScoreGrid, gridSum, totalOver, FinalScoreGrid } from '../prediction/finalScore';
import { ArbEvent, arbStakes, bestRoundedStakes, impliedSum } from './arbScanner';

// ─── Lois de probabilité ─────────────────────────────────────────────────────

/** P(lo ≤ x ≤ hi) = p. Les bornes ±99 représentent les queues (« 8 buts et + »). */
export interface Bucket { lo: number; hi: number; p: number }

export interface Dists {
  /** Total de buts du score final. */
  total?: Bucket[];
  /** Écart final domicile − visiteur (jamais 0 : prolongation/fusillade). */
  margin?: Bucket[];
  source: string;
}

const TAIL = 99;

function normalize(b: Bucket[]): Bucket[] {
  const clean = b.map((x) => ({ ...x, p: Math.max(0, x.p) }));
  const s = clean.reduce((a, x) => a + x.p, 0);
  return s > 0 ? clean.map((x) => ({ ...x, p: x.p / s })) : clean;
}

/** Probabilité d'une valeur exacte (ou d'un intervalle) dans une loi en seaux. */
export function probIn(b: Bucket[], lo: number, hi: number): number {
  return b.filter((x) => x.lo >= lo && x.hi <= hi).reduce((a, x) => a + x.p, 0);
}

type Group = { id?: string; options?: Array<{ id?: string; rulePct?: number }> };

/**
 * Loi arakiceML à partir de la réponse de `GET /api/nhl/predictions/game/:id`
 * (tableau de MarketGroup). `null` si les marchés attendus manquent.
 */
export function iceedgeDists(groups: unknown): Dists | null {
  if (!Array.isArray(groups)) return null;
  const pct = (gid: string, oid: string): number | null => {
    const g = (groups as Group[]).find((x) => x?.id === gid);
    const v = g?.options?.find((o) => o?.id === oid)?.rulePct;
    return typeof v === 'number' && Number.isFinite(v) ? v / 100 : null;
  };
  const out: Dists = { source: 'arakiceML' };

  const O = [25, 35, 45, 55, 65, 75].map((t) => pct('totals', `o${t}`));
  if (O.every((x): x is number => x !== null)) {
    const [o25, o35, o45, o55, o65, o75] = O as number[];
    out.total = normalize([
      { lo: 0, hi: 2, p: 1 - o25 },
      { lo: 3, hi: 3, p: o25 - o35 },
      { lo: 4, hi: 4, p: o35 - o45 },
      { lo: 5, hi: 5, p: o45 - o55 },
      { lo: 6, hi: 6, p: o55 - o65 },
      { lo: 7, hi: 7, p: o65 - o75 },
      { lo: 8, hi: TAIL, p: o75 },
    ]);
  }

  const mlH = pct('moneyline', 'mw-home');
  const mlA = pct('moneyline', 'mw-away');
  const hm = [15, 25, 35].map((t) => pct('puckline', `pl-home-m${t}`));
  const am = [15, 25, 35].map((t) => pct('puckline', `pl-away-m${t}`));
  if (mlH !== null && mlA !== null && [...hm, ...am].every((x) => x !== null)) {
    const [h15, h25, h35] = hm as number[];
    const [a15, a25, a35] = am as number[];
    out.margin = normalize([
      { lo: 4, hi: TAIL, p: h35 },
      { lo: 3, hi: 3, p: h25 - h35 },
      { lo: 2, hi: 2, p: h15 - h25 },
      { lo: 1, hi: 1, p: mlH - h15 },
      { lo: -1, hi: -1, p: mlA - a15 },
      { lo: -2, hi: -2, p: a15 - a25 },
      { lo: -3, hi: -3, p: a25 - a35 },
      { lo: -TAIL, hi: -4, p: a35 },
    ]);
  }
  return out.total || out.margin ? out : null;
}

// ─── Loi du marché ───────────────────────────────────────────────────────────

const norm = (s?: string): string => (s ?? '').trim().toLowerCase();

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Racine d'une fonction croissante sur [lo, hi] (bornée aux extrémités). */
function bisect(f: (x: number) => number, lo: number, hi: number): number {
  if (f(lo) >= 0) return lo;
  if (f(hi) <= 0) return hi;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function ageOk(iso: string | undefined, now: Date, maxAgeSec: number): boolean {
  if (!maxAgeSec || !iso) return true;
  const t = Date.parse(iso);
  return !Number.isFinite(t) || (now.getTime() - t) / 1000 <= maxAgeSec;
}

export interface MarketFit {
  lambdaT: number;
  homeShare: number;
  /** Ligne du total et P(Over) juste visées par l'ajustement. */
  line?: number;
  pOver?: number;
  pHome?: number;
}

/**
 * Ajuste λ (total) et la part domicile sur les cotes dé-viggées de TOUS les
 * livres (le consensus estime la vérité ; le filtre de livres ne concerne que
 * l'endroit où l'on peut parier).
 */
export function fitMarket(ev: ArbEvent, now = new Date(), maxQuoteAgeSec = 900): MarketFit | null {
  const home = norm(ev.home_team), away = norm(ev.away_team);
  const overByLine = new Map<number, number[]>();
  const pHomes: number[] = [];

  for (const bk of ev.bookmakers ?? []) {
    for (const mk of bk.markets ?? []) {
      if (!ageOk(mk.last_update ?? bk.last_update, now, maxQuoteAgeSec)) continue;
      if (mk.key === 'totals') {
        const byLine = new Map<number, { o?: number; u?: number }>();
        for (const o of mk.outcomes ?? []) {
          if (typeof o.point !== 'number' || !(o.price > 1)) continue;
          const e = byLine.get(o.point) ?? {};
          if (norm(o.name) === 'over') e.o = o.price;
          if (norm(o.name) === 'under') e.u = o.price;
          byLine.set(o.point, e);
        }
        for (const [L, e] of byLine) {
          if (!e.o || !e.u || Number.isInteger(L)) continue;   // demi-lignes : pas de push
          const fair = (1 / e.o) / (1 / e.o + 1 / e.u);
          overByLine.set(L, [...(overByLine.get(L) ?? []), fair]);
        }
      }
      if (mk.key === 'h2h') {
        const ph = mk.outcomes?.find((o) => norm(o.name) === home)?.price;
        const pa = mk.outcomes?.find((o) => norm(o.name) === away)?.price;
        if (mk.outcomes?.length === 2 && ph && pa && ph > 1 && pa > 1) {
          pHomes.push((1 / ph) / (1 / ph + 1 / pa));
        }
      }
    }
  }

  let line: number | undefined;
  let pOver: number | undefined;
  for (const [L, fairs] of overByLine) {
    const m = median(fairs);
    const best = line === undefined ? null : overByLine.get(line)!;
    if (best === null || fairs.length > best.length
        || (fairs.length === best.length && Math.abs(m - 0.5) < Math.abs((pOver ?? 0) - 0.5))) {
      line = L; pOver = m;
    }
  }
  const pHome = pHomes.length ? median(pHomes) : undefined;
  if (pOver === undefined && pHome === undefined) return null;

  const grid = (lt: number, s: number): FinalScoreGrid => finalScoreGrid(lt * s, lt * (1 - s), 0.5);
  let lambdaT = 6;
  let homeShare = 0.5;
  for (let it = 0; it < 4; it++) {
    if (line !== undefined && pOver !== undefined) {
      const L = line, target = pOver;
      lambdaT = bisect((x) => totalOver(grid(x, homeShare), L) - target, 2, 12);
    }
    if (pHome !== undefined) {
      const target = pHome;
      homeShare = bisect((s) => gridSum(grid(lambdaT, s), (h, a) => h > a) - target, 0.25, 0.75);
    }
  }
  return { lambdaT, homeShare, line, pOver, pHome };
}

/** Loi du marché, valeur par valeur (aucun seau ambigu). */
export function marketDists(ev: ArbEvent, now = new Date(), maxQuoteAgeSec = 900): Dists | null {
  const fit = fitMarket(ev, now, maxQuoteAgeSec);
  if (!fit) return null;
  const g = finalScoreGrid(fit.lambdaT * fit.homeShare, fit.lambdaT * (1 - fit.homeShare), 0.5);
  const tot = new Map<number, number>();
  const mar = new Map<number, number>();
  for (let h = 0; h < g.size; h++) {
    for (let a = 0; a < g.size; a++) {
      const p = g.p[h][a];
      if (!p) continue;
      tot.set(h + a, (tot.get(h + a) ?? 0) + p);
      mar.set(h - a, (mar.get(h - a) ?? 0) + p);
    }
  }
  const toBuckets = (m: Map<number, number>): Bucket[] =>
    [...m].sort((x, y) => x[0] - y[0]).map(([k, p]) => ({ lo: k, hi: k, p }));
  // Sans total observé, λ par défaut : la loi des totaux ne vaut rien.
  return {
    total: fit.line !== undefined ? toBuckets(tot) : undefined,
    margin: fit.pHome !== undefined ? toBuckets(mar) : undefined,
    source: 'marché',
  };
}

// ─── Règlement d'un pari selon le score ──────────────────────────────────────

export type LegKind = 'over' | 'under' | 'home' | 'away';

/**
 * Multiplicateur de la mise rendu par le pari pour une valeur du score :
 * cote si gagné, 1 si remboursé (push), 0 si perdu. `x` = total (over/under)
 * ou écart domicile − visiteur (home/away).
 */
export function legReturn(kind: LegKind, line: number, price: number, x: number): number {
  const v = kind === 'over' ? x - line
    : kind === 'under' ? line - x
    : kind === 'home' ? x + line
    : -x + line;
  return v > 0 ? price : v === 0 ? 1 : 0;
}

// ─── Recherche des middles ───────────────────────────────────────────────────

interface Quote { price: number; bookmaker: string; bookmakerTitle: string; lastUpdate?: string }

export interface MiddleLeg {
  side: string;
  kind: LegKind;
  line: number;
  bookmaker: string;
  bookmakerTitle: string;
  price: number;
  stake: number;
  stakeRounded: number;
  lastUpdate?: string;
}

export interface MiddleOpportunity {
  id: string;
  eventId?: string;
  match: string;
  commenceTime: string;
  kind: 'totals' | 'spreads';
  legs: MiddleLeg[];
  impliedSum: number;
  /**
   * Valeurs du score dans la fenêtre : aucun pari perdu, au moins un gagné
   * (totaux, ou écarts domicile − visiteur). Inclut le demi-middle d'une ligne
   * entière : Over 5.5 + Under 6 à 6 buts = gagné + remboursé.
   */
  windowValues: number[];
  /** Fenêtre en clair : « 6 buts », « 6 buts (Under 6 remboursé) », « Toronto Maple Leafs gagne par 2 ». */
  window: string;
  /** Source des probabilités utilisées pour l'espérance. */
  source: string;
  /** P(fenêtre) selon `source`. */
  pMiddle: number;
  /** Même probabilité selon le marché, quand `source` est le modèle. */
  pMiddleMarket?: number;
  /** P(fenêtre) minimale pour une espérance positive (= Σ − 1 avec deux demi-lignes). */
  breakeven: number;
  /** Avantage : (P(fenêtre) − seuil), en points de pourcentage. */
  edgePts: number;
  /** Espérance selon le marché, quand `source` est le modèle. */
  evMarket?: number;
  totalStaked: number;
  /** Espérance, mises arrondies. */
  ev: number;
  evPct: number;
  /** Résultat si un seul pari gagne (le cas le plus fréquent). */
  worstCase: number;
  /** Résultat si les deux gagnent. */
  bestCase: number;
  /** Au pire ≥ 0 : arbitrage avec bonus. */
  riskFree: boolean;
  warnings: string[];
}

export interface MiddleOptions {
  now?: Date;
  bankroll?: number;
  roundTo?: number;
  minLeadMinutes?: number;
  maxQuoteAgeSec?: number;
  /** Livres où l'on peut parier. Vide = tous. */
  books?: string[];
  /** Largeur max de la fenêtre, en buts (Over 5.5 / Under 7.5 = 2). Défaut 2. */
  maxWindow?: number;
  /** Espérance minimale en % de la mise pour signaler. Défaut 0. */
  minEvPct?: number;
  /**
   * Avantage minimal, en points : P(fenêtre) doit dépasser le seuil d'au moins
   * autant. Défaut 2.5 — arakiceML publie des pourcentages ENTIERS et la
   * fenêtre est une différence de deux d'entre eux (±1 point d'arrondi) ; il
   * faut une marge au-delà de ce bruit, et de l'incertitude du modèle sur un
   * score exact. Ne s'applique pas aux middles sans risque.
   */
  minEdgePts?: number;
  /** Écart modèle / marché (rapport des P(fenêtre)) au-delà duquel on avertit. Défaut 1.3. */
  divergenceWarn?: number;
  /** Lois du modèle par id d'événement ; sinon loi du marché. */
  model?: Map<string, Dists>;
  /** Nombre max de résultats. Défaut 10. */
  limit?: number;
}

const TOTAL_KEYS = new Set(['totals', 'alternate_totals']);
const SPREAD_KEYS = new Set(['spreads', 'alternate_spreads']);
const isQuarter = (p: number): boolean => Math.abs(p * 2 - Math.round(p * 2)) > 1e-9;
const r2 = (x: number): number => Math.round(x * 100) / 100;
const fmtPt = (p: number): string => (p > 0 ? `+${p}` : `${p}`);

function keepBest(m: Map<number, Quote>, line: number, q: Quote): void {
  const cur = m.get(line);
  if (!cur || q.price > cur.price) m.set(line, q);
}

type EvalLeg = { kind: LegKind; line: number; price: number };

/**
 * Vrai si `x` est dans la fenêtre : aucun pari perdu et au moins un gagné.
 * Couvre le middle complet (gagné + gagné) ET le demi-middle d'une ligne
 * entière (gagné + remboursé : Over 5.5 + Under 6 à 6 buts).
 */
function inWindow(legs: EvalLeg[], x: number): boolean {
  const r = legs.map((l) => legReturn(l.kind, l.line, l.price, x));
  return r.every((v) => v >= 1) && r.some((v, i) => v === legs[i].price);
}

/**
 * EV, P(fenêtre), seuil de rentabilité, pire et meilleur cas — ou `null` si un
 * seau est ambigu (la loi est trop grossière pour ces lignes).
 *
 * Seuil = P(fenêtre) qui annule l'espérance, à profits moyens fixés dans et
 * hors fenêtre : −L̄ / (W̄ − L̄). Avec deux demi-lignes et des paiements égaux,
 * c'est exactement Σ − 1.
 */
function evaluate(
  legs: EvalLeg[], stakes: number[], buckets: Bucket[],
): { ev: number; pWindow: number; breakeven: number; worst: number; best: number } | null {
  const total = stakes.reduce((a, b) => a + b, 0);
  let ev = 0, pW = 0, wSum = 0, pL = 0, lSum = 0, worst = Infinity, best = -Infinity;
  for (const b of buckets) {
    let ret = 0;
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i];
      const lo = legReturn(l.kind, l.line, l.price, b.lo);
      const hi = legReturn(l.kind, l.line, l.price, b.hi);
      if (lo !== hi) return null;            // le pari change d'issue dans le seau : loi trop grossière
      ret += stakes[i] * lo;
    }
    const profit = ret - total;
    ev += b.p * profit;
    if (inWindow(legs, b.lo)) { pW += b.p; wSum += b.p * profit; }
    else { pL += b.p; lSum += b.p * profit; }
    if (b.p > 1e-9) { worst = Math.min(worst, profit); best = Math.max(best, profit); }
  }
  const W = pW > 0 ? wSum / pW : best;
  const L = pL > 0 ? lSum / pL : worst;
  const breakeven = L >= 0 ? 0 : W > L ? -L / (W - L) : 1;
  return { ev, pWindow: pW, breakeven, worst, best };
}

export function findMiddles(events: ArbEvent[], opts: MiddleOptions = {}): MiddleOpportunity[] {
  const now = opts.now ?? new Date();
  const bankroll = opts.bankroll ?? 1000;
  const roundTo = opts.roundTo ?? 1;
  const minLeadMs = (opts.minLeadMinutes ?? 5) * 60_000;
  const maxAge = opts.maxQuoteAgeSec ?? 900;
  const books = new Set((opts.books ?? []).map(norm).filter(Boolean));
  const maxWindow = opts.maxWindow ?? 2;
  const minEvPct = opts.minEvPct ?? 0;
  const minEdgePts = opts.minEdgePts ?? 2.5;
  const divergenceWarn = opts.divergenceWarn ?? 1.3;
  const out: MiddleOpportunity[] = [];

  for (const ev of events) {
    const start = Date.parse(ev.commence_time);
    if (!Number.isFinite(start) || start - now.getTime() < minLeadMs) continue;
    const home = norm(ev.home_team), away = norm(ev.away_team);
    const match = `${ev.away_team} @ ${ev.home_team}`;

    const over = new Map<number, Quote>(), under = new Map<number, Quote>();
    const homeQ = new Map<number, Quote>(), awayQ = new Map<number, Quote>();
    for (const bk of ev.bookmakers ?? []) {
      if (books.size && !books.has(norm(bk.key))) continue;
      for (const mk of bk.markets ?? []) {
        const isTot = TOTAL_KEYS.has(mk.key), isSpr = SPREAD_KEYS.has(mk.key);
        if (!isTot && !isSpr) continue;
        const updated = mk.last_update ?? bk.last_update;
        if (!ageOk(updated, now, maxAge)) continue;
        for (const o of mk.outcomes ?? []) {
          if (typeof o.point !== 'number' || !(o.price > 1) || isQuarter(o.point)) continue;
          const q: Quote = { price: o.price, bookmaker: bk.key, bookmakerTitle: bk.title ?? bk.key, lastUpdate: updated };
          const n = norm(o.name);
          if (isTot && n === 'over') keepBest(over, o.point, q);
          else if (isTot && n === 'under') keepBest(under, o.point, q);
          else if (isSpr && n === home) keepBest(homeQ, o.point, q);
          else if (isSpr && n === away) keepBest(awayQ, o.point, q);
        }
      }
    }

    const modelD = ev.id ? opts.model?.get(ev.id) : undefined;
    let marketD: Dists | null | undefined;
    const market = (): Dists | null => (marketD === undefined ? (marketD = marketDists(ev, now, maxAge)) : marketD);

    type Cand = { kind: 'totals' | 'spreads'; legs: Array<{ side: string; kind: LegKind; line: number; q: Quote }> };
    const cands: Cand[] = [];
    for (const [a, qo] of over) for (const [b, qu] of under) {
      const w = b - a;
      if (w > 0 && w <= maxWindow) {
        cands.push({ kind: 'totals', legs: [
          { side: `Over ${a}`, kind: 'over', line: a, q: qo },
          { side: `Under ${b}`, kind: 'under', line: b, q: qu },
        ] });
      }
    }
    for (const [x, qh] of homeQ) for (const [y, qa] of awayQ) {
      const w = x + y;
      if (w > 0 && w <= maxWindow) {
        cands.push({ kind: 'spreads', legs: [
          { side: `${ev.home_team} ${fmtPt(x)}`, kind: 'home', line: x, q: qh },
          { side: `${ev.away_team} ${fmtPt(y)}`, kind: 'away', line: y, q: qa },
        ] });
      }
    }

    for (const c of cands) {
      const pick = (d: Dists | null | undefined): Bucket[] | undefined =>
        c.kind === 'totals' ? d?.total : d?.margin;
      const primary = pick(modelD) ? modelD! : market();
      const buckets = pick(primary);
      if (!primary || !buckets) continue;

      const prices = c.legs.map((l) => l.q.price);
      const sum = impliedSum(prices);
      const exact = arbStakes(prices, bankroll);
      const stakes = bestRoundedStakes(exact, prices, roundTo);
      const legsEval = c.legs.map((l) => ({ kind: l.kind, line: l.line, price: l.q.price }));
      const res = evaluate(legsEval, stakes, buckets);
      if (!res) continue;

      const totalStaked = stakes.reduce((a, b) => a + b, 0);
      const evPct = (res.ev / totalStaked) * 100;
      const riskFree = res.worst >= 0;
      const edgePts = (res.pWindow - res.breakeven) * 100;
      if (!riskFree && (evPct < minEvPct || edgePts < minEdgePts)) continue;

      let pMiddleMarket: number | undefined;
      let evMarket: number | undefined;
      if (primary !== market()) {
        const mb = pick(market());
        const mr = mb ? evaluate(legsEval, stakes, mb) : null;
        if (mr) { pMiddleMarket = mr.pWindow; evMarket = r2(mr.ev); }
      }

      // Valeurs du score dans la fenêtre, avec les paris remboursés (lignes entières).
      const range = c.kind === 'totals' ? Array.from({ length: 16 }, (_, i) => i)
        : Array.from({ length: 21 }, (_, i) => i - 10).filter((d) => d !== 0);
      const windowValues = range.filter((x) => inWindow(legsEval, x));
      const label = (x: number): string => {
        const base = c.kind === 'totals' ? `${x} buts`
          : x > 0 ? `${ev.home_team} gagne par ${x}` : `${ev.away_team} gagne par ${-x}`;
        const pushed = c.legs.filter((l) => legReturn(l.kind, l.line, l.q.price, x) === 1).map((l) => l.side);
        return pushed.length ? `${base} (${pushed.join(', ')} remboursé)` : base;
      };
      const window = windowValues.map(label).join(' ou ');

      const warnings: string[] = [];
      if (!riskFree) {
        warnings.push(`Pas sans risque : hors fenêtre (${((1 - res.pWindow) * 100).toFixed(0)} % des cas selon ${primary.source}), tu perds jusqu'à ${(-res.worst).toFixed(2)} $.`);
      }
      const ratio = pMiddleMarket ? res.pWindow / pMiddleMarket : 1;
      const diverge = pMiddleMarket !== undefined && pMiddleMarket > 0
        && (ratio > divergenceWarn || ratio < 1 / divergenceWarn);
      const marketNegative = evMarket !== undefined && evMarket < 0;
      if (diverge || marketNegative) {
        const parts: string[] = [];
        if (diverge) {
          parts.push(`modèle et marché en désaccord (${(res.pWindow * 100).toFixed(1)} % contre ${(pMiddleMarket! * 100).toFixed(1)} %)`);
        }
        if (marketNegative) parts.push(`selon le marché, l'espérance est négative (${evMarket!.toFixed(2)} $)`);
        const text = `${parts.join(' ; ')} : l'avantage repose entièrement sur ${primary.source}.`;
        warnings.push(text.charAt(0).toUpperCase() + text.slice(1));
      }
      for (const l of c.legs) {
        if (l.q.price < 1.15) {
          const other = c.legs.find((x) => x !== l)!;
          warnings.push(`Jambe quasi certaine (${l.side} @ ${l.q.price.toFixed(2)}) : c'est surtout un pari simple sur ${other.side}, `
            + 'avec une grosse mise immobilisée pour un petit gain.');
        }
      }
      if (new Set(c.legs.map((l) => l.q.bookmaker)).size === 1) {
        warnings.push('Les deux paris chez le même livre.');
      }

      out.push({
        id: [ev.id ?? match, c.kind, ...c.legs.map((l) => `${l.kind}${l.line}:${l.q.bookmaker}:${l.q.price}`)].join('|'),
        eventId: ev.id,
        match,
        commenceTime: ev.commence_time,
        kind: c.kind,
        legs: c.legs.map((l, i) => ({
          side: l.side, kind: l.kind, line: l.line, bookmaker: l.q.bookmaker,
          bookmakerTitle: l.q.bookmakerTitle, price: l.q.price,
          stake: r2(exact[i]), stakeRounded: r2(stakes[i]), lastUpdate: l.q.lastUpdate,
        })),
        impliedSum: Math.round(sum * 10_000) / 10_000,
        windowValues,
        window,
        source: primary.source,
        pMiddle: res.pWindow,
        pMiddleMarket,
        breakeven: res.breakeven,
        edgePts: r2(edgePts),
        evMarket,
        totalStaked: r2(totalStaked),
        ev: r2(res.ev),
        evPct: r2(evPct),
        worstCase: r2(res.worst),
        bestCase: r2(res.best),
        riskFree,
        warnings,
      });
    }
  }

  out.sort((a, b) => (Number(b.riskFree) - Number(a.riskFree)) || b.evPct - a.evPct);
  return out.slice(0, opts.limit ?? 10);
}
