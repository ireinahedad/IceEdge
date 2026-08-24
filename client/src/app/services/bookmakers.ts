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

export type Sport = "hockey";
export type BookmakerId = "bet365" | "stake";

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
}

const BET365: Bookmaker = {
  id: "bet365",
  label: "Bet365",
  badge: "b365",
  base: "https://www.bet365.com",
  affiliateCode: import.meta.env.VITE_BET365_AFFILIATE_CODE as string | undefined,
  affiliateParam: (code) => `?affiliate=${code}`,
  // Bet365 doesn't expose clean per-match deep links publicly, so we link to
  // the in-play section for the sport.
  sectionPath: () => "/#/IP/B18",
  signupPath: "/#/OA/E/",
};

const STAKE: Bookmaker = {
  id: "stake",
  label: "Stake",
  badge: "STK",
  // Global domain (works for testing outside Canada). For Ontario use
  // "https://stake.com/en" -> "https://stake.ca". Change here if needed.
  base: "https://stake.com",
  affiliateCode: import.meta.env.VITE_STAKE_AFFILIATE_CODE as string | undefined,
  // Stake tracks referrals with a campaign code: ?c=CODE
  affiliateParam: (code) => `?c=${code}`,
  sectionPath: () => "/sports/ice-hockey",
  signupPath: "/?tab=register",
};

export const BOOKMAKERS: Record<BookmakerId, Bookmaker> = {
  bet365: BET365,
  stake: STAKE,
};

/** Ordered list for rendering selectors */
export const BOOKMAKER_LIST: Bookmaker[] = [BET365, STAKE];

export const BOOKMAKER_STORAGE_KEY = "iceedge_bookmaker";
const DEFAULT_BOOKMAKER: BookmakerId = "bet365";

export function isBookmakerId(v: unknown): v is BookmakerId {
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

export function getSelectedBookmaker(): Bookmaker {
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
export function buildBookmakerUrl(book: Bookmaker, path = ""): string {
  const affiliate = book.affiliateCode ? book.affiliateParam(book.affiliateCode) : "";
  return `${book.base}${path}${affiliate}`;
}

function openUrl(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Open the selected sportsbook's section for a sport in a new tab. */
export function openBet(sport: Sport): void {
  const book = getSelectedBookmaker();
  openUrl(buildBookmakerUrl(book, book.sectionPath(sport)));
}

/** Open the selected sportsbook's sign-up page in a new tab. */
export function openSignup(): void {
  const book = getSelectedBookmaker();
  openUrl(buildBookmakerUrl(book, book.signupPath));
}
