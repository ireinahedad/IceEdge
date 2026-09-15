// ============================================================
//  Subscription service — Free / Pro plans
// ============================================================
// Provider-agnostic: works with a dev "activate" path today and is ready to be
// driven by Stripe webhooks later (just call upsertFromStripe from the webhook).

import Stripe from 'stripe';
import { pool } from '../db/connection';
import { SubscriptionRow, SubscriptionStatus, BillingPlan, SubStatus } from '../types/subscription.type';
import { logger } from '../logger';
import { TtlCache } from './ttlCache';

// ─── Stripe client (lazy) ─────────────────────────────────────────────────────
// Only constructed when STRIPE_SECRET_KEY is set, so the app runs fine without
// payments configured (dev / pre-launch). Everything below no-ops until then.
let _stripe: Stripe | null = null;

export function stripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

function getStripe(): Stripe {
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

// ─── Cache d'entitlement (audit, ligne L) ────────────────────────────────────
//
// `isPro` était une requête Postgres à CHAQUE appel LLM et à chaque route
// `requirePro` : la plus fréquente de l'application, pour une donnée qui change
// quelques fois dans la vie d'un compte.
//
// Deux garde-fous rendent le cache sûr plutôt que « probablement sûr » :
//
//  1. **Invalidation sur écriture.** Tout chemin qui modifie l'abonnement
//     (`upsert` — donc Stripe, promo, activation dev —, `startTrial`, `cancel`)
//     oublie la clé. Quelqu'un qui vient de payer ne doit pas attendre le TTL.
//  2. **TTL borné par la fin de période.** Un abonnement qui expire dans 10 s ne
//     peut pas être mis en cache 60 s : sans cela le cache prolongerait
//     gratuitement un accès payant, ce qui est exactement le genre de détail
//     qu'on ne découvre jamais.
//
// Reste par instance : au scale horizontal, une révocation met au pire un TTL à
// se propager aux autres instances. Acceptable pour un downgrade (borné, et le
// prochain cycle de facturation le rattrape) ; c'est la raison pour laquelle le
// TTL est court et non de plusieurs minutes.
const PRO_TTL_MS = Number(process.env.PRO_CACHE_TTL_MS) || 60_000;
const proCache = new TtlCache<boolean>(PRO_TTL_MS, 20_000, 'isPro');

/** Oublie l'entitlement mémorisé pour cet utilisateur. */
function invalidateProCache(userId: string): void {
  proCache.delete(userId);
}

/** Fast boolean check used by the requirePro middleware. */
export async function isPro(userId: string): Promise<boolean> {
  const cached = proCache.get(userId);
  if (cached !== null) return cached;

  const status = await getStatus(userId);

  // Ne jamais garder un « oui » au-delà de la fin de période annoncée.
  const endMs = status.currentPeriodEnd ? Date.parse(status.currentPeriodEnd) : NaN;
  const untilEnd = Number.isFinite(endMs) ? endMs - Date.now() : Infinity;
  const ttl = Math.min(PRO_TTL_MS, Math.max(0, untilEnd));

  // TTL nul (période déjà terminée) : rien à mémoriser, la réponse est déjà
  // `false` et la relire coûte moins qu'une entrée morte dans la Map.
  if (ttl > 0) proCache.set(userId, status.isPro, ttl);
  return status.isPro;
}

interface UpsertOpts {
  plan: BillingPlan;
  status?: SubStatus;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
  /**
   * Horodatage de l'événement Stripe à l'origine de cette écriture.
   *
   * Renseigné UNIQUEMENT par le webhook. Il active la garde d'ordonnancement :
   * l'écriture est ignorée si la ligne porte déjà un événement plus récent.
   * Absent (essai gratuit, code promo, activation dev), l'écriture s'applique
   * toujours — ces chemins-là ne souffrent pas de désordre, ils sont déclenchés
   * par une action utilisateur unique.
   */
  eventCreatedAt?: Date | null;
}

/** Inserts or updates a user's subscription. Call this from a Stripe webhook
 *  (mapping the event to these fields) or from the dev-activation path. */
async function upsert(userId: string, opts: UpsertOpts): Promise<SubscriptionStatus> {
  const {
    plan,
    status = 'active',
    stripeCustomerId = null,
    stripeSubscriptionId = null,
    currentPeriodEnd = null,
    cancelAtPeriodEnd = false,
    eventCreatedAt = null,
  } = opts;

  // Garde d'ordonnancement (migration 026). La condition vit dans le `WHERE` du
  // `DO UPDATE`, donc dans le MÊME énoncé que l'écriture : il n'existe aucune
  // fenêtre entre « comparer » et « écrire » où deux événements livrés en
  // parallèle pourraient tous deux se croire les plus récents.
  //
  // Trois cas la laissent passer :
  //   - l'écriture n'a pas d'événement (chemin local) ;
  //   - la ligne n'en a pas encore (premier passage par Stripe) ;
  //   - l'événement entrant est plus récent ou identique (rejeu du même).
  const { rows } = await pool.query<SubscriptionRow>(
    `INSERT INTO subscriptions
       (user_id, plan, status, stripe_customer_id, stripe_subscription_id, current_period_end, cancel_at_period_end, last_event_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       plan                   = EXCLUDED.plan,
       status                 = EXCLUDED.status,
       stripe_customer_id     = COALESCE(EXCLUDED.stripe_customer_id, subscriptions.stripe_customer_id),
       stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, subscriptions.stripe_subscription_id),
       current_period_end     = EXCLUDED.current_period_end,
       cancel_at_period_end   = EXCLUDED.cancel_at_period_end,
       last_event_at          = COALESCE(EXCLUDED.last_event_at, subscriptions.last_event_at),
       updated_at             = NOW()
     WHERE EXCLUDED.last_event_at     IS NULL
        OR subscriptions.last_event_at IS NULL
        OR subscriptions.last_event_at <= EXCLUDED.last_event_at
     RETURNING *`,
    [userId, plan, status, stripeCustomerId, stripeSubscriptionId, currentPeriodEnd, cancelAtPeriodEnd, eventCreatedAt],
  );
  invalidateProCache(userId);

  // Aucune ligne renvoyée = la garde a rejeté une écriture périmée. Ce n'est pas
  // une erreur, mais l'appelant attend l'état de l'abonnement : il faut le
  // RELIRE. Renvoyer `toStatus(undefined)` ici annoncerait « free » à quelqu'un
  // qui est Pro — le bug que la garde était censée empêcher, déplacé d'un cran.
  if (!rows[0]) {
    logger.info({ userId, eventCreatedAt }, '[subscription] écriture ignorée : événement plus ancien que l\'état courant');
    return getStatus(userId);
  }
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
  invalidateProCache(userId);
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
    return catalog;
  }

  // No codes configured. NEVER fall back to a guessable default in production —
  // it would grant free Pro to anyone who guesses it. Dev/test only.
  if (process.env.NODE_ENV === 'production') {
    logger.warn('[subscription] PRO_PROMO_CODES is not set — promo redemption is disabled in production');
    return catalog; // empty → every code is rejected (400)
  }
  catalog['ICEEDGEPRO'] = 365; // default demo code (non-production only)
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
      logger.error({ err: err?.message }, '[subscription] Stripe cancel failed');
    }
  }

  const { rows } = await pool.query<SubscriptionRow>(
    `UPDATE subscriptions
       SET cancel_at_period_end = TRUE, updated_at = NOW()
     WHERE user_id = $1
     RETURNING *`,
    [userId],
  );
  // `cancel_at_period_end` ne retire pas l'accès (il court jusqu'à la fin de
  // période), mais on invalide quand même : la ligne a changé, et un cache dont
  // l'invalidation dépend de « est-ce que ce champ-là compte ? » finit toujours
  // par être faux le jour où un champ s'ajoute.
  invalidateProCache(userId);
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
 * Les deux cadences de facturation vendues.
 *
 * ⚠️ Ne PAS appeler ça `BillingPlan` : ce nom est déjà pris, et par le NIVEAU
 * d'abonnement (`'free' | 'pro'`, dans `types/subscription.type.ts`), qui vit
 * dans le champ `plan` de la table et de `SubscriptionStatus`. Les deux notions
 * se croisent partout dans ce fichier — un abonné `pro` payé `yearly` — et le
 * typecheck a déjà attrapé la collision une fois. « Période » pour le rythme,
 * « plan » pour le niveau.
 */
