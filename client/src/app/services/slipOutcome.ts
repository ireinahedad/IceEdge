/**
 * slipOutcome.ts — l'issue d'un coupon, en un seul endroit.
 *
 * POURQUOI CE FICHIER EXISTE. Cinq écrans écrivaient la même ligne :
 *
 *     slip.outcome === "win" ? t("slip.won") : t("slip.lost")
 *
 * Tant qu'il n'y avait que deux issues réglées, ça tenait. Depuis la migration
 * 037 côté serveur il y en a trois : un coupon dont toutes les jambes ont été
 * annulées (marché sans règle de règlement automatique) sort en `void` — ni
 * gagné, ni perdu, sans XP. Ces cinq lignes l'auraient affiché « PERDU »,
 * c'est-à-dire accusé le joueur d'avoir raté un pari que le serveur n'a jamais
 * jugé. La sixième écriture de la même ligne, ailleurs, referait la même faute.
 */

export type SlipOutcome = "pending" | "win" | "loss" | "void";

/** Clé i18n de l'issue. */
export function outcomeKey(outcome: SlipOutcome | string): string {
  switch (outcome) {
    case "win":  return "slip.won";
    case "loss": return "slip.lost";
    case "void": return "slip.void";
    default:     return "slip.pending";
  }
}

/**
 * L'issue se lit-elle comme neutre ?
 *
 * `pending` et `void` partagent le même traitement visuel — gris, pas d'anneau
 * de couleur, icône d'horloge — parce qu'ils disent la même chose au joueur :
 * il n'y a rien à célébrer ni à regretter ici.
 */
export function isNeutralOutcome(outcome: SlipOutcome | string): boolean {
  return outcome === "pending" || outcome === "void";
}
