/**
 * landingTypes.ts
 *
 * Extrait de HockeyLanding.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import type { NHLGame } from "../../types/bet";
import type { OddsEvent } from "../../services/oddsApiService";
import { nhlLogoUrl } from "../../data/teamEmoji";
import { fetchGameMlBundle } from "../../components/MLPredictionCard";
import { mlBundleKey } from "../prediction/gameMarkets";


// ─── Hockey helpers ────────────────────────────────────────────────────────────



export interface DisplayGame {
  id: string;
  period?: string;
  time?: string;
  /**
   * Jour du match, tel que la LNH le date (`YYYY-MM-DD`), et l'instant exact
   * de la mise au jeu.
   *
   * Les deux manquaient : la carte ne connaissait que `time` (« 7:00 PM »),
   * donc l'accueil ne pouvait NI afficher de quel jour parlait cette heure, NI
   * trier deux matchs entre eux. `startTimeUTC` est la clé de tri (un instant,
   * pas une chaîne localisée) ; `gameDate` reste le repli quand l'amont ne le
   * donne pas.
   */
  gameDate?: string;
  startTimeUTC?: string | null;
  overUnder?: number;
  totalPct?: number | null;
  // Vrais prix moneyline (décimaux) du livre relayé par le serveur — BetRivers,
  // PAS Bet365 (The Odds API ne le cote pas sur la NHL). La source est
  // dite dans les Réglages ; voir `components/BookPricePill`.
  bookHome?: number;
  bookAway?: number;
  /**
   * Handicap (puck line ±1.5) du même livre, quand il le cote. `point` est la
   * ligne du côté (−1.5 pour le favori du livre, +1.5 pour l'autre). Voir
   * `extractSpreadOdds`.
   */
  bookSpread?: { home?: { point: number; price: number }; away?: { point: number; price: number } };
  // `null` = le modèle n'a pas répondu. Jamais un nombre de repli : voir
  // l'entête de `predictionApiService.ts`.
  team1: { id: string; abbr: string; name: string; score?: number; logo: string; winPct: number | null };
  team2: { id: string; abbr: string; name: string; score?: number; logo: string; winPct: number | null };
}

/** P(victoire domicile) selon le modèle ML, ou `null` s'il ne répond pas. */
async function mlHomeWinPct(gameId: string): Promise<number | null> {
  const b = await fetchGameMlBundle(gameId);
  const v = b?.byKey[mlBundleKey("moneyline", null, null, true)]?.probability;
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

export async function toDisplayGame(game: NHLGame): Promise<DisplayGame> {
  // Le % du O/U 5.5 (`total_goals`) n'est plus demandé : la ligne de match de
  // l'accueil ne l'affiche plus depuis le 2026-09-27 (remplacé par le tableau
  // Handicap / Vainqueur, qui lit le paquet ML du match). Un appel de moins par
  // match sur `predictLimiter`.
  // 2026-10-01 (demande du user) : l'accueil n'affiche QUE le modèle ML. Le %
  // du vainqueur (barre de la carte en direct, badge d'edge, section +EV) vient
  // du paquet ML du match — le même que lit le tableau des matchs à venir, mis
  // en cache, donc aucun appel de plus. Plus de `/predict/single` (moteur de
  // règles) ici : les règles ne se voient que dans la fiche d'un pari.
  const homePct = await mlHomeWinPct(game.id);
  const totalPct = null;
  return {
    id: game.id,
    period: game.period ? `${game.period}P • ${game.clock}` : undefined,
    time: game.startTime,
    gameDate: game.gameDate,
    startTimeUTC: game.startTimeUTC ?? null,
    overUnder: 5.5,
    totalPct,
    team1: { id: game.homeTeam.abbreviation.toLowerCase(), abbr: game.homeTeam.abbreviation, name: game.homeTeam.name, score: game.homeTeam.score, logo: nhlLogoUrl(game.homeTeam.abbreviation), winPct: homePct },
    team2: { id: game.awayTeam.abbreviation.toLowerCase(), abbr: game.awayTeam.abbreviation, name: game.awayTeam.name, score: game.awayTeam.score, logo: nhlLogoUrl(game.awayTeam.abbreviation), winPct: homePct == null ? null : 100 - homePct },
  };
}

export interface AddSheetState {
  open: boolean;
  /** Match d'où la feuille a été ouverte. `HockeyLanding` l'écrivait et le
   *  relisait sans qu'il soit déclaré ici : ça marchait en JS, mais le type
   *  mentait sur la forme réelle de l'état. */
  gameId?: string;
  subject?: { id: string; type: "team" | "player" | "game"; name: string; logo: string; subtitle: string };
}

// ─── Handicap (puck line ±1.5) du livre ──────────────────────────────────────

function normName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

/**
 * Le handicap ±1.5 d'un événement, rangé par équipe du MATCH (et non par
 * domicile/extérieur du flux : `findOddsEvent` accepte un flux inversé).
 * Seules les lignes ±1.5 sont gardées — c'est la seule que montre l'accueil.
 */
export function extractSpreadOdds(
  event: OddsEvent,
  homeName: string,
  awayName: string,
): DisplayGame["bookSpread"] {
  const book = event.bookmakers.find((b) => b.markets.some((m) => m.key === "spreads"));
  const market = book?.markets.find((m) => m.key === "spreads");
  if (!market) return undefined;
  const pick = (name: string) => {
    const o = market.outcomes.find((x) => normName(x.name ?? "") === normName(name)) as
      | { price: number; point?: number }
      | undefined;
    if (!o || !Number.isFinite(o.price) || o.price <= 1) return undefined;
    if (typeof o.point !== "number" || Math.abs(Math.abs(o.point) - 1.5) > 1e-9) return undefined;
    return { point: o.point, price: o.price };
  };
  const home = pick(homeName);
  const away = pick(awayName);
  return home || away ? { home, away } : undefined;
}
