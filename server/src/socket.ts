/**
 * socket.ts — Socket.io singleton
 *
 * Initialised once in server.ts, then imported anywhere that needs to emit.
 * chat.routes.ts calls io.to(roomId).emit('new_message', msg) after each POST.
 *
 * Security: clients authenticate the socket with their JWT (auth.token).
 * join_room verifies room read-access (membership for private rooms) before
 * subscribing the socket, so private-room broadcasts never leak.
 *
 * Depuis le 2026-09-11, un handshake SANS jeton est accepté comme invité —
 * lecture seule, salons publics uniquement. Voir le commentaire du middleware
 * d'authentification plus bas pour ce que ça ouvre et ce que ça n'ouvre pas.
 */
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server as HttpServer } from 'http';
import { verifyAccessToken } from './services/auth.service';
import { chatService } from './services/chat.service';
import { corsOriginCallback } from './cors';
import { socketRedisClients } from './redis';
import { logger } from './logger';

export let io: Server;

// ── Compte de présence (room_users) ─────────────────────────────────────────
//
// Chaque join / leave / disconnect recalculait `allSockets()` (parcours de tous
// les sockets du salon) puis émettait le résultat à TOUS ses membres. Dans le
// salon « live » d'un match à 2 000 personnes, une seule connexion produisait
// 2 000 messages sortants ; le coup d'envoi, où tout le monde arrive en même
// temps, générait donc un trafic quadratique qui sature l'event loop — et fait
// tomber la latence des vrais messages, ceux qu'on est venu lire.
//
// Le compte est un indicateur d'ambiance, pas une donnée transactionnelle : le
// client s'en sert pour afficher « N en ligne ». On coalesce donc la rafale en
// une seule mesure + un seul envoi par salon toutes les ROOM_COUNT_INTERVAL_MS.
// Le coût d'une tempête de connexions devient linéaire en nombre de salons, et
// non plus quadratique en nombre de sockets.
const ROOM_COUNT_INTERVAL_MS = Number(process.env.ROOM_COUNT_INTERVAL_MS) || 3_000;

/** Vrai quand la diffusion traverse les instances. Lu par la bannière de
 *  démarrage — un réglage qui change silencieusement ce que le serveur fait
 *  doit être visible sans avoir à le déduire — et par `compterSalon`, qui
 *  n'interroge le cluster que s'il y en a un. */
export let socketAdapter: 'memory' | 'redis' = 'memory';

/** Salons dont une émission de compte est déjà programmée. */
const roomCountTimers = new Map<string, NodeJS.Timeout>();

/**
 * Programme une émission de `room_users` pour ce salon, au plus une par
 * intervalle. Volontairement en fin d'intervalle (trailing edge) : quand le
 * timer se déclenche, les entrées ET sorties de la rafale sont terminées, donc
 * le compte mesuré est le bon. C'est aussi ce qui permet de supprimer le
 * « −1 » que `disconnecting` devait appliquer parce qu'il mesurait avant que
 * le socket ait réellement quitté le salon.
 */
function scheduleRoomCount(roomId: string): void {
  if (roomCountTimers.has(roomId)) return;

  const timer = setTimeout(async () => {
    // Retiré AVANT l'await : une nouvelle rafale pendant la mesure doit pouvoir
    // reprogrammer une émission, sinon le compte se fige.
    roomCountTimers.delete(roomId);
    try {
      const total = await compterSalon(roomId);
      // Salon vide → plus personne à qui émettre ; on évite un aller-retour inutile.
      if (total > 0) io.to(roomId).emit('room_users', total);
    } catch {
      // Adaptateur indisponible / salon disparu : le compte est cosmétique,
      // on n'escalade pas.
    }
  }, ROOM_COUNT_INTERVAL_MS);

  // Ne pas retenir l'event loop pour un compteur d'affichage lors de l'arrêt.
  timer.unref();
  roomCountTimers.set(roomId, timer);
}

