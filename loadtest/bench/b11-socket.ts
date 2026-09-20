/**
 * B11 — SOCKET.IO : LE COUP D'ENVOI (scénario S4 de l'audit)
 *
 * LA SITUATION REPRODUITE : le salon « live » d'un match, à la mise au jeu.
 * Tout le monde arrive dans la même seconde, dans le même salon. C'est le pire
 * cas, et c'est aussi le seul moment où les deux défauts que ce banc cherche
 * deviennent visibles.
 *
 * DEUX QUESTIONS, celles que l'audit pose pour S4 :
 *
 *  1. **L'amplification `room_users`.** Chaque arrivée met à jour le compte de
 *     présence affiché. Si ce compte est émis à TOUS les membres à CHAQUE
 *     arrivée, N arrivées produisent N²/2 trames sortantes : à 500 personnes,
 *     125 000 messages pour afficher un nombre. Le coût devient quadratique au
 *     moment précis où l'event loop a autre chose à faire — servir les vrais
 *     messages. La colonne qui décide est **trames par arrivée** : elle doit
 *     rester plate quand N est multiplié par douze.
 *
 *  2. **Le coût Neon d'une ouverture de salon.** `join_room` vérifie le droit
 *     de lecture avant d'abonner le socket. Si cette vérification part en base
 *     à chaque arrivée, N arrivées = N lectures de la MÊME ligne, immuable, sur
 *     un pool qui compte dix connexions. L'audit fixe le critère : « ~1, pas
 *     ~100 ». La colonne est **requêtes SQL par arrivée**.
 *
 * POURQUOI LE BALAYAGE EN N EST LE CONTRÔLE. Contrairement à B7, ce banc n'a
 * pas besoin qu'on casse quelque chose pour savoir s'il mesure : une grandeur
 * qui doit rester constante quand N est multiplié par douze est falsifiable par
 * construction. Si les deux colonnes sont plates, la coalescence et le cache
 * font leur travail ; si elles suivent N, le banc l'aura dit sans qu'on ait à
 * l'aider.
 *
 * PRÉREQUIS : `socket.io-client`, devDependency ajoutée pour ce banc.
 *   cd server && npm install
 */

import { runChild } from './spawn';

const PALIERS = (process.env.BENCH_SOCKET_LEVELS ?? '25,100,300').split(',').map(Number);

export interface B11Row {
  n: number; intervalMs: number; observationMs: number;
  msPourConnecter: number; erreursSalon: number; socketsActifs: number;
  sqlTempete: number; sqlParJoin: number;
  detailTempete: Array<{ sql: string; n: number }>;
  framesRoomUsers: number; framesParJoin: number;
  statusEnvoi: number; sqlMessage: number; framesNewMessage: number;
  eventLoop: { meanMs: number; p50Ms: number; p99Ms: number; maxMs: number };
  rssMb: number;
}

export function runB11(): B11Row[] {
  return PALIERS.map((n) => runChild<B11Row>('b11-rung', { BENCH_SOCKETS: String(n) }));
}

