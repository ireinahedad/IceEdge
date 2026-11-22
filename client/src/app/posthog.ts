/**
 * posthog.ts — entonnoir produit dans PostHog (2026-11-22).
 *
 * Pourquoi en plus de Clarity et `product_events` : Clarity montre les
 * sessions mais ne fait ni entonnoirs ni rétention ; `product_events` se lit
 * en SQL mais sans visiteurs anonymes reliés à leur compte. PostHog relie le
 * visiteur anonyme (accueil → /pro) à son compte dès la connexion
 * (`identify`), et les étapes serveur (signup, trial_started,
 * subscription_started — envoyées par growth.service.ts avec l'id de compte)
 * tombent sur la même personne. Un seul entonnoir, de la première visite au
 * paiement.
 *
 * Règles :
 *   • Chargé SEULEMENT quand `analytics.ts` dit que la mesure est permise
 *     (même consentement que Clarity / product_events). Avant ça, rien n'est
 *     chargé et rien n'est déposé.
 *   • Passe par arakice.com/ingest (réécriture Vercel) : CSP `'self'` intacte,
 *     et les bloqueurs de pub ne coupent pas l'entonnoir.
 *   • Pas d'enregistrement de session ni d'autocapture : Clarity s'en charge.
 *     Seulement les pages vues + nos événements nommés.
 *   • Aucune donnée personnelle : l'id de compte, jamais le courriel.
 *   • Sans VITE_POSTHOG_KEY : no-op complet.
 */
import { env } from "./env";

type PH = typeof import("posthog-js").default;

let ph: PH | null = null;
let loading: Promise<PH | null> | null = null;
/** Appels faits pendant le chargement du module, rejoués ensuite. */
const queue: Array<(p: PH) => void> = [];
let identifiedAs: string | null = null;

export function posthogConfigured(): boolean {
  return !!env.posthogKey;
}

/** Charge PostHog (une fois). Appelé par analytics.ts quand la mesure est permise. */
export function startPosthog(superProps: Record<string, string>): void {
  if (!env.posthogKey) return;
  if (ph) { if (ph.has_opted_out_capturing()) ph.opt_in_capturing(); return; }
  if (loading) return;
  loading = import("posthog-js")
    .then(({ default: posthog }) => {
      posthog.init(env.posthogKey!, {
        api_host: "/ingest",
        ui_host: "https://us.posthog.com",
        capture_pageview: "history_change", // pages vues SPA (react-router)
        capture_pageleave: true,
        autocapture: false,
        disable_session_recording: true,
        disable_surveys: true,
        person_profiles: "identified_only", // pas de profil pour un simple passant
        persistence: "localStorage+cookie",
      });
      posthog.register(superProps);
      ph = posthog;
      if (wanted) applyIdentity(posthog, wanted.userId, wanted.plan);
      queue.splice(0).forEach((fn) => fn(posthog));
      return posthog;
    })
    .catch(() => null);
}

function withPH(fn: (p: PH) => void) {
  if (ph) fn(ph);
  else if (loading && queue.length < 50) queue.push(fn);
}

/** Refus du consentement après coup : on arrête et on efface ce que PostHog a déposé. */
export function stopPosthog(): void {
  withPH((p) => { p.opt_out_capturing(); p.reset(); });
}

export function phCapture(name: string, props?: Record<string, unknown>): void {
  withPH((p) => p.capture(name, props));
}

type Plan = "free" | "pro" | "anonymous";
/** Dernière identité connue : appliquée au chargement si elle arrive avant PostHog. */
let wanted: { userId: string | null; plan: Plan } | null = null;

function applyIdentity(p: PH, userId: string | null, plan: Plan) {
  if (userId) {
    if (identifiedAs !== userId) p.identify(userId);
    identifiedAs = userId;
    p.setPersonProperties({ plan });
  } else if (identifiedAs) {
    identifiedAs = null;
    p.reset();
  }
  p.register({ plan });
}

/** Relie le visiteur anonyme à son compte ; `reset` à la déconnexion. */
export function phIdentify(userId: string | null, plan: Plan): void {
  wanted = { userId, plan };
  if (ph) applyIdentity(ph, userId, plan);
}
