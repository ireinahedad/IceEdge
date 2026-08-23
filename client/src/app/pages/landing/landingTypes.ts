/**
 * landingTypes.ts
 *
 * Extrait de HockeyLanding.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { predictionApiService } from "../../services/predictionApiService";
import type { TennisApiMatch } from "../../services/tennisApiService";
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

// ─── Tennis mock data ──────────────────────────────────────────────────────────

export interface TennisMatch {
  id: string;
  player1: { name: string; country: string; winPct: number; sets?: number[]; serving?: boolean; bet365Odds?: number };
  player2: { name: string; country: string; winPct: number; sets?: number[]; serving?: boolean; bet365Odds?: number };
  time: string; tournament: string; surface: string; surfaceIcon: string;
  isLive?: boolean; liveSet?: string;
}

export const TENNIS_LIVE_FALLBACK: TennisMatch[] = [
  {
    id: "tl1",
    player1: { name: "N. Djokovic", country: "🇷🇸", winPct: 62, sets: [6, 4], serving: true, bet365Odds: 1.52 },
    player2: { name: "C. Alcaraz",  country: "🇪🇸", winPct: 38, sets: [3, 5],                bet365Odds: 2.55 },
    time: "Live", tournament: "Roland Garros", surface: "Clay", surfaceIcon: "🟫", isLive: true, liveSet: "SET 2",
  },
  {
    id: "tl2",
    player1: { name: "J. Sinner", country: "🇮🇹", winPct: 71, sets: [6], serving: true, bet365Odds: 1.35 },
    player2: { name: "A. Zverev", country: "🇩🇪", winPct: 29, sets: [2],                 bet365Odds: 3.10 },
    time: "Live", tournament: "Roland Garros", surface: "Clay", surfaceIcon: "🟫", isLive: true, liveSet: "SET 1",
  },
];

export const TENNIS_UPCOMING_FALLBACK: TennisMatch[] = [
  { id: "tu1", player1: { name: "I. Swiatek",  country: "🇵🇱", winPct: 61, bet365Odds: 1.65 }, player2: { name: "A. Sabalenka", country: "🇧🇾", winPct: 39, bet365Odds: 2.30 }, time: "14:00", tournament: "Roland Garros", surface: "Clay", surfaceIcon: "🟫" },
  { id: "tu2", player1: { name: "D. Medvedev", country: "🇷🇺", winPct: 55, bet365Odds: 1.80 }, player2: { name: "H. Rune",      country: "🇩🇰", winPct: 45, bet365Odds: 2.00 }, time: "16:00", tournament: "Roland Garros", surface: "Clay", surfaceIcon: "🟫" },
  { id: "tu3", player1: { name: "C. Gauff",    country: "🇺🇸", winPct: 58, bet365Odds: 1.72 }, player2: { name: "E. Rybakina",  country: "🇰🇿", winPct: 42, bet365Odds: 2.15 }, time: "18:30", tournament: "Roland Garros", surface: "Clay", surfaceIcon: "🟫" },
];

export const TENNIS_TOP_PREDICTIONS_FALLBACK = [
  { icon: "🇷🇸", name: "Djokovic", label: "Win vs Alcaraz",   pct: 62, trend: "+3%", edge: 62 - impliedPct(1.52) },
  { icon: "🇮🇹", name: "Sinner",   label: "Win vs Zverev",    pct: 71, trend: "+5%", edge: 71 - impliedPct(1.35) },
  { icon: "🇵🇱", name: "Swiatek",  label: "Win vs Sabalenka", pct: 61, trend: "+1%", edge: 61 - impliedPct(1.65) },
];

export async function toTennisMatch(m: TennisApiMatch): Promise<TennisMatch> {
  const pred = await predictionApiService.getSinglePrediction({
    marketType: "moneyline",
    gameId: m.id,
    playerId: m.player1.id,
  });

  let time = "TBD";
  if (m.isLive) {
    time = "Live";
  } else if (m.scheduledIso) {
    const d = new Date(m.scheduledIso);
    time = d.toLocaleTimeString("en-US", {
      hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/New_York",
    });
  }

  return {
    id: m.id,
    tournament: m.tournament,
    surface: m.surface,
    surfaceIcon: m.surfaceIcon,
    isLive: m.isLive,
    liveSet: m.liveSet,
    time,
    player1: {
      name: m.player1.name,
      country: m.player1.country,
      winPct: pred.probability,
      sets: m.player1.sets,
      serving: m.player1.serving,
    },
    player2: {
      name: m.player2.name,
      country: m.player2.country,
      winPct: 100 - pred.probability,
      sets: m.player2.sets,
      serving: m.player2.serving,
    },
  };
}

export interface AddSheetState {
  open: boolean;
  subject?: { id: string; type: "team" | "player" | "game"; name: string; logo: string; subtitle: string };
}
