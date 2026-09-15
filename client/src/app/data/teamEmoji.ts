

// `probToOdds` supprimée le 2026-08-10 : sans appelant, et doublon exact de
// `probToOddsLabel` (privée) dans `predictionApiService.ts`, qui est la version
// réellement utilisée. Deux conversions identiques finissent toujours par diverger.

/** Returns the official NHL team logo URL (light/white version) for the given abbreviation. */
export function nhlLogoUrl(abbr: string): string {
  return `https://assets.nhle.com/logos/nhl/svg/${abbr.toUpperCase()}_light.svg`;
}

// ─── Team colours ─────────────────────────────────────────────────────────────
// Same contract as TEAM_EMOJI above: purely cosmetic. The NHL API returns
// `logoUrl` but no colours, so the home-page jersey tiles need this map to
// paint their background. Nothing here feeds a model or a stat.
//
// The table itself lives in team-colors.json because it is read from BOTH sides
// of the repo: here, and by server/scripts/render-slides.ts for the card border
// on the videos. It cannot stay inline — this package declares "type": "module",
// so every .ts here is an ES module, which ts-node (CommonJS, on the server
// side) refuses to require(). JSON is exempt from that rule.
//
// The shape is unchanged: TEAM_COLORS and teamColors() keep their exact
// signatures, so nothing that imports them needs to know any of this.
import teamColorData from "./team-colors.json";

const TEAM_COLORS: Record<string, { primary: string; secondary: string }> =
  teamColorData.teams;

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
