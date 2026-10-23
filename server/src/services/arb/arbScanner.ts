/**
 * arbScanner.ts — Détection d'arbitrages (« surebets ») entre bookmakers.
 *
 * PRINCIPE. Pour un même marché, on prend la MEILLEURE cote de chaque issue
 * parmi tous les livres. Si la somme des probabilités implicites est < 1,
 * miser sur toutes les issues (chacune chez son livre) rapporte quel que soit
 * le résultat :
 *
 *   Σ 1/cote_i < 1   →   profit garanti = 1/Σ − 1
 *   mise_i = bankroll × (1/cote_i) / Σ          (paiements identiques partout)
 *
 * ISSUES OPPOSÉES. Le module ne connaît pas une liste fermée de marchés : il
 * apparie les issues par la forme des données de The Odds API, ce qui couvre
 * d'un coup les marchés principaux, alternatifs, par période, totaux d'équipe
 * et props joueurs.
 *
 *   • Over/Under       → même `point` (et même `description` : joueur, équipe)
 *                        ex. Over 6.5 ↔ Under 6.5, Matthews tirs O3.5 ↔ U3.5
 *   • Handicap équipe  → points opposés : Domicile −1.5 ↔ Visiteur +1.5
 *                        (clé = handicap vu du côté domicile)
 *   • Sans ligne       → Domicile ↔ Visiteur (h2h), Oui ↔ Non (btts)
 *   • `*3_way*`        → 3 issues obligatoires (Domicile / Nul / Visiteur)
 *
 * Un groupe n'est évalué que s'il a EXACTEMENT le nombre d'issues attendu (2,
 * ou 3 pour un 3-way) : un h2h qui contiendrait un « Draw » chez un livre, ou
 * une prop « Oui » sans « Non », est ignoré plutôt que mal apparié.
 *
 * SÉCURITÉ. On ne mélange jamais deux clés de marché : `h2h` (prolongation et
 * tirs de barrage inclus chez les livres nord-américains) et `h2h_3_way`
 * (temps réglementaire) restent séparés. Les lignes en quart (6.25, Asian)
 * sont écartées : leur règlement partiel casse la garantie.
 *
 * Module PUR (aucun appel réseau, aucune base) : le script
 * `scripts/arb-scan.ts` s'occupe de récupérer les cotes.
 */

// ─── Types d'entrée (forme The Odds API v4, cotes décimales) ─────────────────

export interface ArbOutcome {
  name: string;
  price: number;
  point?: number;
  /** Joueur (props) ou équipe (team_totals). */
  description?: string;
}

export interface ArbMarket {
  key: string;
  last_update?: string;
  outcomes: ArbOutcome[];
}

export interface ArbBookmaker {
  key: string;
  title?: string;
  last_update?: string;
  markets: ArbMarket[];
}

export interface ArbEvent {
  id?: string;
  sport_key?: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: ArbBookmaker[];
}

// ─── Types de sortie ─────────────────────────────────────────────────────────

export interface ArbLeg {
  /** Libellé lisible : « Over 6.5 », « Toronto Maple Leafs -1.5 », « Draw ». */
  side: string;
  bookmaker: string;
  bookmakerTitle: string;
  price: number;
  /** Mise exacte pour la bankroll demandée. */
  stake: number;
  /** Mise arrondie au pas demandé (ce qu'on tape vraiment dans l'appli). */
  stakeRounded: number;
  lastUpdate?: string;
}

export interface ArbOpportunity {
  /** Identifiant stable (match + marché + ligne + livres + cotes) — sert au dédoublonnage des alertes. */
  id: string;
  eventId?: string;
  match: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  market: string;
  /** Ligne Over/Under, ou handicap du côté DOMICILE pour un spread. */
  line?: number;
  /** Joueur (props) ou équipe (team_totals). */
  subject?: string;
  legs: ArbLeg[];
  /** Σ 1/cote — < 1 signifie arbitrage. */
  impliedSum: number;
  /** Profit garanti en % de la mise totale (mises exactes). */
  profitPct: number;
  bankroll: number;
  guaranteedProfit: number;
  /** Profit MINIMUM avec les mises arrondies (peut être < profit exact). */
  guaranteedProfitRounded: number;
  /** Ligne entière : les deux paris peuvent être remboursés (profit 0, pas de perte). */
  pushPossible: boolean;
  /** Profit anormalement élevé → erreur de cote probable, risque d'annulation. */
  suspect: boolean;
  warnings: string[];
}

