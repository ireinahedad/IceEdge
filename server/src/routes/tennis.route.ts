import { Router } from "express";
import * as tennisApi from "../services/tennisApiClient";

const router = Router();

// GET /api/tennis/live
router.get("/live", async (_req, res) => {
  try {
    res.json(await tennisApi.fetchLiveMatches());
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/tennis/fixtures?date=YYYY-MM-DD  (defaults to today)
router.get("/fixtures", async (req, res) => {
  try {
    const dateStr = req.query.date as string | undefined;
    const date = dateStr ? new Date(dateStr) : new Date();
    res.json(await tennisApi.fetchFixtures(date));
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

export default router;
