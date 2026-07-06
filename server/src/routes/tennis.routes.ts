import { Router } from "express";
import * as tennisApi from "../services/tennisApiClient";

const router = Router();

// GET /api/tennis/live
router.get("/live", async (_req, res) => {
  try {
    res.json(await tennisApi.fetchLiveMatches());
  } catch (err: any) {
    console.error('[Tennis]', err.message);
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
    console.error('[Tennis]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// GET /api/tennis/rankings/:tour  (ATP or WTA)
router.get("/rankings/:tour", async (req, res) => {
  const tour = (req.params.tour ?? "ATP").toUpperCase();
  if (tour !== "ATP" && tour !== "WTA") {
    res.status(400).json({ error: "tour must be ATP or WTA" });
    return;
  }
  try {
    res.json(await tennisApi.fetchRankings(tour as "ATP" | "WTA"));
  } catch (err: any) {
    console.error('[Tennis]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// GET /api/tennis/tournaments?year=YYYY  (defaults to current year)
router.get("/tournaments", async (req, res) => {
  try {
    const year = req.query.year ? Number(req.query.year) : undefined;
    res.json(await tennisApi.fetchTournaments(year));
  } catch (err: any) {
    console.error('[Tennis]', err.message);
    res.status(502).json({ error: err.message });
  }
});

export default router;
