/** Vérification à blanc des chemins authentifiés, avant d'écrire B10/B11. */

import { boot, request, loginToken } from './harness';
import * as upstream from './upstream';
import * as pgstub from './pgstub';

export async function main() {
  upstream.setLeague({ teams: 32, games: 8, players: 20 });
  upstream.setLatency({ nhl: 5, odds: 5, ml: 3 });
  pgstub.setRowCount(20);

  const { base, close } = await boot({ sqlLatencyMs: 1 });
  const token = await loginToken(base);
  const H = { Authorization: `Bearer ${token}` };
  const R = pgstub.BENCH_ROOM_ID;
  const U = pgstub.BENCH_USER.id;

  const cibles: Array<[string, string]> = [
    ['GET', '/api/subscription/me'],
    ['GET', '/api/slips'],
    ['GET', '/api/slips/slip-0'],
    ['GET', '/api/users/me'],
    ['GET', '/api/users/me/bets'],
    ['GET', '/api/users/me/stats'],
    ['GET', `/api/users/${U}/summary`],
    ['GET', `/api/users/${U}/slips`],
    ['GET', '/api/chat/rooms'],
    ['GET', `/api/chat/rooms/${R}/messages`],
    ['GET', `/api/chat/rooms/${R}/members`],
  ];

  for (const [method, path] of cibles) {
    pgstub.reset(); upstream.reset();
    const r = await request(base, path, { method, headers: H });
    console.log(
      String(r.status).padEnd(4), String(r.ms + 'ms').padStart(6),
      `sql=${pgstub.total()}`.padEnd(8), path,
      r.status >= 400 ? ' ← ' + r.body.slice(0, 200) : '',
    );
  }
  await close();
}
