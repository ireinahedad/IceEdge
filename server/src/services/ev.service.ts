export class EVService {
  calculateEV(modelProb: number, odds: number) {
    const payout = odds > 0 ? odds / 100 : 100 / Math.abs(odds);

    const win = modelProb * payout;
    const loss = 1 - modelProb;

    return win - loss;
  }
}