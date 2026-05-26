import { Router } from "express";
import { OddsService } from "../services/odds.service";

const router = Router();
const odds = new OddsService();

router.get("/live", (req, res) => {
  res.json(odds.getLiveOdds());
});

router.get("/game/:gameId", (req, res) => {
  res.json(odds.getOddsByGame(req.params.gameId));
});

export default router;