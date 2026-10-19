/**
 * bench/all.ts — enchaîne les quatorze bancs et écrit le résultat brut.
 *
 * ORDRE VOULU : les bancs « structure » d'abord (ce que coûte une requête, ce
 * que coûtent N requêtes), la charge ensuite, les deux contrôles en dernier.
 * B7 et B9 closent la série parce que ce sont eux qui disent si les « ✓ »
 * précédents valaient quelque chose — les lire en premier n'aurait aucun sens.
 * B7 contrôle les bancs, B9 contrôle l'instrument qu'ils lisent.
 *
 *   node ../loadtest/bench/run.js all           # depuis server/
 *
 * Variables : BENCH_SECONDS (durée d'une phase de B6), BENCH_VUS,
 * BENCH_LEVELS (paliers de concurrence de B3), BENCH_ROWS_LEVELS (tailles de
 * données de B4 et B10), BENCH_SOCKET_LEVELS (paliers de B11),
 * BENCH_ENDURANCE_SECONDS (durée de B13), BENCH_SLIP_LEVELS (paliers de B14).
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import { runB1, printB1 } from './b1-amplification';
import { runB2, printB2 } from './b2-cache';
import { runB3, printB3 } from './b3-dedup';
import { runB4, printB4 } from './b4-nplusone';
import { runB5, printB5 } from './b5-scaling';
import { runB7, printB7 } from './b7-controle';
import { runB10, printB10 } from './b10-authentifie';
import { runB11, printB11 } from './b11-socket';
import { runB13, printB13 } from './b13-endurance';
import { runB14, printB14 } from './b14-reglement';
import { runB15, printB15 } from './b15-direct';
import { runChild, runChildOutput } from './spawn';

export async function main() {
  // B13 tire trois minutes en standalone ; dans la suite complète, deux
  // suffisent à séparer le plateau du bruit sans doubler la durée totale.
  process.env.BENCH_ENDURANCE_SECONDS = process.env.BENCH_ENDURANCE_SECONDS ?? '120';

  const debut = Date.now();
  const resultats: Record<string, unknown> = {};

  const b1 = runB1(); printB1(b1); resultats.b1_amplification = b1;
  const b2 = runB2(); printB2(b2); resultats.b2_cache = b2;
  const b3 = runB3(); printB3(b3); resultats.b3_dedup = b3;
  const b4 = runB4(); printB4(b4); resultats.b4_nplusone = b4;
  const b5 = runB5(); printB5(b5); resultats.b5_scaling = b5;

  // B8 et B9 impriment leur propre tableau : l'orchestrateur les relaie.
  const b8 = runChildOutput('b8-clecache'); console.log(b8); resultats.b8_clecache = b8;

  // B6 écrit son tableau lui-même (il tire en continu, il n'a pas de « paliers »
  // à agréger). On le lance dans son processus comme les autres, et on relaie
  // sa sortie telle quelle.
  console.log('\n(B6 — charge concurrente, en cours…)');
  const b6 = runChild<any>('b6-emit', {
    BENCH_SECONDS: process.env.BENCH_SECONDS ?? '45',
    BENCH_VUS: process.env.BENCH_VUS ?? '40',
  });
  console.log(b6.sortie);
  resultats.b6_concurrence = b6.mesures;

  const b10 = runB10(); printB10(b10); resultats.b10_authentifie = b10;
  const b11 = runB11(); printB11(b11); resultats.b11_socket = b11;

  const b14 = runB14(); printB14(b14); resultats.b14_reglement = b14;
  const b15 = runB15(); printB15(b15); resultats.b15_direct = b15;

  console.log('\n(B13 — endurance, en cours…)');
  const b13 = runB13(); printB13(b13); resultats.b13_endurance = b13;

  // B12 démarre une seconde instance : il lui faut son propre processus, et
  // l'orchestrateur ne doit pas en héberger une lui-même.
  const b12 = runChildOutput('b12-multiinstance'); console.log(b12); resultats.b12_multiinstance = b12;

  const b7 = runB7(); printB7(b7); resultats.b7_controle = b7;
  const b9 = runChildOutput('b9-eventloop'); console.log(b9); resultats.b9_eventloop = b9;

  const cible = join(__dirname, '..', 'bench-results.json');
  writeFileSync(cible, JSON.stringify({
    genere: new Date().toISOString(),
    dureeMs: Date.now() - debut,
    resultats,
  }, null, 2));

  console.log(`\n───\nRésultats bruts : ${cible}`);
  console.log(`Durée totale : ${Math.round((Date.now() - debut) / 1000)} s`);
}
