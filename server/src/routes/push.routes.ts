import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import * as Push from '../services/push.service';
import { validateBody } from '../middleware/validate.middleware';
import { apnsRegisterSchema, apnsUnregisterSchema, pushSubscribeSchema, pushUnsubscribeSchema } from '../validation/schemas';
import { sendError } from '../httpError';

const router = Router();

// GET /push/vapid-public-key — the client needs this to subscribe.
router.get('/vapid-public-key', (_req: Request, res: Response) => {
  const key = Push.getVapidPublicKey();
  if (!key) return res.status(503).json({ error: 'Push not configured' });
  return res.json({ key });
});

// POST /push/subscribe — store the browser's PushSubscription.
router.post('/subscribe', authenticate, validateBody(pushSubscribeSchema), async (req: Request, res: Response) => {
  try {
    // Les trois champs sont désormais garantis présents et bornés par le
    // schéma ; la vérification manuelle qui vivait ici ne bornait rien.
    const sub = req.body as Push.PushSubscriptionInput;
    await Push.saveSubscription(req.user!.sub, sub);
    return res.status(201).json({ ok: true });
  } catch (err: any) { return sendError(res, err); }
});

// POST /push/unsubscribe — remove a subscription by endpoint.
router.post('/unsubscribe', authenticate, validateBody(pushUnsubscribeSchema), async (req: Request, res: Response) => {
  try {
    const { endpoint } = req.body as { endpoint?: string };
    // L'identifiant du propriétaire est passé au service : sans lui, n'importe
    // quel compte authentifié pouvait supprimer l'abonnement push d'un AUTRE
    // utilisateur en devinant/rejouant son endpoint.
    await Push.removeSubscription(endpoint!, req.user!.sub);
    return res.json({ ok: true });
  } catch (err: any) { return sendError(res, err); }
});

// ── iOS (APPLE_PLAN 4.1) ─────────────────────────────────────────────────────

// POST /push/apns/register — store this iPhone's APNs device token. The app
// calls it on every launch where notifications are allowed (Apple may rotate
// the token), so it must stay an idempotent upsert.
router.post('/apns/register', authenticate, validateBody(apnsRegisterSchema), async (req: Request, res: Response) => {
  try {
    const { token, lang } = req.body as { token: string; lang: Push.PushLang };
    await Push.saveDeviceToken(req.user!.sub, token, lang);
    return res.status(201).json({ ok: true });
  } catch (err: any) { return sendError(res, err); }
});

// POST /push/apns/unregister — the user turned notifications off in the app,
// or signed out on this device.
router.post('/apns/unregister', authenticate, validateBody(apnsUnregisterSchema), async (req: Request, res: Response) => {
  try {
    const { token } = req.body as { token: string };
    await Push.removeDeviceToken(token, req.user!.sub);
    return res.json({ ok: true });
  } catch (err: any) { return sendError(res, err); }
});

export default router;
