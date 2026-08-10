import { Router, Request, Response } from "express";
import { OddsService } from "../services/odds.service";
import { TtlCache } from "../services/ttlCache";
import { timeUpstream } from "../metrics";
import { logger } from "../logger";
import * as oddsQuota from "../services/oddsQuota";

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
//
// Le coût upstream est découplé du trafic : chaque combinaison
// (sport, marchés) ne déclenche au maximum qu'un appel toutes les 5 minutes,
// quel que soit le nombre de visiteurs (~17 000 appels/mois au pire).
// Le cache dédoublonne aussi les requêtes concurrentes sur une clé froide,
// et conserve la dernière réponse connue pour la servir si l'upstream tombe
// ou si le quota est épuisé.

const ODDS_BASE = "https://api.the-odds-api.com/v4";
const ODDS_KEY  = process.env.ODDS_API_KEY;

/** Même TTL que `services/oddsClient.ts` — les cotes bougent lentement. */
const ODDS_TTL   = 5 * 60_000;
/** La liste des sports ne change quasiment jamais (et ne coûte pas de crédit). */
const SPORTS_TTL = 60 * 60_000;

/** Seuil d'alerte sur les crédits restants renvoyés par The Odds API. */
const QUOTA_WARN = Number(process.env.ODDS_QUOTA_WARN ?? 100);

const oddsCache  = new TtlCache<unknown>(ODDS_TTL, 50, 'odds');
const sportsCache = new TtlCache<unknown>(SPORTS_TTL, 1, 'odds-sports');

/**
 * Marchés autorisés. La valeur entre dans la clé de cache ET dans l'URL
 * upstream : une liste blanche évite qu'un appelant fasse exploser le nombre
 * de clés (DoS mémoire) ou consomme le quota avec des marchés arbitraires.
 */
const ALLOWED_MARKETS = new Set(["h2h", "totals", "spreads", "outrights"]);
/** Les sport keys de The Odds API sont de la forme `icehockey_nhl`. */
const SPORT_KEY_RE = /^[a-z0-9_]{1,50}$/;

function parseMarkets(raw: unknown): string {
  const asked = String(raw ?? "h2h").split(",").map((m) => m.trim().toLowerCase());
  const kept = [...new Set(asked.filter((m) => ALLOWED_MARKETS.has(m)))].sort();
  return kept.length ? kept.join(",") : "h2h";
}

/**
 * Journalise le quota restant, alerte sous le seuil, et le publie à l'arbitre
 * partagé (`oddsQuota`) qui s'en sert pour suspendre la collecte de fond.
 *
 * Le proxy est le consommateur PRIORITAIRE : il n'est jamais bridé par la
 * réserve, c'est lui qu'elle protège. Il se contente d'espacer ses
 * rafraîchissements quand les crédits baissent.
 */
function trackQuota(upstream: { headers: { get(name: string): string | null } }): void {
  oddsQuota.observe(upstream.headers);
  const remaining = Number(upstream.headers.get("x-requests-remaining"));
  if (!Number.isFinite(remaining)) return;
  const used = upstream.headers.get("x-requests-used");
  if (remaining <= QUOTA_WARN) {
    logger.warn({ remaining, used }, "[odds proxy] quota The Odds API bas");
  } else {
    logger.info({ remaining, used }, "[odds proxy] quota The Odds API");
  }
}

// GET /api/odds/bet365/:sportKey?markets=h2h,totals
router.get("/bet365/:sportKey", async (req: Request, res: Response) => {
  const apiKey = ODDS_KEY;
  if (!apiKey) return res.json([]);

  const sportKey = String(req.params.sportKey).toLowerCase();
  if (!SPORT_KEY_RE.test(sportKey)) {
    return res.status(400).json({ error: "invalid sportKey" });
  }
  const markets = parseMarkets(req.query.markets);
  const key = `${sportKey}|${markets}`;

  const params = new URLSearchParams({
    apiKey,
    regions:    "eu",
    bookmakers: "bet365",
    markets,
    oddsFormat: "decimal",
  });

  // TTL adaptatif : 5 min tant que les crédits abondent, jusqu'à 24 h quand il
  // n'en reste plus. Le visiteur voit alors des cotes un peu datées plutôt
  // qu'une page vide — c'est le compromis voulu sur une clé gratuite, où un
  // TTL fixe de 5 min vaudrait à lui seul ~17 000 appels par mois.
  const ttl = oddsQuota.proxyTtlMs(ODDS_TTL);

  try {
    const data = await oddsCache.wrap(key, () => timeUpstream('odds', async () => {
      const upstream = await fetch(`${ODDS_BASE}/sports/${sportKey}/odds?${params}`);
      trackQuota(upstream);
      if (!upstream.ok) {
        const body = await upstream.text().catch(() => "");
        logger.error({ status: upstream.status, body }, "[odds proxy]");
        throw new Error(`upstream ${upstream.status}`);
      }
      return upstream.json();
    }), ttl);

    // 60 s navigateur/CDN + 5 min de stale-while-revalidate : la vague
    // d'arrivée est absorbée en amont du serveur.
    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    res.json(data);
  } catch (err: any) {
    // Filet de sécurité : plutôt servir des cotes un peu datées qu'une page vide
    // (typiquement quand le quota mensuel est épuisé).
    const stale = oddsCache.getStale(key);
    if (stale !== null) {
      logger.warn({ key, err: err?.message }, "[odds proxy] upstream KO — réponse stale servie");
      res.set("Cache-Control", "public, max-age=30");
      return res.json(stale);
    }
    logger.error({ err: err?.message }, "[odds proxy] fetch error");
    res.status(502).json([]);
  }
});

// GET /api/odds/sports — available sports/tournaments
router.get("/sports", async (_req: Request, res: Response) => {
  if (!ODDS_KEY) return res.json([]);
  try {
    const data = await sportsCache.wrap("sports", () => timeUpstream('odds', async () => {
      const upstream = await fetch(`${ODDS_BASE}/sports?apiKey=${ODDS_KEY}`);
      trackQuota(upstream);
      if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
      return upstream.json();
    }));
    res.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
    res.json(data);
  } catch {
    res.json(sportsCache.getStale("sports") ?? []);
  }
});

export default router;