/**
 * Combien de personnes dans ce salon, sur TOUTES les instances.
 *
 * ⚠️ `io.in(room).allSockets()` NE COUVRE PAS LE CLUSTER, contrairement à ce
 * que ce fichier a longtemps affirmé. Mesuré le 2026-09-19, deux instances
 * reliées par `@socket.io/redis-adapter`, un socket sur chacune :
 *
 *     serverCount()      = 2   ← l'adaptateur voit bien les deux nœuds
 *     emit()             → traverse  ← la diffusion, elle, est partagée
 *     allSockets()       = 1   ← LOCAL
 *     adapter.sockets()  = 1   ← LOCAL
 *     fetchSockets()     = 2   ← cluster
 *
 * Autrement dit, brancher l'adaptateur répare la diffusion mais PAS ce compte :
 * il aurait continué à annoncer « 1 en ligne » à chacun, sans erreur nulle
 * part. C'est le genre de demi-correction qu'on ne découvre qu'en production.
 *
 * `fetchSockets()` rapatrie des descripteurs de socket, pas un entier : sur un
 * salon de 2 000 personnes, ça traverse Redis à chaque émission groupée. C'est
 * tenable PARCE QUE l'émission est coalescée à une par salon et par
 * `ROOM_COUNT_INTERVAL_MS` (3 s par défaut) — sans cette coalescence, ce serait
 * une mauvaise idée. Si le coût devenait visible, le levier est l'intervalle,
 * pas le retour à un compte local qui serait faux.
 *
 * Sans adaptateur (mono-instance), on garde le compte local : même résultat,
 * sans le moindre aller-retour.
 */
async function compterSalon(roomId: string): Promise<number> {
  if (socketAdapter === 'memory') return localRoomSize(roomId);
  const sockets = await io.in(roomId).fetchSockets();
  return sockets.length;
}

/**
 * Compte local du salon, sans allocation ni parcours : `adapter.rooms` est une
 * Map de Sets, donc `.size` est en O(1).
 *
 * Sert à donner immédiatement son compte au socket qui vient d'entrer — sans
 * lui, il affiche « 0 en ligne » jusqu'à la prochaine émission groupée. Un seul
 * message sortant, vers un seul destinataire : c'est le fan-out qu'on limite,
 * pas la mesure.
 *
 * NB : local à l'instance, et il le reste. L'arrivant voit donc d'abord les
 * personnes de SON conteneur, puis le total du salon à la première émission
 * groupée — celle-ci passe par `compterSalon`, qui interroge le cluster.
 */
function localRoomSize(roomId: string): number {
  return io.sockets.adapter.rooms.get(roomId)?.size ?? 0;
}

