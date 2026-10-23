/**
 * arbCalc.ts — Calculs « à la main » pour l'exécution d'un arbitrage.
 *
 *   • conversion des cotes américaines (+108, −110) ↔ décimales : les applis
 *     nord-américaines affichent l'américain par défaut ;
 *   • couverture : le 1er pari est PLACÉ (mise et cote figées), la cote de
 *     l'autre côté a bougé → combien miser pour que tous les résultats paient
 *     pareil, et ce que ça laisse (profit ou petite perte garantie).
 *
 * Module pur, utilisé par `scripts/arb-calc.ts` et l'affichage de `arb-scan.ts`.
 */

import { worstCaseProfit } from './arbScanner';

/** +X → 1 + X/100 ; −X → 1 + 100/X. */
export function americanToDecimal(american: number): number {
  if (!Number.isFinite(american) || Math.abs(american) < 100) {
    throw new Error(`Cote américaine invalide : ${american} (|cote| ≥ 100)`);
  }
  return american > 0 ? 1 + american / 100 : 1 + 100 / -american;
}

/** 2.08 → +108 ; 1.95 → −105 ; 2.00 → +100. */
export function decimalToAmerican(decimal: number): number {
  if (!(decimal > 1)) throw new Error(`Cote décimale invalide : ${decimal}`);
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : -Math.round(100 / (decimal - 1));
}

export function fmtAmerican(decimal: number): string {
  const a = decimalToAmerican(decimal);
  return a > 0 ? `+${a}` : `${a}`;
}

/**
 * Lit une cote saisie à la main.
 *   « +108 », « -110 »  → américaine (signe explicite)
 *   « 150 »             → américaine (≥ 100 sans signe : aucune cote décimale ne vaut 150)
 *   « 2.08 », « 2,08 »  → décimale
 */
export function parseOdds(raw: string): number {
  const s = raw.trim().replace(',', '.');
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) throw new Error(`Cote illisible : « ${raw} »`);
  const n = Number(s);
  if (s.startsWith('+') || s.startsWith('-') || n >= 100) return americanToDecimal(n);
  if (!(n > 1)) throw new Error(`Cote décimale invalide : « ${raw} » (doit être > 1)`);
  return n;
}

export interface HedgeResult {
  /** Mises exactes des issues restantes (égalisent les paiements). */
  stakes: number[];
  /** Mises arrondies au pas, choisies pour le meilleur résultat garanti. */
  stakesRounded: number[];
  /** Résultat garanti (mises exactes) : > 0 profit, < 0 perte. */
  result: number;
  /** Résultat garanti avec les mises arrondies. */
  resultRounded: number;
  totalStaked: number;
  totalStakedRounded: number;
}

/**
 * Couverture d'un pari déjà placé. `placedStake` à `placedPrice` paie
 * placedStake × placedPrice ; chaque issue restante reçoit la mise qui paie
 * le même montant.
 */
export function hedge(
  placedStake: number, placedPrice: number, otherPrices: number[], step = 1,
): HedgeResult {
  if (!(placedStake > 0) || !(placedPrice > 1)) throw new Error('Pari placé invalide');
  if (!otherPrices.length || otherPrices.some((p) => !(p > 1))) throw new Error('Cotes à couvrir invalides');

  const target = placedStake * placedPrice;
  const stakes = otherPrices.map((p) => target / p);
  const prices = [placedPrice, ...otherPrices];

  // Arrondi : pas inférieur ou supérieur pour chaque mise, meilleure combinaison.
  const opts = stakes.map((s) => {
    if (!(step > 0)) return [s];
    const lo = Math.max(step, Math.floor(s / step) * step);
    const hi = Math.max(step, Math.ceil(s / step) * step);
    return lo === hi ? [lo] : [lo, hi];
  });
  let best: number[] = opts.map((o) => o[0]);
  let bestRes = -Infinity;
  const walk = (i: number, acc: number[]): void => {
    if (i === opts.length) {
      const r = worstCaseProfit([placedStake, ...acc], prices);
      if (r > bestRes + 1e-9) { bestRes = r; best = acc.slice(); }
      return;
    }
    for (const v of opts[i]) { acc.push(v); walk(i + 1, acc); acc.pop(); }
  };
  walk(0, []);

  const r2 = (x: number): number => Math.round(x * 100) / 100;
  const totalStaked = placedStake + stakes.reduce((a, b) => a + b, 0);
  const totalStakedRounded = placedStake + best.reduce((a, b) => a + b, 0);
  return {
    stakes: stakes.map(r2),
    stakesRounded: best.map(r2),
    result: r2(target - totalStaked),
    resultRounded: r2(bestRes),
    totalStaked: r2(totalStaked),
    totalStakedRounded: r2(totalStakedRounded),
  };
}
