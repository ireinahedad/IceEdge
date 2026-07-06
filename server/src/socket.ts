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

export let io: Server;

export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: { origin: process.env.CORS_ORIGIN || process.env.CLIENT_URL || 'http://localhost:5173' },
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
        const sockets = await io.in(roomId).allSockets();
        io.to(roomId).emit('room_users', sockets.size);
      } catch {
        socket.emit('room_error', { roomId, error: 'Could not join room' });
      }
    });

    // Client leaves a chat room explicitly
    socket.on('leave_room', async (roomId: string) => {
      socket.leave(roomId);
      const sockets = await io.in(roomId).allSockets();
      io.to(roomId).emit('room_users', sockets.size);
    });

    // Broadcast updated count when a user disconnects mid-session
    socket.on('disconnecting', async () => {
      for (const roomId of socket.rooms) {
        if (roomId === socket.id) continue; // skip the default personal room
        const sockets = await io.in(roomId).allSockets();
        // -1 because the socket is still counted until after disconnect
        io.to(roomId).emit('room_users', Math.max(0, sockets.size - 1));
      }
    });
  });

  return io;
}
