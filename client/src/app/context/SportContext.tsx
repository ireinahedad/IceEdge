import { createContext, useContext, useState, type ReactNode } from "react";

export type Sport = "hockey" | "tennis";

export interface SportTheme {
  bg: string;
  accent: string;
  gradientGlow: string;
  sportIcon: string;
  sportLabel: string;
}

export const SPORT_THEMES: Record<Sport, SportTheme> = {
  hockey: {
    bg: "#0A0E0C",
    accent: "#86d1ea",
    gradientGlow: "rgba(134,209,234,0.07)",
    sportIcon: "",
    sportLabel: "",
  },
  tennis: {
    bg: "#0a1209",
    accent: "#a8e060",
    gradientGlow: "rgba(168,224,96,0.07)",
    sportIcon: "T",
    sportLabel: "Tennis",
  },
};

interface SportContextType {
  sport: Sport;
  setSport: (s: Sport) => void;
  theme: SportTheme;
}

const SportContext = createContext<SportContextType | null>(null);

export function SportProvider({ children }: { children: ReactNode }) {
  const [sport, setSport] = useState<Sport>("hockey");
  return (
    <SportContext.Provider value={{ sport, setSport, theme: SPORT_THEMES[sport] }}>
      {children}
    </SportContext.Provider>
  );
}

export function useSport(): SportContextType {
  const ctx = useContext(SportContext);
  if (!ctx) throw new Error("useSport must be used within SportProvider");
  return ctx;
}
