// ============================================================
//  Subscription service — Free / Pro plans
// ============================================================
// Provider-agnostic: works with a dev "activate" path today and is ready to be
// driven by Stripe webhooks later (just call upsertFromStripe from the webhook).

import Stripe from 'stripe';
import { pool } from '../db/connection';
import { SubscriptionRow, SubscriptionStatus, BillingPlan, SubStatus } from '../types/subscription.type';

// ─── Stripe client (lazy) ─────────────────────────────────────────────────────
// Only constructed when STRIPE_SECRET_KEY is set, so the app runs fine without
// payments configured (dev / pre-launch). Everything below no-ops until then.
let _stripe: Stripe | null = null;

export function stripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

export function getStripe(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw Object.assign(new Error('Stripe is not configured'), { status: 501 });
  }
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

function clientBaseUrl(): string {
  return (
    process.env.CLIENT_URL ||
    (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',')[0].trim()
  );
}

// The default (no row) state: everyone is Free until they subscribe.
const FREE_STATUS: SubscriptionStatus = {
  plan: 'free',
  status: 'active',
  isPro: false,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  trialUsed: false,
};

/** True when a row represents an entitled Pro subscription right now. */
function rowIsPro(row: SubscriptionRow): boolean {
  if (row.plan !== 'pro') return false;
  if (row.status !== 'active' && row.status !== 'trialing') return false;
  // If a period end is set, it must be in the future.
  if (row.current_period_end && new Date(row.current_period_end) <= new Date()) return false;
  return true;
}

function toStatus(row: SubscriptionRow | undefined): SubscriptionStatus {
  if (!row) return FREE_STATUS;
  return {
    plan: row.plan,
    status: row.status,
    isPro: rowIsPro(row),
    currentPeriodEnd: row.current_period_end ? new Date(row.current_period_end).toISOString() : null,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    trialUsed: row.trial_used,
  };
}

/** Reads the caller's subscription (defaults to Free if no row exists). */
export async function getStatus(userId: string): Promise<SubscriptionStatus> {
  const { rows } = await pool.query<SubscriptionRow>(
    'SELECT * FROM subscriptions WHERE user_id = $1',
    [userId],
  );
  return toStatus(rows[0]);
}

/** Fast boolean check used by the requirePro middleware. */
export async function isPro(userId: string): Promise<boolean> {
  const status = await getStatus(userId);
  return status.isPro;
}

interface UpsertOpts {
  plan: BillingPlan;
  status?: SubStatus;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
}

/** Inserts or updates a user's subscription. Call this from a Stripe webhook
 *  (mapping the event to these fields) or from the dev-activation path. */
export async function upsert(userId: string, opts: UpsertOpts): Promise<SubscriptionStatus> {
  const {
    plan,
    status = 'active',
    stripeCustomerId = null,
    stripeSubscriptionId = null,
    currentPeriodEnd = null,
    cancelAtPeriodEnd = false,
  } = opts;

  const { rows } = await pool.query<SubscriptionRow>(
    `INSERT INTO subscriptions
       (user_id, plan, status, stripe_customer_id, stripe_subscription_id, current_period_end, cancel_at_period_end, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       plan                   = EXCLUDED.plan,
       status                 = EXCLUDED.status,
       stripe_customer_id     = COALESCE(EXCLUDED.stripe_customer_id, subscriptions.stripe_customer_id),
       stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, subscriptions.stripe_subscription_id),
       current_period_end     = EXCLUDED.current_period_end,
       cancel_at_period_end   = EXCLUDED.cancel_at_period_end,
       updated_at             = NOW()
     RETURNING *`,
    [userId, plan, status, stripeCustomerId, stripeSubscriptionId, currentPeriodEnd, cancelAtPeriodEnd],
  );
  return toStatus(rows[0]);
}

