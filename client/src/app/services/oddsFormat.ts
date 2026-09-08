// services/oddsFormat.ts
// Comment un même chiffre s'écrit en %, en cote décimale ou en cote américaine.
//
// ── Ce que ce module convertit, et ce qu'il ne convertit PAS ────────────────
// Il ne traite que des PROBABILITÉS DE PARI : la chance qu'une sélection passe
// (le % du modèle) et le prix d'un bookmaker. Un taux de victoire, un ROI, un
// pourcentage de forme ou un EV ne sont pas des probabilités de sélection : les
// écrire « -713 » n'aurait aucun sens, et ces chiffres restent donc en %
// partout dans l'app.
//
// ── Le choix est un réglage de LECTURE ─────────────────────────────────────
// Il ne change aucun calcul, aucune donnée envoyée au serveur, aucun pari
// enregistré : seulement la façon dont un nombre déjà calculé s'affiche. Il vit
// donc en localStorage comme le bookmaker choisi (voir `bookmakers.ts`), pas en
// base — c'est une préférence d'appareil, pas de compte.
//
// ── Les bornes ──────────────────────────────────────────────────────────────
// `clampPct` reprend exactement les 5–95 % de l'ancien `toOddsLabel` de
// betParts.tsx, dont ce module est l'extension. Ce n'est pas de la prudence
// décorative : à 99 % la cote américaine vaut -9900 et la décimale 1,01, deux
// nombres qui remplissent l'écran sans rien apprendre, et à 0 % la décimale
// diverge. Les bornes sont ici pour que la valeur affichée reste lisible, pas
// pour corriger le modèle.

export type OddsFormat = "percent" | "decimal" | "american";

/** Ordre d'affichage du sélecteur, et seule source de vérité de la liste. */
export const ODDS_FORMAT_IDS: OddsFormat[] = ["percent", "decimal", "american"];

/** Exemple montré sous chaque choix — le format se comprend mieux qu'il ne se décrit. */
export const ODDS_FORMAT_SAMPLE: Record<OddsFormat, string> = {
  percent: "68 %",
  decimal: "1.47",
  american: "-213",
};

export const ODDS_FORMAT_STORAGE_KEY = "iceedge_odds_format";
const DEFAULT_ODDS_FORMAT: OddsFormat = "percent";

export function isOddsFormat(v: unknown): v is OddsFormat {
  return typeof v === "string" && (ODDS_FORMAT_IDS as string[]).includes(v);
}

/** Lit le format choisi (repli sur le %, le seul qui ne demande rien au lecteur). */
export function getSelectedOddsFormat(): OddsFormat {
  try {
    const stored = localStorage.getItem(ODDS_FORMAT_STORAGE_KEY);
    if (isOddsFormat(stored)) return stored;
  } catch {
    /* navigation privée verrouillée : on garde le défaut */
  }
  return DEFAULT_ODDS_FORMAT;
}

export function setSelectedOddsFormat(format: OddsFormat): void {
  try {
    localStorage.setItem(ODDS_FORMAT_STORAGE_KEY, format);
  } catch {
    /* le choix vaut alors pour la session en cours seulement */
  }
}

// ── Conversions ─────────────────────────────────────────────────────────────

const MIN_PCT = 5;
const MAX_PCT = 95;

function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return MIN_PCT;
  return Math.max(MIN_PCT, Math.min(MAX_PCT, pct));
}

/** Probabilité (0-100) → cote décimale (ex. 68 % → 1.47). */
export function pctToDecimal(pct: number): number {
  return 100 / clampPct(pct);
}

/** Probabilité (0-100) → cote américaine signée (ex. 68 % → -213, 32 % → +213). */
export function pctToAmerican(pct: number): number {
  const p = clampPct(pct) / 100;
  return p >= 0.5
    ? -Math.round((p / (1 - p)) * 100)
    : Math.round(((1 - p) / p) * 100);
}

/** Cote décimale → probabilité implicite (0-100). Le vig n'est PAS retiré. */
export function decimalToPct(decimal: number): number {
  if (!Number.isFinite(decimal) || decimal <= 1) return 0;
  return 100 / decimal;
}

/** Le signe fait partie du format : une cote américaine sans « + » se lit mal. */
export function formatAmerican(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

/**
 * Écrit une PROBABILITÉ DE SÉLECTION (0-100) dans le format choisi.
 *
 * `decimals` ne s'applique QU'AU %, et il est volontairement facultatif :
 * omis, le nombre part tel quel, exactement comme les `{pct}%` littéraux que
 * cette fonction remplace. Ce n'est pas un détail — la probabilité combinée
 * d'un coupon arrive du serveur arrondie au dixième (`ml.routes.ts`,
 * `adjustedProbability`), donc un `toFixed(0)` imposé ici transformerait
 * silencieusement « 12,3 % » en « 12 % » sur tous les coupons multiples.
 * Un écran qui VEUT arrondir le demande.
 *
 * Une cote, elle, se lit à deux décimales (décimale) ou en entier (américaine)
 * quel que soit l'appelant : laisser ce choix à chaque écran ferait diverger
 * l'écriture d'un même nombre d'une page à l'autre.
 */
export function formatProbability(pct: number, format: OddsFormat, decimals?: number): string {
  if (!Number.isFinite(pct)) return "—";
  switch (format) {
    case "decimal":  return pctToDecimal(pct).toFixed(2);
    case "american": return formatAmerican(pctToAmerican(pct));
    default:         return `${decimals == null ? pct : pct.toFixed(decimals)}%`;
  }
}

/**
 * Écrit une COTE DE BOOKMAKER, reçue en décimal (ex. 1.85), dans le format choisi.
 *
 * Distinct de `formatProbability` par la borne : une cote réelle n'est pas
 * bridée à 5–95 % quand on l'affiche telle quelle (`decimal`), parce qu'elle
 * n'est pas une estimation à nous mais un prix affiché par le livre.
 */
export function formatDecimalOdds(decimal: number, format: OddsFormat): string {
  if (!Number.isFinite(decimal) || decimal <= 1) return "—";
  switch (format) {
    case "percent":  return `${Math.round(decimalToPct(decimal))}%`;
    case "american": return formatAmerican(pctToAmerican(decimalToPct(decimal)));
    default:         return decimal.toFixed(2);
  }
}
