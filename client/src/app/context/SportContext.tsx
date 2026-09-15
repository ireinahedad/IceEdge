import { createContext, useContext, type ReactNode } from "react";

/**
 * Contexte de sport — mono-sport depuis le retrait du tennis (2026-08-24).
 *
 * Le tennis est sorti du produit : pages, service d'API, sélecteur de sport et
 * marchés sont partis. Le contexte, lui, reste : c'est lui qui porte le thème
 * (`bg`, `accent`, `gradientGlow`) que consomment la plupart des écrans. Le
 * supprimer aurait voulu dire disséminer ces trois constantes dans une vingtaine
 * de composants — beaucoup de churn pour aucun gain.
 *
 * Il n'y a donc plus de `setSport` : la valeur ne change plus. Si un deuxième
 * sport revient un jour, c'est ici qu'il se rebranche.
 */
export type Sport = "hockey";

export interface SportTheme {
  bg: string;
  accent: string;
  gradientGlow: string;
  sportIcon: string;
  sportLabel: string;
}

const SPORT_THEMES: Record<Sport, SportTheme> = {
  hockey: {
    bg: "#0A0E0C",
    accent: "#86d1ea",
    gradientGlow: "rgba(134,209,234,0.07)",
    sportIcon: "",
    sportLabel: "",
  },
};

interface SportContextType {
  sport: Sport;
  theme: SportTheme;
}

const SportContext = createContext<SportContextType | null>(null);

export function SportProvider({ children }: { children: ReactNode }) {
  return (
    <SportContext.Provider value={{ sport: "hockey", theme: SPORT_THEMES.hockey }}>
      {children}
    </SportContext.Provider>
  );
}

export function useSport(): SportContextType {
  const ctx = useContext(SportContext);
  if (!ctx) throw new Error("useSport must be used within SportProvider");
  return ctx;
}
