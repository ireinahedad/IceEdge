/**
 * foldAll.tsx — plier / déplier les sections de la page Prédiction
 * (2026-10-13, demande du user).
 *
 * Chaque section (H2H, groupes de marchés, grilles joueur, Top 90 % +) se plie
 * d'un tap sur son en-tête, et l'état est gardé en mémoire (`useFoldState`) :
 * on retrouve la page comme on l'a laissée.
 *
 * Le bouton « Tout plier / Tout déplier » de l'en-tête de page n'impose pas un
 * état partagé : il émet un SIGNAL (`seq` incrémenté) que chaque section
 * applique à son propre état. Une section repliée à la main après coup reste
 * donc indépendante, et rien ne se replie tout seul à l'ouverture de la page.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useFoldState } from "../../hooks/useFoldState";

interface FoldAllValue {
  /** Dernier ordre global ; `seq` à 0 = aucun ordre depuis l'ouverture. */
  signal: { seq: number; collapsed: boolean };
  /** `true` si le dernier ordre global était « tout plier ». */
  allCollapsed: boolean;
  foldAll: (collapsed: boolean) => void;
}

const FoldAllCtx = createContext<FoldAllValue>({
  signal: { seq: 0, collapsed: false },
  allCollapsed: false,
  foldAll: () => {},
});

export function FoldAllProvider({ children }: { children: ReactNode }) {
  const [signal, setSignal] = useState({ seq: 0, collapsed: false });
  const foldAll = useCallback((collapsed: boolean) => {
    setSignal(s => ({ seq: s.seq + 1, collapsed }));
  }, []);
  const value = useMemo(
    () => ({ signal, allCollapsed: signal.seq > 0 && signal.collapsed, foldAll }),
    [signal, foldAll],
  );
  return <FoldAllCtx.Provider value={value}>{children}</FoldAllCtx.Provider>;
}

export function useFoldAll() {
  return useContext(FoldAllCtx);
}

/**
 * État plié d'UNE section de la page Prédiction : mémorisé (clé préfixée
 * `pred.`) et soumis au « tout plier / tout déplier ».
 *
 * Renvoie `[collapsed, toggle]`.
 */
export function useSectionFold(key: string, defaultCollapsed = false): [boolean, () => void] {
  const [collapsed, toggle, set] = useFoldState(`pred.${key}`, defaultCollapsed);
  const { signal } = useContext(FoldAllCtx);
  // Seul un NOUVEL ordre s'applique : une section montée après coup (groupe
  // arrivé avec la réponse du serveur) ne rejoue pas l'ordre précédent.
  const seen = useRef(signal.seq);
  useEffect(() => {
    if (signal.seq === seen.current) return;
    seen.current = signal.seq;
    set(signal.collapsed);
  }, [signal, set]);
  return [collapsed, toggle];
}
