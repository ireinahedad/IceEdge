/**
 * socket.ts — Socket.io singleton
 *
 * Initialised once in server.ts, then imported anywhere that needs to emit.
 * chat.routes.ts calls io.to(roomId).emit('new_message', msg) after each POST.
 */
import { Server } from 'socket.io';
import type { Server as HttpServer } from 'http';

export let io: Server;

export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: { origin: '*' },
    path: '/socket.io',
  });

  io.on('connection', (socket) => {
    // Client joins a chat room
    socket.on('join_room', async (roomId: string) => {
      socket.join(roomId);
      const sockets = await io.in(roomId).allSockets();
      io.to(roomId).emit('room_users', sockets.size);
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
