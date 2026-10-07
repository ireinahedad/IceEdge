import { Router, Request, Response, NextFunction } from 'express';
import { chatService } from '../services/chat.service';
import { optionalAuthenticate } from '../middleware/auth.middleware';
import { createChatRateLimitStore, RateLimitStore } from '../middleware/rateLimitStore';
import { validateBody } from '../middleware/validate.middleware';
import {
  chatCreateRoomSchema, chatJoinByCodeSchema, chatSendMessageSchema,
  chatReactionSchema, chatReportSchema,
} from '../validation/schemas';
import { io } from '../socket';
import { sendError } from '../httpError';

const router = Router();

// Optional auth: read-only endpoints (public room list + public messages) are
// visible to signed-out guests; every write still calls uid() which throws 401
// when no valid token is present, so posting/creating/joining stays protected.
router.use(optionalAuthenticate);

function uid(req: Request): string {
  const id = (req as any).user?.sub;
  if (!id) throw Object.assign(new Error('Sign in to continue'), { status: 401 });
  return id;
}

// ─── Per-user rate limiting (sliding window) ─────────────────────────────────
// Protects against message spam and join-code brute force.
//
// Storage is abstracted behind RateLimitStore. With REDIS_URL the counters live
// in Redis and are shared across instances (sliding window, Lua-atomic); without
// it, the in-memory store — SINGLE-INSTANCE ONLY — exactly as before. If Redis
// goes down at runtime the Redis store falls back to memory on its own
// (cf. rateLimitStore.ts) — the middleware below is unchanged either way.
const rateStore: RateLimitStore = createChatRateLimitStore();

function rateLimit(action: string, max: number, windowMs: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = `${action}:${(req as any).user?.sub ?? req.ip}`;
      const allowed = await rateStore.tryConsume(key, max, windowMs);
      if (!allowed) {
        return res.status(429).json({ error: 'Too many requests — slow down' });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// GET /api/chat/rooms — signed-in: public rooms + my private rooms (pinned
// first). Guests: public rooms only (read-only).
router.get('/rooms', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.sub as string | undefined;
    res.json(userId
      ? await chatService.getRoomsForUser(userId)
      : await chatService.getPublicRooms());
  } catch (err: any) { sendError(res, err); }
});

// POST /api/chat/rooms — create (creator becomes admin) · max 5/5min
router.post('/rooms', rateLimit('create', 5, 5 * 60_000), validateBody(chatCreateRoomSchema), async (req: Request, res: Response) => {
  try {
    const { name, icon, description, isPrivate, color } = req.body;
    res.status(201).json(await chatService.createRoom(uid(req), {
      name, icon: icon ?? '💬', description: description ?? '', isPrivate: !!isPrivate, color,
    }));
  } catch (err: any) { sendError(res, err); }
});

// GET /api/chat/rooms/lookup?code=ABC123 — search a room by join code · max 10/min (anti brute-force)
router.get('/rooms/lookup', rateLimit('code', 10, 60_000), async (req: Request, res: Response) => {
  try {
    const code = String(req.query.code ?? '');
    if (!code) return res.status(400).json({ error: 'code is required' });
    res.json(await chatService.findRoomByCode(code, uid(req)));
  } catch (err: any) { sendError(res, err); }
});

// POST /api/chat/rooms/join — join by code (public or private) · max 10/min (anti brute-force)
router.post('/rooms/join', rateLimit('code', 10, 60_000), validateBody(chatJoinByCodeSchema), async (req: Request, res: Response) => {
  try {
    const { code } = req.body;
    res.json(await chatService.joinRoom(uid(req), { code }));
  } catch (err: any) { sendError(res, err); }
});

// POST /api/chat/rooms/:roomId/join — join a public room directly
router.post('/rooms/:roomId/join', async (req: Request, res: Response) => {
  try { res.json(await chatService.joinRoom(uid(req), { roomId: req.params.roomId })); }
  catch (err: any) { sendError(res, err); }
});

// POST /api/chat/rooms/:roomId/leave
router.post('/rooms/:roomId/leave', async (req: Request, res: Response) => {
  try { await chatService.leaveRoom(req.params.roomId, uid(req)); res.status(204).send(); }
  catch (err: any) { sendError(res, err); }
});

// POST /api/chat/rooms/:roomId/pin  { pinned: boolean }
router.post('/rooms/:roomId/pin', async (req: Request, res: Response) => {
  try { res.json(await chatService.setPinned(req.params.roomId, uid(req), !!req.body.pinned)); }
  catch (err: any) { sendError(res, err); }
});

// GET /api/chat/rooms/:roomId/members
router.get('/rooms/:roomId/members', async (req: Request, res: Response) => {
  try { res.json(await chatService.getMembers(req.params.roomId, uid(req))); }
  catch (err: any) { sendError(res, err); }
});

// DELETE /api/chat/rooms/:roomId/members/:userId — admin kick
router.delete('/rooms/:roomId/members/:userId', async (req: Request, res: Response) => {
  try {
    await chatService.kickMember(req.params.roomId, uid(req), req.params.userId);
    res.status(204).send();
  } catch (err: any) { sendError(res, err); }
});

