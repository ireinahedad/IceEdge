/**
 * BookPricePill — un VRAI prix de bookmaker, et le geste pour aller parier.
 *
 * Règles du user (2026-09-27), à ne pas défaire :
 *
 *   • Les prix affichés viennent de Betano (Ontario), le seul livre canadien que
 *     The Odds API cote complètement sur la NHL (Bet365 et Stake n'y sont pas).
 *     La source est dite UNE fois, dans les Réglages (« Cotes affichées »),
 *     pas sur chaque pastille.
 *   • Le toucher ouvre le livre CHOISI dans les Réglages (Bet365 ou Stake), même
 *     si sa cote diffère : `openBet` lit ce choix au moment du clic.
 *   • Le prix suit le format des Réglages (`useOddsFormat`) — c'est un prix de
 *     livre, pas une probabilité du modèle (voir `services/oddsFormat.ts`).
 *
 * APPLE_PLAN §4 — Guideline 5.3 : sur iOS, le prix reste (c'est une
 * information), le lien sortant disparaît.
 */

import { useOddsFormat } from "../context/OddsFormatContext";
import { openBet } from "../services/bookmakers";
import { features } from "../platform";

export function BookPricePill({ price, size = "sm" }: { price: number; size?: "sm" | "md" }) {
  const { odds } = useOddsFormat();
  const text = size === "md" ? "text-sm" : "text-[11px]";
  const inner = (
    <span className={`${text} font-bold text-green-400 tabular-nums`}>{odds(price)}</span>
  );
  const cls = "inline-flex items-center gap-1 bg-green-500/10 border border-green-500/20 rounded-full px-2 py-0.5";

  if (!features.bookmakerLinks) return <span className={cls}>{inner}</span>;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); openBet("hockey"); }}
      className={`${cls} active:bg-green-500/20 transition-colors`}
    >
      {inner}
    </button>
  );
}
