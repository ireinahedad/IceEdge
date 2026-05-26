import React, { createContext, useContext, useState, useCallback, useEffect } from "react";
import type { BetLeg } from "../types/bet";
import { predictionApiService } from "../services/predictionApiService";

interface BetContextValue {
  legs: BetLeg[];
  addLeg: (leg: BetLeg) => void;
  removeLeg: (id: string) => void;
  clearSlip: () => void;
  combinedProbability: number;
  hasLeg: (legId: string) => boolean;
}

const BetContext = createContext<BetContextValue | null>(null);

export function BetProvider({ children }: { children: React.ReactNode }) {
  const [legs, setLegs] = useState<BetLeg[]>([]);
  const [combinedProbability, setCombined] = useState(0); // ← useState, not useMemo

  useEffect(() => {
    if (legs.length === 0) { setCombined(0); return; }
    if (legs.length === 1) { setCombined(legs[0].probability); return; }

    predictionApiService.getParlayPrediction({
      legs: legs.map((l) => ({ marketType: l.marketType, probability: l.probability })),
    }).then((r) => setCombined(r.adjustedProbability));
  }, [legs]);

  const addLeg = useCallback((leg: BetLeg) => {
    setLegs((prev) => {
      if (prev.some((l) => l.id === leg.id)) return prev;
      return [...prev, leg];
    });
  }, []);

  const removeLeg = useCallback((id: string) => {
    setLegs((prev) => prev.filter((l) => l.id !== id));
  }, []);

  const clearSlip = useCallback(() => setLegs([]), []);

  const hasLeg = useCallback(
    (legId: string) => legs.some((l) => l.id === legId),
    [legs]
  );

  return (
    <BetContext.Provider
      value={{ legs, addLeg, removeLeg, clearSlip, combinedProbability, hasLeg }}
    >
      {children}
    </BetContext.Provider>
  );
}

export function useBet() {
  const ctx = useContext(BetContext);
  if (!ctx) throw new Error("useBet must be used within BetProvider");
  return ctx;
}