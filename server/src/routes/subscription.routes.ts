import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { redeemLimiter } from '../middleware/rateLimit.middleware';
import { validateBody } from '../middleware/validate.middleware';
import { checkoutSchema, redeemPromoSchema } from '../validation/schemas';
import * as Subscriptions from '../services/subscription.service';
import { logger } from '../logger';
import { sendError } from '../httpError';

const router = Router();

// GET /subscription/me — current plan/status for the signed-in user.
//
// `periods` est ajouté ICI et non dans `getStatus` : c'est une propriété de la
// configuration du serveur (quels IDs de tarif Stripe existent), pas de
// l'abonnement de l'utilisateur. Le mettre dans le mapper de ligne mêlerait les
// deux. La page /pro s'en sert pour n'afficher que les cadences achetables.
router.get('/me', authenticate, async (req: Request, res: Response) => {
  try {
    const status = await Subscriptions.getStatus(req.user!.sub);
    return res.json({ ...status, periods: Subscriptions.availablePeriods() });
  } catch (err: any) { return sendError(res, err); }
});

// POST /subscription/checkout — start an upgrade.
//   • If Stripe is configured (STRIPE_SECRET_KEY set) → create a real Checkout
//     Session and return its URL.
//   • In non-production without Stripe → dev activation so Pro gating can be
//     tested end to end without a payment provider.
//   • In production without Stripe → 501 (never silently grant Pro for free).
router.post('/checkout', authenticate, validateBody(checkoutSchema), async (req: Request, res: Response) => {
  try {
    if (Subscriptions.stripeConfigured()) {
      // Corps absent = ancien bundle client → mensuel, comme avant (cf. `checkoutSchema`).
      const period = (req.body as { period?: Subscriptions.BillingPeriod } | undefined)?.period ?? 'monthly';
      const url = await Subscriptions.createCheckoutSession(req.user!.sub, req.user!.email, period);
      return res.json({ url });
    }

    if (process.env.NODE_ENV === 'production') {
      return res.status(501).json({ error: 'Payments are not configured' });
    }

    // Dev / no-payment mode only.
    const status = await Subscriptions.activateProDev(req.user!.sub);
    return res.json({ devActivated: true, status });
  } catch (err: any) { return sendError(res, err); }
});

// POST /subscription/redeem — activate Pro with a promo code (no payment).
// authenticate first so the limiter can key on the user id (see redeemLimiter).
router.post('/redeem', authenticate, redeemLimiter, validateBody(redeemPromoSchema), async (req: Request, res: Response) => {
  try {
    const status = await Subscriptions.redeemPromo(req.user!.sub, req.body?.code);
    return res.json({ redeemed: true, status });
  } catch (err: any) { return sendError(res, err); }
});

// POST /subscription/trial — start the one-time 7-day free trial.
router.post('/trial', authenticate, async (req: Request, res: Response) => {
  try {
    const status = await Subscriptions.startTrial(req.user!.sub);
    return res.json(status);
  } catch (err: any) { return sendError(res, err); }
});

// POST /subscription/cancel — cancel at period end (keeps Pro until it lapses).
router.post('/cancel', authenticate, async (req: Request, res: Response) => {
  try {
    const status = await Subscriptions.cancel(req.user!.sub);
    return res.json(status);
  } catch (err: any) { return sendError(res, err); }
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
    // `err.status ?? 400` était un piège : une erreur INATTENDUE (panne base,
    // TypeError) n'a pas de `status`, retombait donc sur 400 — un code client —
    // et son message repartait tel quel dans la réponse. C'est-à-dire que le
    // seul chemin où le message avait le plus de chances d'être interne était
    // aussi celui qui le laissait passer.
    //
    // Sans statut explicite, c'est donc 500. Stripe réessaie sur 5xx comme sur
    // 4xx, rien n'est perdu ; ce qui change est que l'échec est visible comme
    // une panne serveur au lieu d'un refus de signature.
    logger.error({ err: err?.message }, '[subscription] webhook error');
    sendError(res, err, { context: '[subscription] webhook' });
  }
}

export default router;
