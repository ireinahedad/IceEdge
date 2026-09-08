import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import {
  ODDS_FORMAT_IDS,
  formatDecimalOdds,
  formatProbability,
  getSelectedOddsFormat,
  setSelectedOddsFormat,
  type OddsFormat,
} from "../services/oddsFormat";

/**
 * Le format d'affichage des cotes, partagé par toute l'app.
 *
 * Calqué sur `BookmakerContext` : même forme (état + setter qui persiste), même
 * raison d'être en contexte plutôt qu'en lecture directe de localStorage — un
 * changement dans les Paramètres doit se voir immédiatement sur tous les écrans
 * montés, sans rechargement.
 *
 * `prob` et `odds` sont exposés déjà liés au format courant pour que les écrans
 * n'aient jamais à faire un `switch` sur le format : un `switch` recopié dans
 * quinze fichiers finit par diverger, et c'est exactement ce que ce réglage doit
 * éviter. Voir `services/oddsFormat.ts` pour ce que chacun convertit.
 */
interface OddsFormatContextType {
  /** Format actuellement choisi */
  format: OddsFormat;
  /** Change le format (persisté en localStorage) */
  setFormat: (format: OddsFormat) => void;
  /** Tous les formats, pour dessiner un sélecteur */
  formats: OddsFormat[];
  /**
   * Écrit une probabilité de sélection (0-100) dans le format courant.
   * `decimals` n'agit qu'en % ; omis, le nombre part tel quel (voir
   * `formatProbability`).
   */
  prob: (pct: number, decimals?: number) => string;
  /** Écrit une cote de bookmaker reçue en décimal dans le format courant */
  odds: (decimal: number) => string;
}

const OddsFormatContext = createContext<OddsFormatContextType | null>(null);

export function OddsFormatProvider({ children }: { children: ReactNode }) {
  const [format, setFormatState] = useState<OddsFormat>(() => getSelectedOddsFormat());

  const setFormat = useCallback((next: OddsFormat) => {
    setFormatState(next);
    setSelectedOddsFormat(next);
  }, []);

  const prob = useCallback(
    (pct: number, decimals?: number) => formatProbability(pct, format, decimals),
    [format],
  );
  const odds = useCallback((decimal: number) => formatDecimalOdds(decimal, format), [format]);

  const value = useMemo<OddsFormatContextType>(
    () => ({ format, setFormat, formats: ODDS_FORMAT_IDS, prob, odds }),
    [format, setFormat, prob, odds],
  );

  return <OddsFormatContext.Provider value={value}>{children}</OddsFormatContext.Provider>;
}

export function useOddsFormat(): OddsFormatContextType {
  const ctx = useContext(OddsFormatContext);
  if (!ctx) throw new Error("useOddsFormat must be used within OddsFormatProvider");
  return ctx;
}
