import { MOCK_ODDS } from "../data/mock";

export class OddsService {
  getLiveOdds() {
    return MOCK_ODDS;
  }

  getOddsByGame(gameId: string) {
    return MOCK_ODDS.filter(o => o.gameId === gameId);
  }
}