export interface ScanOptions {
  /** Horloge (injectée pour les tests et le mode démo). Défaut : maintenant. */
  now?: Date;
  /** Mise totale répartie sur les issues. Défaut 1000. */
  bankroll?: number;
  /** Pas d'arrondi des mises (1 = au dollar, 5 = au 5 $). Défaut 1. */
  roundTo?: number;
  /** Profit minimum pour signaler, en %. Défaut 0.5. */
  minProfitPct?: number;
  /** Au-delà de ce profit (%), l'opportunité est marquée suspecte. Défaut 8. */
  suspectProfitPct?: number;
  /** Ignore les matchs qui commencent dans moins de N minutes (ou déjà commencés). Défaut 5. */
  minLeadMinutes?: number;
  /** Ignore une cote plus vieille que N secondes. 0 = pas de filtre. Défaut 900. */
  maxQuoteAgeSec?: number;
  /** Livres autorisés (clés The Odds API). Vide = tous. */
  books?: string[];
  /** Marchés autorisés (clés). Vide = tous. */
  markets?: string[];
}

export interface ScanStats {
  events: number;
  eventsSkippedTime: number;
  quotesSkippedStale: number;
  quotesSkippedQuarterLine: number;
  /** Groupes d'issues opposées complets, effectivement comparés. */
  groupsCompared: number;
  /** Le marché le plus proche d'un arbitrage, même s'il n'en est pas un. */
  closest?: { label: string; impliedSum: number };
}

export interface ScanResult {
  opportunities: ArbOpportunity[];
  stats: ScanStats;
}

// ─── Calcul ──────────────────────────────────────────────────────────────────

/** Σ 1/cote. */
export function impliedSum(prices: number[]): number {
  return prices.reduce((s, p) => s + 1 / p, 0);
}

/** Profit garanti en %, positif seulement s'il y a arbitrage. */
export function profitPct(prices: number[]): number {
  return (1 / impliedSum(prices) - 1) * 100;
}

/** Mises qui égalisent le paiement de chaque issue. */
export function arbStakes(prices: number[], bankroll: number): number[] {
  const sum = impliedSum(prices);
  return prices.map((p) => (bankroll * (1 / p)) / sum);
}

/** Arrondit chaque mise au pas donné (au moins un pas, jamais 0). */
export function roundStakes(stakes: number[], step: number): number[] {
  if (!(step > 0)) return stakes.slice();
  return stakes.map((s) => Math.max(step, Math.round(s / step) * step));
}

/** Profit dans le PIRE scénario : plus petit paiement − total misé. */
export function worstCaseProfit(stakes: number[], prices: number[]): number {
  const total = stakes.reduce((a, b) => a + b, 0);
  const payouts = stakes.map((s, i) => s * prices[i]);
  return Math.min(...payouts) - total;
}

/**
 * Meilleur arrondi : pour chaque mise, essaie le pas inférieur ET supérieur, et
 * garde la combinaison au profit garanti le plus haut. Arrondir chaque mise au
 * plus proche (`roundStakes`) peut effacer un petit arbitrage ; avec 2–3 issues
 * il n'y a que 4 à 8 combinaisons à tester.
 */