/** Starts the one-time 7-day free trial. Throws 409 if already used. */
export async function startTrial(userId: string, days = 7): Promise<SubscriptionStatus> {
  const { rows: existing } = await pool.query<SubscriptionRow>(
    'SELECT * FROM subscriptions WHERE user_id = $1',
    [userId],
  );
  if (existing[0]?.trial_used) {
    throw Object.assign(new Error('Free trial already used'), { status: 409 });
  }

  const end = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const { rows } = await pool.query<SubscriptionRow>(
    `INSERT INTO subscriptions (user_id, plan, status, current_period_end, trial_used, updated_at)
     VALUES ($1, 'pro', 'trialing', $2, TRUE, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       plan = 'pro', status = 'trialing',
       current_period_end = EXCLUDED.current_period_end,
       cancel_at_period_end = FALSE,
       trial_used = TRUE, updated_at = NOW()
     RETURNING *`,
    [userId, end],
  );
  return toStatus(rows[0]);
}

/** Dev / no-payment activation — grants Pro for `days` (default 30). */
export async function activateProDev(userId: string, days = 30): Promise<SubscriptionStatus> {
  const end = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return upsert(userId, { plan: 'pro', status: 'active', currentPeriodEnd: end });
}

/** Valid promo codes and how many days of Pro they grant.
 *  Configure via env PRO_PROMO_CODES as `CODE:DAYS` pairs (comma-separated),
 *  e.g. "ICEEDGE2026:365,VIP:30". A pair without days defaults to 365.
 *  If the env var is unset, a built-in default code is used. */
function promoCatalog(): Record<string, number> {
  const raw = process.env.PRO_PROMO_CODES?.trim();
  const catalog: Record<string, number> = {};
  if (raw) {
    for (const part of raw.split(',')) {
      const [code, days] = part.split(':').map((s) => s.trim());
      if (code) catalog[code.toUpperCase()] = Number(days) > 0 ? Number(days) : 365;
    }
  } else {
    catalog['ICEEDGEPRO'] = 365; // default demo code
  }
  return catalog;
}

/** Redeems a promo code and grants Pro without payment. Throws 400 if invalid. */
export async function redeemPromo(userId: string, code: string): Promise<SubscriptionStatus> {
  const key = (code ?? '').trim().toUpperCase();
  if (!key) throw Object.assign(new Error('Code required'), { status: 400 });

  const days = promoCatalog()[key];
  if (!days) throw Object.assign(new Error('Invalid promo code'), { status: 400 });

  const end = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return upsert(userId, { plan: 'pro', status: 'active', currentPeriodEnd: end });
}

/** Marks the subscription to end at the period boundary (keeps Pro until then). */
export async function cancel(userId: string): Promise<SubscriptionStatus> {
  // If this is a real Stripe subscription, cancel it at Stripe too; the webhook
  // will sync the final state back. The local flag is set immediately so the UI
  // reflects the choice without waiting for the webhook round-trip.
  const { rows: existing } = await pool.query<SubscriptionRow>(
    'SELECT * FROM subscriptions WHERE user_id = $1',
    [userId],
  );
  const subId = existing[0]?.stripe_subscription_id;
  if (stripeConfigured() && subId) {
    try {
      await getStripe().subscriptions.update(subId, { cancel_at_period_end: true });
    } catch (err: any) {
      console.error('[subscription] Stripe cancel failed:', err?.message);
    }
  }

  const { rows } = await pool.query<SubscriptionRow>(
    `UPDATE subscriptions
       SET cancel_at_period_end = TRUE, updated_at = NOW()
     WHERE user_id = $1
     RETURNING *`,
    [userId],
  );
  return toStatus(rows[0]);
}

// ─── Stripe checkout + webhook ────────────────────────────────────────────────

/** Maps a Stripe subscription status onto our narrower SubStatus enum. */
function mapStripeStatus(s: Stripe.Subscription.Status): SubStatus {
  switch (s) {
    case 'active':             return 'active';
    case 'trialing':           return 'trialing';
    case 'past_due':           return 'past_due';
    case 'unpaid':             return 'past_due';
    case 'canceled':           return 'canceled';
    case 'incomplete_expired': return 'canceled';
    case 'incomplete':         return 'incomplete';
    default:                   return 'incomplete';
  }
}

