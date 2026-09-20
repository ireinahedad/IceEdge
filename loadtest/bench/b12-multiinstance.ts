/**
 * B12 — LE VERROU MULTI-INSTANCE (ligne D de l'audit)
 *
 * CE QUE L'AUDIT DIT, ET QUE PERSONNE N'AVAIT MESURÉ. `AUDIT_SCALABILITE_COUTS.md`
 * classe « Socket.io mono-instance » en 🔴, « le dernier verrou architectural ».
 * C'est une conclusion de lecture de code — juste, mais jamais vérifiée. Or
 * c'est le genre d'affirmation qu'il vaut mieux voir échouer sur une machine
 * que découvrir le soir où on passe à deux conteneurs.
 *
 * L'EXPÉRIENCE, en une phrase : deux instances complètes de l'application, dans
 * deux processus, chacune avec son Socket.io. Un lecteur branché sur chacune.
 * On poste un message sur l'instance A — qui le reçoit ?
 *
 *   • Le lecteur de A : oui. C'est le cas mono-instance, celui que B11 mesure.
 *   • Le lecteur de B : **non**, tant qu'aucun adaptateur ne relie les deux.
 *     `io.to(room).emit()` ne parle qu'aux sockets de SON processus.
 *
 * CE QUE ÇA VEUT DIRE EN PRODUCTION : à partir de la deuxième instance, deux
 * personnes dans le même salon cessent de se voir une fois sur deux, selon le
 * conteneur sur lequel le répartiteur les a posées. Le symptôme n'est pas une
 * erreur, c'est un chat qui « marche mal » — et il est invisible tant qu'on ne
 * tourne qu'à une instance, c'est-à-dire pendant tout le développement.
 *
 * DEUX MODES, UN SEUL BANC — et c'est `REDIS_URL` qui choisit, côté SERVEUR :
 *
 *   • absente → adaptateur mémoire. Le message ne traverse pas : ✗ attendu, et
 *     c'est le comportement CORRECT d'un déploiement à une instance. C'est dans
 *     ce mode que tourne la suite `all`.
 *   • posée → `@socket.io/redis-adapter` (voir `server/src/redis.ts`). Le message
 *     traverse, et chaque instance annonce le salon ENTIER. Ce banc est alors la
 *     non-régression de la ligne D, fermée le 2026-09-19.
 *
 *     cd server && REDIS_URL=redis://127.0.0.1:6399 node ../loadtest/bench/run.js b12-multiinstance
 *
 * POURQUOI CE BANC EXISTE APRÈS LE CORRECTIF. La bannière de démarrage dit quel
 * adaptateur est CHARGÉ ; elle ne dit pas qu'un message TRAVERSE. Entre les deux
 * il y a de la place pour se tromper, et on s'y est trompé : avec l'adaptateur
 * actif, la diffusion passait déjà pendant que le compte de présence restait à
 * 1 de chaque côté — parce que `allSockets()` est LOCAL. Seul ce banc pouvait
 * le voir.
 *
 * PRÉREQUIS : `socket.io-client` (devDependency). `cd server && npm install`.
 */

import { spawn, ChildProcess } from 'child_process';
import { join } from 'path';
import { boot, request, loginToken, sleep } from './harness';
import * as upstream from './upstream';
import * as pgstub from './pgstub';
import { MARQUE_PORT } from './b12-instance';

const RUNNER = join(__dirname, 'run.js');
const SERVER_DIR = join(__dirname, '..', '..', 'server');

function chargerClient() {
  const mod = require(require.resolve('socket.io-client', { paths: [SERVER_DIR] }));
  return mod.io ?? mod.default?.io ?? mod.default;
}

/** Démarre l'instance B et attend qu'elle annonce son adresse. */
function demarrerInstanceB(): Promise<{ base: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [RUNNER, 'b12-instance'], {
      cwd: SERVER_DIR,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let tampon = '';
    const minuteur = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`L'instance B n'a pas annoncé son port.\n${tampon.slice(-1500)}`));
    }, 60_000);

    proc.stdout.on('data', (c) => {
      tampon += c;
      const ligne = tampon.split('\n').find((l) => l.startsWith(MARQUE_PORT));
      if (ligne) {
        clearTimeout(minuteur);
        resolve({ base: ligne.slice(MARQUE_PORT.length).trim(), proc });
      }
    });
    proc.stderr.on('data', (c) => { tampon += c; });
    proc.on('exit', (code) => {
      clearTimeout(minuteur);
      reject(new Error(`L'instance B s'est arrêtée (code ${code}).\n${tampon.slice(-1500)}`));
    });
  });
}

