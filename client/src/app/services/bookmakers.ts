// services/bookmakers.ts
// Registry of supported sportsbooks + deep-link helpers.
//
// The user picks a sportsbook in Settings; the choice is stored in
// localStorage under BOOKMAKER_STORAGE_KEY. Click handlers call openBet()/
// openSignup(), which read the *current* selection at click time — so
// changing the sportsbook in Settings takes effect immediately, no reload.
//
// Affiliate codes are optional. Set them per-book via .env, e.g.
//   VITE_BET365_AFFILIATE_CODE=365_123456
//   VITE_STAKE_AFFILIATE_CODE=abcd1234
// Links work without a code — they're just untracked.

import { env } from "../env";
import { features } from "../platform";

export type Sport = "hockey";
export type BookmakerId = "bet365" | "stake" | "bet99";

export interface Bookmaker {
  id: BookmakerId;
  label: string;
  /** Short badge text shown on buttons */
  badge: string;
  base: string;
  affiliateCode?: string;
  /** Builds the affiliate query string for this book (given a non-empty code) */
  affiliateParam: (code: string) => string;
  /** Path to the section for a given sport */
  sectionPath: (sport: Sport) => string;
  /** Path to the sign-up / register page */
  signupPath: string;
  /**
   * Couleurs du bouton « Parier chez … » — celles du LIVRE, pour qu'on
   * reconnaisse d'un coup d'œil où le bouton envoie. Le bouton était peint aux
   * couleurs de bet365 quel que soit le livre choisi, donc « Stake » s'affichait
   * en vert et or (corrigé 2026-09-25).
   */
  colors: { bg: string; bgHover: string; fg: string; badgeBg: string; badgeFg: string };
}

const BET365: Bookmaker = {
  id: "bet365",
  label: "Bet365",
  badge: "b365",
  base: "https://www.bet365.com",
  affiliateCode: env.bet365AffiliateCode,
  affiliateParam: (code) => `?affiliate=${code}`,
  // Bet365 n'expose pas de lien par match stable : on ouvre la page du SPORT.
  // ⚠️ Corrigé le 2026-09-27 : l'ancien chemin `/#/IP/B18` ouvrait le direct du
  // BASKETBALL (B18) — le hockey sur glace est B17 chez Bet365. `AS` = la page
  // du sport (avant-match), pas le seul direct, qui est vide hors des matchs.
  sectionPath: () => "/#/AS/B17/",
  signupPath: "/#/OA/E/",
  colors: { bg: "#126e51", bgHover: "#0f5c44", fg: "#ffd700", badgeBg: "#ffd700", badgeFg: "#126e51" },
};

const STAKE: Bookmaker = {
  id: "stake",
  label: "Stake",
  badge: "STK",
  // Global domain (works for testing outside Canada). For Ontario use
  // "https://stake.com/en" -> "https://stake.ca". Change here if needed.
  base: "https://stake.com",
  affiliateCode: env.stakeAffiliateCode,
  // Stake tracks referrals with a campaign code: ?c=CODE
  affiliateParam: (code) => `?c=${code}`,
  // Page NHL (vérifiée le 2026-09-27 : liste les matchs de la ligue). Les
  // pages par match portent un identifiant Stake (`/nhl/46728042-…`) que
  // rien ne nous donne : on s'arrête à la ligue.
  sectionPath: () => "/sports/ice-hockey/usa/nhl",
  signupPath: "/?tab=register",
  // Bleu nuit de l'interface Stake, texte blanc, pastille au bleu de ses boutons.
  colors: { bg: "#1a2c38", bgHover: "#213743", fg: "#ffffff", badgeBg: "#1475e1", badgeFg: "#ffffff" },
};

/**
 * BET99 — ajouté le 2026-10-02 (demande du user). C'est le livre dont viennent
 * les cotes AFFICHÉES dans l'app (`ODDS_BOOKMAKERS=bet99_ca_on` côté serveur) :
 * l'utilisateur qui le choisit retrouve chez lui exactement le prix vu ici.
 *
 * Page LNH relevée par le user sur le site le 2026-10-02. `1590` est
 * l'identifiant de la ligue chez BET99 : s'il change un jour, le lien tombera
 * sur une page vide — recopier alors l'adresse de la page LNH depuis le site.
 * Pas de code affilié (le user n'en a pas) : `affiliateParam` ne sert pas.
 */
const BET99: Bookmaker = {
  id: "bet99",
  label: "BET99",
  badge: "B99",
  base: "https://bet99.com",
  affiliateCode: undefined,
  affiliateParam: (code) => `?btag=${code}`,
  sectionPath: () => "/en/sports/ice_hockey/usa/nhl/1590",
  signupPath: "/",
  // Noir et jaune de la marque.
  colors: { bg: "#111111", bgHover: "#222222", fg: "#ffd200", badgeBg: "#ffd200", badgeFg: "#111111" },
};

export const BOOKMAKERS: Record<BookmakerId, Bookmaker> = {
  bet365: BET365,
  stake: STAKE,
  bet99: BET99,
};

/** Ordered list for rendering selectors */
export const BOOKMAKER_LIST: Bookmaker[] = [BET365, STAKE, BET99];

const BOOKMAKER_STORAGE_KEY = "iceedge_bookmaker";
const DEFAULT_BOOKMAKER: BookmakerId = "bet365";

function isBookmakerId(v: unknown): v is BookmakerId {
  return typeof v === "string" && v in BOOKMAKERS;
}

/** Read the currently selected sportsbook from localStorage (falls back to default). */
export function getSelectedBookmakerId(): BookmakerId {
  try {
    const stored = localStorage.getItem(BOOKMAKER_STORAGE_KEY);
    if (isBookmakerId(stored)) return stored;
  } catch {
    /* ignore */
  }
  return DEFAULT_BOOKMAKER;
}

function getSelectedBookmaker(): Bookmaker {
  return BOOKMAKERS[getSelectedBookmakerId()];
}

export function setSelectedBookmakerId(id: BookmakerId): void {
  try {
    localStorage.setItem(BOOKMAKER_STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}

/** Build a full URL for a book + path, appending the affiliate code if set. */
function buildBookmakerUrl(book: Bookmaker, path = ""): string {
  const affiliate = book.affiliateCode ? book.affiliateParam(book.affiliateCode) : "";
  return `${book.base}${path}${affiliate}`;
}

function openUrl(url: string): void {
  // APPLE_PLAN §4 — Guideline 5.3. Every entry point is already hidden on
  // iOS; this is the second line of defence, so a call site added later
  // cannot quietly re-open a sportsbook from inside the app.
  if (!features.bookmakerLinks) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Open the selected sportsbook's section for a sport in a new tab. */
export function openBet(sport: Sport): void {
  const book = getSelectedBookmaker();
  openUrl(buildBookmakerUrl(book, book.sectionPath(sport)));
}

