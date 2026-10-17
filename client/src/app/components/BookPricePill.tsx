/**
 * BookPricePill — un VRAI prix de bookmaker, et le geste pour aller parier.
 *
 * Règles du user (2026-09-27), à ne pas défaire :
 *
 *   • Les prix affichés viennent de DraftKings (2026-10-17), le livre de la
 *     collecte du ML — un seul livre partout. Avant : BetRivers / BET99.
 *     The Odds API ne cote ni Bet365 ni Stake sur la NHL.
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

/**
 * Cote ÉQUITABLE déduite du % ML (100 / p), sans marge — affichée à la place
 * de `BookPricePill` quand le livre ne cote pas ce pari ou que le flux ne
 * répond pas (demande du user, 2026-10-02 : la cote du vainqueur et du
 * handicap doit accompagner chaque prédiction). Grise et sans lien, pour ne
 * jamais se lire comme un prix de bookmaker ; l'infobulle le dit.
 */
export function fairOdds(pct: number | null | undefined): number | null {
  if (pct == null || !Number.isFinite(pct) || pct <= 0 || pct >= 100) return null;
  return Math.round((100 / pct) * 100) / 100;
}

export function FairOddsPill({ pct, size = "sm", title, reserve = false }: {
  pct: number | null | undefined; size?: "sm" | "md"; title?: string;
  /**
   * Garder la place de la pastille tant qu'il n'y a pas de cote (prédiction en
   * cours de chargement). Sans ça, les cartes de match de l'accueil passaient de
   * 92 à 99 px à l'arrivée du paquet ML et poussaient tout ce qui suit : CLS
   * 0,395 sur une seule carte en PSI mobile (2026-10-06).
   */
  reserve?: boolean;
}) {
  const { odds } = useOddsFormat();
  const fair = fairOdds(pct);
  const text = size === "md" ? "text-sm" : "text-[11px]";
  if (fair == null) {
    if (!reserve) return null;
    return (
      <span aria-hidden className="invisible inline-flex items-center gap-1 border border-transparent rounded-full px-2 py-0.5">
        <span className={`${text} font-semibold tabular-nums`}>0.00</span>
      </span>
    );
  }
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 bg-white/[0.04] border border-white/15 rounded-full px-2 py-0.5"
    >
      <span className={`${text} font-semibold text-[#bfc8cc] tabular-nums`}>{odds(fair)}</span>
    </span>
  );
}
