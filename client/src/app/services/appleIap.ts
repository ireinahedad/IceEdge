/**
 * appleIap.ts — APPLE_PLAN Phase 5. Abonnement Pro acheté dans l'app iOS.
 *
 * Le plugin natif `StoreKit` (ios/App/App/StoreKitPlugin.swift) achète et
 * renvoie la transaction signée par Apple ; ce module l'envoie au serveur
 * (`POST /subscription/apple/verify`), qui vérifie la signature et accorde le
 * Pro. La transaction n'est « finie » côté Apple qu'APRÈS la réponse du
 * serveur : si l'app est tuée entre les deux, iOS la redonne au lancement
 * suivant et `syncAppleTransactions` la renvoie.
 *
 * iOS uniquement : chargé par import dynamique derrière `isIOS` (constante de
 * build), donc absent du bundle web.
 *
 * ⚠️ Ne jamais RENVOYER `StoreKit` depuis une fonction async — un plugin
 * Capacitor est un Proxy qui répond à `.then` (voir tokenStore.ts).
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { authedFetch } from './authService';
import type { BillingPeriod, SubscriptionStatus } from './subscriptionService';

/** Mêmes valeurs que `DEFAULT_APPLE_PRODUCT_IDS` côté serveur et qu'App Store Connect. */
export const APPLE_PRODUCT_IDS: Record<BillingPeriod, string> = {
  monthly: 'com.arakice.arakice.pro.monthly',
  yearly:  'com.arakice.arakice.pro.yearly',
};

export interface StoreIntroOffer {
  paymentMode: 'freeTrial' | 'payAsYouGo' | 'payUpFront' | 'unknown';
  periodUnit: 'day' | 'week' | 'month' | 'year' | 'unknown';
  periodValue: number;
  periodCount: number;
  displayPrice: string;
}

export interface StoreProduct {
  id: string;
  displayName: string;
  description: string;
  /** Prix dans la devise et le format de la boutique de l'utilisateur, ex. « 5,99 $ ». */
  displayPrice: string;
  price: number;
  currencyCode: string;
  periodUnit?: 'day' | 'week' | 'month' | 'year' | 'unknown';
  periodValue?: number;
  eligibleForIntroOffer?: boolean;
  introOffer?: StoreIntroOffer;
}

export interface StoreTransaction {
  transactionJws: string;
  renewalJws?: string;
  transactionId: string;
  originalTransactionId: string;
  productId: string;
  expiresDate?: number;
}

type PurchaseResult =
  | ({ status: 'success' } & StoreTransaction)
  | { status: 'cancelled' | 'pending' | 'unknown' };

interface StoreKitPlugin {
  getProducts(opts: { productIds: string[] }): Promise<{ products: StoreProduct[] }>;
  purchase(opts: { productId: string; appAccountToken: string }): Promise<PurchaseResult>;
  restore(): Promise<{ transactions: StoreTransaction[] }>;
  currentEntitlements(): Promise<{ transactions: StoreTransaction[] }>;
  pendingTransactions(): Promise<{ transactions: StoreTransaction[] }>;
  finish(opts: { transactionId: string }): Promise<void>;
  manageSubscriptions(): Promise<void>;
  addListener(event: 'transaction', cb: (tx: StoreTransaction) => void): Promise<PluginListenerHandle>;
}

const StoreKit = registerPlugin<StoreKitPlugin>('StoreKit');

/** Erreur du serveur, avec le `code` qu'il renvoie (`APPLE_OTHER_ACCOUNT`, …). */
export class AppleIapError extends Error {
  constructor(message: string, public code?: string, public status?: number) { super(message); }
}

/** Produits de la boutique, rangés par cadence. Une cadence absente = pas en vente. */
export async function loadAppleProducts(): Promise<Partial<Record<BillingPeriod, StoreProduct>>> {
  const { products } = await StoreKit.getProducts({ productIds: Object.values(APPLE_PRODUCT_IDS) });
  const out: Partial<Record<BillingPeriod, StoreProduct>> = {};
  for (const period of Object.keys(APPLE_PRODUCT_IDS) as BillingPeriod[]) {
    const p = products.find((x) => x.id === APPLE_PRODUCT_IDS[period]);
    if (p) out[period] = p;
  }
  return out;
}

