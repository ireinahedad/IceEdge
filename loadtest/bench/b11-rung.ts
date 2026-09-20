/**
 * Palier du banc B11 — N sockets rejoignant LE MÊME salon, processus neuf.
 *
 * Reproduit le coup d'envoi : tout le monde arrive en même temps dans le salon
 * « live » d'un match. C'est le moment que le scénario S4 de l'audit décrit, et
 * le seul où l'amplification `room_users` se voit.
 */

import { boot, request, loginToken, sleep } from './harness';
import * as upstream from './upstream';
import * as pgstub from './pgstub';
import { emit, envInt } from './spawn';

/**
 * `socket.io-client` est une devDependency ajoutée pour ce banc.
 *
 * Résolu depuis `server/`, comme `pg` dans `pgstub.ts` : ce fichier vit dans
 * `loadtest/`, qui n'a pas de `node_modules`. Et un message clair vaut mieux
 * qu'une trace d'import pour quelqu'un qui n'a pas relancé `npm install`.
 */
function chargerClient() {
  const serveur = require('path').join(__dirname, '..', '..', 'server');
  try {
    const mod = require(require.resolve('socket.io-client', { paths: [serveur] }));
    return mod.io ?? mod.default?.io ?? mod.default;
  } catch {
    throw new Error(
      'socket.io-client introuvable. C\'est une devDependency ajoutée pour ce banc :\n' +
      '  cd server && npm install',
    );
  }
}

export async function main() {
  const n = envInt('BENCH_SOCKETS', 100);
  const intervalMs = envInt('BENCH_ROOM_INTERVAL_MS', 1000);
  const observationMs = envInt('BENCH_OBSERVE_MS', 3500);

  // Lu à l'import de `socket.ts` : posé AVANT `boot`, comme toutes les autres.
  process.env.ROOM_COUNT_INTERVAL_MS = String(intervalMs);

  upstream.setLeague({ teams: 32, games: 8, players: 20 });
  upstream.setLatency({ nhl: 5, odds: 5, ml: 3 });
  pgstub.setRowCount(20);
  pgstub.setUserRole('user');

  const io = chargerClient();
  const { base, metrics, close } = await boot({ sqlLatencyMs: 2, socket: true });
  const token = await loginToken(base);
  const ROOM = pgstub.BENCH_ROOM_ID;

  // ── La tempête d'arrivée ────────────────────────────────────────────────
  pgstub.reset();
  metrics.resetMetrics();

  let framesRoomUsers = 0;
  let framesNewMessage = 0;
  let erreursSalon = 0;
  const sockets: any[] = [];
  const debut = Date.now();

  /**
   * Connexions par VAGUES, et non toutes à la microseconde.
   *
   * POURQUOI — le pilote et le serveur partagent le même processus. Ouvrir 300
   * poignées de main WebSocket au même instant sature le CLIENT avant le
   * serveur : sur une machine plus lente que celle où ce banc a été écrit, une
   * soixantaine de sockets se voyaient refuser la connexion, et le banc
   * concluait à une diffusion incomplète — un défaut du pilote lu comme un
   * défaut du serveur, exactement ce qu'un banc ne doit jamais faire.
   *
   * Les vagues restent largement assez serrées pour ce qu'on mesure : la
   * fenêtre de coalescence du compte de présence dure une seconde, et toutes
   * les arrivées tiennent dedans. Le « coup d'envoi » reste un coup d'envoi.
   */
  const TAILLE_VAGUE = envInt('BENCH_SOCKET_WAVE', 50);
  const PAUSE_VAGUE_MS = envInt('BENCH_SOCKET_WAVE_MS', 120);

  const brancherUn = () => new Promise<void>((resolve) => {
    const s = io(base, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      timeout: 20_000,
    });
    sockets.push(s);
    s.on('room_users', () => { framesRoomUsers += 1; });
    s.on('new_message', () => { framesNewMessage += 1; });
    s.on('room_error', () => { erreursSalon += 1; resolve(); });
    s.on('connect_error', () => { erreursSalon += 1; resolve(); });
    s.on('connect', () => {
      s.emit('join_room', ROOM);
      // Résolu à la CONNEXION, pas à la première trame : attendre `room_users`
      // ferait dépendre la mesure de ce qu'on est en train de mesurer.
      resolve();
    });
  });

  for (let depart = 0; depart < n; depart += TAILLE_VAGUE) {
    const taille = Math.min(TAILLE_VAGUE, n - depart);
    await Promise.all(Array.from({ length: taille }, brancherUn));
    if (depart + taille < n) await sleep(PAUSE_VAGUE_MS);
  }

  const msPourConnecter = Date.now() - debut;

  // Fenêtre d'observation : assez longue pour couvrir plusieurs intervalles de
  // coalescence, donc pour voir si le fan-out se répète ou se tasse.
  await sleep(observationMs);

  const sqlTempete = pgstub.total();
  const detailTempete = pgstub.byStatement().slice(0, 3);
  const framesApresArrivee = framesRoomUsers;
  const snapTempete = metrics.snapshotMetrics();

  // ── Un message diffusé ──────────────────────────────────────────────────
  pgstub.reset();
  framesNewMessage = 0;
  const envoi = await request(base, `/api/chat/rooms/${ROOM}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text: 'banc de charge' }),
    discardBody: true,
  });
  await sleep(300);
  const sqlMessage = pgstub.total();

  for (const s of sockets) s.close();
  await sleep(100);

  emit({
    n,
    intervalMs,
    observationMs,
    msPourConnecter,
    erreursSalon,
    /** Sockets réellement dans le salon : c'est la base de comparaison des
     *  trames, pas `n`, quand le pilote n'a pas pu tous les connecter. */
    socketsActifs: n - erreursSalon,
    sqlTempete,
    // Rapporté aux sockets réellement entrés, pas à `n` : sinon une poignée
    // de main refusée par le pilote améliorerait artificiellement le chiffre.
    sqlParJoin: +(sqlTempete / Math.max(1, n - erreursSalon)).toFixed(2),
    detailTempete,
    framesRoomUsers: framesApresArrivee,
    framesParJoin: +(framesApresArrivee / Math.max(1, n - erreursSalon)).toFixed(2),
    statusEnvoi: envoi.status,
    sqlMessage,
    framesNewMessage,
    eventLoop: snapTempete.eventLoop,
    rssMb: snapTempete.memory.rssMb,
  });

  await close();
}
