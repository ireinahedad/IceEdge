/**
 * pctScale.ts — l'échelle de couleur unique des probabilités.
 *
 * Une seule rampe pour TOUTES les pages de prédiction : rouge → mauve → bleu,
 * du moins probable au plus probable. Elle a remplacé le 2026-09-04 l'ancienne
 * rampe vert / bleu / jaune / rouge, qui était recopiée à l'identique dans sept
 * fichiers et divergeait déjà (accent de sport ici, violet ML là).
 *
 * Les paliers 38 / 50 / 65 sont ceux d'origine : seules les couleurs changent,
 * donc aucune tuile ne change de palier.
 */

/** Rouge (faible) → mauve → bleu (fort). */
export function pctColor(pct: number): string {
  if (pct >= 65) return "#60a5fa"; // bleu
  if (pct >= 50) return "#a78bfa"; // mauve
  if (pct >= 38) return "#c084fc"; // mauve rosé
  return "#f87171";                // rouge
}

