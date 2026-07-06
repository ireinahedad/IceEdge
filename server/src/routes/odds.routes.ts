import { Router, Request, Response } from "express";
import { OddsService } from "../services/odds.service";

const router = Router();
const odds = new OddsService();

router.get("/live", (req, res) => {
  res.json(odds.getLiveOdds());
});

router.get("/game/:gameId", (req, res) => {
  res.json(odds.getOddsByGame(req.params.gameId));
});

// ── The Odds API proxy ────────────────────────────────────────────────────────
// Keeps the API key server-side (was previously exposed in the client bundle via
// VITE_ODDS_API_KEY). The client calls these endpoints instead of the-odds-api
// directly. Responses are relayed unchanged. Falls back to [] when unconfigured
// so the client can show mock data. Rate-limited by the global /api limiter.

const ODDS_BASE = "https://api.the-odds-api.com/v4";
const ODDS_KEY  = process.env.ODDS_API_KEY;

// GET /api/odds/bet365/:sportKey?markets=h2h,totals
router.get("/bet365/:sportKey", async (req: Request, res: Response) => {
  if (!ODDS_KEY) return res.json([]);
  const markets = String(req.query.markets || "h2h");
  const params = new URLSearchParams({
    apiKey:     ODDS_KEY,
    regions:    "eu",
    bookmakers: "bet365",
    markets,
    oddsFormat: "decimal",
  });
  try {
    const upstream = await fetch(
      `${ODDS_BASE}/sports/${encodeURIComponent(req.params.sportKey)}/odds?${params}`
    );
    if (!upstream.ok) {
      console.error("[odds proxy]", upstream.status, await upstream.text().catch(() => ""));
      return res.status(502).json([]);
    }
    res.json(await upstream.json());
  } catch (err: any) {
    console.error("[odds proxy] fetch error", err?.message);
    res.status(502).json([]);
  }
});

// GET /api/odds/sports — available sports/tournaments
router.get("/sports", async (_req: Request, res: Response) => {
  if (!ODDS_KEY) return res.json([]);
  try {
    const upstream = await fetch(`${ODDS_BASE}/sports?apiKey=${ODDS_KEY}`);
    if (!upstream.ok) return res.json([]);
    res.json(await upstream.json());
  } catch {
    res.json([]);
  }
});

export default router;