export type BillingPeriod = 'monthly' | 'yearly';

/** Quelle variable d'environnement porte l'ID de tarif Stripe de chaque cadence. */
const PERIOD_PRICE_ENV: Record<BillingPeriod, string> = {
  monthly: 'STRIPE_PRICE_PRO_MONTHLY',
  yearly:  'STRIPE_PRICE_PRO_YEARLY',
};

/**
 * Cadences réellement achetables : celles dont l'ID de tarif est configuré.
 *
 * Exposé par `GET /subscription/me` pour que la page /pro n'affiche jamais un
 * bouton qui échouerait. Un prix annoncé sans moyen de l'acheter est pire que
 * pas de prix du tout — c'est déjà la règle de la carte de prix côté client.
 */
export function availablePeriods(): BillingPeriod[] {
  if (!stripeConfigured()) return [];
  return (Object.keys(PERIOD_PRICE_ENV) as BillingPeriod[])
    .filter((p) => !!process.env[PERIOD_PRICE_ENV[p]]?.trim());
}

/**
 * Creates a Stripe Checkout Session for the Pro plan and returns its URL.
 * `client_reference_id` + subscription metadata carry our userId so the webhook
 * can attribute the resulting subscription back to the right account.
 */
export async function createCheckoutSession(
  userId: string,
  email?: string,
  period: BillingPeriod = 'monthly',
): Promise<string> {
  const stripe = getStripe();
  const envName = PERIOD_PRICE_ENV[period];
  const price = process.env[envName]?.trim();
  if (!price) throw Object.assign(new Error(`${envName} is not set`), { status: 500 });
  // Stripe attend un ID de TARIF (`price_…`), pas un ID de PRODUIT (`prod_…`).
  // Les deux se copient au même endroit du tableau de bord et se ressemblent ;
  // la seule différence visible sans cette garde serait un
  // « No such price: prod_… » remonté par Stripe au milieu du paiement.
  if (price.startsWith('prod_')) {
    throw Object.assign(
      new Error(`${envName} contient un ID de produit (${price}) au lieu d'un ID de tarif price_…`),
      { status: 500 },
    );
  }

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
    subscription_data: { metadata: { userId, period } },
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
async function syncSubscription(sub: Stripe.Subscription, eventCreatedAt: Date | null = null): Promise<void> {
  const userId = await resolveUserId(sub);
  if (!userId) {
    logger.warn({ subscriptionId: sub.id }, '[subscription] webhook: could not resolve userId for subscription');
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
    eventCreatedAt,
  });
}

