/**
 * socket.ts — Socket.io singleton
 *
 * Initialised once in server.ts, then imported anywhere that needs to emit.
 * chat.routes.ts calls io.to(roomId).emit('new_message', msg) after each POST.
 *
 * Security: clients authenticate the socket with their JWT (auth.token).
 * join_room verifies room read-access (membership for private rooms) before
 * subscribing the socket, so private-room broadcasts never leak.
 */
import { Server } from 'socket.io';
import type { Server as HttpServer } from 'http';
import { verifyAccessToken } from './services/auth.service';
import { chatService } from './services/chat.service';
import { corsOriginCallback } from './cors';

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
      const sockets = await io.in(roomId).allSockets();
      // Salon vide → plus personne à qui émettre ; on évite un aller-retour inutile.
      if (sockets.size > 0) io.to(roomId).emit('room_users', sockets.size);
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
 * Compte local du salon, sans allocation ni parcours : `adapter.rooms` est une
 * Map de Sets, donc `.size` est en O(1).
 *
 * Sert à donner immédiatement son compte au socket qui vient d'entrer — sans
 * lui, il affiche « 0 en ligne » jusqu'à la prochaine émission groupée. Un seul
 * message sortant, vers un seul destinataire : c'est le fan-out qu'on limite,
 * pas la mesure.
 *
 * NB : local à l'instance. Le jour où l'adaptateur Redis arrive (multi-instance),
 * ce chiffre initial sous-estimera le total jusqu'à la première émission
 * groupée, qui elle passe par `allSockets()` et couvre le cluster.
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

  // Authenticate every socket connection via JWT
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) return next(new Error('Authentication required'));
      const payload = verifyAccessToken(token);
      (socket.data as any).userId = payload.sub;
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = (socket.data as any).userId as string;

    // Client joins a chat room — only if allowed to read it
    socket.on('join_room', async (roomId: string) => {
      try {
        const allowed = await chatService.canRead(roomId, userId);
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
