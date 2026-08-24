/**
 * landingTypes.ts
 *
 * Extrait de HockeyLanding.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { predictionApiService } from "../../services/predictionApiService";
import type { NHLGame } from "../../types/bet";
import { nhlLogoUrl } from "../../data/teamEmoji";


// ─── Hockey helpers ────────────────────────────────────────────────────────────



export interface DisplayGame {
  id: string;
  period?: string;
  time?: string;
  overUnder?: number;
  totalPct?: number;
  // bet365 decimal odds — only populated when VITE_ODDS_API_KEY is set
  bet365Home?: number;
  bet365Away?: number;
  team1: { id: string; abbr: string; name: string; score?: number; logo: string; winPct: number };
  team2: { id: string; abbr: string; name: string; score?: number; logo: string; winPct: number };
}

export async function toDisplayGame(game: NHLGame): Promise<DisplayGame> {
  const [homePred, totalPred] = await Promise.all([
    predictionApiService.getSinglePrediction({ marketType: "moneyline", gameId: game.id, teamId: game.homeTeam.abbreviation.toLowerCase() }),
    predictionApiService.getSinglePrediction({ marketType: "total_goals", gameId: game.id, selection: "over", line: 5.5 }),
  ]);
  return {
    id: game.id,
    period: game.period ? `${game.period}P • ${game.clock}` : undefined,
    time: game.startTime,
    overUnder: 5.5,
    totalPct: totalPred.probability,
    team1: { id: game.homeTeam.abbreviation.toLowerCase(), abbr: game.homeTeam.abbreviation, name: game.homeTeam.name, score: game.homeTeam.score, logo: nhlLogoUrl(game.homeTeam.abbreviation), winPct: homePred.probability },
    team2: { id: game.awayTeam.abbreviation.toLowerCase(), abbr: game.awayTeam.abbreviation, name: game.awayTeam.name, score: game.awayTeam.score, logo: nhlLogoUrl(game.awayTeam.abbreviation), winPct: 100 - homePred.probability },
  };
}

// ─── Edge detection helpers ───────────────────────────────────────────────────

/** Convert a bet365 decimal odd to the bookmaker's implied win probability (%) */
function impliedPct(decimal: number): number {
  return Math.round(100 / decimal);
}

/**
 * Edge = our model's probability minus the bookmaker's implied probability.
 * Only meaningful when we have real bet365 odds.
 */
export function calcEdge(modelPct: number, decimal: number): number {
  return modelPct - impliedPct(decimal);
}

export interface AddSheetState {
  open: boolean;
  subject?: { id: string; type: "team" | "player" | "game"; name: string; logo: string; subtitle: string };
}
