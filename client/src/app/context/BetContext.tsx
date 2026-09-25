import React, { createContext, useContext, useState, useCallback, useEffect, useMemo } from "react";
// Même module que la route serveur, importé tel quel : voir l'en-tête de parlay.ts.
import { combineParlayLegs } from "../../../../server/src/services/parlay";
import { predictionApiService } from "../services/predictionApiService";
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
  /**
   * Ce que `parlay.ts` a VU en combinant les jambes.
   *
   * Il le calculait déjà et on le jetait : l'écran n'avait aucun moyen de dire
   * pourquoi un coupon tombe à 0 %, ni qu'une jambe venait de disparaître du
   * calcul. Un chiffre juste et inexplicable ne vaut pas mieux qu'un chiffre
   * faux — cf. `SlipNotices` dans `bet/betParts.tsx`.
   */
  slipAnalysis: SlipAnalysis;
  hasLeg: (legId: string) => boolean;
}

/** Version « à afficher » de `ParlayResult` : trois faits, pas les jambes. */
export interface SlipAnalysis {
  /** Deux jambes s'excluent : la combinaison ne peut PAS se produire. */
  impossible: boolean;
  /** Jambes retirées du calcul parce que dupliquées ou déjà impliquées. */
  redundantLegs: number;
  /**
   * Le chiffre AFFICHÉ suppose une indépendance qu'on sait fausse : des jambes
   * partagent un match sans relation logique connue ET le serveur n'a pas
   * raffiné. Faux dès que le raffinement arrive — l'écran n'a donc pas à
   * connaître l'existence de cet appel.
   */
  assumesIndependence: boolean;
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
// le serveur faisait, et rien d'autre. Le voyage réseau n'achetait donc rien :
// même formule, plus la latence, plus la batterie, plus un état de chargement.
// (Audit pré-freeze iOS, § 5.)
//
// Ce qui a changé le 2026-09-13 : la formule elle-même était fausse. Multiplier
// « domicile gagne » par « extérieur gagne » sur le même match donnait 22,8 %
// pour un événement impossible. Le calcul vit maintenant dans `server/src/services/parlay.ts`,
// qui reconnaît les jambes incompatibles, dupliquées et impliquées.
//
// Il reste LOCAL : il ne raisonne que sur l'identité des jambes, sans lire une
// seule donnée serveur. Le coupon continue donc de se recalculer hors ligne,
// instantanément — on a corrigé le chiffre sans reprendre la latence.
//
// Le `0.95` a disparu : c'était un abattement forfaitaire, pas un modèle, et il
// tirait dans le mauvais sens sur les jambes d'un même match.

function combineLegs(legs: BetLeg[]): number | null {
  if (legs.length === 0) return 0;

  // Une probabilité illisible (jambe relue d'un vieux coupon, carte à moitié
  // chargée) doit donner « — » et non `NaN%` affiché en gros à l'écran.
  if (legs.some((l) => !Number.isFinite(l.probability))) return null;

  // Une jambe unique n'est pas un parlay : pas d'arrondi, pas de combinaison.
  if (legs.length === 1) return legs[0].probability;

  const r = combineParlayLegs(legs.map((l) => ({
    marketType:     l.marketType,
    probability:    l.probability,
    gameId:         l.gameId,
    selectionValue: l.selectionValue,
    line:           l.line,
  })));

  if (!Number.isFinite(r.probability)) return null;
  return Math.round(r.probability * 10) / 10;
}

/** Détail des relations entre jambes — pour que le coupon puisse s'expliquer. */
function analyseSlip(legs: BetLeg[]) {
  return combineParlayLegs(legs.map((l) => ({
    marketType:     l.marketType,
    probability:    l.probability,
    gameId:         l.gameId,
    selectionValue: l.selectionValue,
    line:           l.line,
  })));
}

export function BetProvider({ children }: { children: React.ReactNode }) {
  // Initialiseur paresseux : la relecture n'a lieu qu'au premier rendu.
  const [legs, setLegs] = useState<BetLeg[]>(loadSlip);

  // Valeur LOCALE, immédiate, hors ligne. Voir `combineLegs`.
  const localProbability = useMemo(() => combineLegs(legs), [legs]);

  // Deuxième passage sur les mêmes jambes, volontairement : `combineLegs` rend
  // un nombre et rien d'autre, et le découper pour en extraire aussi les
  // relations toucherait à ses trois cas particuliers (0 jambe, 1 jambe,
  // probabilité illisible). Sur douze jambes au maximum, ça ne se mesure pas.
  const analysis = useMemo(() => analyseSlip(legs), [legs]);

  // ── Raffinement réseau, uniquement quand il change quelque chose ──────────
  //
  // Le calcul local règle tout ce qui est logique — incompatibilité, doublon,
  // implication — sans rien demander à personne. Ce qu'il ne peut pas faire,
  // c'est chiffrer la CORRÉLATION de deux jambes d'un même match : « le
  // domicile gagne » et « plus de 5,5 buts » ne s'excluent ni ne s'impliquent,
  // mais ils vont dans le même sens, et les multiplier sous-estime le coupon.
  // Ça demande la loi jointe des scores, donc les données du serveur.
  //
  // L'appel n'est donc PAS systématique : il ne part que si le coupon contient
  // au moins deux jambes du même match, ce qui est rare. Un coupon ordinaire
  // reste instantané et fonctionne en tunnel, comme depuis le 2026-09-11 — on
  // paye le réseau exactement là où il achète quelque chose.
  const [refined, setRefined] = useState<number | null>(null);
  const sameGame = useMemo(() => {
    const seen = new Map<string, number>();
    for (const l of legs) {
      if (!l.gameId) continue;
      seen.set(l.gameId, (seen.get(l.gameId) ?? 0) + 1);
    }
    return [...seen.values()].some((n) => n > 1);
  }, [legs]);

  useEffect(() => {
    setRefined(null);
    if (!sameGame || legs.length < 2) return;
    let alive = true;
    predictionApiService
      .getParlayPrediction({
        legs: legs.map((l) => ({
          marketType: l.marketType,
          probability: l.probability,
          gameId: l.gameId,
          selection: l.selectionValue,
          line: l.line,
          teamId: l.subjectId,
          opponentId: l.opponentId,
          isHome: l.isHome,
        })),
      })
      // Le serveur peut dire « je n'ai pas pu » : on garde alors le local.
      .then((r) => { if (alive && typeof r.adjustedProbability === "number") setRefined(r.adjustedProbability); })
      .catch(() => { /* hors ligne : le chiffre local reste affiché */ });
    return () => { alive = false; };
  }, [legs, sameGame]);

  // Le local s'affiche tout de suite ; le raffiné le remplace s'il arrive.
  const combinedProbability = refined ?? localProbability;

  // `assumesIndependence` est rabattu à faux dès que le raffinement est arrivé :
  // l'avertissement porte sur le chiffre QU'ON MONTRE, pas sur le calcul local
  // qu'il vient de remplacer.
  const slipAnalysis = useMemo<SlipAnalysis>(() => ({
    impossible:          analysis.impossible,
    redundantLegs:       analysis.redundantLegs,
    assumesIndependence: analysis.assumesIndependence && refined == null,
  }), [analysis, refined]);

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
    // Sans match, le serveur refuse le coupon (`legSettlementProblem`) : mieux
    // vaut que le chemin fautif se signale ici, à l'ajout, qu'au dépôt.
    if (!leg.gameId) {
      console.error("[BetContext] jambe refusée : pas de gameId, elle ne pourrait jamais être réglée", leg);
      return;
    }
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
      value={{ legs, addLeg, removeLeg, clearSlip, combinedProbability, slipAnalysis, hasLeg }}
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