export function printB11(rows: B11Row[]): void {
  const r0 = rows[0];
  console.log(
    `\n═══ B11 · Socket.io — arrivée simultanée dans un même salon (S4) ═══\n` +
    `    coalescence du compte de présence : ${r0.intervalMs} ms · observation : ${r0.observationMs} ms\n`,
  );
  console.log(' sockets │ connexion │ trames room_users │ /arrivée │ SQL tempête │ /arrivée │ msg diffusé │ EL p99 │ RSS');
  console.log('─────────┼───────────┼───────────────────┼──────────┼─────────────┼──────────┼─────────────┼────────┼──────');
  for (const r of rows) {
    console.log(
      ` ${String(r.n).padStart(7)} │ ${String(r.msPourConnecter + ' ms').padStart(9)} │` +
      ` ${String(r.framesRoomUsers).padStart(17)} │ ${String(r.framesParJoin).padStart(8)} │` +
      ` ${String(r.sqlTempete).padStart(11)} │ ${String(r.sqlParJoin).padStart(8)} │` +
      ` ${String(r.framesNewMessage).padStart(11)} │ ${String(r.eventLoop.p99Ms).padStart(6)} │ ${r.rssMb}`,
    );
  }

  const premier = rows[0];
  const dernier = rows[rows.length - 1];
  const facteurN = dernier.n / premier.n;

  // ── 1. Amplification ────────────────────────────────────────────────────
  //
  // Le critère porte sur les trames PAR ARRIVÉE, pas sur le total. Le total
  // dépend aussi de la fenêtre d'observation et de l'étalement des vagues de
  // connexion — deux choses qui appartiennent au banc, pas au serveur. Le
  // rapport par arrivée, lui, ne dépend que du serveur : quadratique, il suit
  // N ; coalescé, il reste une petite constante.
  const facteurFrames = premier.framesRoomUsers ? dernier.framesRoomUsers / premier.framesRoomUsers : 0;
  const facteurParArrivee = premier.framesParJoin ? dernier.framesParJoin / premier.framesParJoin : 0;
  console.log(
    `\n  Sockets ×${facteurN.toFixed(0)}  →  trames room_users ×${facteurFrames.toFixed(1)}` +
    `  ·  PAR ARRIVÉE : ${premier.framesParJoin} → ${dernier.framesParJoin} (×${facteurParArrivee.toFixed(2)})`,
  );
  console.log(
    facteurParArrivee <= 3
      ? `  ✓ le fan-out du compte de présence est LINÉAIRE en nombre de sockets :` +
        ` ${dernier.framesParJoin} trames par arrivée à ${dernier.n} sockets contre ${premier.framesParJoin} à ${premier.n}.\n` +
        '    La coalescence de `scheduleRoomCount` tient : pas de tempête quadratique au coup d\'envoi.\n' +
        `    (Quadratique, ce rapport vaudrait ~×${facteurN.toFixed(0)}.)`
      : `  ✗ les trames PAR ARRIVÉE suivent le nombre de sockets (×${facteurParArrivee.toFixed(1)} pour ×${facteurN.toFixed(0)}) —` +
        ' c\'est le comportement quadratique que la coalescence doit empêcher.',
  );

  // ── 2. Coût Neon par ouverture ──────────────────────────────────────────
  console.log(
    dernier.sqlParJoin <= 0.2
      ? `  ✓ ouverture de salon : ${dernier.sqlParJoin} requête Neon par arrivée à ${dernier.n} sockets —` +
        ' le critère S4 (« ~1, pas ~100 ») est tenu.'
      : `  ✗ ouverture de salon : ${dernier.sqlParJoin} requête Neon PAR ARRIVÉE (${dernier.sqlTempete} pour ${dernier.n} sockets).\n` +
        '    La même ligne de salon, immuable, est relue une fois par arrivant. Au coup d\'envoi d\'un\n' +
        '    match, c\'est une rafale de lectures identiques sur un pool qui compte dix connexions.',
  );
  if (dernier.detailTempete.length) {
    console.log('    Requêtes de la tempête :');
    for (const d of dernier.detailTempete) console.log(`        ${String(d.n).padStart(4)}×  ${d.sql}`);
  }

  // ── 3. Diffusion d'un message ───────────────────────────────────────────
  // La référence est le nombre de sockets RÉELLEMENT dans le salon. Comparer à
  // `n` ferait passer une limite du pilote (poignées de main refusées sur une
  // machine lente) pour une diffusion incomplète côté serveur.
  const actifs = (r: B11Row) => r.socketsActifs ?? r.n;
  const diffusionOk = rows.every((r) => r.framesNewMessage >= actifs(r) * 0.95 && r.statusEnvoi < 400);
  console.log(
    diffusionOk
      ? `  ✓ un message posté atteint bien tous les sockets du salon` +
        ` (${dernier.framesNewMessage}/${actifs(dernier)}), pour ${dernier.sqlMessage} requêtes SQL.`
      : `  ⚠ diffusion incomplète : ${dernier.framesNewMessage}/${actifs(dernier)} trames,` +
        ` statut d'envoi ${dernier.statusEnvoi}.`,
  );

  const erreurs = rows.reduce((a, r) => a + r.erreursSalon, 0);
  if (erreurs) {
    console.log(
      `  ⚠ ${erreurs} poignée(s) de main refusée(s) par le PILOTE (pas par le serveur) — il partage\n` +
      '    le processus du serveur, donc au-delà de quelques centaines de sockets simultanés c\'est\n' +
      '    lui qui sature en premier. La mesure porte sur les sockets réellement connectés ;\n' +
      '    `BENCH_SOCKET_WAVE` règle la taille des vagues de connexion.',
    );
  }

  console.log(
    `  · event loop p99 pendant la tempête : ${rows.map((r) => `${r.n}→${r.eventLoop.p99Ms} ms`).join(', ')}` +
    ` (plancher = résolution de metrics.ts).`,
  );
  console.log(
    '\n  Rappel : tout ceci est MONO-INSTANCE. `room_users` compte les sockets de CE process,\n' +
    '  et la coalescence est locale. Le verrou architectural que l\'audit signale (ligne D) —\n' +
    '  Socket.io sans adaptateur Redis — n\'est pas testable ici : il ne se manifeste qu\'à\n' +
    '  partir de la deuxième instance, où deux visiteurs du même salon cessent de se voir.',
  );
}

export function main(): void {
  printB11(runB11());
}
