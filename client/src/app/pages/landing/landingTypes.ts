/**
 * landingTypes.ts
 *
 * Extrait de HockeyLanding.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { predictionApiService, isPredictionUnavailable } from "../../services/predictionApiService";
import type { NHLGame } from "../../types/bet";
import { nhlLogoUrl } from "../../data/teamEmoji";


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
  // Vrais prix moneyline (décimaux) du livre relayé par le serveur — Betano
  // Ontario, PAS Bet365 (The Odds API ne le cote pas sur la NHL). La source est
  // dite dans les Réglages ; voir `components/BookPricePill`.
  bookHome?: number;
  bookAway?: number;
  // `null` = le modèle n'a pas répondu. Jamais un nombre de repli : voir
  // l'entête de `predictionApiService.ts`.
  team1: { id: string; abbr: string; name: string; score?: number; logo: string; winPct: number | null };
  team2: { id: string; abbr: string; name: string; score?: number; logo: string; winPct: number | null };
}

/**
 * Une probabilité que le modèle n'a pas rendue vaut `null` — jamais un nombre
 * fabriqué. La carte affiche « — » et le calcul d'edge est neutralisé.
 */
async function pctOrNull(
  req: Parameters<typeof predictionApiService.getSinglePrediction>[0]
): Promise<number | null> {
  try {
    return (await predictionApiService.getSinglePrediction(req)).probability;
  } catch (e) {
    if (!isPredictionUnavailable(e)) throw e;
    console.warn("[landing] prédiction indisponible :", e.reason);
    return null;
  }
}

export async function toDisplayGame(game: NHLGame): Promise<DisplayGame> {
  const [homePct, totalPct] = await Promise.all([
    pctOrNull({ marketType: "moneyline", gameId: game.id, teamId: game.homeTeam.abbreviation.toLowerCase() }),
    pctOrNull({ marketType: "total_goals", gameId: game.id, selection: "over", line: 5.5 }),
  ]);
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

// ─── Edge detection helpers ───────────────────────────────────────────────────

/** Convert a bookmaker decimal odd to its implied win probability (%) */
function impliedPct(decimal: number): number {
  return Math.round(100 / decimal);
}

/**
 * Edge = our model's probability minus the bookmaker's implied probability.
 * Only meaningful when we have real bookmaker odds.
 */
export function calcEdge(modelPct: number, decimal: number): number {
  return modelPct - impliedPct(decimal);
}

export interface AddSheetState {
  open: boolean;
  /** Match d'où la feuille a été ouverte. `HockeyLanding` l'écrivait et le
   *  relisait sans qu'il soit déclaré ici : ça marchait en JS, mais le type
   *  mentait sur la forme réelle de l'état. */
  gameId?: string;
  subject?: { id: string; type: "team" | "player" | "game"; name: string; logo: string; subtitle: string };
}
