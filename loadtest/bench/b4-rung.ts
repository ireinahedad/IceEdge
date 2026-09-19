/**
 * Palier du banc B4 — requêtes SQL par requête HTTP, à une taille de données
 * donnée. Processus neuf pour que la première requête soit vraiment froide.
 */

import { boot, request, loginToken, sleep } from './harness';
import * as upstream from './upstream';
import * as pgstub from './pgstub';
import { emit, envInt } from './spawn';

/** Endpoints qui touchent la base — les seuls où un N+1 peut exister. */
const CIBLES: Array<{ id: string; path: string; auth?: boolean; method?: string; body?: string }> = [
  { id: 'leaderboard', path: '/api/leaderboard' },
  { id: 'best-bets',   path: '/api/predict/best-bets?limit=15' },
  { id: 'odds-h2h',    path: '/api/odds/bet365/icehockey_nhl?markets=h2h' },
  { id: 'auth/me',     path: '/api/auth/me', auth: true },
  { id: 'auth/login',  path: '/api/auth/login', method: 'POST' },
];

export async function main() {
  const rows = envInt('BENCH_ROWS', 5);

  upstream.setLeague({ teams: 32, games: 8, players: 30 });
  upstream.setLatency({ nhl: 5, odds: 5, ml: 3 });
  pgstub.setRowCount(rows);

  const { base, close } = await boot({ sqlLatencyMs: 1 });
  const token = await loginToken(base);

  const out: any[] = [];
  for (const c of CIBLES) {
    const call = () => request(base, c.path, {
      method: c.method ?? 'GET',
      headers: c.auth ? { Authorization: `Bearer ${token}` } : undefined,
      body: c.id === 'auth/login'
        ? JSON.stringify({ email: pgstub.BENCH_USER.email, password: pgstub.BENCH_USER.password })
        : undefined,
    });

    // Froid : ce que coûte la première requête, caches vides.
    pgstub.reset(); upstream.reset();
    const froid = await call();
    const sqlFroid = pgstub.total();
    const detailFroid = pgstub.byStatement();

    await sleep(10);

    // Chaud : ce que coûte la requête suivante, une fois les caches remplis.
    pgstub.reset();
    const chaud = await call();
    const sqlChaud = pgstub.total();

    out.push({
      id: c.id,
      status: froid.status,
      statusChaud: chaud.status,
      sqlFroid,
      sqlChaud,
      detail: detailFroid.slice(0, 4),
    });
  }

  emit({ rows, endpoints: out });
  await close();
}
