import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import {
  BOOKMAKERS,
  BOOKMAKER_LIST,
  getSelectedBookmakerId,
  openBet,
  setSelectedBookmakerId,
  type Bookmaker,
  type BookmakerId,
} from "../services/bookmakers";
import { features } from "../platform";

/**
 * Ce que l'utilisateur doit retrouver chez SON livre (2026-10-02).
 *
 * Bet365 n'expose aucun lien vers un match ou un pari précis (ses adresses
 * internes changent, et The Odds API ne le cote pas en LNH) : l'app ne peut
 * ouvrir que sa page hockey. Décision du user : avant de l'ouvrir, on montre
 * le match, le marché, la sélection et la cote minimale, pour qu'il retrouve le
 * pari en deux touches. Voir `components/BetHandoffSheet.tsx`.
 */
export interface BetTicket {
  /** « MTL @ TOR » — visiteur @ domicile, comme les livres l'écrivent. */
  match: string;
  /** Heure ou jour de la mise au jeu, quand on la connaît. */
  when?: string | null;
  /** Le marché tel que le livre le range (« Vainqueur », « Puck line »…) ; absent si la sélection le dit déjà. */
  market?: string | null;
  /** Ce qu'on prend : « MTL −1.5 », « TOR gagne ». */
  selection: string;
  /** Seuil de rentabilité selon notre probabilité (1 / p), en décimal. */
  minOdds?: number | null;
  /** Le prix vu dans l'app, et le livre qui le propose (pas forcément le sien). */
  shownPrice?: number | null;
  shownBook?: string | null;
}

/** Seuil de rentabilité d'une probabilité en % (0–100), ou null si illisible. */
export function minOddsFromPct(pct: number | null | undefined): number | null {
  return typeof pct === "number" && pct > 0 && pct < 100 ? 100 / pct : null;
}

interface BookmakerContextType {
  /** Currently selected sportsbook id */
  bookmakerId: BookmakerId;
  /** Full config for the selected sportsbook */
  bookmaker: Bookmaker;
  /** Change the selected sportsbook (also persisted to localStorage) */
  setBookmakerId: (id: BookmakerId) => void;
  /** All sportsbooks, for rendering a selector */
  bookmakers: Bookmaker[];
  /**
   * Aller parier. Avec un ticket : la fiche « à chercher chez ton livre »
   * s'ouvre d'abord. Sans ticket : le livre s'ouvre directement, comme avant.
   * Ne fait rien là où les liens sortants sont coupés (iOS, Guideline 5.3).
   */
  openBetFor: (ticket?: BetTicket | null) => void;
  /** Le ticket affiché par `BetHandoffHost`, ou null. */
  ticket: BetTicket | null;
  closeTicket: () => void;
}

const BookmakerContext = createContext<BookmakerContextType | null>(null);

export function BookmakerProvider({ children }: { children: ReactNode }) {
  const [bookmakerId, setId] = useState<BookmakerId>(() => getSelectedBookmakerId());

  const setBookmakerId = useCallback((id: BookmakerId) => {
    setId(id);
    setSelectedBookmakerId(id);
  }, []);

  const [ticket, setTicket] = useState<BetTicket | null>(null);
  const openBetFor = useCallback((next?: BetTicket | null) => {
    if (!features.bookmakerLinks) return;
    if (next) setTicket(next);
    else openBet("hockey");
  }, []);
  const closeTicket = useCallback(() => setTicket(null), []);

  return (
    <BookmakerContext.Provider
      value={{
        bookmakerId,
        bookmaker: BOOKMAKERS[bookmakerId],
        setBookmakerId,
        bookmakers: BOOKMAKER_LIST,
        openBetFor,
        ticket,
        closeTicket,
      }}
    >
      {children}
    </BookmakerContext.Provider>
  );
}

export function useBookmaker(): BookmakerContextType {
  const ctx = useContext(BookmakerContext);
  if (!ctx) throw new Error("useBookmaker must be used within BookmakerProvider");
  return ctx;
}
