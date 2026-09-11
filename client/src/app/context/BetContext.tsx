import React, { createContext, useContext, useState, useCallback, useEffect, useMemo } from "react";
import type { BetLeg } from "../types/bet";

interface BetContextValue {
  legs: BetLeg[];
  addLeg: (leg: BetLeg) => void;
  removeLeg: (id: string) => void;
  clearSlip: () => void;
  /**
   * Probabilité du coupon, en pourcentage.
   *
   * `null` ne veut plus dire « le service n'a pas répondu » (il n'y a plus de
   * service, voir `combineLegs` plus bas) mais « au moins une jambe porte une
   * probabilité inexploitable ». Les écrans qui affichaient « — » et
   * `pred.unavailableParlay` continuent donc de dire quelque chose de vrai.
   */
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

// ─── Probabilité combinée ─────────────────────────────────────────────────────
//
// Jusqu'au 2026-09-11, chaque ajout ou retrait de jambe déclenchait un
// `POST /api/predict/parlay`. Le commentaire d'alors disait que multiplier côté
// client « supposerait l'indépendance des jambes » — or c'est exactement ce que
// le serveur faisait, et rien d'autre (`server/src/routes/ml.routes.ts`) :
//
//     const combined = legs.reduce((acc, l) => acc * (l.probability / 100), 1) * 100;
//     const adjusted = combined * 0.95;
//
// Aucune donnée n'était lue, aucune corrélation calculée. Le voyage réseau
// n'achetait donc rien : même formule, plus la latence, plus la batterie, plus
// un état de chargement — et sur iPhone un chiffre qui arrivait après le geste,
// ou pas du tout en tunnel. (Audit pré-freeze iOS, § 5.)
//
// ⚠️ Ce qui suit est une COPIE de la formule du serveur, arrondi compris. La
// route `/predict/parlay` reste en place et inchangée : si elle implémente un
// jour une vraie corrélation — l'autre branche que l'audit laissait ouverte —
// c'est ce bloc qu'il faudra rebasculer sur le réseau, pas son coefficient
// qu'il faudra recopier ici.
//
// Le `0.95` reste ce qu'il était : un abattement forfaitaire, pas un modèle.

const PARLAY_HAIRCUT = 0.95;

function combineLegs(legs: BetLeg[]): number | null {
  if (legs.length === 0) return 0;

  // Une probabilité illisible (jambe relue d'un vieux coupon, carte à moitié
  // chargée) doit donner « — » et non `NaN%` affiché en gros à l'écran.
  if (legs.some((l) => !Number.isFinite(l.probability))) return null;

  // Une jambe unique n'est pas un parlay : pas d'abattement, pas d'arrondi.
  // C'est le comportement d'avant, qui court-circuitait déjà l'appel réseau.
  if (legs.length === 1) return legs[0].probability;

  const combined = legs.reduce((acc, l) => acc * (l.probability / 100), 1) * 100;
  // L'arrondi porte sur le produit NON arrondi, comme côté serveur — arrondir
  // en deux temps donnerait un chiffre différent du sien sur certains coupons.
  return Math.round(combined * PARLAY_HAIRCUT * 10) / 10;
}

export function BetProvider({ children }: { children: React.ReactNode }) {
  // Initialiseur paresseux : la relecture n'a lieu qu'au premier rendu.
  const [legs, setLegs] = useState<BetLeg[]>(loadSlip);

  // Un calcul, pas un appel réseau. Voir `combineLegs`.
  const combinedProbability = useMemo(() => combineLegs(legs), [legs]);

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