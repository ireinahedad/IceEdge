/**
 * geo.ts — the visitor's location, as the API reads it from Cloudflare.
 *
 * DRAFTKINGS_AFFILIATE_PLAN Phase 1 (2026-11-09): sportsbook links are for US
 * visitors in a DraftKings state only. `GET /api/geo` (server/src/services/geo.ts)
 * decides; the client never guesses from the browser language or time zone.
 *
 * Fails CLOSED: until the answer arrives, or if the call fails, the visitor
 * counts as not eligible — no link, no affiliate copy. One request per page
 * load, shared by every component through `useGeo()`.
 *
 * Testing from outside the US (dev server only): `?geo=US-NJ`, `?geo=CA-ON`,
 * `?geo=off` to clear. Never honoured in a production build.
 */

import { useSyncExternalStore } from "react";
import { env } from "../env";
import { isIOS } from "../platform";

export interface GeoInfo {
  country: string | null;
  region: string | null;
  sportsbookEligible: boolean;
  minAge: 18 | 21 | null;
}

const UNKNOWN: GeoInfo = { country: null, region: null, sportsbookEligible: false, minAge: null };
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
    const eligible = country === "US" && !!region && DEV_STATES.has(region);
    return { country, region, sportsbookEligible: eligible, minAge: eligible ? (DEV_AGE_18.has(region!) ? 18 : 21) : null };
  } catch {
    return null;
  }
}

function isGeoInfo(v: unknown): v is GeoInfo {
  return !!v && typeof v === "object" && typeof (v as GeoInfo).sportsbookEligible === "boolean";
}

function start() {
  if (started || isIOS) return;
  started = true;
  const o = devOverride();
  if (o) { set(o); return; }
  fetch(`${env.apiBase}/geo`, { credentials: "omit" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { if (isGeoInfo(j)) set({ ...UNKNOWN, ...j }); })
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
