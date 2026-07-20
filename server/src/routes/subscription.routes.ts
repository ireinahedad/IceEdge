import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { redeemLimiter } from '../middleware/rateLimit.middleware';
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
//   • If Stripe is configured (STRIPE_SECRET_KEY set) → create a real Checkout
//     Session and return its URL.
//   • In non-production without Stripe → dev activation so Pro gating can be
//     tested end to end without a payment provider.
//   • In production without Stripe → 501 (never silently grant Pro for free).
router.post('/checkout', authenticate, async (req: Request, res: Response) => {
  try {
    if (Subscriptions.stripeConfigured()) {
      const url = await Subscriptions.createCheckoutSession(req.user!.sub, req.user!.email);
      return res.json({ url });
    }

    if (process.env.NODE_ENV === 'production') {
      return res.status(501).json({ error: 'Payments are not configured' });
    }

    // Dev / no-payment mode only.
    const status = await Subscriptions.activateProDev(req.user!.sub);
    return res.json({ devActivated: true, status });
  } catch (err: any) { return res.status(err.status ?? 500).json({ error: err.message }); }
});

// POST /subscription/redeem — activate Pro with a promo code (no payment).
// authenticate first so the limiter can key on the user id (see redeemLimiter).
router.post('/redeem', authenticate, redeemLimiter, async (req: Request, res: Response) => {
  try {
    const status = await Subscriptions.redeemPromo(req.user!.sub, req.body?.code);
    return res.json({ redeemed: true, status });
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

// POST /api/subscription/webhook — Stripe events (signature-verified).
// Mounted separately in app.ts with a RAW body parser (Stripe needs the raw
// bytes to verify the signature), so it is NOT part of this JSON router.
export async function stripeWebhook(req: Request, res: Response): Promise<void> {
  try {
    await Subscriptions.handleStripeWebhook(
      req.body as Buffer,
      req.headers['stripe-signature'] as string | undefined,
    );
    res.json({ received: true });
  } catch (err: any) {
    // 400 → Stripe will retry. Log for visibility.
    console.error('[subscription] webhook error:', err?.message);
    res.status(err.status ?? 400).json({ error: err.message });
  }
}

export default router;
