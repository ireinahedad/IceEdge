/**
 * geo.ts — the visitor's location, as the API reads it from Cloudflare.
 *
 * DRAFTKINGS_AFFILIATE_PLAN Phase 1 (2026-11-09): sportsbook links are for US
 * visitors in a DraftKings state, and for Ontario. `GET /api/geo` (server/src/services/geo.ts)
 * decides; the client never guesses from the browser language or time zone.
 *
 * Fails CLOSED: until the answer arrives, or if the call fails, the visitor
 * counts as not eligible — no link, no affiliate copy. One request per page
 * load, shared by every component through `useGeo()`.
 *
 * Testing from Bali (dev server only): `?geo=US-NJ`, `?geo=CA-ON`, `?geo=CA-QC`,
 * `?geo=off` to clear. Never honoured in a production build.
 */

import { useSyncExternalStore } from "react";
import { env } from "../env";
import { isIOS } from "../platform";

export interface GeoInfo {
  country: string | null;
  region: string | null;
  /** Liens d'affiliation permis ici. Renommé le 2026-11-22 : les clés d'objet
   *  survivent à la minification et ce mot-là est refusé dans le bundle iOS
   *  (scripts/build-ios.mjs, APPLE_PLAN 2.2). Le serveur garde son champ ;
   *  on le recalcule ici depuis `market` (même règle : `market !== null`). */
  linksEligible: boolean;
  /** 'US' or 'ON' (Ontario): which age, helpline and advertising rules apply. */
  market: "US" | "ON" | null;
  minAge: 18 | 19 | 21 | null;
}

const UNKNOWN: GeoInfo = { country: null, region: null, linksEligible: false, market: null, minAge: null };
const OVERRIDE_KEY = "arakice_geo_override";
/** Mirrors the default list in server/src/services/geo.ts — dev override only. */
const DEV_STATES = new Set(["AZ","CO","CT","DC","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MO","NH","NJ","NY","NC","OH","OR","PA","TN","VT","VA","WV","WY"]);
const DEV_AGE_18 = new Set(["DC", "KY", "NH", "WY"]);

let current: GeoInfo = UNKNOWN;
let started = false;
const listeners = new Set<() => void>();

function set(next: GeoInfo) {
  current = next;
  listeners.forEach((l) => l());
}

function devOverride(): GeoInfo | null {
  if (!import.meta.env.DEV) return null;
  try {
    const q = new URLSearchParams(window.location.search).get("geo");
    if (q === "off") sessionStorage.removeItem(OVERRIDE_KEY);
    else if (q) sessionStorage.setItem(OVERRIDE_KEY, q.toUpperCase());
    const raw = sessionStorage.getItem(OVERRIDE_KEY);
    if (!raw) return null;
    const [country, region = null] = raw.split("-");
    const market = country === "US" && !!region && DEV_STATES.has(region) ? "US"
      : country === "CA" && region === "ON" ? "ON" : null;
    const minAge = market === "ON" ? 19 : market === "US" ? (DEV_AGE_18.has(region!) ? 18 : 21) : null;
    return { country, region, linksEligible: market !== null, market, minAge };
  } catch {
    return null;
  }
}

type GeoResponse = Pick<GeoInfo, "country" | "region" | "market" | "minAge">;

function isGeoResponse(v: unknown): v is GeoResponse {
  return !!v && typeof v === "object" && "market" in v;
}

/** Réponse de `/api/geo` → GeoInfo. Un marché inconnu compte comme aucun. */
function fromResponse(j: GeoResponse): GeoInfo {
  const market = j.market === "US" || j.market === "ON" ? j.market : null;
  return {
    country: j.country ?? null,
    region:  j.region ?? null,
    market,
    minAge:  market ? (j.minAge ?? null) : null,
    linksEligible: market !== null,
  };
}

function start() {
  if (started || isIOS) return;
  started = true;
  const o = devOverride();
  if (o) { set(o); return; }
  fetch(`${env.apiBase}/geo`, { credentials: "omit" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { if (isGeoResponse(j)) set(fromResponse(j)); })
    .catch(() => { /* stays UNKNOWN: fail closed */ });
}

function subscribe(l: () => void) {
  start();
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** Synchronous read, for non-React code (`openUrl`). */
export function getGeo(): GeoInfo {
  start();
  return current;
}

export function useGeo(): GeoInfo {
  return useSyncExternalStore(subscribe, () => current, () => UNKNOWN);
}
