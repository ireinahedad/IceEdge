import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import * as Subscriptions from '../services/subscription.service';

const router = Router();

// GET /subscription/me — current plan/status for the signed-in user.
router.get('/me', authenticate, async (req: Request, res: Response) => {
  try {
    const status = await Subscriptions.getStatus(req.user!.sub);
    return res.json(status);
  } catch (err: any) { return res.status(err.status ?? 500).json({ error: err.message }); }
});

// POST /subscription/checkout — start an upgrade.
//   • If Stripe is configured (STRIPE_SECRET_KEY set) this is where you'd create
//     a Checkout Session and return its URL. (Wiring left as a clear next step.)
//   • Otherwise we fall back to a dev activation so Pro gating can be tested end
//     to end without a payment provider.
router.post('/checkout', authenticate, async (req: Request, res: Response) => {
  try {
    const stripeConfigured = !!process.env.STRIPE_SECRET_KEY;

    if (stripeConfigured) {
      // TODO(stripe): create a Checkout Session for the Pro price and return:
      //   return res.json({ url: session.url });
      return res.status(501).json({ error: 'Stripe checkout not wired yet' });
    }

    // Dev / no-payment mode: grant Pro immediately.
    const status = await Subscriptions.activateProDev(req.user!.sub);
    return res.json({ devActivated: true, status });
  } catch (err: any) { return res.status(err.status ?? 500).json({ error: err.message }); }
});

// POST /subscription/trial — start the one-time 7-day free trial.
router.post('/trial', authenticate, async (req: Request, res: Response) => {
  try {
    const status = await Subscriptions.startTrial(req.user!.sub);
    return res.json(status);
  } catch (err: any) { return res.status(err.status ?? 500).json({ error: err.message }); }
});

// POST /subscription/cancel — cancel at period end (keeps Pro until it lapses).
router.post('/cancel', authenticate, async (req: Request, res: Response) => {
  try {
    const status = await Subscriptions.cancel(req.user!.sub);
    return res.json(status);
  } catch (err: any) { return res.status(err.status ?? 500).json({ error: err.message }); }
});

export default router;
