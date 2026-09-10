import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import {
  ODDS_FORMAT_IDS,
  formatDecimalOdds,
  getSelectedOddsFormat,
  setSelectedOddsFormat,
  type OddsFormat,
} from "../services/oddsFormat";

/**
 * Le format d'écriture des COTES DE BOOKMAKER, partagé par toute l'app.
 *
 * Calqué sur `BookmakerContext` : même forme (état + setter qui persiste), même
 * raison d'être en contexte plutôt qu'en lecture directe de localStorage — un
 * changement dans les Réglages doit se voir immédiatement sur tous les écrans
 * montés, sans rechargement.
 *
 * ⚠️⚠️ **Ce contexte n'expose délibérément AUCUN moyen de formater une
 * probabilité du modèle.** Ce n'est pas un oubli : une probabilité de modèle est
 * une mesure de confiance, pas un prix, et doit rester en % partout (voir le
 * long commentaire de `services/oddsFormat.ts`). Une fonction `prob()` a existé
 * ici et a été retirée le 2026-09-10 — elle rendait l'erreur facile, son absence
 * la rend impossible. Si tu es en train d'en réécrire une, relis d'abord ce
 * commentaire : ce que tu veux afficher est probablement un `{pct}%`.
 */
interface OddsFormatContextType {
  /** Format actuellement choisi */
  format: OddsFormat;
  /** Change le format (persisté en localStorage) */
  setFormat: (format: OddsFormat) => void;
  /** Tous les formats, pour dessiner un sélecteur */
  formats: OddsFormat[];
  /** Écrit une cote de bookmaker, reçue en décimal, dans le format courant */
  odds: (decimal: number) => string;
}

const OddsFormatContext = createContext<OddsFormatContextType | null>(null);

export function OddsFormatProvider({ children }: { children: ReactNode }) {
  const [format, setFormatState] = useState<OddsFormat>(() => getSelectedOddsFormat());

  const setFormat = useCallback((next: OddsFormat) => {
    setFormatState(next);
    setSelectedOddsFormat(next);
  }, []);

  const odds = useCallback((decimal: number) => formatDecimalOdds(decimal, format), [format]);

  const value = useMemo<OddsFormatContextType>(
    () => ({ format, setFormat, formats: ODDS_FORMAT_IDS, odds }),
    [format, setFormat, odds],
  );

  return <OddsFormatContext.Provider value={value}>{children}</OddsFormatContext.Provider>;
}

export function useOddsFormat(): OddsFormatContextType {
  const ctx = useContext(OddsFormatContext);
  if (!ctx) throw new Error("useOddsFormat must be used within OddsFormatProvider");
  return ctx;
}
