import React, { createContext, useContext, useState, useCallback, useEffect } from "react";
import type { BetLeg } from "../types/bet";
import { predictionApiService } from "../services/predictionApiService";

interface BetContextValue {
  legs: BetLeg[];
  addLeg: (leg: BetLeg) => void;
  removeLeg: (id: string) => void;
  clearSlip: () => void;
  combinedProbability: number | null;
  hasLeg: (legId: string) => boolean;
}

const BetContext = createContext<BetContextValue | null>(null);

// ─── Persistance du coupon ────────────────────────────────────────────────────
//
// iOS purge régulièrement les WKWebView en arrière-plan : sans ça, quelqu'un
// qui construit un coupon à cinq jambes, reçoit un appel et revient repart de
// zéro. Sur le web un simple rechargement suffisait aussi à tout perdre.
//
// `localStorage` et pas `@capacitor/preferences` : ce dernier n'est pas dans
// `package.json` et relève de la phase 3. localStorage fonctionne dans la
// WKWebView — iOS peut le purger sous pression de stockage, ce qui est
// exactement le cas que le TTL couvre déjà.

const SLIP_KEY = "iceedge_slip";

/**
 * 12 heures, mesurées depuis la jambe la plus récemment ajoutée.
 *
 * Ce n'est pas une garantie de fraîcheur — les cotes et les probabilités
 * dorment avec le coupon, et c'est le serveur qui valide au verrouillage. C'est
 * une limite de bon sens : douze heures couvrent une soirée interrompue, pas un
 * coupon d'avant-hier dont tous les matchs sont joués.
 */
const SLIP_TTL_MS = 12 * 60 * 60 * 1000;

function loadSlip(): BetLeg[] {
  try {
    const raw = localStorage.getItem(SLIP_KEY);
    if (!raw) return [];

    const saved = JSON.parse(raw) as { v?: number; legs?: unknown };
    // Un `v` inconnu vient d'une version où `BetLeg` avait une autre forme :
    // on jette, on ne devine pas.
    if (saved?.v !== 1 || !Array.isArray(saved.legs)) return [];

    // Ce qui est relu vient du disque de quelqu'un d'autre que nous : on ne
    // garde que ce qui a la forme attendue, plutôt que de laisser un `undefined`
    // exploser au rendu d'une carte de jambe.
    const legs = (saved.legs as unknown[]).filter((l): l is BetLeg => {
      const x = l as Partial<BetLeg> | null;
      return !!x
        && typeof x.id === "string"
        && typeof x.marketType === "string"
        && typeof x.probability === "number"
        && typeof x.addedAt === "string";
    });
    if (legs.length === 0) return [];

    const derniereJambe = Math.max(...legs.map((l) => new Date(l.addedAt).getTime()));
    if (!Number.isFinite(derniereJambe) || Date.now() - derniereJambe > SLIP_TTL_MS) return [];

    return legs;
  } catch {
    // JSON cassé, navigation privée Safari, stockage refusé : le coupon repart
    // vide, ce qui est le comportement d'avant. Jamais une page blanche.
    return [];
  }
}

export function BetProvider({ children }: { children: React.ReactNode }) {
  // Initialiseur paresseux : la relecture n'a lieu qu'au premier rendu.
  const [legs, setLegs] = useState<BetLeg[]>(loadSlip);
  // `null` = le service de parlay n'a pas répondu. Multiplier les jambes
  // côté client supposerait leur indépendance et surestimerait le coupon.
  const [combinedProbability, setCombined] = useState<number | null>(0); // ← useState, not useMemo

  useEffect(() => {
    if (legs.length === 0) { setCombined(0); return; }
    if (legs.length === 1) { setCombined(legs[0].probability); return; }

    let alive = true;
    predictionApiService.getParlayPrediction({
      legs: legs.map((l) => ({ marketType: l.marketType, probability: l.probability })),
    })
      .then((r) => { if (alive) setCombined(r.adjustedProbability); })
      .catch(() => { if (alive) setCombined(null); });
    return () => { alive = false; };
  }, [legs]);

  // Un coupon vide n'est pas un coupon sauvegardé : on retire la clé plutôt
  // que d'y laisser un tableau vide qui survivrait au TTL.
  useEffect(() => {
    try {
      if (legs.length === 0) localStorage.removeItem(SLIP_KEY);
      else localStorage.setItem(SLIP_KEY, JSON.stringify({ v: 1, legs }));
    } catch {
      // Stockage plein ou refusé : le coupon continue de vivre en mémoire,
      // il ne survivra simplement pas à la mise en arrière-plan.
    }
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