export function bestRoundedStakes(stakes: number[], prices: number[], step: number): number[] {
  if (!(step > 0)) return stakes.slice();
  const options = stakes.map((s) => {
    const lo = Math.max(step, Math.floor(s / step) * step);
    const hi = Math.max(step, Math.ceil(s / step) * step);
    return lo === hi ? [lo] : [lo, hi];
  });
  let best = roundStakes(stakes, step);
  let bestProfit = worstCaseProfit(best, prices);
  const walk = (i: number, acc: number[]): void => {
    if (i === options.length) {
      const p = worstCaseProfit(acc, prices);
      if (p > bestProfit + 1e-9) { best = acc.slice(); bestProfit = p; }
      return;
    }
    for (const v of options[i]) { acc.push(v); walk(i + 1, acc); acc.pop(); }
  };
  walk(0, []);
  return best;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

// ─── Appariement ─────────────────────────────────────────────────────────────

interface Quote {
  side: string;
  price: number;
  bookmaker: string;
  bookmakerTitle: string;
  lastUpdate?: string;
}

interface Group {
  market: string;
  subject?: string;
  line?: number;
  sides: Map<string, Quote>;
}

const norm = (s?: string): string => (s ?? '').trim().toLowerCase();
const isOverUnder = (n: string): boolean => n === 'over' || n === 'under';
/** Vrai pour 6.25, 6.75… — tout ce qui n'est pas un multiple de 0.5. */
const isQuarterLine = (p: number): boolean => Math.abs(p * 2 - Math.round(p * 2)) > 1e-9;
const expectedSides = (marketKey: string): number => (/3_way/.test(marketKey) ? 3 : 2);
const fmtPoint = (p: number): string => (p > 0 ? `+${p}` : `${p}`);

function ageSec(iso: string | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now.getTime() - t) / 1000 : null;
}

/**
 * Clé de groupe + libellé de l'issue, ou `null` si l'issue ne peut pas être
 * appariée sans ambiguïté.
 */
function classify(
  o: ArbOutcome, home: string, away: string,
): { line?: number; side: string; label: string } | null {
  const name = norm(o.name);
  if (isOverUnder(name)) {
    if (typeof o.point !== 'number') return null;
    return { line: o.point, side: name, label: `${o.name} ${o.point}` };
  }
  if (typeof o.point === 'number') {
    // Handicap d'équipe : on ramène tout au point du côté domicile.
    if (name === home) return { line: o.point + 0, side: name, label: `${o.name} ${fmtPoint(o.point)}` };
    if (name === away) return { line: -o.point + 0, side: name, label: `${o.name} ${fmtPoint(o.point)}` };
    return null;
  }
  return { side: name, label: o.name };
}

function marketWarnings(market: string): string[] {
  const w: string[] = [];
  if (/_p\d/.test(market) && !/3_way/.test(market) && /^h2h/.test(market)) {
    w.push('Moneyline de période à 2 issues : vérifie la règle en cas d\'égalité chez les deux livres.');
  }
  if (/^player_/.test(market)) {
    w.push('Prop joueur : vérifie la règle si le joueur ne joue pas (pari annulé chez les deux livres ?).');
  }
  return w;
}

/**
 * Cherche les arbitrages dans une liste de matchs.
 */