export async function main() {
  // Coalescence courte : le compte de présence groupé passe par `compterSalon`,
  // qui interroge tout le cluster avec `fetchSockets()` dès qu'un adaptateur est
  // branché (`allSockets()`, lui, reste LOCAL même avec adaptateur — c'est
  // mesuré, et c'est le piège que ce banc a fait tomber). Avec l'intervalle par
  // défaut (3 s) l'émission groupée ne se déclenche pas pendant la fenêtre de
  // mesure, et le banc ne verrait que la moitié de ce que l'adaptateur apporte.
  process.env.ROOM_COUNT_INTERVAL_MS = process.env.ROOM_COUNT_INTERVAL_MS ?? '400';

  upstream.setLeague({ teams: 32, games: 8, players: 20 });
  upstream.setLatency({ nhl: 5, odds: 5, ml: 3 });
  pgstub.setRowCount(10);
  pgstub.setUserRole('user');

  const io = chargerClient();
  const { base: baseA, close } = await boot({ sqlLatencyMs: 1, socket: true });
  const { base: baseB, proc } = await demarrerInstanceB();

  // Le même `JWT_SECRET` est posé par `harness.boot` des deux côtés : un jeton
  // émis par A est donc accepté par B, exactement comme derrière un répartiteur.
  const token = await loginToken(baseA);
  const ROOM = pgstub.BENCH_ROOM_ID;

  const recu = { A: 0, B: 0 };
  const compteurs = { A: -1, B: -1 };

  const brancher = (base: string, cle: 'A' | 'B') => new Promise<any>((resolve) => {
    const s = io(base, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false });
    s.on('new_message', () => { recu[cle] += 1; });
    s.on('room_users', (n: number) => { compteurs[cle] = n; });
    s.on('connect', () => { s.emit('join_room', ROOM); resolve(s); });
  });

  const sA = await brancher(baseA, 'A');
  const sB = await brancher(baseB, 'B');
  // Assez long pour couvrir au moins une émission groupée du compte de
  // présence : c'est elle qui, avec un adaptateur, voit les sockets des DEUX
  // instances.
  await sleep(1500);

  const envoi = await request(baseA, `/api/chat/rooms/${ROOM}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text: 'message posté sur l\'instance A' }),
    discardBody: true,
  });
  await sleep(1000);

  sA.close(); sB.close();
  proc.kill('SIGTERM');
  await sleep(200);

  // ── Restitution ─────────────────────────────────────────────────────────
  console.log('\n═══ B12 · Deux instances — un message traverse-t-il ? (ligne D) ═══\n');
  console.log(`  POST du message sur l'instance A → ${envoi.status}\n`);
  console.log(' lecteur branché sur │ trames `new_message` reçues │ « N en ligne » annoncé');
  console.log('─────────────────────┼─────────────────────────────┼───────────────────────');
  console.log(` instance A          │ ${String(recu.A).padStart(27)} │ ${String(compteurs.A).padStart(21)}`);
  console.log(` instance B          │ ${String(recu.B).padStart(27)} │ ${String(compteurs.B).padStart(21)}`);

  const traverse = recu.B > 0;
  const localOk = recu.A > 0;

  if (!localOk) {
    console.log('\n  ⚠ le lecteur de l\'instance A n\'a rien reçu non plus : le banc ne mesure pas ce qu\'il croit.');
  } else if (traverse) {
    const presenceOk = compteurs.A >= 2 && compteurs.B >= 2;
    console.log(
      '\n  ✓ le message a traversé les deux instances : un adaptateur relie les Socket.io.\n' +
      '    La ligne D de l\'audit n\'est plus ouverte — ce banc sert désormais de non-régression.\n' +
      (presenceOk
        ? `    Le compte de présence le confirme : chaque instance annonce ${compteurs.A} personnes,\n` +
          '    c\'est-à-dire le salon entier et non ses seuls sockets locaux.'
        : `    ⚠ le compte de présence annonce encore ${compteurs.A} et ${compteurs.B}. Ce n'est pas la\n` +
          '      diffusion qui est en cause (le message est passé) : l\'émission groupée qui interroge\n' +
          '      tout le cluster n\'a pas encore eu lieu dans la fenêtre de mesure. Allonger\n' +
          '      `ROOM_COUNT_INTERVAL_MS` ou l\'attente si on veut la voir.'),
    );
  } else {
    console.log(
      '\n  ✗ CONFIRMÉ — le message reste dans l\'instance qui l\'a reçu.\n' +
      '    `io.to(room).emit()` ne parle qu\'aux sockets de son propre processus.\n' +
      '\n    En production, à partir de la deuxième instance : deux personnes du même salon\n' +
      '    ne se voient que si le répartiteur les a posées sur le même conteneur. Le symptôme\n' +
      '    n\'est pas une erreur — c\'est un chat qui « marche une fois sur deux », invisible\n' +
      '    tant qu\'on ne tourne qu\'à une instance.\n' +
      '\n    Le compte de présence le dit aussi : chaque instance annonce SES sockets\n' +
      `    (${compteurs.A} et ${compteurs.B}), jamais le total du salon.\n` +
      '\n    Ce n\'est pas un défaut de ce dépôt : c\'est le comportement CORRECT d\'un\n' +
      '    déploiement à UNE instance, et c\'est ainsi que tourne la suite `all`.\n' +
      '\n    L\'adaptateur Redis est livré depuis le 2026-09-19 (server/src/redis.ts) : il\n' +
      '    suffit d\'un Redis joignable pour voir ce banc passer au vert, sans le retoucher.\n' +
      '        REDIS_URL=redis://127.0.0.1:6399 node ../loadtest/bench/run.js b12-multiinstance',
    );
  }

  await close();
}
