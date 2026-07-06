// ============================================================
//  Subscription service — Free / Pro plans
// ============================================================
// Provider-agnostic: works with a dev "activate" path today and is ready to be
// driven by Stripe webhooks later (just call upsertFromStripe from the webhook).

import { pool } from '../db/connection';
import { SubscriptionRow, SubscriptionStatus, BillingPlan, SubStatus } from '../types/subscription.type';

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
  const { rows } = await pool.query<SubscriptionRow>(
    `UPDATE subscriptions
       SET cancel_at_period_end = TRUE, updated_at = NOW()
     WHERE user_id = $1
     RETURNING *`,
    [userId],
  );
  return toStatus(rows[0]);
}
