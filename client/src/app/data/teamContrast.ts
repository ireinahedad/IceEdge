/**
 * teamContrast.ts — couleurs de club lisibles sur le fond sombre de l'app, et
 * distinctes entre deux équipes. Purement cosmétique, comme `teamColors`.
 *
 * Partagé par le pick'em du chat (`PickemSection`) et celui de la page de match
 * (`MatchPickem`) : les deux montrent le même match aux mêmes couleurs.
 */

import { teamColors } from "./teamEmoji";

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function distance(a: string, b: string): number {
  const [x, y] = [rgb(a), rgb(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/** La couleur du club la plus lisible sur fond sombre ; bleu glace si les deux sont trop foncées. */
function readable(abbr: string): string {
  const { primary, secondary } = teamColors(abbr);
  if (luminance(primary) >= 0.07) return primary;
  if (luminance(secondary) >= 0.07) return secondary;
  return "#86d1ea";
}

/** Paire visiteur / domicile : si elles se confondent, le domicile passe en blanc. */
export function sideColors(away: string, home: string): { away: string; home: string } {
  const a = readable(away);
  const h = readable(home);
  return { away: a, home: distance(a, h) < 90 ? "#dfe9ef" : h };
}
