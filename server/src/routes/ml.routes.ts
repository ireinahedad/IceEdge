import { Router } from "express";

const router = Router();

router.post("/predict", (req, res) => {
  res.json({
    homeWinProb: 0.62,
    awayWinProb: 0.38,
    confidence: 0.7
  });
});

export default router;