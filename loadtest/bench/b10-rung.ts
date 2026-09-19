/**
 * Palier du banc B10 — chemins AUTHENTIFIÉS, à une taille de données donnée.
 * Processus neuf, pour que la colonne « froid » le soit vraiment.
 */

import { boot, request, loginToken, sleep } from './harness';
import * as upstream from './upstream';
import * as pgstub from './pgstub';
import { emit, envInt } from './spawn';

/**
 * Ce qu'on mesure, et pourquoi chacun est là.
 *
 * `taille` dit si l'endpoint sert une COLLECTION dont le nombre de lignes est
 * piloté par `pgstub.setRowCount` : ce sont les seuls où un N+1 peut exister,
 * et donc les seuls dont l'écart entre deux paliers veut dire quelque chose.
 * Les autres sont là pour le coût par requête, pas pour la croissance.
 */
const CIBLES: Array<{ id: string; path: (u: string, r: string) => string; taille: boolean; pro?: boolean }> = [
  { id: 'subscription/me', path: () => '/api/subscription/me',            taille: false },
  { id: 'slips',           path: () => '/api/slips',                      taille: true  },
  { id: 'users/me',        path: () => '/api/users/me',                   taille: false },
  { id: 'users/me/bets',   path: () => '/api/users/me/bets',              taille: true  },
  { id: 'users/me/stats',  path: () => '/api/users/me/stats',             taille: true  },
  // ⚠ `requireProForOthers` LAISSE PASSER quand on regarde son propre profil.
  // Viser son propre id mesurerait donc un chemin sans porte Pro — et c'est
  // exactement ce qui a fait croire, au premier essai, que le cache `isPro`
  // n'était pas exercé. Ces deux-là visent AUTRUI, à dessein.
  { id: 'summary (Pro)',   path: () => `/api/users/${AUTRUI}/summary`,    taille: false, pro: true },
  { id: 'slips (Pro)',     path: () => `/api/users/${AUTRUI}/slips`,      taille: true,  pro: true },
  { id: 'chat/rooms',      path: () => '/api/chat/rooms',                 taille: true  },
  { id: 'chat/messages',   path: (_u, r) => `/api/chat/rooms/${r}/messages`, taille: true },
  { id: 'chat/members',    path: (_u, r) => `/api/chat/rooms/${r}/members`,  taille: true },
];

/** Un autre compte que celui du banc : c'est ce qui déclenche `requirePro`. */
const AUTRUI = '00000000-0000-4000-8000-000000000042';

export async function main() {
  const rows = envInt('BENCH_ROWS', 20);
  const rafale = envInt('BENCH_PRO_BURST', 30);

  upstream.setLeague({ teams: 32, games: 8, players: 20 });
  upstream.setLatency({ nhl: 5, odds: 5, ml: 3 });
  pgstub.setRowCount(rows);
  // Simple membre, PAS admin : sinon `requirePro` court-circuite `isPro` et le
  // cache d'entitlement n'est jamais touché (cf. `setUserRole`).
  pgstub.setUserRole('user');

  const { base, metrics, close } = await boot({ sqlLatencyMs: 1 });
  const token = await loginToken(base);
  const H = { Authorization: `Bearer ${token}` };
  const U = pgstub.BENCH_USER.id;
  const R = pgstub.BENCH_ROOM_ID;

  const endpoints: any[] = [];
  for (const c of CIBLES) {
    const chemin = c.path(U, R);
    const appel = () => request(base, chemin, { headers: H, discardBody: true });

    pgstub.reset();
    const froid = await appel();
    const sqlFroid = pgstub.total();
    const detail = pgstub.byStatement().slice(0, 4);

    await sleep(5);

    pgstub.reset();
    const chaud = await appel();

    endpoints.push({
      id: c.id,
      taille: c.taille,
      pro: !!c.pro,
      status: froid.status,
      statusChaud: chaud.status,
      sqlFroid,
      sqlChaud: pgstub.total(),
      ms: froid.ms,
      detail,
      erreur: froid.status >= 400 ? froid.body.slice(0, 200) : null,
    });
  }

  // ── Le cache d'entitlement, enfin exercé ────────────────────────────────
  //
  // `isPro` est resté à zéro sur toute la campagne précédente : aucun banc ne
  // touchait une route Pro, donc le cache de l'audit (ligne L) n'avait jamais
  // été mesuré sous charge. Une rafale sur une route `requirePro` répond à la
  // seule question qui compte : combien de fois la base est-elle interrogée
  // pour une donnée qui change quelques fois dans la vie d'un compte ?
  metrics.resetMetrics();
  pgstub.reset();
  const cheminPro = `/api/users/${AUTRUI}/summary`;
  await Promise.all(Array.from({ length: rafale }, () => request(base, cheminPro, { headers: H, discardBody: true })));
  const snap = metrics.snapshotMetrics();

  emit({
    rows,
    rafale,
    endpoints,
    isPro: snap.caches.isPro ?? null,
    sqlRafale: pgstub.total(),
  });

  await close();
}