// ─── Déduplication des événements (audit, ligne P) ───────────────────────────

/** Vrai si cet événement a déjà été traité intégralement. */
async function alreadyProcessed(eventId: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM stripe_events WHERE id = $1', [eventId]);
  return rows.length > 0;
}

/**
 * Marque un événement comme traité. Écrit APRÈS le traitement, jamais avant :
 * l'inscrire d'abord ferait passer un traitement échoué pour un traitement fait,
 * et le réessai de Stripe — qui est ici notre seul filet — serait alors ignoré.
 */
async function markProcessed(event: Stripe.Event): Promise<void> {
  await pool.query(
    `INSERT INTO stripe_events (id, type, event_created, processed_at)
     VALUES ($1, $2, to_timestamp($3), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [event.id, event.type, event.created],
  );
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

  // Rejeu d'un événement déjà traité → acquittement immédiat, sans refaire le
  // `subscriptions.retrieve` ni l'écriture. C'est ce qui rend les redélivrances
  // de Stripe gratuites, et donc ce qui évite qu'une série de traitements lents
  // finisse par faire désactiver l'endpoint.
  if (await alreadyProcessed(event.id)) {
    logger.debug({ eventId: event.id, type: event.type }, '[subscription] webhook: événement déjà traité');
    return;
  }

  // Horodatage de l'événement, pas de sa réception : c'est l'ordre chez Stripe
  // qui fait autorité, pas l'ordre d'arrivée chez nous — les deux diffèrent
  // précisément dans le cas que la garde doit couvrir.
  const eventCreatedAt = new Date(event.created * 1000);

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
        await syncSubscription(sub, eventCreatedAt);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      await syncSubscription(event.data.object as Stripe.Subscription, eventCreatedAt);
      break;
    }
    default:
      // Unhandled event types are acknowledged (200) without action.
      break;
  }

  // Enregistré seulement si tout ce qui précède a réussi. Une exception laisse
  // l'événement absent du registre, donc rejouable par Stripe — c'est notre
  // mécanisme de durabilité, et il ne fonctionne que dans cet ordre.
  await markProcessed(event);
}
