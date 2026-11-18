/**
 * analytics.ts — Microsoft Clarity + provenance des visiteurs (2026-11-18).
 *
 * Demande du user : voir sur quoi les visiteurs cliquent, où ils restent
 * (enregistrements de sessions, cartes de clics, défilement) et D'OÙ ils
 * viennent. Vercel Web Analytics (Hobby) ne donne ni clics ni temps passé.
 *
 * Provenance « premier contact » : à la toute première visite, on garde la
 * source (`utm_source`, sinon le site d'où l'on vient, sinon « direct ») dans
 * localStorage, sans jamais l'écraser. Elle reste attachée au visiteur s'il
 * revient plus tard en tapant l'adresse, puis s'abonne : on sait quel canal a
 * amené chaque abonné. La source de la visite EN COURS est gardée à part.
 *
 * Tout passe en balises Clarity (`clarity("set", …)`) : filtres « first_source »,
 * « source », « campaign », « plan » (free/pro), « signed_in » dans Clarity.
 * Aucune donnée personnelle : l'identifiant envoyé à `identify` est l'id de
 * compte (Clarity le hache), jamais le courriel.
 */

const CLARITY_ID = "zfj9sz095j";
const FIRST_TOUCH_KEY = "ae.firstTouch";

type Touch = { source: string; medium?: string; campaign?: string; landing: string; at: string };

type ClarityFn = ((...args: unknown[]) => void) & { q?: unknown[][] };
declare global {
  interface Window { clarity?: ClarityFn }
}

/** File d'attente Clarity (comme le snippet officiel) : les appels faits avant le chargement sont rejoués. */
function clarity(...args: unknown[]) {
  if (typeof window === "undefined") return;
  if (!window.clarity) {
    const q: ClarityFn = (...a: unknown[]) => { (q.q = q.q || []).push(a); };
    window.clarity = q;
  }
  window.clarity(...args);
}

/** Source de la visite en cours : UTM d'abord, sinon le site référent, sinon « direct ». */
function currentTouch(): Touch {
  const p = new URLSearchParams(window.location.search);
  const utm = (k: string) => p.get(k)?.trim().toLowerCase().slice(0, 60) || undefined;
  let source = utm("utm_source");
  if (!source) {
    try {
      const ref = document.referrer ? new URL(document.referrer).hostname.replace(/^www\./, "") : "";
      source = ref && ref !== window.location.hostname.replace(/^www\./, "") ? ref : "direct";
    } catch { source = "direct"; }
  }
  return {
    source,
    medium: utm("utm_medium"),
    campaign: utm("utm_campaign"),
    landing: window.location.pathname,
    at: new Date().toISOString(),
  };
}

function readFirstTouch(): Touch | null {
  try { const raw = localStorage.getItem(FIRST_TOUCH_KEY); return raw ? (JSON.parse(raw) as Touch) : null; }
  catch { return null; }
}

/** Le premier contact du visiteur (gardé), ou la visite en cours si c'est la première. */
export function firstTouch(): Touch | null {
  return readFirstTouch();
}

/** Charge Clarity et pose les balises de provenance. Web, production seulement. */
export function initAnalytics() {
  const now = currentTouch();
  let first = readFirstTouch();
  if (!first) {
    first = now;
    try { localStorage.setItem(FIRST_TOUCH_KEY, JSON.stringify(now)); } catch { /* navigation privée : tant pis */ }
  }

  clarity("set", "source", now.source);
  if (now.campaign) clarity("set", "campaign", now.campaign);
  if (now.medium) clarity("set", "medium", now.medium);
  clarity("set", "first_source", first.source);
  if (first.campaign) clarity("set", "first_campaign", first.campaign);
  clarity("set", "first_landing", first.landing);

  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.clarity.ms/tag/${CLARITY_ID}`;
  document.head.appendChild(s);
}

/** Relie la session au compte (id haché par Clarity) et marque gratuit / Pro. */
export function tagUser(userId: string | null, isPro: boolean) {
  if (!window.clarity) return; // Clarity pas chargé (dev, iOS) : rien à faire
  clarity("set", "signed_in", userId ? "yes" : "no");
  clarity("set", "plan", userId ? (isPro ? "pro" : "free") : "anonymous");
  if (userId) clarity("identify", userId);
}

/** Événement personnalisé (ex. « pro_checkout_click ») : filtrable dans Clarity. */
export function trackEvent(name: string) {
  if (window.clarity) clarity("event", name);
}
