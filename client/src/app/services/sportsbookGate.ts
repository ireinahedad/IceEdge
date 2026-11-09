/**
 * sportsbookGate.ts — may THIS visitor see a sportsbook link right now?
 *
 *   build flag (`features.bookmakerLinks`: web + VITE_BOOKMAKER_LINKS=true)
 *   AND location (`/api/geo`: US visitor in a DraftKings state)
 *
 * The build flag alone is not enough since 2026-11-09 (DRAFTKINGS_AFFILIATE_PLAN
 * Phase 1). Every link entry point reads one of these two.
 */

import { features } from "../platform";
import { getGeo, useGeo } from "./geo";

export function bookmakerLinksAllowed(): boolean {
  return features.bookmakerLinks && getGeo().sportsbookEligible;
}

export function useBookmakerLinks(): boolean {
  const geo = useGeo();
  return features.bookmakerLinks && geo.sportsbookEligible;
}
