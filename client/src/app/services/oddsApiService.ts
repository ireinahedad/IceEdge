// services/oddsApiService.ts
// Fetches live Bet365 odds via the backend proxy (/api/odds/*).
// The Odds API key now lives server-side only — it is never shipped to the client.
// Falls back to empty array when the backend/upstream is unavailable.

import { env } from "../env";
import { fetchWithTimeout } from "./http";

// Backend base, e.g. https://<railway>/api — validated in env.ts, no localhost fallback.
const API_BASE = env.apiBase;

// Sport keys used by The Odds API
export const ODDS_SPORT_KEYS = {
  hockey: "icehockey_nhl",
} as const;

export interface OddsOutcome {
  name: string;
  price: number; // decimal odds e.g. 1.85
}

export interface OddsMarket {
  key: string;      // e.g. "h2h", "spreads", "totals"
  lastUpdate: string;
  outcomes: OddsOutcome[];
}

export interface OddsEvent {
  id: string;
  sportKey: string;
  commenceTime: string; // ISO 8601
  homeTeam: string;
  awayTeam: string;
  bookmakers: Array<{
    key: string;
    title: string;
    lastUpdate: string;
    markets: OddsMarket[];
  }>;
}

/**
 * Fetch odds for a sport, filtered to Bet365.
 * Returns [] if no API key is set or the request fails.
 */
export async function fetchBet365Odds(
  sportKey: string,
  markets: string[] = ["h2h"]
): Promise<OddsEvent[]> {
  try {
    const params = new URLSearchParams({ markets: markets.join(",") });
    const res = await fetchWithTimeout(
      `${API_BASE}/odds/bet365/${encodeURIComponent(sportKey)}?${params}`
    );
    if (!res.ok) {
      console.error("[oddsApi] HTTP", res.status);
      return [];
    }
    return (await res.json()) as OddsEvent[];
  } catch (err) {
    console.error("[oddsApi] fetch error", err);
    return [];
  }
}

/**
 * Extract the Bet365 h2h (match winner) prices for a single event.
 * Returns null if Bet365 data isn't present.
 */
export function extractH2HOdds(
  event: OddsEvent
): { home: number; away: number } | null {
  const bet365 = event.bookmakers.find((b) => b.key === "bet365");
  if (!bet365) return null;

  const h2h = bet365.markets.find((m) => m.key === "h2h");
  if (!h2h || h2h.outcomes.length < 2) return null;

  const home = h2h.outcomes.find((o) => o.name === event.homeTeam);
  const away = h2h.outcomes.find((o) => o.name === event.awayTeam);
  if (!home || !away) return null;

  return { home: home.price, away: away.price };
}

// `decimalToWinPct` et `fetchAvailableSports` supprimées le 2026-08-10 (0 appelant).
// La conversion cote → probabilité vit dans `HockeyLanding` (`impliedPct`), qui
// dévigue la paire au lieu d'inverser une seule cote — c'est la bonne version.
