/**
 * Palier du banc B13 — charge soutenue à clés de cache VARIABLES, relevé du RSS.
 *
 * Lancé avec `--expose-gc` par l'orchestrateur : chaque relevé force d'abord un
 * ramasse-miettes. Sans ça, la courbe mesure surtout le moment où V8 a décidé
 * de collecter, et une dent de scie de plusieurs dizaines de mégaoctets se lit
 * comme une fuite.
 */

import { boot, request, sleep } from './harness';
import * as upstream from './upstream';
import * as pgstub from './pgstub';
import { emit, envInt } from './spawn';

export interface Echantillon {
  tMs: number;
  rssMb: number;
  heapMb: number;
  caches: Record<string, { size: number; maxEntries: number; evictions: number; hitRate: number }>;
}

/** `YYYY-MM-DD` décalé de n jours — la source de clés de cache la plus simple. */
function dateDecalee(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function main() {
  const dureeMs = envInt('BENCH_ENDURANCE_SECONDS', 180) * 1000;
  const pasMs = envInt('BENCH_SAMPLE_MS', 10_000);
  const vus = envInt('BENCH_ENDURANCE_VUS', 12);

  upstream.setLeague({ teams: 32, games: 10, players: 30 });
  upstream.setLatency({ nhl: 15, odds: 15, ml: 8 });
  pgstub.setRowCount(25);
  pgstub.setUserRole('user');

  const { base, metrics, close } = await boot({ sqlLatencyMs: 2 });

  /**
   * Une itération = des clés de cache TOUTES DIFFÉRENTES.
   *
   * C'est la consigne du scénario S5 (« en variant les paramètres pour créer
   * des clés de cache distinctes »), et c'est le seul profil qui puisse révéler
   * une fuite : un trafic répétitif tape toujours les mêmes entrées, donc une
   * `Map` non bornée y ressemble à une `Map` bornée. Ici chaque itération crée
   * une date de calendrier, un joueur et une équipe qu'on n'a jamais demandés.
   */
  const iteration = async (i: number) => {
    const jour = dateDecalee((i % 400) - 200);
    const joueur = 8470000 + (i % 900);
    const equipe = ['BOS', 'NYR', 'TOR', 'MTL', 'EDM', 'VAN', 'CGY', 'SEA'][i % 8];
    await Promise.all([
      request(base, `/api/nhl/games?date=${jour}`, { discardBody: true }),
      request(base, `/api/nhl/players/${joueur}`, { discardBody: true }),
      request(base, `/api/nhl/teams/${equipe}/roster`, { discardBody: true }),
      request(base, `/api/predict/best-bets?limit=${(i % 40) + 1}&days=${(i % 3) + 1}`, { discardBody: true }),
      request(base, '/api/leaderboard', { discardBody: true }),
    ]);
  };

  // Préchauffage : on ne veut pas que le premier relevé porte le coût du
  // démarrage (compilation JIT, premiers caches) et fasse un faux « plateau ».
  await iteration(0);
  await sleep(300);

  const echantillons: Echantillon = [] as any;
  const releves: Echantillon[] = [];
  const debut = Date.now();
  const fin = debut + dureeMs;
  let iterations = 0;
  let erreurs = 0;

  const releve = () => {
    // `global.gc` n'existe que si le processus a été lancé avec `--expose-gc`.
    const gc = (globalThis as any).gc;
    if (typeof gc === 'function') { gc(); gc(); }
    const m = process.memoryUsage();
    const snap = metrics.snapshotMetrics();
    const caches: Echantillon['caches'] = {};
    for (const [nom, c] of Object.entries(snap.caches)) {
      if (c.hits + c.misses + c.dedup === 0) continue;
      caches[nom] = { size: c.size, maxEntries: c.maxEntries, evictions: c.evictions, hitRate: c.hitRate };
    }
    releves.push({
      tMs: Date.now() - debut,
      rssMb: Math.round((m.rss / 1024 / 1024) * 10) / 10,
      heapMb: Math.round((m.heapUsed / 1024 / 1024) * 10) / 10,
      caches,
    });
  };

  releve();
  let prochainReleve = Date.now() + pasMs;

  // `vus` boucles concurrentes, chacune avec son propre décalage de clés.
  await Promise.all(Array.from({ length: vus }, async (_, vu) => {
    let i = vu * 1000;
    while (Date.now() < fin) {
      try { await iteration(i++); } catch { erreurs += 1; }
      iterations += 1;
      if (vu === 0 && Date.now() >= prochainReleve) {
        releve();
        prochainReleve = Date.now() + pasMs;
      }
      await sleep(20);
    }
  }));

  releve();

  emit({
    dureeMs,
    pasMs,
    vus,
    iterations,
    erreurs,
    gcForce: typeof (globalThis as any).gc === 'function',
    releves,
  });

  await close();
}
