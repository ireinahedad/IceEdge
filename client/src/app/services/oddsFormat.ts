// services/oddsFormat.ts
// Comment une COTE DE BOOKMAKER s'écrit : en cote décimale, en cote américaine,
// ou en probabilité implicite.
//
// ── Ce que ce module convertit, et ce qu'il ne convertira JAMAIS ────────────
//
// Uniquement les **prix affichés par un livre** — bet365, Stake, ou tout autre
// bookmaker dont l'app relaie les cotes. Un prix est une offre : le livre
// s'engage à payer ce multiple. Il peut donc s'écrire indifféremment 1.47,
// -213 ou 68 % — trois écritures du même engagement, et le lecteur choisit
// celle qu'il lit le plus vite.
//
// ⚠️⚠️ **La probabilité du modèle n'est PAS un prix, et ne passe pas par ici.**
// C'est une mesure de confiance : « d'après nos données, ce pari a telle chance
// de passer ». Personne ne s'engage à payer quoi que ce soit dessus. L'écrire
// « -213 » à côté des cotes du livre la ferait passer pour une offre concurrente
// alors qu'elle n'en est pas une, et brouillerait précisément la comparaison qui
// fait l'intérêt du produit : notre estimation FACE au prix du marché. Les
// probabilités du modèle restent donc en % partout, quel que soit ce réglage —
// jauges de prédiction, Best Bets, jambes de coupon, carte ML, page joueur.
//
// 🔁 Exception décidée par le user le 2026-09-25 : la cote ÉQUIVALENTE écrite à
// côté d'un pourcentage (jambes du coupon, pastille « implied odds » sous la
// jauge du coupon) suit ce réglage — via `impliedDecimal()` de
// `pages/bet/betParts.tsx`. Le pourcentage lui-même reste en %. `toOddsLabel`,
// figée en américain, ne sert plus qu'aux données ENREGISTRÉES et à l'image de
// partage.
//
// ── Le choix est un réglage de LECTURE ─────────────────────────────────────
// Il ne change aucun calcul, aucune donnée envoyée au serveur, aucun pari
// enregistré : seulement la façon dont un prix déjà reçu s'affiche. Il vit donc
// en localStorage comme le bookmaker choisi (voir `bookmakers.ts`), pas en base
// — c'est une préférence d'appareil, pas de compte.

export type OddsFormat = "percent" | "decimal" | "american";

/** Ordre d'affichage du sélecteur, et seule source de vérité de la liste. */
export const ODDS_FORMAT_IDS: OddsFormat[] = ["percent", "decimal", "american"];

/** Exemple montré sous chaque choix — le format se comprend mieux qu'il ne se décrit. */
export const ODDS_FORMAT_SAMPLE: Record<OddsFormat, string> = {
  percent: "68 %",
  decimal: "1.47",
  american: "-213",
};

const ODDS_FORMAT_STORAGE_KEY = "iceedge_odds_format";
const DEFAULT_ODDS_FORMAT: OddsFormat = "decimal";

function isOddsFormat(v: unknown): v is OddsFormat {
  return typeof v === "string" && (ODDS_FORMAT_IDS as string[]).includes(v);
}

/**
 * Lit le format choisi.
 *
 * Repli sur la cote **décimale** : c'est la forme sous laquelle les cotes
 * arrivent du fournisseur et celle que l'app affichait avant ce réglage. Un
 * défaut différent changerait l'écran de tous ceux qui n'ont jamais ouvert les
 * Réglages, pour un choix qu'ils n'ont pas fait.
 */
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
//
// Aucune borne ici, contrairement à `toOddsLabel` qui bride les probabilités du
// modèle entre 5 et 95 %. La différence est de nature : borner une ESTIMATION
// évite d'afficher une précision qu'on n'a pas, alors qu'un PRIX est un fait —
// une cote à 1.02 vaut vraiment -5000, et l'écrêter afficherait un prix que le
// livre ne propose pas.

/** Cote décimale → probabilité implicite (0-100). Le vig n'est PAS retiré. */
function decimalToPct(decimal: number): number {
  return 100 / decimal;
}

/** Cote décimale → cote américaine signée (2.13 → +113 ; 1.47 → -213). */
function decimalToAmerican(decimal: number): number {
  return decimal >= 2
    ? Math.round((decimal - 1) * 100)
    : -Math.round(100 / (decimal - 1));
}

/** Le signe fait partie du format : une cote américaine sans « + » se lit mal. */
function formatAmerican(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

/**
 * Écrit une cote de bookmaker, reçue en décimal (ex. 1.85), dans le format choisi.
 *
 * `decimal <= 1` est refusé plutôt que converti : une cote de 1 ou moins n'est
 * pas un prix (elle ne rembourse même pas la mise), c'est une valeur manquante
 * ou une erreur du flux — et les formules ci-dessus y divisent par zéro.
 */
export function formatDecimalOdds(decimal: number, format: OddsFormat): string {
  if (!Number.isFinite(decimal) || decimal <= 1) return "—";
  switch (format) {
    case "percent":  return `${Math.round(decimalToPct(decimal))}%`;
    case "american": return formatAmerican(decimalToAmerican(decimal));
    default:         return decimal.toFixed(2);
  }
}