export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    // Même politique d'origine que l'API HTTP (voir ./cors). Auparavant cette
    // ligne lisait CORS_ORIGIN brut : une liste à deux origines cassait le
    // WebSocket pour toutes.
    cors: { origin: corsOriginCallback, credentials: true },
    path: '/socket.io',
  });

  /**
   * ── Diffusion entre instances (audit, ligne D) ────────────────────────────
   *
   * Sans adaptateur, `io.to(room).emit()` ne touche que les sockets de CE
   * process : à deux instances, deux personnes du même salon ne se voient que
   * si le répartiteur les a posées sur le même conteneur. Silencieusement.
   *
   * L'adaptateur Redis relaie chaque diffusion aux autres instances par
   * pub/sub. Branché seulement si `REDIS_URL` est posé — sans lui, le
   * comportement est EXACTEMENT celui d'avant, ce qui reste correct à une
   * instance.
   *
   * ⚠️ IL NE SUFFIT PAS SEUL. L'adaptateur règle la DIFFUSION ; il ne règle pas
   * le HANDSHAKE. Une poignée de main en HTTP long-polling s'étale sur
   * plusieurs requêtes qui doivent toutes atteindre la même instance, faute de
   * quoi le client reçoit des 400. La parade habituelle est l'affinité de
   * session côté répartiteur — que **Railway ne propose pas et n'a pas prévu**.
   * D'où le client réglé sur `transports: ['websocket']` (voir
   * `client/src/app/hooks/useChatSocket.ts`) : une seule connexion TCP, donc
   * plus rien à faire suivre. Les deux changements vont ensemble ; brancher
   * celui-ci sans l'autre produirait des erreurs 400 intermittentes à la
   * deuxième instance.
   */
  const clients = socketRedisClients();
  if (clients) {
    io.adapter(createAdapter(clients.pub, clients.sub));
    socketAdapter = 'redis';
    logger.info('[Socket] adaptateur Redis actif — diffusion partagée entre instances');
  } else {
    logger.info('[Socket] adaptateur mémoire — diffusion LOCALE à cette instance (mono-instance uniquement)');
  }

  /**
   * Authentification du socket — avec, pour la première fois, un chemin invité.
   *
   * ── Ce que ça corrige ───────────────────────────────────────────────────────
   * L'historique des salons publics est lisible sans compte via HTTP
   * (`getPublicRoomMessages`), mais le socket exigeait un jeton. Un visiteur
   * voyait donc les messages et **jamais les nouveaux**, avec « 0 en ligne » et
   * un point gris : l'application avait l'air cassée. Pire, le refus de
   * handshake ('Authentication required') contient « auth », donc le client
   * tentait un refresh, échouait, et affichait « session expirée » à quelqu'un
   * qui n'avait jamais eu de session. C'est aussi la première chose que voit un
   * relecteur Apple, qui n'est pas connecté.
   *
   * ── La distinction qui compte : jeton ABSENT ≠ jeton INVALIDE ───────────────
   * Un jeton absent, c'est un visiteur : on le laisse entrer en invité. Un
   * jeton présent mais refusé, c'est une session expirée : on refuse, et le
   * `connect_error` du client déclenche son refresh comme avant. Confondre les
   * deux ferait retomber silencieusement un utilisateur connecté en invité au
   * bout de 15 minutes — il perdrait ses salons privés sans un mot.
   *
   * ── Ce que ça ouvre, et ce que ça n'ouvre pas ──────────────────────────────
   * Ça ouvre : un socket sans compte peut exister, donc consommer une connexion
   * (il n'y a pas de plafond par IP ici ; c'est à l'hébergeur de le poser).
   * Ça n'ouvre pas : ce socket n'a AUCUN chemin d'écriture — les messages
   * partent en POST HTTP, qui exige toujours un compte —, il ne peut rejoindre
   * qu'un salon public, et il n'y reçoit que ce que `GET /messages` lui sert
   * déjà sans compte. Il n'y a donc pas une donnée de plus qui sorte.
   */
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;

    // Invité : lecture seule, salons publics. `userId` reste null et c'est
    // `join_room` qui applique la règle.
    if (!token) {
      (socket.data as any).userId = null;
      return next();
    }

    try {
      const payload = verifyAccessToken(token);
      (socket.data as any).userId = payload.sub;
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = (socket.data as any).userId as string | null;

    // Client joins a chat room — only if allowed to read it
    socket.on('join_room', async (roomId: string) => {
      try {
        // Un invité n'a pas d'appartenance à vérifier : la seule question est
        // de savoir si le salon est public. Même règle que le chemin HTTP.
        const allowed = userId
          ? await chatService.canRead(roomId, userId)
          : await chatService.isPublicRoom(roomId);
        if (!allowed) {
          socket.emit('room_error', { roomId, error: 'Access denied' });
          return;
        }
        socket.join(roomId);
        // Retour immédiat pour l'arrivant seul ; les autres l'apprendront à la
        // prochaine émission groupée.
        socket.emit('room_users', localRoomSize(roomId));
        scheduleRoomCount(roomId);
      } catch {
        socket.emit('room_error', { roomId, error: 'Could not join room' });
      }
    });

    // Client leaves a chat room explicitly
    socket.on('leave_room', (roomId: string) => {
      socket.leave(roomId);
      scheduleRoomCount(roomId);
    });

    // Broadcast updated count when a user disconnects mid-session
    socket.on('disconnecting', () => {
      for (const roomId of socket.rooms) {
        if (roomId === socket.id) continue; // skip the default personal room
        scheduleRoomCount(roomId);
      }
    });
  });

  return io;
}