async function verifyWithServer(tx: StoreTransaction): Promise<SubscriptionStatus> {
  const res = await authedFetch('/subscription/apple/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transactionJws: tx.transactionJws, renewalJws: tx.renewalJws ?? null }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({} as { error?: string; code?: string }));
    throw new AppleIapError(body.error ?? 'Verification failed', body.code, res.status);
  }
  return res.json();
}

/**
 * Envoie au serveur, puis « finit » la transaction chez Apple.
 *
 * Finie aussi sur un refus DÉFINITIF (4xx sauf 401) : la redonner à chaque
 * lancement ne changerait pas la réponse. Gardée sur 401 (pas de session :
 * elle repartira après connexion), 5xx et réseau (le serveur la prendra plus tard).
 */
async function verifyAndFinish(tx: StoreTransaction): Promise<SubscriptionStatus> {
  try {
    const status = await verifyWithServer(tx);
    await StoreKit.finish({ transactionId: tx.transactionId });
    return status;
  } catch (err) {
    const s = err instanceof AppleIapError ? err.status ?? 0 : 0;
    if (s >= 400 && s < 500 && s !== 401) await StoreKit.finish({ transactionId: tx.transactionId }).catch(() => {});
    throw err;
  }
}

export type PurchaseOutcome =
  | { kind: 'success'; status: SubscriptionStatus }
  | { kind: 'cancelled' }
  | { kind: 'pending' };

/** Achat. `userId` devient l'`appAccountToken` : c'est lui qui relie l'achat au compte. */
export async function purchaseApplePro(period: BillingPeriod, userId: string): Promise<PurchaseOutcome> {
  const result = await StoreKit.purchase({ productId: APPLE_PRODUCT_IDS[period], appAccountToken: userId });
  if (result.status === 'success') return { kind: 'success', status: await verifyAndFinish(result) };
  if (result.status === 'pending') return { kind: 'pending' };
  return { kind: 'cancelled' };
}

/**
 * « Restaurer les achats ». Renvoie le dernier état du serveur, ou `null` si
 * l'identifiant Apple n'a aucun abonnement en cours.
 */
export async function restoreApplePurchases(): Promise<SubscriptionStatus | null> {
  const { transactions } = await StoreKit.restore();
  let last: SubscriptionStatus | null = null;
  let firstError: unknown = null;
  for (const tx of transactions) {
    try { last = await verifyAndFinish(tx); }
    catch (err) { firstError ??= err; }
  }
  if (!last && firstError) throw firstError;
  return last;
}

/**
 * Au lancement / à la connexion : renvoie au serveur les transactions restées
 * en suspens. Silencieux ; renvoie `true` si le serveur a accepté quelque chose.
 */
export async function syncAppleTransactions(): Promise<boolean> {
  let changed = false;
  try {
    const { transactions } = await StoreKit.pendingTransactions();
    for (const tx of transactions) {
      try { await verifyAndFinish(tx); changed = true; } catch { /* réessayé au prochain lancement */ }
    }
  } catch { /* plugin absent (build ancien) : rien à faire */ }
  return changed;
}

/**
 * Transactions arrivées pendant que l'app tourne (renouvellement, achat
 * approuvé plus tard, autre appareil). `onAccepted` est appelé après chaque
 * transaction acceptée par le serveur.
 */
export function listenForAppleTransactions(onAccepted: () => void): () => void {
  let handle: PluginListenerHandle | null = null;
  let stopped = false;
  void StoreKit.addListener('transaction', (tx) => {
    void verifyAndFinish(tx).then(onAccepted, () => { /* gardée : repartira via syncAppleTransactions */ });
  }).then((h) => { if (stopped) void h.remove(); else handle = h; });
  return () => { stopped = true; void handle?.remove(); };
}

/** Feuille Apple « Gérer l'abonnement » (changer de formule, annuler). */
export function manageAppleSubscription(): Promise<void> {
  return StoreKit.manageSubscriptions();
}
