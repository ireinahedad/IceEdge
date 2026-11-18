/**
 * experiments.ts — tests A/B maison (2026-11-18, demande du user).
 *
 * Chaque visiteur reçoit une variante au hasard, gardée dans localStorage pour
 * qu'il voie toujours la même. La variante est posée en balise Clarity
 * (`exp_<nom>`) : dans Clarity, filtrer par cette balise puis comparer les
 * événements de conversion (`pro_*_click`, `pro_page_view`) entre A et B.
 *
 * Pour arrêter un test : retirer son appel `useVariant`, ou forcer la variante
 * gagnante dans `FORCED`. Pour se voir dans une variante : `?exp_<nom>=B`.
 *
 * Tests en cours :
 *   pro_position  A = carte Pro en bas de l'accueil (avant)
 *                 B = carte Pro compacte tout en haut, sous les équipes
 *   pro_cta       A = boutons Pro de l'accueil « Passer à Pro » (avant)
 *                 B = « Essai Pro gratuit · 7 jours » + « Sans carte bancaire »
 *                 (seulement si l'essai est encore possible pour ce visiteur)
 *   Les deux tirages sont indépendants : comparer un test à la fois dans Clarity.
 */

import { useSubscription } from "./context/SubscriptionContext";

import { useMemo } from "react";

type Variant = "A" | "B";
const FORCED: Record<string, Variant> = {};

function clarityTag(name: string, v: Variant) {
  const c = (window as { clarity?: (...a: unknown[]) => void }).clarity;
  if (c) c("set", `exp_${name}`, v);
}

export function getVariant(name: string): Variant {
  if (FORCED[name]) return FORCED[name];
  const key = `ae.exp.${name}`;
  let v: Variant | null = null;
  try {
    const q = new URLSearchParams(window.location.search).get(`exp_${name}`)?.toUpperCase();
    if (q === "A" || q === "B") { v = q; localStorage.setItem(key, q); }
    else {
      const saved = localStorage.getItem(key);
      if (saved === "A" || saved === "B") v = saved;
    }
  } catch { /* localStorage indisponible */ }
  if (!v) {
    v = Math.random() < 0.5 ? "A" : "B";
    try { localStorage.setItem(key, v); } catch { /* rien */ }
  }
  clarityTag(name, v);
  return v;
}

/** Variante stable pour la durée de vie du composant. */
export function useVariant(name: string): Variant {
  return useMemo(() => getVariant(name), [name]);
}

/**
 * Test `pro_cta` : faut-il parler d'essai gratuit ? Vrai pour la variante B,
 * tant que l'essai reste possible (visiteur anonyme, ou compte qui ne l'a pas
 * encore utilisé).
 */
export function useTrialCta(): boolean {
  const v = useVariant("pro_cta");
  const { status } = useSubscription();
  return v === "B" && !status?.trialUsed;
}
