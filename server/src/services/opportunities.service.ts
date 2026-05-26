import { NHLService } from "./nhl.service";
import { OddsService } from "./odds.service";
import { ProbabilityService } from "./probability.service";
import { EVService } from "./ev.service";

export class OpportunityService {
  private nhl  = new NHLService();
  private odds = new OddsService();
  private prob = new ProbabilityService();
  private ev   = new EVService();

  async getTodayOpportunities() {
    const games = await this.nhl.getGamesByDate();

    const results: any[] = [];

    for (const game of games) {
      const oddsList  = this.odds.getOddsByGame(game.id);
      const prediction = this.prob.calculateWinProb(game);

      for (const odd of oddsList) {
        const implied  = this.impliedProbability(odd.odds);
        const modelProb = prediction.homeWinProb;
        const edge     = modelProb - implied;
        const ev       = this.ev.calculateEV(modelProb, odd.odds);

        results.push({
          gameId:     game.id,
          selection:  odd.selection,
          bookmaker:  odd.bookmaker,
          odds:       odd.odds,
          modelProb,
          impliedProb: implied,
          edge,
          ev,
          confidence: prediction.confidence,
          reasoning: [
            'Home advantage',
            'Recent form difference',
            'Goal differential trend',
          ],
        });
      }
    }

    return results.sort((a, b) => b.ev - a.ev);
  }

  private impliedProbability(odds: number) {
    if (odds > 0) return 100 / (odds + 100);
    return Math.abs(odds) / (Math.abs(odds) + 100);
  }
}
