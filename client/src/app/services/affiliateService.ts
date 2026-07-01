// services/affiliateService.ts
// Generates tracked Bet365 affiliate deep-links.
// Set VITE_BET365_AFFILIATE_CODE in .env (e.g. "365_123456").

const AFFILIATE_CODE = import.meta.env.VITE_BET365_AFFILIATE_CODE as
  | string
  | undefined;

const BET365_BASE = "https://www.bet365.com";

/**
 * Open a Bet365 page in a new tab with affiliate tracking.
 * If no affiliate code is configured, links still work — just untracked.
 */
export function openBet365(path = "") {
  const url = buildBet365Url(path);
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Build a Bet365 URL with the affiliate code appended.
 */
export function buildBet365Url(path = ""): string {
  const affiliate = AFFILIATE_CODE ? `?affiliate=${AFFILIATE_CODE}` : "";
  return `${BET365_BASE}${path}${affiliate}`;
}

// ─── Sport-specific deep links ─────────────────────────────────────────────

/** NHL / Hockey section on Bet365 */
export function bet365HockeyUrl(): string {
  return buildBet365Url("/#/IP/B18");
}

/** Tennis section on Bet365 */
export function bet365TennisUrl(): string {
  return buildBet365Url("/#/IP/B13");
}

/**
 * Link to a specific match. Bet365 doesn't expose clean per-match deep links
 * publicly, so we fall back to the sport section. If you get a
 * sport-specific event URL from their affiliate dashboard, pass it as `path`.
 */
export function bet365MatchUrl(sport: "hockey" | "tennis", _eventId?: string): string {
  return sport === "hockey" ? bet365HockeyUrl() : bet365TennisUrl();
}

/** Open account / sign-up page — most valuable affiliate conversion */
export function bet365SignupUrl(): string {  return buildBet365Url("/#/OA/E/");
}
