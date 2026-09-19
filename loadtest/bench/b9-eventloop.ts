/**
 * B9 — LE COMPTEUR D'EVENT LOOP SAIT-IL VOIR UN BLOCAGE ?
 *
 * MÊME ESPRIT QUE B7, appliqué à l'instrument plutôt qu'au code. Le critère du
 * scénario S2 de l'audit est « `eventLoop.p99Ms` ne doit pas grimper pendant
 * une vague de connexions ». Encore faut-il que ce compteur BOUGE quand
 * l'event loop est réellement bloqué. S'il ne bouge pas, S2 est un critère
 * qu'on ne peut pas rater — ce qui n'est pas la même chose qu'un critère tenu.
 *
 * LE PROTOCOLE : on mesure une fenêtre au repos, puis une fenêtre où du travail
 * SYNCHRONE (un `pbkdf2Sync` de quelques dizaines de millisecondes) bloque le
 * process à chaque tour de boucle. Le compteur doit séparer nettement les deux.
 * On répète à plusieurs résolutions d'échantillonnage pour savoir laquelle
 * `metrics.ts` devrait utiliser.
 *
 * POURQUOI LA RÉSOLUTION DÉCIDE DE TOUT : `monitorEventLoopDelay({resolution})`
 * échantillonne toutes les `resolution` ms, et un retard plus court que
 * l'intervalle d'échantillonnage ne peut pas apparaître. La valeur au repos est
 * donc toujours ≈ `resolution`, et tout ce qui est plus rapide se noie dedans.
 * Une résolution de 20 ms met le plancher à 20 ms — au-dessus de la plupart des
 * blocages qu'on cherche.
 */

import crypto from 'crypto';
import { monitorEventLoopDelay } from 'perf_hooks';
import { sleep } from './harness';
import { envInt } from './spawn';

const FENETRE_MS = envInt('BENCH_WINDOW_MS', 3000);

/** ~30-60 ms de CPU synchrone : exactement le genre de travail qui bloque un
 *  process Node sans qu'aucune latence HTTP ne le dise clairement. */
function bloque(): void {
  crypto.pbkdf2Sync('x', 'sel', 8000, 32, 'sha256');
}

async function fenetre(resolution: number, bloquant: boolean) {
  const h = monitorEventLoopDelay({ resolution });
  h.enable();
  const fin = Date.now() + FENETRE_MS;
  while (Date.now() < fin) {
    if (bloquant) bloque();
    await sleep(5);
  }
  h.disable();
  const ms = (n: number) => Math.round((n / 1e6) * 100) / 100;
  return { mean: ms(h.mean), p50: ms(h.percentile(50)), p99: ms(h.percentile(99)), max: ms(h.max) };
}

export async function main() {
  // La résolution RÉELLEMENT en vigueur, lue dans `metrics.ts`. Comparer à une
  // constante recopiée ici se périmerait au premier changement là-bas — et un
  // banc qui se trompe sur ce qu'il teste est pire que pas de banc.
  const { EVENT_LOOP_RESOLUTION_MS } = await import('../../server/src/metrics');

  console.log('\n═══ B9 · Sensibilité du compteur d\'event loop ═══\n');
  console.log(` (résolution en vigueur dans metrics.ts : ${EVENT_LOOP_RESOLUTION_MS} ms)\n`);
  console.log(' résolution │ au repos (mean / p99) │ BLOQUÉ (mean / p99 / max) │ écart p99');
  console.log('────────────┼───────────────────────┼───────────────────────────┼──────────');

  const lignes: Array<{ resolution: number; ecart: number }> = [];

  const aTester = [...new Set([20, 10, 5, 1, EVENT_LOOP_RESOLUTION_MS])].sort((a, b) => b - a);
  for (const resolution of aTester) {
    const repos = await fenetre(resolution, false);
    const charge = await fenetre(resolution, true);
    const ecart = charge.p99 / Math.max(0.01, repos.p99);
    lignes.push({ resolution, ecart });
    const marque = resolution === EVENT_LOOP_RESOLUTION_MS ? ' ←' : '';
    console.log(
      ` ${String(resolution).padStart(10)} │ ${`${repos.mean} / ${repos.p99}`.padStart(21)} │` +
      ` ${`${charge.mean} / ${charge.p99} / ${charge.max}`.padStart(25)} │ ×${ecart.toFixed(1)}${marque}`,
    );
  }

  const actuelle = lignes.find((l) => l.resolution === EVENT_LOOP_RESOLUTION_MS)!;
  const meilleure = lignes.reduce((a, b) => (b.ecart > a.ecart ? b : a));

  console.log(
    actuelle.ecart < 1.5
      ? `\n  ✗ à la résolution ${EVENT_LOOP_RESOLUTION_MS} ms — celle de \`metrics.ts\` — un process réellement\n` +
        `    bloqué ne se distingue du repos que d'un facteur ×${actuelle.ecart.toFixed(1)}. C'est dans le bruit :\n` +
        `    le critère S2 « eventLoop.p99 ne grimpe pas » est intenable À RATER, ce qui n'est pas\n` +
        `    la même chose qu'un critère tenu.\n` +
        `    À la résolution ${meilleure.resolution} ms, le même blocage ressort ×${meilleure.ecart.toFixed(1)}.\n` +
        `    Correctif : \`EVENT_LOOP_RESOLUTION_MS\` dans \`server/src/metrics.ts\`.`
      : `\n  ✓ à la résolution ${EVENT_LOOP_RESOLUTION_MS} ms — celle en vigueur — un blocage réel ressort\n` +
        `    ×${actuelle.ecart.toFixed(1)} par rapport au repos. Le critère S2 mesure quelque chose.`,
  );

  console.log(
    '\n  Rappel de lecture : la valeur AU REPOS est toujours ≈ la résolution. Une moyenne\n' +
    '  de 20 ms avec `resolution: 20` ne veut pas dire « 20 ms de retard », elle veut dire\n' +
    '  « rien à signaler ». C\'est ce qui a fait conclure à tort à un event loop chargé sur\n' +
    '  le tir Windows du 2026-08-03 (README §5).',
  );
}