// POST /api/chat/rooms/:roomId/members/:userId/role  { role: 'admin' | 'member' }
router.post('/rooms/:roomId/members/:userId/role', async (req: Request, res: Response) => {
  try {
    await chatService.setRole(req.params.roomId, uid(req), req.params.userId, req.body.role);
    res.status(204).send();
  } catch (err: any) { sendError(res, err); }
});

// DELETE /api/chat/rooms/:roomId — admin only
router.delete('/rooms/:roomId', async (req: Request, res: Response) => {
  try {
    await chatService.deleteRoom(req.params.roomId, uid(req));
    res.status(204).send();
  } catch (err: any) { sendError(res, err); }
});

// GET /api/chat/rooms/:roomId/messages — members (or public rooms). Guests may
// read PUBLIC room messages; private rooms require a signed-in member.
router.get('/rooms/:roomId/messages', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.sub as string | undefined;
    res.json(userId
      ? await chatService.getRoomMessages(req.params.roomId, userId)
      : await chatService.getPublicRoomMessages(req.params.roomId));
  } catch (err: any) { sendError(res, err); }
});

// POST /api/chat/rooms/:roomId/messages — identity derived server-side · max 10/10s
router.post('/rooms/:roomId/messages', rateLimit('msg', 10, 10_000), validateBody(chatSendMessageSchema), async (req: Request, res: Response) => {
  try {
    const { text, tag, replyTo, slipId } = req.body;
    const msg = await chatService.sendMessage(req.params.roomId, uid(req), { text, tag, replyTo, slipId });
    res.status(201).json(msg);
    // Broadcast to all clients in the room (real-time)
    //
    // ⚠️ R4.2g — ce broadcast N'EST PAS filtré par les blocages, et c'est un
    // choix, pas un oubli. `io.to(roomId)` émet à la salle entière : filtrer par
    // destinataire demanderait soit une émission par socket avec la liste de
    // blocage de chacun, soit des salles dérivées par paire — deux fois plus de
    // requêtes et un cache à invalider à chaque blocage, pour un salon de chat.
    //
    // Pour la v1, c'est le CLIENT qui filtre le direct contre la liste de
    // blocage qu'il a déjà chargée (R4.3d). Conséquence à connaître : le message
    // d'une personne bloquée traverse quand même le réseau jusqu'au navigateur
    // de celui qui l'a bloquée — il n'est jamais affiché, mais ce n'est pas un
    // secret gardé côté serveur. L'historique (R4.2f), lui, est filtré en SQL.
    //
    // Le jour où ça ne suffit plus : émettre depuis le serveur vers des sockets
    // nommés plutôt que vers la salle, en gardant la liste de blocage en mémoire
    // par connexion.
    try { io?.to(req.params.roomId).emit('new_message', msg); } catch { /* io not yet initialised */ }
  } catch (err: any) { sendError(res, err); }
});

// DELETE /api/chat/rooms/:roomId/messages/:messageId — own messages only
router.delete('/rooms/:roomId/messages/:messageId', async (req: Request, res: Response) => {
  try {
    await chatService.deleteMessage(req.params.roomId, req.params.messageId, uid(req));
    res.status(204).send();
    // Tell everyone in the room to drop the message in real time
    try { io?.to(req.params.roomId).emit('message_deleted', { messageId: req.params.messageId }); } catch { /* io not ready */ }
  } catch (err: any) { sendError(res, err); }
});

// POST /api/chat/rooms/:roomId/messages/:messageId/reactions · max 20/10s
router.post('/rooms/:roomId/messages/:messageId/reactions', rateLimit('react', 20, 10_000), validateBody(chatReactionSchema), async (req: Request, res: Response) => {
  try {
    const { emoji } = req.body;
    await chatService.toggleReaction(req.params.roomId, req.params.messageId, uid(req), emoji);
    res.status(204).send();
  } catch (err: any) { sendError(res, err); }
});

// POST /api/chat/rooms/:roomId/messages/:messageId/report · max 10/5min
//
// Guideline 1.2 : une façon de signaler du contenu répréhensible. Le chemin est
// imbriqué comme les réactions et la suppression, pas plat comme l'annonçait le
// plan : le roomId sert d'abord à autoriser la lecture, et le message est
// ensuite vérifié comme appartenant à ce salon. Un chemin plat aurait laissé
// n'importe quel compte confirmer l'existence d'un message d'un salon privé.
//
// La route reste fine : validation du motif, refus de l'auto-signalement et
// masquage automatique vivent dans chat.service.ts, avec tous les autres
// garde-fous de ce domaine.
router.post('/rooms/:roomId/messages/:messageId/report', rateLimit('report', 10, 5 * 60_000), validateBody(chatReportSchema), async (req: Request, res: Response) => {
  try {
    const { reason, note } = req.body ?? {};
    const result = await chatService.reportMessage(
      req.params.roomId, req.params.messageId, uid(req), { reason, note },
    );
    res.status(201).json(result);
  } catch (err: any) { sendError(res, err); }
});

export default router;
