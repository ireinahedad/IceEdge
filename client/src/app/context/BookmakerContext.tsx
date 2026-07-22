import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import {
  BOOKMAKERS,
  BOOKMAKER_LIST,
  getSelectedBookmakerId,
  setSelectedBookmakerId,
  type Bookmaker,
  type BookmakerId,
} from "../services/bookmakers";

interface BookmakerContextType {
  /** Currently selected sportsbook id */
  bookmakerId: BookmakerId;
  /** Full config for the selected sportsbook */
  bookmaker: Bookmaker;
  /** Change the selected sportsbook (also persisted to localStorage) */
  setBookmakerId: (id: BookmakerId) => void;
  /** All sportsbooks, for rendering a selector */
  bookmakers: Bookmaker[];
}

const BookmakerContext = createContext<BookmakerContextType | null>(null);

export function BookmakerProvider({ children }: { children: ReactNode }) {
  const [bookmakerId, setId] = useState<BookmakerId>(() => getSelectedBookmakerId());

  const setBookmakerId = useCallback((id: BookmakerId) => {
    setId(id);
    setSelectedBookmakerId(id);
  }, []);

  return (
    <BookmakerContext.Provider
      value={{
        bookmakerId,
        bookmaker: BOOKMAKERS[bookmakerId],
        setBookmakerId,
        bookmakers: BOOKMAKER_LIST,
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
