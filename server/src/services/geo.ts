/**
 * geo.ts — where is this visitor, and may we show them a sportsbook link?
 *
 * DRAFTKINGS_AFFILIATE_PLAN Phase 1 (2026-11-09). A visitor gets the DraftKings
 * button, the age notice and the affiliate disclosure only when Cloudflare
 * places them in a US state where DraftKings Sportsbook takes online bets, or
 * in Ontario (the only Canadian province with a private regulated market,
 * AGCO / iGaming Ontario). Everyone else (Québec, the rest of Canada,
 * Indonesia, unknown) sees the app as before: probabilities, no link.
 *
 * `market` tells the client which rules to apply:
 *   'US' → 21+ (18+ in DC/KY/NH/WY), 1-800-GAMBLER.
 *   'ON' → 19+, ConnexOntario 1-866-531-2600, and NO bonus / promo / free-bet
 *          copy anywhere (AGCO Registrar's Standard 2.05).
 * Ontario can be switched off without a deploy: `SPORTSBOOK_ONTARIO=false`.
 *
 * Location comes from Cloudflare, which proxies the API:
 *   - `cf-ipcountry`    always sent when the request goes through Cloudflare.
 *   - `cf-region-code`  only sent once the Managed Transform « Add visitor
 *                       location headers » is ON (Cloudflare dashboard → Rules →
 *                       Transform Rules → Managed Transforms). Without it the
 *                       state is unknown and the visitor is NOT eligible — we
 *                       fail closed, never open.
 *
 * The state list changes (new launches). Override it without a deploy through
 * `SPORTSBOOK_US_STATES=AZ,CO,...` on Railway. Last checked 2026-11-09 against
 * public state lists; confirm with the DraftKings affiliate manager.
 */

/** DraftKings Sportsbook online states + DC (Nov 2026). Arkansas left out: unconfirmed. */
const DEFAULT_US_STATES = [
  'AZ', 'CO', 'CT', 'DC', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA',
  'MI', 'MO', 'NH', 'NJ', 'NY', 'NC', 'OH', 'OR', 'PA', 'TN', 'VT', 'VA', 'WV', 'WY',
];

/** States where the sportsbook minimum age is 18 instead of 21. */
const AGE_18_STATES = new Set(['DC', 'KY', 'NH', 'WY']);

const CODE_RE = /^[A-Z]{2}$/;

export function eligibleUsStates(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.SPORTSBOOK_US_STATES?.trim();
  const list = raw ? raw.split(',').map((s) => s.trim().toUpperCase()).filter((s) => CODE_RE.test(s)) : DEFAULT_US_STATES;
  return new Set(list);
}

export type SportsbookMarket = 'US' | 'ON';

export interface GeoInfo {
  /** ISO 3166-1 alpha-2, or null when unknown (no Cloudflare, Tor `T1`, `XX`). */
  country: string | null;
  /** US state / CA province code (ISO 3166-2 suffix), or null when unknown. */
  region: string | null;
  /** True only for a known US DraftKings state, or Ontario. */
  sportsbookEligible: boolean;
  /** Which rule set applies; null when not eligible. */
  market: SportsbookMarket | null;
  /** Minimum betting age where the visitor is; null when not eligible. */
  minAge: 18 | 19 | 21 | null;
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const v = headers[name];
  const s = (Array.isArray(v) ? v[0] : v)?.trim().toUpperCase();
  return s && CODE_RE.test(s) && s !== 'XX' && s !== 'T1' ? s : null;
}

export function geoFromHeaders(
  headers: Record<string, string | string[] | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): GeoInfo {
  const country = header(headers, 'cf-ipcountry');
  const region = country ? header(headers, 'cf-region-code') : null;
  const market: SportsbookMarket | null =
    country === 'US' && region !== null && eligibleUsStates(env).has(region) ? 'US'
    : country === 'CA' && region === 'ON' && env.SPORTSBOOK_ONTARIO !== 'false' ? 'ON'
    : null;
  return {
    country,
    region,
    sportsbookEligible: market !== null,
    market,
    minAge: market === 'ON' ? 19 : market === 'US' ? (AGE_18_STATES.has(region!) ? 18 : 21) : null,
  };
}
