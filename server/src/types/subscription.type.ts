// ============================================================
//  Subscription types
// ============================================================

export type BillingPlan = 'free' | 'pro';
export type SubStatus   = 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete';

/** Full subscription row as stored in the DB. */
export interface SubscriptionRow {
  user_id: string;
  plan: BillingPlan;
  status: SubStatus;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  trial_used: boolean;
  created_at: Date;
  updated_at: Date;
}

/** What the client needs to render plan state and gate features. */
export interface SubscriptionStatus {
  plan: BillingPlan;
  status: SubStatus;
  isPro: boolean;
  currentPeriodEnd: string | null;   // ISO string
  cancelAtPeriodEnd: boolean;
  trialUsed: boolean;
}