export function findArbs(events: ArbEvent[], opts: ScanOptions = {}): ScanResult {
  const now = opts.now ?? new Date();
  const bankroll = opts.bankroll ?? 1000;
  const roundTo = opts.roundTo ?? 1;
  const minProfitPct = opts.minProfitPct ?? 0.5;
  const suspectProfitPct = opts.suspectProfitPct ?? 8;
  const minLeadMs = (opts.minLeadMinutes ?? 5) * 60_000;
  const maxAge = opts.maxQuoteAgeSec ?? 900;
  const books = new Set((opts.books ?? []).map(norm).filter(Boolean));
  const markets = new Set((opts.markets ?? []).map(norm).filter(Boolean));

  const stats: ScanStats = {
    events: events.length, eventsSkippedTime: 0, quotesSkippedStale: 0,
    quotesSkippedQuarterLine: 0, groupsCompared: 0,
  };
  const opportunities: ArbOpportunity[] = [];

  for (const ev of events) {
    const start = Date.parse(ev.commence_time);
    if (!Number.isFinite(start) || start - now.getTime() < minLeadMs) {
      stats.eventsSkippedTime++;
      continue;
    }
    const home = norm(ev.home_team);
    const away = norm(ev.away_team);
    const match = `${ev.away_team} @ ${ev.home_team}`;
    const groups = new Map<string, Group>();

    for (const bk of ev.bookmakers ?? []) {
      if (books.size && !books.has(norm(bk.key))) continue;
      for (const mk of bk.markets ?? []) {
        if (markets.size && !markets.has(norm(mk.key))) continue;
        const updated = mk.last_update ?? bk.last_update;
        const age = ageSec(updated, now);
        const stale = maxAge > 0 && age !== null && age > maxAge;

        for (const o of mk.outcomes ?? []) {
          if (!(typeof o.price === 'number' && Number.isFinite(o.price) && o.price > 1)) continue;
          if (stale) { stats.quotesSkippedStale++; continue; }
          if (typeof o.point === 'number' && isQuarterLine(o.point)) {
            stats.quotesSkippedQuarterLine++;
            continue;
          }
          const c = classify(o, home, away);
          if (!c) continue;

          const subject = o.description?.trim() || undefined;
          const key = `${mk.key}|${norm(subject)}|${c.line ?? ''}`;
          let g = groups.get(key);
          if (!g) {
            g = { market: mk.key, subject, line: c.line, sides: new Map() };
            groups.set(key, g);
          }
          const best = g.sides.get(c.side);
          if (!best || o.price > best.price) {
            g.sides.set(c.side, {
              side: c.label, price: o.price, bookmaker: bk.key,
              bookmakerTitle: bk.title ?? bk.key, lastUpdate: updated,
            });
          }
        }
      }
    }

    for (const g of groups.values()) {
      if (g.sides.size !== expectedSides(g.market)) continue;
      stats.groupsCompared++;

      const quotes = [...g.sides.values()];
      const prices = quotes.map((q) => q.price);
      const sum = impliedSum(prices);
      const label = `${match} · ${g.market}${g.subject ? ` ${g.subject}` : ''}${g.line !== undefined ? ` ${g.line}` : ''}`;
      if (!stats.closest || sum < stats.closest.impliedSum) {
        stats.closest = { label, impliedSum: round4(sum) };
      }

      const pct = profitPct(prices);
      if (pct < minProfitPct || sum >= 1) continue;

      const stakes = arbStakes(prices, bankroll);
      const rounded = bestRoundedStakes(stakes, prices, roundTo);
      const pushPossible = g.line !== undefined && Number.isInteger(g.line) && quotes.length === 2;
      const suspect = pct >= suspectProfitPct;
      const guaranteedProfitRounded = round2(worstCaseProfit(rounded, prices));

      const warnings = marketWarnings(g.market);
      if (suspect) {
        warnings.unshift(`Profit anormal (${pct.toFixed(1)} %) : erreur de cote probable, le livre peut annuler le pari.`);
      }
      if (new Set(quotes.map((q) => q.bookmaker)).size === 1) {
        warnings.push('Les deux côtés chez le même livre : quasi sûrement une erreur de cote.');
      }
      if (pushPossible) {
        warnings.push('Ligne entière : si le résultat tombe pile dessus, les deux paris sont remboursés (ni gain ni perte).');
      }
      if (guaranteedProfitRounded <= 0) {
        warnings.push('L\'arrondi des mises efface le profit : utilise un pas d\'arrondi plus petit.');
      }

      opportunities.push({
        id: [ev.id ?? match, g.market, norm(g.subject), g.line ?? '',
          ...quotes.map((q) => `${q.bookmaker}:${q.price}`)].join('|'),
        eventId: ev.id,
        match,
        homeTeam: ev.home_team,
        awayTeam: ev.away_team,
        commenceTime: ev.commence_time,
        market: g.market,
        line: g.line,
        subject: g.subject,
        legs: quotes.map((q, i) => ({
          side: q.side, bookmaker: q.bookmaker, bookmakerTitle: q.bookmakerTitle,
          price: q.price, stake: round2(stakes[i]), stakeRounded: round2(rounded[i]),
          lastUpdate: q.lastUpdate,
        })),
        impliedSum: round4(sum),
        profitPct: round2(pct),
        bankroll,
        guaranteedProfit: round2(bankroll / sum - bankroll),
        guaranteedProfitRounded,
        pushPossible,
        suspect,
        warnings,
      });
    }
  }

  opportunities.sort((a, b) => b.profitPct - a.profitPct);
  return { opportunities, stats };
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}
