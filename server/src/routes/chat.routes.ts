import { Router, Request, Response, NextFunction } from 'express';
import { chatService } from '../services/chat.service';
import { authenticate } from '../middleware/auth.middleware';
import { io } from '../socket';

const router = Router();

// Every chat route requires a valid JWT — identity comes from req.user.sub
router.use(authenticate);

function uid(req: Request): string {
  const id = (req as any).user?.sub;
  if (!id) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  return id;
}

// ─── Per-user rate limiting (in-memory sliding window) ───────────────────────
// Protects against message spam and join-code brute force.

const rateBuckets = new Map<string, number[]>();

function rateLimit(action: string, max: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${action}:${(req as any).user?.sub ?? req.ip}`;
    const now = Date.now();
    const hits = (rateBuckets.get(key) ?? []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      return res.status(429).json({ error: 'Too many requests — slow down' });
    }
    hits.push(now);
    rateBuckets.set(key, hits);
    next();
  };
}

// Prune stale buckets every 10 min so memory stays bounded
setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of rateBuckets) {
    const alive = hits.filter((t) => now - t < 10 * 60_000);
    if (alive.length === 0) rateBuckets.delete(key);
    else rateBuckets.set(key, alive);
  }
}, 10 * 60_000).unref();

// GET /api/chat/rooms — public rooms + my private rooms (pinned first)
router.get('/rooms', async (req: Request, res: Response) => {
  try { res.json(await chatService.getRoomsForUser(uid(req))); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// POST /api/chat/rooms — create (creator becomes admin) · max 5/5min
router.post('/rooms', rateLimit('create', 5, 5 * 60_000), async (req: Request, res: Response) => {
  try {
    const { name, icon, description, isPrivate, color } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    res.status(201).json(await chatService.createRoom(uid(req), {
      name, icon: icon ?? '💬', description: description ?? '', isPrivate: !!isPrivate, color,
    }));
  } catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// GET /api/chat/rooms/lookup?code=ABC123 — search a room by join code · max 10/min (anti brute-force)
router.get('/rooms/lookup', rateLimit('code', 10, 60_000), async (req: Request, res: Response) => {
  try {
    const code = String(req.query.code ?? '');
    if (!code) return res.status(400).json({ error: 'code is required' });
    res.json(await chatService.findRoomByCode(code, uid(req)));
  } catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// POST /api/chat/rooms/join — join by code (public or private) · max 10/min (anti brute-force)
router.post('/rooms/join', rateLimit('code', 10, 60_000), async (req: Request, res: Response) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'code is required' });
    res.json(await chatService.joinRoom(uid(req), { code }));
  } catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// POST /api/chat/rooms/:roomId/join — join a public room directly
router.post('/rooms/:roomId/join', async (req: Request, res: Response) => {
  try { res.json(await chatService.joinRoom(uid(req), { roomId: req.params.roomId })); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// POST /api/chat/rooms/:roomId/leave
router.post('/rooms/:roomId/leave', async (req: Request, res: Response) => {
  try { await chatService.leaveRoom(req.params.roomId, uid(req)); res.status(204).send(); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// POST /api/chat/rooms/:roomId/pin  { pinned: boolean }
router.post('/rooms/:roomId/pin', async (req: Request, res: Response) => {
  try { res.json(await chatService.setPinned(req.params.roomId, uid(req), !!req.body.pinned)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// GET /api/chat/rooms/:roomId/members
router.get('/rooms/:roomId/members', async (req: Request, res: Response) => {
  try { res.json(await chatService.getMembers(req.params.roomId, uid(req))); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// DELETE /api/chat/rooms/:roomId/members/:userId — admin kick
router.delete('/rooms/:roomId/members/:userId', async (req: Request, res: Response) => {
  try {
    await chatService.kickMember(req.params.roomId, uid(req), req.params.userId);
    res.status(204).send();
  } catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// POST /api/chat/rooms/:roomId/members/:userId/role  { role: 'admin' | 'member' }
router.post('/rooms/:roomId/members/:userId/role', async (req: Request, res: Response) => {
  try {
    await chatService.setRole(req.params.roomId, uid(req), req.params.userId, req.body.role);
    res.status(204).send();
  } catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// DELETE /api/chat/rooms/:roomId — admin only
router.delete('/rooms/:roomId', async (req: Request, res: Response) => {
  try {
    await chatService.deleteRoom(req.params.roomId, uid(req));
    res.status(204).send();
  } catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// GET /api/chat/rooms/:roomId/messages — members (or public rooms)
router.get('/rooms/:roomId/messages', async (req: Request, res: Response) => {
  try { res.json(await chatService.getRoomMessages(req.params.roomId, uid(req))); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// POST /api/chat/rooms/:roomId/messages — identity derived server-side · max 10/10s
router.post('/rooms/:roomId/messages', rateLimit('msg', 10, 10_000), async (req: Request, res: Response) => {
  try {
    const { text, tag, replyTo } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });

    const msg = await chatService.sendMessage(req.params.roomId, uid(req), { text, tag, replyTo });
    res.status(201).json(msg);
    // Broadcast to all clients in the room (real-time)
    try { io?.to(req.params.roomId).emit('new_message', msg); } catch { /* io not yet initialised */ }
  } catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// DELETE /api/chat/rooms/:roomId/messages/:messageId — own messages only
router.delete('/rooms/:roomId/messages/:messageId', async (req: Request, res: Response) => {
  try {
    await chatService.deleteMessage(req.params.roomId, req.params.messageId, uid(req));
    res.status(204).send();
    // Tell everyone in the room to drop the message in real time
    try { io?.to(req.params.roomId).emit('message_deleted', { messageId: req.params.messageId }); } catch { /* io not ready */ }
  } catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// POST /api/chat/rooms/:roomId/messages/:messageId/reactions · max 20/10s
router.post('/rooms/:roomId/messages/:messageId/reactions', rateLimit('react', 20, 10_000), async (req: Request, res: Response) => {
  try {
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ error: 'emoji is required' });
    await chatService.toggleReaction(req.params.roomId, req.params.messageId, uid(req), emoji);
    res.status(204).send();
  } catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

export default router;
