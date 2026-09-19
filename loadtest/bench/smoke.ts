/** Vérification à blanc : l'app démarre, les endpoints critiques répondent,
 *  les bouchons comptent. Si ce script échoue, aucun banc n'est interprétable. */

import { boot, request, loginToken } from './harness';
import * as upstream from './upstream';
import * as pgstub from './pgstub';

export async function main() {
  upstream.setLeague({ teams: 32, games: 8, players: 30 });
  upstream.setLatency({ nhl: 20, odds: 20, ml: 10 });

  const { base, metrics, close } = await boot({ sqlLatencyMs: 1 });

  const paths = [
    '/health',
    '/api/nhl/teams',
    '/api/nhl/games/live',
    `/api/nhl/games?date=${new Date().toISOString().slice(0, 10)}`,
    '/api/odds/bet365/icehockey_nhl?markets=h2h',
    '/api/odds/bet365/icehockey_nhl?markets=totals',
    '/api/leaderboard',
    '/api/predict/best-bets?limit=15',
  ];

  for (const p of paths) {
    upstream.reset(); pgstub.reset();
    const r = await request(base, p);
    console.log(
      String(r.status).padEnd(4),
      String(r.ms + 'ms').padStart(7),
      `nhl=${upstream.total('nhl-web') + upstream.total('nhl-stats')}`.padEnd(9),
      `odds=${upstream.total('odds')}`.padEnd(8),
      `ml=${upstream.total('ml')}`.padEnd(7),
      `sql=${pgstub.total()}`.padEnd(8),
      p,
      r.status >= 400 ? ' ← ' + r.body.slice(0, 160) : '',
    );
  }

  const token = await loginToken(base);
  const m = await request(base, '/api/dev/metrics', { headers: { Authorization: `Bearer ${token}` } });
  console.log('\n/api/dev/metrics →', m.status);

  const snap = metrics.snapshotMetrics();
  console.log('caches:', Object.entries(snap.caches).map(([k, v]) => `${k} h${v.hits}/m${v.misses}/d${v.dedup}`).join('  '));
  console.log('upstream:', JSON.stringify(snap.upstream));
  console.log('appels non classés:', upstream.counts().autre, upstream.topRepeats(3));

  await close();
}