/**
 * Creates a Stripe Checkout Session for the Pro plan and returns its URL.
 * `client_reference_id` + subscription metadata carry our userId so the webhook
 * can attribute the resulting subscription back to the right account.
 */
export async function createCheckoutSession(userId: string, email?: string): Promise<string> {
  const stripe = getStripe();
  const price = process.env.STRIPE_PRICE_PRO_MONTHLY;
  if (!price) throw Object.assign(new Error('STRIPE_PRICE_PRO_MONTHLY is not set'), { status: 500 });

  // Reuse an existing Stripe customer if we already have one for this user.
  const { rows } = await pool.query<SubscriptionRow>(
    'SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1',
    [userId],
  );
  const existingCustomer = rows[0]?.stripe_customer_id || undefined;

  const base = clientBaseUrl();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    client_reference_id: userId,
    customer: existingCustomer,
    customer_email: existingCustomer ? undefined : email,
    subscription_data: { metadata: { userId } },
    success_url: `${base}/pro/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/pro`,
    allow_promotion_codes: true,
  });

  if (!session.url) throw Object.assign(new Error('Stripe did not return a checkout URL'), { status: 502 });
  return session.url;
}

/** Resolve our userId for an incoming Stripe subscription (metadata first, then customer id). */
async function resolveUserId(sub: Stripe.Subscription): Promise<string | null> {
  const fromMeta = sub.metadata?.userId;
  if (fromMeta) return fromMeta;
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  if (!customerId) return null;
  const { rows } = await pool.query<{ user_id: string }>(
    'SELECT user_id FROM subscriptions WHERE stripe_customer_id = $1',
    [customerId],
  );
  return rows[0]?.user_id ?? null;
}

/** Upserts our subscriptions row from a Stripe Subscription object. */
async function syncSubscription(sub: Stripe.Subscription): Promise<void> {
  const userId = await resolveUserId(sub);
  if (!userId) {
    console.warn('[subscription] webhook: could not resolve userId for subscription', sub.id);
    return;
  }
  const status = mapStripeStatus(sub.status);
  const active = status === 'active' || status === 'trialing';
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null;
  // `current_period_end` has moved across Stripe API versions — read defensively.
  const periodEndUnix = (sub as any).current_period_end as number | undefined;
  const periodEnd = periodEndUnix ? new Date(periodEndUnix * 1000) : null;

  await upsert(userId, {
    plan: active ? 'pro' : 'free',
    status,
    stripeCustomerId: customerId,
    stripeSubscriptionId: sub.id,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
  });
}

/**
 * Verifies a Stripe webhook signature and processes the event.
 * `rawBody` MUST be the raw request Buffer (see the express.raw route in app.ts).
 * Throws (400) if the signature can't be verified — Stripe will retry.
 */
export async function handleStripeWebhook(rawBody: Buffer, signature: string | undefined): Promise<void> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw Object.assign(new Error('STRIPE_WEBHOOK_SECRET is not set'), { status: 500 });
  if (!signature) throw Object.assign(new Error('Missing Stripe-Signature header'), { status: 400 });

  const stripe = getStripe();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (err: any) {
    throw Object.assign(new Error(`Webhook signature verification failed: ${err.message}`), { status: 400 });
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.subscription) {
        const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
        const sub = await stripe.subscriptions.retrieve(subId);
        // Ensure our userId is attached for future events.
        if (session.client_reference_id && !sub.metadata?.userId) {
          sub.metadata = { ...sub.metadata, userId: session.client_reference_id };
        }
        await syncSubscription(sub);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      await syncSubscription(event.data.object as Stripe.Subscription);
      break;
    }
    default:
      // Unhandled event types are acknowledged (200) without action.
      break;
  }
}
