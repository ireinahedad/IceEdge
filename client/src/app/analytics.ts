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
 *
 * Consentement (2026-11-18, demande du user) : pour un visiteur de l'Espace
 * économique européen, du Royaume-Uni ou de Suisse, rien n'est déposé (ni
 * cookie Clarity, ni provenance en localStorage) avant qu'il accepte dans le
 * bandeau (`ConsentBanner`). Sans réponse ou s'il refuse, Clarity tourne en
 * mode sans cookie (`consentv2` refusé). Le pays vient de `/api/geo`
 * (Cloudflare) ; si l'API ne répond pas, un fuseau `Europe/…` compte comme
 * européen — on se trompe du côté prudent. Ailleurs, pas de bandeau.
 */

import { phCapture, phIdentify, startPosthog, stopPosthog } from "./posthog";

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

const CONSENT_KEY = "ae.consent";
export type ConsentChoice = "granted" | "denied";

/** EEE + Royaume-Uni + Suisse : là où le consentement aux cookies est exigé. */
const CONSENT_COUNTRIES = new Set([
  "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT","NL",
  "PL","PT","RO","SK","SI","ES","SE","IS","LI","NO","GB","CH",
  // Territoires français d'outre-mer : même règle que la France.
  "GP","MQ","GF","RE","YT","PM","BL","MF","NC","PF","WF",
]);

let active = false;
/** Source de la visite en cours, gardée pour la noter une fois le consentement donné. */
let pendingTouch: Touch | null = null;
const consentListeners = new Set<() => void>();

export function readConsent(): ConsentChoice | null {
  try { const v = localStorage.getItem(CONSENT_KEY); return v === "granted" || v === "denied" ? v : null; }
  catch { return null; }
}

/** Le visiteur doit-il donner son accord ? `country` : celui de `/api/geo`, ou null s'il n'est pas connu. */
export function consentRequired(country: string | null): boolean {
  if (country) return CONSENT_COUNTRIES.has(country.toUpperCase());
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone.startsWith("Europe/"); }
  catch { return true; }
}

/** Clarity est-il chargé (web, production) ? Le bandeau ne s'affiche que dans ce cas. */
export function analyticsActive() {
  return active;
}

function rememberFirstTouch() {
  if (!pendingTouch) return;
  try { if (!localStorage.getItem(FIRST_TOUCH_KEY)) localStorage.setItem(FIRST_TOUCH_KEY, JSON.stringify(pendingTouch)); }
  catch { /* navigation privée : tant pis */ }
}

function applyConsent(choice: ConsentChoice) {
  clarity("consentv2", { ad_Storage: "denied", analytics_Storage: choice });
  if (choice === "granted") rememberFirstTouch();
  else {
    try { localStorage.removeItem(FIRST_TOUCH_KEY); } catch { /* rien */ }
    stopPosthog(); // sans effet s'il n'a jamais été chargé
  }
}

/** Réponse du visiteur au bandeau. Gardée, puis appliquée tout de suite. */
export function setConsent(choice: ConsentChoice) {
  try { localStorage.setItem(CONSENT_KEY, choice); } catch { /* rien */ }
  applyConsent(choice);
  flushPending();
  consentListeners.forEach((l) => l());
}

/** « Gérer les cookies » : oublie la réponse et rouvre le bandeau. */
export function resetConsent() {
  try { localStorage.removeItem(CONSENT_KEY); } catch { /* rien */ }
  applyConsent("denied");
  consentListeners.forEach((l) => l());
}

export function onConsentChange(l: () => void) {
  consentListeners.add(l);
  return () => { consentListeners.delete(l); };
}

/**
 * Une fois le pays connu, sans réponse gardée : hors Europe, l'accord est
 * implicite (comme avant le bandeau) ; en Europe, on reste en mode sans cookie
 * en attendant le bandeau.
 */
export function resolveRegion(country: string | null) {
  regionNeedsConsent = consentRequired(country);
  flushPending();
  if (!active || readConsent()) return;
  applyConsent(consentRequired(country) ? "denied" : "granted");
}

/** Charge Clarity et pose les balises de provenance. Web, production seulement. */
export function initAnalytics() {
  active = true;
  const now = currentTouch();
  pendingTouch = now;
  const first = readFirstTouch() ?? now;

  // Avant tout chargement : sans réponse gardée, mode sans cookie par défaut ;
  // `resolveRegion` lève la restriction hors d'Europe quand le pays arrive.
  const stored = readConsent();
  applyConsent(stored ?? "denied");

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
  maybeStartPosthog(); // réponse « Accepter » déjà gardée : tout de suite
  consentListeners.forEach((l) => l());
}

