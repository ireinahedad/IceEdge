/** Maps team abbreviation (uppercase) → display emoji.
 *  This is purely cosmetic — the NHL API provides logoUrl but not emoji.
 *  All other data (name, stats, standings) must come from the API.
 */
export const TEAM_EMOJI: Record<string, string> = {
  ANA: "\u{1F425}", ARI: "\u{1F40D}", BOS: "\u{1F43B}", BUF: "\u{1F9AC}",
  CAR: "\u{1F300}", CBJ: "\u{1F4A5}", CGY: "\u{1F525}", CHI: "\u{1F985}",
  COL: "\u{26F0}\u{FE0F}",  DAL: "\u{2B50}", DET: "\u{1F3CE}\u{FE0F}", EDM: "\u{1F6E2}\u{FE0F}",
  FLA: "\u{1F406}", LAK: "\u{1F451}", MIN: "\u{1F332}", MTL: "\u{1F535}",
  NJD: "\u{1F608}", NSH: "\u{1F3B8}", NYI: "\u{1F5FD}", NYR: "\u{1F5FD}",
  OTT: "\u{2B50}", PHI: "\u{1F7E0}", PIT: "\u{1F427}", SEA: "\u{1F9DC}",
  SJS: "\u{1F988}", STL: "\u{1F3B5}", TBL: "\u{26A1}", TOR: "\u{1F341}",
  VAN: "\u{1F40B}", VGK: "\u{2694}\u{FE0F}", WSH: "\u{1F985}", WPG: "\u{2708}\u{FE0F}",
};

export function teamEmoji(abbr: string): string {
  return TEAM_EMOJI[abbr?.toUpperCase()] ?? "\u{1F3D2}";
}

/** Convert win probability (0-100) to a rough American odds string. */
export function probToOdds(pct: number): string {
  const p = Math.max(5, Math.min(95, pct)) / 100;
  if (p >= 0.5) {
    const odds = Math.round(p / (1 - p) * 100);
    return `-${odds}`;
  } else {
    const odds = Math.round((1 - p) / p * 100);
    return `+${odds}`;
  }
}

/** Returns the official NHL team logo URL (light/white version) for the given abbreviation. */
export function nhlLogoUrl(abbr: string): string {
  return `https://assets.nhle.com/logos/nhl/svg/${abbr.toUpperCase()}_light.svg`;
}
