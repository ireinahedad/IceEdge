/**
 * B6 — PLUSIEURS UTILISATEURS SIMULTANÉS (charge légère)
 *
 * TROIS QUESTIONS, dans l'ordre où elles comptent :
 *
 *  1. Le nombre d'appels SORTANTS suit-il le nombre de visiteurs ? C'est la
 *     thèse centrale de l'audit. La colonne à lire est « appels amont par
 *     itération » : elle doit tendre vers zéro quand la charge dure, pas rester
 *     constante. Un endpoint qui répond 200 en 40 ms peut avoir appelé l'amont
 *     une fois ou mille fois — de l'extérieur c'est indiscernable, et c'est
 *     précisément ce que ce banc existe pour distinguer.
 *
 *  2. Une vague de CONNEXIONS dégrade-t-elle les routes de LECTURE ? C'est le
 *     scénario S2 de l'audit, et son critère n'est pas la latence du login :
 *     c'est celle des lectures pendant le login. bcrypt est du travail lourd ;
 *     s'il bloque l'event loop ou monopolise le pool de threads, toute
 *     l'application ralentit pendant qu'une poignée de gens se connectent. Le
 *     banc mesure donc les mêmes lectures AVANT et PENDANT la vague.
 *
 *  3. Combien ça coûte en RAM et en retard d'event loop.
 *
 * CHARGE VOLONTAIREMENT LÉGÈRE — quelques dizaines d'utilisateurs virtuels,
 * quelques dizaines de secondes. Ce banc ne cherche pas le point de rupture :
 * il cherche si le coût suit le trafic. Un tir à 500 VUs ne répondrait pas
 * mieux à cette question, il coûterait seulement plus cher à lancer.
 */

import { boot, request, sustain, summarise, sleep, pct, Reply } from './harness';
import * as upstream from './upstream';
import * as pgstub from './pgstub';
import { LANDING } from './endpoints';
import { envInt } from './spawn';

const VUS = envInt('BENCH_VUS', 40);
const DUREE_MS = envInt('BENCH_SECONDS', 90) * 1000;
const CONNEXIONS = envInt('BENCH_LOGINS', 60);

/**
 * `silencieux` : la sortie est collectée au lieu d'être imprimée, pour que
 * l'orchestrateur `all` puisse la relayer depuis un processus enfant sans la
 * mélanger aux journaux.
 */