/** Relie la session au compte (id haché par Clarity) et marque gratuit / Pro. */
export function tagUser(userId: string | null, isPro: boolean) {
  phIdentify(userId, userId ? (isPro ? "pro" : "free") : "anonymous");
  if (!window.clarity) return; // Clarity pas chargé (dev, iOS) : rien à faire
  clarity("set", "signed_in", userId ? "yes" : "no");
  clarity("set", "plan", userId ? (isPro ? "pro" : "free") : "anonymous");
  if (userId) clarity("identify", userId);
}

/**
 * Événement personnalisé (ex. « pro_checkout_click ») : filtrable dans Clarity,
 * ET journalisé en base (`product_events`, migration 055) pour que l'entonnoir
 * se lise en SQL — Clarity n'a ni SQL ni historique exportable.
 *
 * Le serveur n'accepte que sa liste blanche (`CLIENT_EVENTS`, growth.service.ts) :
 * un nom inconnu reçoit un 400 sans conséquence. Même règle de consentement
 * que Clarity : en Europe, rien ne part sans « Accepter ».
 */
export function trackEvent(name: string) {
  if (window.clarity) clarity("event", name);
  if (!active) return;
  // Pays pas encore connu et pas de réponse gardée : on attend `resolveRegion`
  // (quelques centaines de ms) au lieu de perdre les événements du chargement.
  if (regionNeedsConsent === null && !readConsent()) {
    if (pendingEvents.length < 20) pendingEvents.push(name);
    return;
  }
  if (!productEventsAllowed()) return;
  postEvent(name);
}

function postEvent(name: string) {
  phCapture(name);
  void import("./services/authService")
    .then((m) => m.authedFetch("/growth/event", { method: "POST", body: JSON.stringify({ name }), keepalive: true }))
    .catch(() => { /* mesure best-effort */ });
}

/** null = pays pas encore connu. Posé par `resolveRegion`. */
let regionNeedsConsent: boolean | null = null;
/** Événements émis avant que le pays soit connu ; vidés par `resolveRegion`. */
const pendingEvents: string[] = [];
let pendingAttribution: string | null = null;

function flushPending() {
  const names = pendingEvents.splice(0);
  const attr = pendingAttribution;
  pendingAttribution = null;
  if (!productEventsAllowed()) return;
  maybeStartPosthog();
  names.forEach(postEvent);
  if (attr) sendSignupAttribution(attr);
}

/**
 * PostHog ne se charge qu'une fois la mesure permise (accord, ou hors Europe
 * une fois le pays connu). Super-propriétés : la provenance, comme dans Clarity,
 * pour couper l'entonnoir par canal (first_source = canal qui a amené l'abonné).
 */
function maybeStartPosthog() {
  if (!productEventsAllowed()) return;
  const now = pendingTouch;
  const first = readFirstTouch() ?? now;
  const props: Record<string, string> = {};
  if (now) props.source = now.source;
  if (now?.campaign) props.campaign = now.campaign;
  if (first) { props.first_source = first.source; props.first_landing = first.landing; }
  if (first?.campaign) props.first_campaign = first.campaign;
  startPosthog(props);
}

/** Mesure en base permise ? Accord explicite, ou hors Europe une fois le pays connu. */
function productEventsAllowed(): boolean {
  if (!active) return false; // dev, iOS : rien
  const c = readConsent();
  if (c) return c === "granted";
  return regionNeedsConsent === false;
}

const ATTR_SENT_KEY = "ae.attrSent";

/**
 * Provenance premier contact → compte (migration 055). Une fois par navigateur
 * et par compte ; le serveur ne l'écrit que pour un compte de moins de 3 jours
 * et seulement si elle est vide. Sans premier contact gardé (refus du
 * consentement, navigation privée), rien n'est envoyé.
 */
export function sendSignupAttribution(userId: string) {
  if (!active) return;
  if (regionNeedsConsent === null && !readConsent()) { pendingAttribution = userId; return; }
  if (!productEventsAllowed()) return;
  const touch = readFirstTouch();
  if (!touch) return;
  try { if (localStorage.getItem(ATTR_SENT_KEY) === userId) return; } catch { return; }
  void import("./services/authService")
    .then((m) => m.authedFetch("/growth/attribution", {
      method: "POST",
      body: JSON.stringify({ source: touch.source, medium: touch.medium, campaign: touch.campaign, landing: touch.landing }),
    }))
    .then((r) => { if (r.ok) { try { localStorage.setItem(ATTR_SENT_KEY, userId); } catch { /* rien */ } } })
    .catch(() => { /* réessai au prochain chargement */ });
}
