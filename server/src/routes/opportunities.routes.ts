import { Router } from "express";
import { OpportunityService } from "../services/opportunities.service";

const router = Router();
const service = new OpportunityService();

router.get("/today", async (_req, res) => {
  try { res.json(await service.getTodayOpportunities()); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

export default router;
