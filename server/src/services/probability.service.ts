import { NHLGame } from "../types/nhl";

export class ProbabilityService {
  calculateWinProb(game: NHLGame) {
    const homeAdv = 0.05;

    const base = 0.5;

    // simple MVP heuristics
    const scoreDiff =
      (game.homeTeam.score || 0) - (game.awayTeam.score || 0);

    let prob = base + homeAdv + scoreDiff * 0.02;

    // clamp
    prob = Math.max(0.05, Math.min(0.95, prob));

    return {
      homeWinProb: prob,
      awayWinProb: 1 - prob,
      confidence: 0.6,
    };
  }
}