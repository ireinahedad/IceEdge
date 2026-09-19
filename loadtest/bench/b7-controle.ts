/**
 * B7 — CONTRÔLE NÉGATIF
 *
 * POURQUOI CE BANC EXISTE
 *
 * Les six bancs précédents rendent tous « ✓ ». C'est la conclusion espérée,
 * donc c'est exactement le moment où il faut se méfier : un banc qui ne peut
 * pas échouer ne prouve rien, et un « ✓ » peut vouloir dire « le code
 * surveillé n'a pas tourné » (le piège de lecture du README §5 : `odds.calls`
 * valait 1 parce que l'API NHL était morte, pas parce que le cache marchait).
 *
 * CE QUE FAIT LE CONTRÔLE — il casse délibérément la déduplication en vol de
 * `TtlCache.wrap`, puis rejoue B3. Si les bancs mesurent bien ce qu'ils
 * prétendent, le résultat doit passer de « 1 exécution » à « N exécutions ». Si
 * le résultat ne bouge PAS, ce sont les bancs qui sont cassés, pas le code.
 *
 * Le code de production n'est pas modifié : le remplacement se fait en mémoire,
 * dans le processus enfant, et meurt avec lui.
 */

import { runChild } from './spawn';
import type { B3Row } from './b3-dedup';

const CIBLES = ['best-bets', 'odds-h2h'];
const N = Number(process.env.BENCH_N ?? 50);

export interface B7Row { id: string; sain: B3Row; casse: B3Row }

export function runB7(): B7Row[] {
  return CIBLES.map((id) => ({
    id,
    sain:  runChild<B3Row>('b3-rung', { BENCH_EP: id, BENCH_N: String(N) }),
    casse: runChild<B3Row>('b3-rung', { BENCH_EP: id, BENCH_N: String(N), BENCH_BREAK: '1' }),
  }));
}

const CACHE: Record<string, string> = { 'best-bets': 'best-bets', 'odds-h2h': 'odds' };

export function printB7(rows: B7Row[]): void {
  console.log(`\n═══ B7 · Contrôle négatif — déduplication neutralisée, N=${N} ═══\n`);
  console.log(' endpoint     │ code sain            │ déduplication cassée │ verdict');
  console.log('──────────────┼──────────────────────┼──────────────────────┼────────');
  let toutBon = true;
  for (const r of rows) {
    // Avec `wrap` neutralisé, plus aucun compteur de cache n'est incrémenté :
    // la vérité est alors le nombre d'appels sortants réellement émis.
    const sain = (r.sain.caches[CACHE[r.id]] ?? { m: 0 }).m;
    const casse = r.casse.appels;
    const sainAppels = r.sain.appels;
    const detecte = casse > sainAppels * 2;
    if (!detecte) toutBon = false;
    console.log(
      ` ${r.id.padEnd(12)}│ ${`${sain} exéc. / ${sainAppels} appels`.padEnd(20)} │` +
      ` ${`${casse} appels`.padEnd(20)} │ ${detecte ? '✓ détecté' : '✗ NON détecté'}`,
    );
  }
  console.log(
    toutBon
      ? '\n  ✓ le banc B3 sait échouer : neutraliser la déduplication multiplie les appels, et ça se voit.\n' +
        '    Les « ✓ » des autres bancs mesurent donc quelque chose.'
      : '\n  ✗ casser la déduplication ne change pas le résultat : c\'est le BANC qui ne mesure rien.\n' +
        '    Ne pas se fier aux autres verdicts tant que ceci n\'est pas corrigé.',
  );
}

export function main(): void {
  printB7(runB7());
}
