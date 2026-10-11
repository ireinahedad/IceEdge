// ============================================================
//  Subscription types
// ============================================================

export type BillingPlan = 'free' | 'pro';
export type SubStatus   = 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete';
/** Qui a donné le Pro actuel (migration 045). */
export type SubSource   = 'stripe' | 'apple' | 'local';

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
  source: SubSource | null;
  apple_original_transaction_id: string | null;
  apple_product_id: string | null;
  apple_environment: string | null;
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
  /**
   * Rail de paiement du Pro actuel. `'apple'` = l'abonnement se gère dans les
   * Réglages de l'iPhone : ni le web ni le serveur ne peuvent l'annuler.
   */
  source: SubSource | null;
}
