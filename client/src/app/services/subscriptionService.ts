/**
 * subscriptionService.ts
 * Wraps /api/subscription/* endpoints (auth required).
 */
import { authedFetch } from './authService';

/**
 * Cadence de facturation.
 *
 * ⚠️ Distincte du champ `plan` ci-dessous, qui est le NIVEAU d'abonnement
 * (`free` / `pro`). Les deux se croisent — un abonné `pro` facturé `yearly` —
 * et côté serveur la confusion des deux noms a déjà cassé le typecheck.
 */
export type BillingPeriod = 'monthly' | 'yearly';

export interface SubscriptionStatus {
  plan: 'free' | 'pro';
  status: string;
  isPro: boolean;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialUsed: boolean;
  /**
   * Cadences réellement achetables, d'après les IDs de tarif configurés côté
   * serveur. Optionnel : un serveur pas encore déployé ne renvoie pas le champ,
   * et l'écran doit alors se comporter comme avant (mensuel seul).
   */
  periods?: BillingPeriod[];
  /**
   * Plafond mensuel de requêtes IA d'un abonné Pro, tel que le serveur le
   * calcule. Optionnel : un serveur pas encore déployé ne renvoie pas le champ,
   * et la page /pro doit alors se rabattre sur une formulation sans chiffre
   * plutôt que d'en inventer un.
   */
  llmMonthlyQuota?: number;
}

export interface CheckoutResult {
  url?: string;              // Stripe Checkout URL (when wired)
  devActivated?: boolean;    // dev/no-payment activation
  status?: SubscriptionStatus;
}

export async function apiGetSubscription(): Promise<SubscriptionStatus> {
  const res = await authedFetch('/subscription/me');
  if (!res.ok) throw new Error('Failed to load subscription');
  return res.json();
}

export async function apiStartCheckout(period: BillingPeriod = 'monthly'): Promise<CheckoutResult> {
  const res = await authedFetch('/subscription/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ period }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Checkout failed');
  }
  return res.json();
}

export async function apiStartTrial(): Promise<SubscriptionStatus> {
  const res = await authedFetch('/subscription/trial', { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Trial failed');
  }
  return res.json();
}

export async function apiRedeemPromo(code: string): Promise<SubscriptionStatus> {
  const res = await authedFetch('/subscription/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Invalid promo code');
  }
  const data = await res.json();
  return data.status;
}

export async function apiCancelSubscription(): Promise<SubscriptionStatus> {
  const res = await authedFetch('/subscription/cancel', { method: 'POST' });
  if (!res.ok) throw new Error('Cancel failed');
  return res.json();
}
