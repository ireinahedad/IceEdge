/**
 * mlWarmup.service.ts — paquets ML d'avant-match tenus au chaud (PERF_PLAN.md, P1.5).
 *
 * POURQUOI. Le calendrier et la flèche « jour suivant » de l'accueil demandent le
 * résumé ML (`/predict/summary`) de jours que rien d'autre ne calcule : best-bets
 * ne couvre qu'aujourd'hui et demain. À froid, 5 matchs dans 2 jours ont pris
 * 3,7 s (mesuré en prod le 2026-10-23), payés par le premier visiteur.
 *
 * CE QUE ÇA FAIT. Toutes les `ML_BUNDLE_WARMUP_INTERVAL_MIN` minutes (90 par
 * défaut), les paquets des matchs À VENIR d'aujourd'hui à J+7 (jour de l'Est)
 * sont recalculés s'ils ne sont plus frais, UN À LA FOIS — le service Python ne
 * voit jamais plus d'un calcul de ce job en même temps. 90 min < la fenêtre de
 * péremption tolérée des paquets (`ML_BUNDLE_STALE_MS`, 2 h) : entre deux tours,
 * un visiteur reçoit toujours un paquet servi tout de suite.
 *
 * CE QUE ÇA COÛTE. Un calcul ML par match à venir et par tour (~50 matchs sur
 * une semaine, ~0,3-0,6 s chacun, en série). Aucun crédit The Odds API de plus
 * que ce que le cache des cotes (30 min) ne dépense déjà : les cotes sont lues
 * une fois pour toute la ligue, pas par match.
 *
 * OPT-IN (`ML_BUNDLE_WARMUP=true`), comme `BEST_BETS_WARMUP` : c'est du calcul
 * permanent sur le service Python, et ce choix revient à la propriétaire.
 * `DORMANT` l'emporte (non démarré en veille). Pas de verrou en base : on ne
 * réveille pas Neon pour ça. À plusieurs instances, chacune réchauffe son propre
 * cache mémoire — c'est exactement ce qu'il faut, puisque le cache est par instance.
 */
import { logger } from '../logger';
import { fetchGamesRange } from './nhlApiClient';
import { etDate } from './bestBets.service';
import { warmGameMlBundle } from './gameMlBundle';

const DAYS_AHEAD = 7;
let running = false;

/** Un tour : tous les matchs à venir de J à J+7, un à la fois. Exporté pour les tests. */
export async function warmUpcomingBundles(
  deps = { fetchGamesRange, warm: warmGameMlBundle, now: () => new Date() },
): Promise<{ games: number; failed: number; ms: number } | null> {
  if (running) return null;          // le tour précédent n'a pas fini : on saute
  running = true;
  const t0 = Date.now();
  let games = 0;
  let failed = 0;
  try {
    const now = deps.now();
    const all = await deps.fetchGamesRange(etDate(0, now), etDate(DAYS_AHEAD, now));
    const upcoming = all.filter((g: any) => (g?.status ?? 'scheduled') === 'scheduled' && g?.id != null);
    for (const g of upcoming) {
      games += 1;
      try { await deps.warm(String(g.id)); }
      catch { failed += 1; }         // un match sans données ne bloque pas les suivants
    }
    return { games, failed, ms: Date.now() - t0 };
  } finally {
    running = false;
  }
}

export function startMlBundleWarmup(): void {
  if (process.env.ML_BUNDLE_WARMUP !== 'true') {
    // Dit pourquoi il ne tourne pas : sans cette ligne, un job éteint et un job
    // jamais atteint (base injoignable au démarrage, `DORMANT`) se ressemblaient.
    logger.info({ ML_BUNDLE_WARMUP: process.env.ML_BUNDLE_WARMUP ?? null }, '[MlWarmup] éteint (ML_BUNDLE_WARMUP ≠ "true")');
    return;
  }
  const minutes = Number(process.env.ML_BUNDLE_WARMUP_INTERVAL_MIN) || 90;
  logger.info({ intervalMin: minutes, firstRunInSec: 120 }, '[MlWarmup] démarré');
  const tick = () => {
    warmUpcomingBundles()
      .then((r) => { if (r) logger.info(r, '[MlWarmup] paquets ML à venir réchauffés'); })
      .catch((err: any) => logger.warn({ err: err?.message }, '[MlWarmup] tour échoué (sans conséquence)'));
  };
  // 2 min après le démarrage : laisser passer le réchauffage de best-bets, qui
  // calcule déjà les paquets d'aujourd'hui et de demain.
  setTimeout(tick, 2 * 60_000).unref();
  setInterval(tick, minutes * 60_000).unref();
}
