/**
 * growth.service.ts
 * ------------------------------------------------------------------
 * Mesure de croissance en base (2026-11-20, audit Growth — migration 055).
 *
 *   • trackEvent()        — une étape d'entonnoir dans `product_events`.
 *   • touchActivity()     — « ce compte a été actif aujourd'hui » dans
 *                           `user_activity_days` (rétention par cohorte).
 *   • saveSignupSource()  — provenance premier contact d'un compte neuf.
 *
 * TOUT EST BEST-EFFORT. Une écriture de mesure ne doit jamais faire échouer
 * une requête : erreurs avalées et journalisées en debug. Tant que la
 * migration 055 n'est pas appliquée, les tables n'existent pas : un seul
 * avertissement, puis plus rien (pas de journal inondé).
 *
 * Coût Neon : aucune écriture ne réveille la base hors d'une requête
 * utilisateur (la base est déjà éveillée), et `touchActivity` n'écrit qu'une
 * fois par compte et par jour grâce au cache mémoire.
 */

import { pool } from '../db/connection';
import { logger } from '../logger';

/** Étapes acceptées. Toute autre valeur est ignorée (pas de table fourre-tout). */
export const SERVER_EVENTS = [
  'signup',
  'trial_started',
  'checkout_started',
  'subscription_started',
  'subscription_canceled',
  'email_trial_ending',
  'email_trial_ended',
] as const;

/** Événements que le CLIENT peut envoyer (POST /api/growth/event). */
export const CLIENT_EVENTS = [
  'pro_page_view',
  'pro_checkout_click',
  'pro_trial_click',
  'pro_top_click',
  'pro_top_trial_click',
  'pro_upsell_click',
  'pro_upsell_trial_click',
  'trial_ended_paywall_view',
  'trial_ended_paywall_click',
  'trial_ended_paywall_dismiss',
  'trial_ending_banner_click',
  'landing_enter_click',
  'slip_add_leg',
  // /pro, refonte CRO (2026-11-21)
  'pro_teaser_view',
  'pro_yearly_select',
  'pro_faq_open',
  'pro_sticky_cta_click',
] as const;

type EventName = (typeof SERVER_EVENTS)[number] | (typeof CLIENT_EVENTS)[number];
const ALLOWED = new Set<string>([...SERVER_EVENTS, ...CLIENT_EVENTS]);

let missingTableWarned = false;
function onWriteError(err: unknown, what: string): void {
  const code = (err as { code?: string })?.code;
  // 42P01 = relation inexistante (migration 055 pas encore appliquée).
  // 42703 = colonne inexistante (idem, colonnes signup_*).
  if (code === '42P01' || code === '42703') {
    if (!missingTableWarned) {
      missingTableWarned = true;
      logger.warn('[growth] migration 055 absente — mesures désactivées jusqu\'à `npm run db:migrate:all`');
    }
    return;
  }
  logger.debug({ err: (err as Error)?.message }, `[growth] ${what} failed`);
}

/** Propriétés : objet plat, petites valeurs, rien de personnel. */
function cleanProps(props?: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!props) return out;
  for (const [k, v] of Object.entries(props).slice(0, 12)) {
    if (!/^[a-z0-9_]{1,40}$/i.test(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 120);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

export function isAllowedEvent(name: string): name is EventName {
  return ALLOWED.has(name);
}

/** Journalise une étape. Ne lève jamais ; ne pas l'attendre dans un chemin critique. */
export async function trackEvent(
  userId: string | null,
  name: EventName,
  props?: Record<string, unknown>,
): Promise<void> {
  if (!ALLOWED.has(name)) return;
  try {
    await pool.query(
      'INSERT INTO product_events (user_id, name, props) VALUES ($1, $2, $3)',
      [userId, name, JSON.stringify(cleanProps(props))],
    );
  } catch (err) {
    onWriteError(err, `trackEvent(${name})`);
  }
}

/** A-t-on déjà journalisé cet événement pour ce compte ? (dédoublonnage des courriels) */
export async function hasEvent(userId: string, name: EventName, since?: Date): Promise<boolean> {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM product_events WHERE user_id = $1 AND name = $2
        AND ($3::timestamptz IS NULL OR created_at >= $3) LIMIT 1`,
    [userId, name, since ?? null],
  );
  return (rowCount ?? 0) > 0;
}

// ── Activité quotidienne ──────────────────────────────────────────────────

/** Jour civil UTC : la rétention se lit en semaines, le fuseau n'y change rien. */
function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

const seenToday = new Set<string>();
let seenDay = utcDay();
const SEEN_MAX = 50_000;

/**
 * Marque le compte actif aujourd'hui. Appelé par `authenticate` à chaque
 * requête authentifiée : le cache mémoire ramène ça à une écriture par compte
 * et par jour (et par instance — l'ON CONFLICT absorbe les doublons).
 */
export function touchActivity(userId: string): void {
  const day = utcDay();
  if (day !== seenDay) { seenToday.clear(); seenDay = day; }
  const key = `${userId}:${day}`;
  if (seenToday.has(key)) return;
  if (seenToday.size >= SEEN_MAX) seenToday.clear();
  seenToday.add(key);
  pool
    .query(
      'INSERT INTO user_activity_days (user_id, day) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, day],
    )
    .catch((err) => {
      // On réessaiera à la prochaine requête si c'était une panne passagère.
      seenToday.delete(key);
      onWriteError(err, 'touchActivity');
    });
}

/** Pour les tests. */
export function _resetActivityCache(): void {
  seenToday.clear();
  seenDay = utcDay();
}

// ── Provenance à l'inscription ─────────────────────────────────────────────

export interface SignupTouch {
  source?: string;
  medium?: string;
  campaign?: string;
  landing?: string;
}

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase().replace(/[^a-z0-9._\-/:]/g, '').slice(0, max);
  return s || null;
};

/**
 * Pose la provenance premier contact d'un compte, UNE fois, et seulement s'il
 * a moins de 3 jours : un vieux compte n'a pas de premier contact fiable
 * (Clarity et la provenance locale datent du 2026-11-18).
 * Renvoie vrai si la ligne a été écrite.
 */
export async function saveSignupSource(userId: string, touch: SignupTouch): Promise<boolean> {
  const source = clean(touch.source, 60);
  if (!source) return false;
  try {
    const { rowCount } = await pool.query(
      `UPDATE users
          SET signup_source = $2, signup_medium = $3, signup_campaign = $4, signup_landing = $5
        WHERE id = $1 AND signup_source IS NULL AND created_at > NOW() - INTERVAL '3 days'`,
      [userId, source, clean(touch.medium, 60), clean(touch.campaign, 120), clean(touch.landing, 200)],
    );
    return (rowCount ?? 0) > 0;
  } catch (err) {
    onWriteError(err, 'saveSignupSource');
    return false;
  }
}
