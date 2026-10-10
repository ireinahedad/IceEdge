// Widget iOS « paris en cours » — APPLE_PLAN 4.2. Voir services/widget.service.ts.
import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { validateBody } from '../middleware/validate.middleware';
import { widgetTokenRevokeSchema } from '../validation/schemas';
import { sendError } from '../httpError';
import * as Widget from '../services/widget.service';

const router = Router();

// POST /widget/token — l'app (connectée) demande un jeton pour son widget.
router.post('/token', authenticate, async (req: Request, res: Response) => {
  try {
    const token = await Widget.issueWidgetToken(req.user!.sub);
    return res.status(201).json({ token });
  } catch (err: any) { return sendError(res, err); }
});

// POST /widget/token/revoke — déconnexion de l'app sur cet appareil.
router.post('/token/revoke', authenticate, validateBody(widgetTokenRevokeSchema), async (req: Request, res: Response) => {
  try {
    await Widget.revokeWidgetToken((req.body as { token: string }).token, req.user!.sub);
    return res.json({ ok: true });
  } catch (err: any) { return sendError(res, err); }
});

// GET /widget/live-bets?lang=fr — appelé par le widget, avec `X-Widget-Token`.
// Pas de session utilisateur ici : le widget tourne hors de l'app.
router.get('/live-bets', async (req: Request, res: Response) => {
  try {
    const userId = await Widget.userForWidgetToken(String(req.get('x-widget-token') ?? ''));
    if (!userId) return res.status(401).json({ error: 'Invalid widget token' });
    const lang: Widget.WidgetLang = req.query.lang === 'en' ? 'en' : 'fr';
    return res.json(await Widget.liveBetsFor(userId, lang));
  } catch (err: any) { return sendError(res, err); }
});

export default router;
