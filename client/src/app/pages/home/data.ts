import { predictionApiService } from "../../services/predictionApiService";
import type { TennisApiMatch } from "../../services/tennisApiService";
import type { NHLGame } from "../../types/bet";
import { nhlLogoUrl } from "../../data/teamEmoji";
import type { DisplayGame, TennisMatch } from "./types";

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

// ─── Tennis fallback data (shown when the tennis API is unavailable) ─────────

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