export async function run(silencieux = false): Promise<{ lignes: string[]; mesures: any }> {
  const lignes: string[] = [];
  const log = (...args: any[]) => {
    const l = args.join(' ');
    lignes.push(l);
    if (!silencieux) log(l);
  };

  upstream.setLeague({ teams: 32, games: 12, players: 40 });
  // Latences amont réalistes : c'est ce qui rend la fenêtre de course
  // observable et la file d'attente honnête.
  upstream.setLatency({ nhl: 120, odds: 200, ml: 60 });

  const { base, metrics, close } = await boot({ sqlLatencyMs: 8 });

  // `discardBody` : le banc tourne dans le MÊME processus que l'application,
  // donc garder les corps de 40 000 réponses ferait passer la mémoire du banc
  // pour celle du serveur. Seule la taille est conservée.
  const landing = (): Promise<Reply[]> =>
    Promise.all(LANDING.map((e) => request(base, e.path, { discardBody: true })));

  // ── Préchauffage : on ne mesure pas le démarrage à froid ici (c'est B3) ──
  await landing();
  await sleep(200);

  // ── Phase A — lectures seules ───────────────────────────────────────────
  upstream.reset(); pgstub.reset(); metrics.resetMetrics();
  const a = await sustain(VUS, DUREE_MS, landing, 250);
  const snapA = metrics.snapshotMetrics();
  const appelsA = upstream.total();
  const sqlA = pgstub.total();
  const resumeA = summarise(a.replies);

  await sleep(500);

  // ── Phase B — mêmes lectures + vague de connexions ──────────────────────
  upstream.reset(); pgstub.reset(); metrics.resetMetrics();

  const lectures: Reply[] = [];
  const connexions: Reply[] = [];

  const lecturesEnCours = sustain(VUS, DUREE_MS, async (vu) => {
    const out = await landing();
    lectures.push(...out);
    return out;
  }, 250);

  // La vague part en parallèle, étalée sur la moitié de la fenêtre : une vague
  // instantanée mesurerait une rafale, pas une arrivée d'utilisateurs.
  const vague = (async () => {
    const espacement = (DUREE_MS / 2) / Math.max(1, CONNEXIONS);
    const enVol: Array<Promise<void>> = [];
    for (let i = 0; i < CONNEXIONS; i++) {
      enVol.push(request(base, '/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: pgstub.BENCH_USER.email, password: pgstub.BENCH_USER.password }),
      }).then((r) => { connexions.push(r); }));
      await sleep(espacement);
    }
    await Promise.all(enVol);
  })();

  const b = await lecturesEnCours;
  await vague;

  const snapB = metrics.snapshotMetrics();
  const appelsB = upstream.total();
  const sqlB = pgstub.total();
  const resumeB = summarise(b.replies);
  const resumeLogin = summarise(connexions);

  // ── Restitution ─────────────────────────────────────────────────────────
  log(`\n═══ B6 · Concurrence — ${VUS} utilisateurs virtuels, ${DUREE_MS / 1000} s par phase ═══\n`);

  log('                          │  phase A (lectures) │  phase B (+ connexions)');
  log('──────────────────────────┼─────────────────────┼────────────────────────');
  const ligne = (label: string, x: any, y: any) =>
    log(` ${label.padEnd(25)}│ ${String(x).padStart(19)} │ ${String(y).padStart(23)}`);

  ligne('itérations', a.iterations, b.iterations);
  ligne('requêtes HTTP', resumeA.n, resumeB.n);
  ligne('erreurs', `${resumeA.errors} (${(resumeA.errorRate * 100).toFixed(2)} %)`, `${resumeB.errors} (${(resumeB.errorRate * 100).toFixed(2)} %)`);
  ligne('429 (limiteur)', resumeA.rateLimited, resumeB.rateLimited);
  ligne('p50 lectures (ms)', resumeA.p50, resumeB.p50);
  ligne('p95 lectures (ms)', resumeA.p95, resumeB.p95);
  ligne('max lectures (ms)', resumeA.max, resumeB.max);
  ligne('appels amont', appelsA, appelsB);
  ligne('appels / itération', (appelsA / Math.max(1, a.iterations)).toFixed(2), (appelsB / Math.max(1, b.iterations)).toFixed(2));
  ligne('requêtes SQL', sqlA, sqlB);
  ligne('event loop p99 (ms)', snapA.eventLoop.p99Ms, snapB.eventLoop.p99Ms);
  ligne('event loop max (ms)', snapA.eventLoop.maxMs, snapB.eventLoop.maxMs);
  ligne('RSS (Mo)', snapA.memory.rssMb, snapB.memory.rssMb);

  const { EVENT_LOOP_RESOLUTION_MS } = await import('../../server/src/metrics');
  log(
    `\n  (le plancher d'\`event loop\` est la résolution d'échantillonnage de \`metrics.ts\`,\n` +
    `   soit ~${EVENT_LOOP_RESOLUTION_MS} ms : une valeur de cet ordre au repos est normale, pas un blocage.)`,
  );

  log(`\n Connexions : ${resumeLogin.n} tentées, ${resumeLogin.errors} en erreur,` +
              ` p50 ${resumeLogin.p50} ms, p95 ${resumeLogin.p95} ms, max ${resumeLogin.max} ms`);

  // ── Verdicts ────────────────────────────────────────────────────────────
  const parIterA = appelsA / Math.max(1, a.iterations);
  log(
    parIterA < 0.5
      ? `\n  ✓ le coût amont NE SUIT PAS le trafic : ${appelsA} appels pour ${a.iterations} itérations (${parIterA.toFixed(2)}/itération).`
      : `\n  ✗ ${parIterA.toFixed(2)} appel(s) amont par itération — le coût suit le nombre de visiteurs.`,
  );

  const degradation = resumeA.p95 ? resumeB.p95 / resumeA.p95 : 1;
  log(
    degradation <= 2
      ? `  ✓ les lectures tiennent pendant la vague de connexions (p95 ×${degradation.toFixed(2)}).`
      : `  ✗ les lectures se dégradent pendant la vague de connexions (p95 ×${degradation.toFixed(2)}) — regarder l'event loop et le pool de threads.`,
  );

  log(
    snapB.eventLoop.p99Ms < 50
      ? `  ✓ event loop p99 à ${snapB.eventLoop.p99Ms} ms sous charge mixte.`
      : `  ✗ event loop p99 à ${snapB.eventLoop.p99Ms} ms : du travail synchrone bloque le process.`,
  );

  if (resumeA.rateLimited + resumeB.rateLimited > 0) {
    log('  ⚠ des 429 sont apparus : le limiteur fausse la mesure, relever API_RATE_LIMIT.');
  }

  // Par endpoint : la moyenne cache les endpoints lents.
  log('\n Détail par endpoint (phase B) :');
  log(' endpoint     │   n │ p50 │ p95 │ max │ err');
  log('──────────────┼─────┼─────┼─────┼─────┼────');
  for (let i = 0; i < LANDING.length; i++) {
    // `landing()` rend les réponses dans l'ordre de LANDING : une itération
    // occupe donc `LANDING.length` entrées consécutives.
    const parEndpoint = b.replies.filter((_, k) => k % LANDING.length === i);
    const ms = parEndpoint.map((r) => r.ms);
    log(
      ` ${LANDING[i].id.padEnd(12)}│ ${String(parEndpoint.length).padStart(4)}│` +
      ` ${String(pct(ms, 50)).padStart(3)} │ ${String(pct(ms, 95)).padStart(3)} │` +
      ` ${String(ms.length ? Math.max(...ms) : 0).padStart(3)} │ ${String(parEndpoint.filter((r) => r.status >= 400).length).padStart(3)}`,
    );
  }

  log('\n Caches en fin de phase B :');
  for (const [nom, c] of Object.entries(snapB.caches)) {
    const lectures = c.hits + c.misses + c.dedup;
    if (!lectures) continue;
    log(`   ${nom.padEnd(16)} hits ${String(c.hits).padStart(5)}  misses ${String(c.misses).padStart(4)}  dedup ${String(c.dedup).padStart(4)}  taux ${(c.hitRate * 100).toFixed(1)} %`);
  }

  const mesures = {
    vus: VUS,
    dureeMsParPhase: DUREE_MS,
    phaseA: { ...resumeA, iterations: a.iterations, appels: appelsA, sql: sqlA, eventLoop: snapA.eventLoop, rssMb: snapA.memory.rssMb },
    phaseB: { ...resumeB, iterations: b.iterations, appels: appelsB, sql: sqlB, eventLoop: snapB.eventLoop, rssMb: snapB.memory.rssMb },
    connexions: resumeLogin,
    caches: snapB.caches,
  };

  await close();
  return { lignes, mesures };
}

export async function main() {
  await run(false);
}
