/**
 * Palier du banc B15 — une soirée EN DIRECT, processus neuf.
 *
 * `V` spectateurs rafraîchissent la page d'un des `G` matchs en cours
 * (`GET /api/predict/game/:id/bundle`) pendant `S` secondes. Tout est le vrai
 * code : paquet d'avant-match (10 min), paquet en direct (30 s, dédoublonné en
 * vol), feuille de match NHL, calage, moteur des effets de score.
 */

import { boot, request, sustain, summarise, sleep } from './harness';
import * as upstream from './upstream';
import { emit, envInt } from './spawn';

export async function main() {
  const viewers = envInt('BENCH_VIEWERS', 100);
  const games = envInt('BENCH_LIVE_GAMES', 16);
  const seconds = envInt('BENCH_SECONDS', 90);
  const thinkMs = envInt('BENCH_THINK_MS', 1000);

  upstream.setLeague({ teams: 32, games, players: 20 });
  upstream.setLatency({ nhl: 120, odds: 200, ml: 300 });
  upstream.setGamesLive(true);

  const { base, metrics, close } = await boot({ sqlLatencyMs: 2 });
  const ids = Array.from({ length: games }, (_, i) => upstream.benchGameId(i));

  // Un jeton par spectateur : le limiteur `predictLimiter` compte par compte
  // (ou par IP). Sans ça, tous les spectateurs du banc partagent une seule IP
  // et le banc mesurerait le limiteur, pas le direct.
  const jwt = require(require.resolve('jsonwebtoken', { paths: [process.cwd()] }));
  const tokens = Array.from({ length: viewers }, (_, vu) =>
    jwt.sign({ sub: `bench-viewer-${vu}`, email: `v${vu}@bench.local`, role: 'user' },
             process.env.JWT_SECRET!, { expiresIn: '1h' }));
  const hit = (vu: number, game = ids[(vu + Math.floor(Math.random() * 3)) % games]) => request(
    base, `/api/predict/game/${game}/bundle`,
    { discardBody: true, headers: { Authorization: `Bearer ${tokens[vu]}` } });

  // Échauffement : chaque match calcule son paquet d'avant-match (10 min) et son
  // premier direct (calage compris). On mesure ensuite le RÉGIME ÉTABLI.
  const warm = await Promise.all(ids.map((id, i) => hit(i % viewers, id)));
  const warmStatus = warm.map(r => r.status);
  const warmMs = Math.max(...warm.map(r => r.ms));
  await sleep(1000);

  upstream.reset();
  metrics.resetMetrics();
  const { replies, iterations } = await sustain(viewers, seconds * 1000, (vu) => hit(vu).then(r => [r]), thinkMs);

  const snap = metrics.snapshotMetrics();
  const c = upstream.counts();
  const live = snap.caches['mlGameBundlesLive'] ?? { hits: 0, misses: 0, dedup: 0 };
  const pre = snap.caches['mlGameBundles'] ?? { hits: 0, misses: 0, dedup: 0 };
  const perGameMin = (x: number) => +(x / games / (seconds / 60)).toFixed(2);
  emit({
    viewers, games, seconds, iterations, warmStatus, warmMs,
    ...summarise(replies),
    rps: +(replies.length / seconds).toFixed(1),
    avgKb: +(replies.reduce((a, r) => a + r.bytes, 0) / Math.max(1, replies.length) / 1024).toFixed(1),
    liveExecutions: live.misses, liveDedup: live.dedup, liveHits: live.hits,
    preExecutions: pre.misses,
    liveExecPerGamePerMin: perGameMin(live.misses),
    // Recalculs par match, lus sur les appels `boxscore` (un par recalcul),
    // séparés selon le rythme attendu : 30 s en cours de match, 10 s en fin.
    ...(() => {
      const per = new Map<string, number>();
      for (const c of upstream.calls) {
        const m = c.url.match(/gamecenter\/(\d+)\/boxscore/);
        if (m) per.set(m[1], (per.get(m[1]) ?? 0) + 1);
      }
      const rate = (end: boolean) => {
        const sel = ids.filter((id, i) => upstream.benchLiveEndgame(i) === end);
        const n = sel.reduce((a, id) => a + (per.get(id) ?? 0), 0);
        return sel.length ? +(n / sel.length / (seconds / 60)).toFixed(2) : 0;
      };
      return { recalcPerMinMid: rate(false), recalcPerMinEndgame: rate(true),
               endgameGames: ids.filter((_, i) => upstream.benchLiveEndgame(i)).length };
    })(),
    nhlPerRecalc: live.misses ? +((c['nhl-web'] + c['nhl-stats']) / live.misses).toFixed(2) : 0,
    nhl: c['nhl-web'] + c['nhl-stats'], ml: c.ml, odds: c.odds,
    nhlPerGamePerMin: perGameMin(c['nhl-web'] + c['nhl-stats']),
    eventLoopP99: (snap.eventLoop as any)?.p99Ms ?? null,
    rssMb: snap.memory.rssMb,
    parFamille: (() => {
      const m: Record<string, number> = {};
      for (const c of upstream.calls) {
        const k = c.group + ' ' + c.url.replace(/https?:\/\/[^/]+\//, '').split('?')[0]
          .replace(/\d{6,}/g, ':id').replace(/\/[A-Z]{3}(\/|$)/g, '/:team$1').replace(/\d{4}-\d{2}-\d{2}/g, ':date');
        m[k] = (m[k] ?? 0) + 1;
      }
      return Object.entries(m).sort((x, y) => y[1] - x[1]).slice(0, 12);
    })(),
  });
  await close();
}
