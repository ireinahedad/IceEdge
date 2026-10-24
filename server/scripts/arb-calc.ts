/**
 * arb-calc.ts — Calculatrice d'arbitrage, 0 crédit. À utiliser AU MOMENT de parier,
 * avec les cotes lues dans les applis des livres.
 *
 *   npm run arb:calc -- 2.08 2.00                      → mises pour 1000 $, profit garanti
 *   npm run arb:calc -- +108 -100 --bankroll 500       → cotes américaines acceptées
 *   npm run arb:calc -- 2.35 4.60 2.95                 → 3 issues (domicile / nul / visiteur)
 *   npm run arb:calc -- 2.08 2.00 --round 5            → mises arrondies au 5 $
 *   npm run arb:calc -- --placed 490@2.08 1.95         → 1er pari DÉJÀ placé (490 $ à 2.08),
 *                                                        l'autre côté est tombé à 1.95 : combien miser ?
 *
 * Cotes : « 2.08 » ou « 2,08 » = décimale ; « +108 », « -110 » (ou ≥ 100 sans signe) = américaine.
 */

import fs from 'fs';
import { arbStakes, bestRoundedStakes, impliedSum, profitPct, worstCaseProfit } from '../src/services/arb/arbScanner';
import { fmtAmerican, hedge, parseOdds } from '../src/services/arb/arbCalc';

const money = (x: number): string => `${x.toFixed(2)} $`;
const show = (d: number): string => `${d.toFixed(3).replace(/0$/, '')} (${fmtAmerican(d)})`;

function usage(): never {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
  process.exit(0);
}

function main(): void {
  const argv = process.argv.slice(2);
  let bankroll = 1000;
  let step = 1;
  let placed: { stake: number; price: number } | null = null;
  const odds: number[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') usage();
    else if (a === '--bankroll') bankroll = Number(argv[++i]);
    else if (a === '--round') step = Number(argv[++i]);
    else if (a === '--placed') {
      const m = /^(\d+(?:[.,]\d+)?)@(.+)$/.exec(argv[++i] ?? '');
      if (!m) throw new Error('--placed attend MISE@COTE, ex. 490@2.08 ou 490@+108');
      placed = { stake: Number(m[1].replace(',', '.')), price: parseOdds(m[2]) };
    } else if (a.startsWith('--')) throw new Error(`Option inconnue : ${a} (voir --help)`);
    else odds.push(parseOdds(a));
  }
  if (!(bankroll > 0)) throw new Error('--bankroll doit être > 0');
  if (!(step >= 0)) throw new Error('--round doit être ≥ 0');

  // ── Couverture d'un pari déjà placé ────────────────────────────────────────
  if (placed) {
    if (!odds.length) throw new Error('Donne la (ou les) cote(s) de l\'autre côté, ex. --placed 490@2.08 1.95');
    const h = hedge(placed.stake, placed.price, odds, step);
    const all = [placed.price, ...odds];
    console.log(`\nDéjà placé : ${placed.stake} $ @ ${show(placed.price)} → paie ${money(placed.stake * placed.price)}`);
    odds.forEach((p, i) => {
      console.log(`Couvrir     : miser ${h.stakesRounded[i]} $ @ ${show(p)} → paie ${money(h.stakesRounded[i] * p)}`);
    });
    const res = h.resultRounded;
    const verdict = res > 0 ? `PROFIT garanti ${money(res)}`
      : res === 0 ? 'Ni gain ni perte' : `PERTE garantie ${money(-res)} (mieux que rester exposée)`;
    console.log(`\n${verdict} — total misé ${h.totalStakedRounded} $ (Σ = ${impliedSum(all).toFixed(4)})`);
    if (res < 0) {
      console.log('Alternative : attendre que la cote revienne, mais tant que l\'autre côté n\'est pas couvert, tu es exposée.');
    }
    return;
  }

  // ── Arbitrage classique ────────────────────────────────────────────────────
  if (odds.length < 2) usage();
  const sum = impliedSum(odds);
  const pct = profitPct(odds);
  const exact = arbStakes(odds, bankroll);
  const stakes = bestRoundedStakes(exact, odds, step);
  const total = stakes.reduce((a, b) => a + b, 0);
  const worst = worstCaseProfit(stakes, odds);

  console.log(`\nΣ 1/cote = ${sum.toFixed(4)}  →  ${sum < 1 ? `ARBITRAGE +${pct.toFixed(2)} %` : `PAS d'arbitrage (${pct.toFixed(2)} %)`}`);
  odds.forEach((p, i) => {
    console.log(`  Issue ${i + 1} @ ${show(p).padEnd(16)} → miser ${String(stakes[i]).padStart(6)} $ → paie ${money(stakes[i] * p)}`);
  });
  console.log(worst >= 0
    ? `\nProfit garanti : ${money(worst)} sur ${total} $ misés`
    : `\nPas d'arbitrage : si un seul pari gagne, tu perds ${money(-worst)} — ne mise pas,\n` +
      'sauf pour un middle (lignes différentes) : c\'est alors son coût hors fenêtre.');
}

try {
  main();
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
}
