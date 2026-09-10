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

// `probToOdds` supprimée le 2026-08-10 : sans appelant, et doublon exact de
// `probToOddsLabel` (privée) dans `predictionApiService.ts`, qui est la version
// réellement utilisée. Deux conversions identiques finissent toujours par diverger.

/** Returns the official NHL team logo URL (light/white version) for the given abbreviation. */
export function nhlLogoUrl(abbr: string): string {
  return `https://assets.nhle.com/logos/nhl/svg/${abbr.toUpperCase()}_light.svg`;
}

// ─── Team colours ─────────────────────────────────────────────────────────────
// Same contract as TEAM_EMOJI above: purely cosmetic, client-side only. The NHL
// API returns `logoUrl` but no colours, so the home-page jersey tiles need this
// map to paint their background. Nothing here feeds a model or a stat.

export const TEAM_COLORS: Record<string, { primary: string; secondary: string }> = {
  ANA: { primary: "#F47A38", secondary: "#B9975B" },
  ARI: { primary: "#8C2633", secondary: "#E2D6B5" },
  BOS: { primary: "#FFB81C", secondary: "#101010" },
  BUF: { primary: "#003087", secondary: "#FFB81C" },
  CAR: { primary: "#CC0000", secondary: "#101010" },
  CBJ: { primary: "#002654", secondary: "#CE1126" },
  CGY: { primary: "#D2001C", secondary: "#FAAF19" },
  CHI: { primary: "#CF0A2C", secondary: "#101010" },
  COL: { primary: "#6F263D", secondary: "#236192" },
  DAL: { primary: "#006847", secondary: "#8F8F8C" },
  DET: { primary: "#CE1126", secondary: "#8C9199" },
  EDM: { primary: "#041E42", secondary: "#FF4C00" },
  FLA: { primary: "#041E42", secondary: "#C8102E" },
  LAK: { primary: "#111111", secondary: "#A2AAAD" },
  MIN: { primary: "#154734", secondary: "#A6192E" },
  MTL: { primary: "#AF1E2D", secondary: "#192168" },
  NJD: { primary: "#CE1126", secondary: "#101010" },
  NSH: { primary: "#FFB81C", secondary: "#041E42" },
  NYI: { primary: "#00539B", secondary: "#F47D30" },
  NYR: { primary: "#0038A8", secondary: "#CE1126" },
  OTT: { primary: "#C52032", secondary: "#C2912C" },
  PHI: { primary: "#F74902", secondary: "#101010" },
  PIT: { primary: "#101010", secondary: "#FCB514" },
  SEA: { primary: "#001628", secondary: "#99D9D9" },
  SJS: { primary: "#006D75", secondary: "#EA7200" },
  STL: { primary: "#002F87", secondary: "#FCB514" },
  TBL: { primary: "#002868", secondary: "#6A7885" },
  TOR: { primary: "#00205B", secondary: "#5A7BB5" },
  UTA: { primary: "#71AFE5", secondary: "#101010" },
  VAN: { primary: "#00205B", secondary: "#00843D" },
  VGK: { primary: "#B4975A", secondary: "#333F42" },
  WPG: { primary: "#041E42", secondary: "#004C97" },
  WSH: { primary: "#041E42", secondary: "#C8102E" },
};

/** Colour pair for a team, with a neutral ice-slate fallback for unknown abbrs. */
export function teamColors(abbr: string): { primary: string; secondary: string } {
  return TEAM_COLORS[abbr?.toUpperCase()] ?? { primary: "#1B2A33", secondary: "#0D1519" };
}

/**
 * Local jersey artwork for a team: `client/public/jerseys/<ABBR>.png`.
 * These files are supplied by us, not by the NHL API. Callers must handle a
 * missing file (`onError`) — the carousel falls back to `nhlLogoUrl`.
 */
export function jerseyUrl(abbr: string): string {
  return `/jerseys/${abbr.toUpperCase()}.png`;
}

// ─── Couleur d'identité d'une jambe de coupon ─────────────────────────────────
//
// Vit ici et non dans `slipShareCanvas` : DEUX écrans en ont besoin — l'image
// de partage et la carte de coupon jointe à un message de salon — et le second
// n'a aucune raison de tirer tout un moteur de rendu derrière lui.

/** Luminance relative approchée, pour juger si une couleur est trop sombre. */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 1;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/**
 * Éclaircit une couleur d'équipe trop sombre pour se voir sur la carte.
 *
 * Plusieurs clubs ont un bleu marine quasi noir (TOR #00205B, WPG #041E42) :
 * posé tel quel sur un fond de glace de nuit, le liseré disparaît. On le mêle
 * de blanc plutôt que d'aller chercher la couleur secondaire — celle-ci change
 * carrément de teinte (le bordeaux du Colorado deviendrait bleu) et l'identité
 * se perdrait.
 */
function liftIfDark(hex: string): string {
  const l = luminance(hex);
  if (l >= 0.20) return hex;
  const mix = Math.min(0.45, (0.20 - l) * 2.2);
  const n = parseInt(hex.replace('#', ''), 16);
  const up = (c: number) => Math.round(c + (255 - c) * mix);
  const r = up((n >> 16) & 255), g = up((n >> 8) & 255), b = up(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

export function legAccent(leg: {
  subjectId?:      string;
  selectionValue?: string;
  subjectLogo?:    string;
}): string {
  const fromUrl = typeof leg.subjectLogo === 'string'
    ? /\/([A-Z]{2,4})[_.]/.exec(leg.subjectLogo)?.[1]
    : undefined;

  const candidates = [leg.selectionValue, leg.subjectId, fromUrl];
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const abbr = c.toUpperCase();
    if (!/^[A-Z]{2,4}$/.test(abbr)) continue;
    const { primary } = teamColors(abbr);
    if (primary !== '#1B2A33') return liftIfDark(primary);   // '#1B2A33' = le repli de teamColors
  }
  return '#3A4A55';   // ardoise, relevée : le repli doit rester visible lui aussi
}
