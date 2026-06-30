import { Router, Request, Response } from 'express';
import { chatService } from '../services/chat.service';
import { io } from '../socket';

const router = Router();

router.get('/rooms', async (_req: Request, res: Response) => {
  try { res.json(await chatService.getRooms()); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

router.post('/rooms', async (req: Request, res: Response) => {
  try {
    const { name, icon, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    res.status(201).json(await chatService.createRoom({ name, icon: icon ?? '💬', description: description ?? '' }));
  } catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

router.get('/rooms/:roomId/messages', async (req: Request, res: Response) => {
  try { res.json(await chatService.getRoomMessages(req.params.roomId)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

router.post('/rooms/:roomId/messages', async (req: Request, res: Response) => {
  try {
    const { text, tag, replyTo } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });

    const user = (req as any).user;
    const msg = await chatService.sendMessage(req.params.roomId, {
      userId:      user?.sub,
      username:    user?.username    ?? 'anonymous',
      displayName: user?.displayName ?? 'Anonymous',
      avatar:      '💬',
      tier:        user?.role === 'admin' ? 'legend' : 'rookie',
      text,
      tag,
      replyTo,
    });
    res.status(201).json(msg);
    // Broadcast to all clients in the room (real-time)
    try { io?.to(req.params.roomId).emit('new_message', msg); } catch { /* io not yet initialised */ }
  } catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

router.post('/rooms/:roomId/messages/:messageId/reactions', async (req: Request, res: Response) => {
  try {
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ error: 'emoji is required' });
    await chatService.toggleReaction(req.params.messageId, emoji);
    res.status(204).send();
  } catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

export default router;
