/**
 * topBetsRegistry.tsx — registre des paris de la page Prédiction, lu par la
 * section « Top 90% + » (`topBets.tsx`). Fichier à part pour que
 * `PredictionSheet` puisse s'y enregistrer sans import circulaire.
 *
 * Deux contextes, pas un : les producteurs ne lisent que la fonction
 * d'enregistrement (stable). Sans cette séparation, chaque enregistrement
 * re-rendrait les producteurs, qui recréeraient leurs options (les pages
 * Équipe et Joueur ne les mémoïsent pas), qui se réenregistreraient… en boucle.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { BetOpt } from "./gameMarkets";

type Register = (key: string, opts: BetOpt[] | null) => void;

const RegisterCtx = createContext<Register>(() => {});
export const TopBetsDataCtx = createContext<Record<string, BetOpt[]>>({});

export function TopBetsProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Record<string, BetOpt[]>>({});
  const register = useCallback<Register>((key, opts) => {
    setData(d => {
      if (opts == null) {
        if (!(key in d)) return d;
        const { [key]: _gone, ...rest } = d;
        return rest;
      }
      return d[key] === opts ? d : { ...d, [key]: opts };
    });
  }, []);
  return (
    <RegisterCtx.Provider value={register}>
      <TopBetsDataCtx.Provider value={data}>{children}</TopBetsDataCtx.Provider>
    </RegisterCtx.Provider>
  );
}

/** Déclare les options d'un producteur sous `key` ; retirées au démontage. */
export function useRegisterTopBets(key: string, opts: BetOpt[]) {
  const register = useContext(RegisterCtx);
  useEffect(() => { register(key, opts); }, [register, key, opts]);
  useEffect(() => () => register(key, null), [register, key]);
}
