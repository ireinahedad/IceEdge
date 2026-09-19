/**
 * Instance B du banc B12 — une application complète dans SON processus.
 *
 * Elle démarre, annonce son port sur la sortie standard, puis reste en vie
 * jusqu'à ce que le parent la termine. C'est tout : le processus séparé EST
 * l'expérience. Deux instances dans le même processus partageraient l'`io`
 * exporté par `socket.ts` et leurs caches mémoire — donc exactement ce que le
 * banc cherche à mesurer comme NON partagé.
 */

import { boot } from './harness';
import * as upstream from './upstream';
import * as pgstub from './pgstub';

export const MARQUE_PORT = '##PORT##';

export async function main() {
  upstream.setLeague({ teams: 32, games: 8, players: 20 });
  upstream.setLatency({ nhl: 5, odds: 5, ml: 3 });
  pgstub.setRowCount(10);
  pgstub.setUserRole('user');

  const { base } = await boot({ sqlLatencyMs: 1, socket: true });
  process.stdout.write(`\n${MARQUE_PORT}${base}\n`);

  // Rester en vie. Le parent envoie SIGTERM quand il a fini de mesurer ;
  // `unref` n'est pas utilisé ici, c'est justement ce timer qui tient le
  // processus ouvert.
  setInterval(() => {}, 1 << 30);
}
