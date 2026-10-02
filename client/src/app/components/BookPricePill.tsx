/**
 * BookPricePill — un VRAI prix de bookmaker, et le geste pour aller parier.
 *
 * Règles du user (2026-09-27), à ne pas défaire :
 *
 *   • Les prix affichés viennent de BetRivers, le livre de The Odds API le plus
 *     proche de Bet365 (2026-10-02) — Bet365 et Stake n'y sont pas cotés.
 *     La source est dite UNE fois, dans les Réglages (« Cotes affichées »),
 *     pas sur chaque pastille.
 *   • Le toucher ouvre le livre CHOISI dans les Réglages (Bet365 ou Stake), même
 *     si sa cote diffère : `openBet` lit ce choix au moment du clic. Avec un
 *     `ticket`, la fiche « à chercher sur Bet365 » (match, marché, cote
 *     minimale) passe d'abord — Bet365 n'ouvre pas un pari précis (2026-10-02).
 *   • Le prix suit le format des Réglages (`useOddsFormat`) — c'est un prix de
 *     livre, pas une probabilité du modèle (voir `services/oddsFormat.ts`).
 *
 * APPLE_PLAN §4 — Guideline 5.3 : sur iOS, le prix reste (c'est une
 * information), le lien sortant disparaît.
 */

import { useOddsFormat } from "../context/OddsFormatContext";
import { useBookmaker, type BetTicket } from "../context/BookmakerContext";
import { features } from "../platform";

/**
 * `link={false}` : la pastille n'est qu'un affichage. Sert dans le tableau de
 * l'accueil (2026-09-28), où toute la case ajoute au coupon — décision du
 * user : là, le toucher sur la cote ajoute le pari au lieu d'ouvrir le livre.
 */
export function BookPricePill({ price, size = "sm", link = true, ticket }: {
  price: number; size?: "sm" | "md"; link?: boolean;
  /** Ce qu'il faut chercher chez son livre — la fiche s'ouvre avant le livre (2026-10-02). */
  ticket?: BetTicket;
}) {
  const { odds } = useOddsFormat();
  const { openBetFor } = useBookmaker();
  const text = size === "md" ? "text-sm" : "text-[11px]";
  const inner = (
    <span className={`${text} font-bold text-green-400 tabular-nums`}>{odds(price)}</span>
  );
  const cls = "inline-flex items-center gap-1 bg-green-500/10 border border-green-500/20 rounded-full px-2 py-0.5";

  if (!link || !features.bookmakerLinks) return <span className={cls}>{inner}</span>;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); openBetFor(ticket ? { shownPrice: price, ...ticket } : null); }}
      className={`${cls} active:bg-green-500/20 transition-colors`}
    >
      {inner}
    </button>
  );
}
