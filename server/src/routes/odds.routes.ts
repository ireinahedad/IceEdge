import { Router, Request, Response } from "express";
import { TtlCache } from "../services/ttlCache";
import { timeUpstream } from "../metrics";
import { logger } from "../logger";
import * as oddsQuota from "../services/oddsQuota";
import { fetchGameExtras, fetchRawOddsStrict, priceForSelection, type RawOddsEvent } from "../services/oddsClient";
import { z } from "zod";
import { validateBody } from "../middleware/validate.middleware";
import { fetchGameById } from "../services/nhlApiClient";

const router = Router();

// `GET /live` et `GET /game/:gameId` ont été supprimées le 2026-09-08. Elles
// servaient `MOCK_ODDS` — deux cotes écrites en dur sur un match « g1 » — à
// n'importe qui, sans authentification et sans le dire. Sur une app de paris,
// une cote inventée qui a l'air vraie est le pire mode d'échec possible ; c'est
// le même arbitrage que `PredictionUnavailableError` côté prédictions.
// Aucun appelant : le client passe par `/bet365/:sportKey` ci-dessous, qui relaie
// The Odds API. `services/odds.service.ts` et `data/mock.ts` sont partis avec
// elles, faute d'appelant.

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

// Livre et région : définis UNE fois, dans `services/oddsClient.ts`
// (`ODDS_BOOKMAKERS`, défaut `draftkings`). L'ancienne paire écrite ici,
// `bet365`/`eu`, ne désignait aucun livre chez The Odds API — d'où zéro cote
// affichée, jamais. Voir le commentaire de `ODDS_BOOKMAKERS`.

/**
 * TTL du cache de la route. Court : la vraie fenêtre de facturation est celle
 * du cache de `oddsClient` (`ODDS_CACHE_TTL_MIN`, 30 min), que cette route lit.
 * Celui-ci ne fait que servir la réponse filtrée par marchés sans refaire le
 * filtrage à chaque visiteur, et porter le repli périmé.
 */
const ODDS_TTL   = 5 * 60_000;
/** La liste des sports ne change quasiment jamais (et ne coûte pas de crédit). */
const SPORTS_TTL = 60 * 60_000;

/** Seuil d'alerte sur les crédits restants renvoyés par The Odds API. */
const QUOTA_WARN = Number(process.env.ODDS_QUOTA_WARN ?? 100);

/**
 * Délai maximal d'un appel à The Odds API.
 *
 * C'était le seul `fetch` sortant du serveur sans borne de temps —
 * `nhlApiClient`, `mlApiClient` et `llm.routes` en ont tous une. Un amont qui
 * accepte la connexion puis ne répond jamais immobilisait donc une connexion
 * Express indéfiniment.
 *
 * ⚠️ **Le coût réel était plus élevé que « une connexion bloquée »** : ces deux
 * routes passent par `TtlCache.wrap`, qui **dédoublonne les requêtes
 * concurrentes sur une clé froide**. Tous les visiteurs demandant les mêmes
 * cotes attendent la MÊME promesse — un seul amont pendu les gelait tous, et
 * aucun n'aurait jamais reçu le repli stale prévu plus bas, puisque la promesse
 * ne rejetait pas. Le délai est ce qui transforme cette panne muette en un
 * rejet, donc en une réponse stale.
 *
 * 8 s : au-dessus du temps de réponse observé de The Odds API, et bien en
 * dessous des 15 s du client (`http.ts`), pour que le repli stale ait le temps
 * de partir avant que le navigateur n'abandonne.
 */
const ODDS_FETCH_TIMEOUT_MS = Number(process.env.ODDS_FETCH_TIMEOUT_MS) || 8_000;

/**
 * `fetch` borné dans le temps. Lève une `AbortError` au-delà du délai.
 *
 * ⚠️ **Pas d'annotation de retour, volontairement.** Ce fichier importe
 * `Response` d'Express : écrire `Promise<Response>` ici désigne la réponse
 * HTTP sortante d'Express, pas celle de `fetch`, et `tsc` rend six erreurs
 * déroutantes. Le type inféré est le bon.
 */
async function fetchOdds(url: string) {
  // `AbortController` plutôt que `AbortSignal.timeout` : c'est le motif déjà
  // employé dans `llm.routes.ts`, et il libère explicitement son minuteur.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ODDS_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const oddsCache  = new TtlCache<unknown>(ODDS_TTL, 50, 'odds');
const sportsCache = new TtlCache<unknown>(SPORTS_TTL, 1, 'odds-sports');

// ── Cache d'ÉCHEC ────────────────────────────────────────────────────────────
//
// `TtlCache` ne mémorise pas un échec (c'est voulu, et testé). Conséquence
// mesurée le 2026-09-16 sur cette route : amont en panne ou quota épuisé,
// 20 visiteurs successifs = 20 appels amont — chacun attendant jusqu'à
// `ODDS_FETCH_TIMEOUT_MS` avant de servir le périmé ou un 502. La
// déduplication en vol ne couvre que les visiteurs SIMULTANÉS.
//
// Après un échec, une clé n'est plus retentée pendant `ODDS_FAILURE_TTL_MS` :
// on sert directement la dernière réponse connue, ou `[]` en 502. Un succès
// efface la marque. Borné comme `oddsCache` (clés = sport × marchés).
const FAILURE_TTL_MS = Number(process.env.ODDS_FAILURE_TTL_MS) || 60_000;
const FAILURE_MAX_KEYS = 50;
const recentFailures = new Map<string, number>();

function failedRecently(key: string): boolean {
  const at = recentFailures.get(key);
  if (at === undefined) return false;
  if (Date.now() - at < FAILURE_TTL_MS) return true;
  recentFailures.delete(key);
  return false;
}

function markFailure(key: string): void {
  recentFailures.delete(key);
  if (recentFailures.size >= FAILURE_MAX_KEYS) {
    const oldest = recentFailures.keys().next();
    if (!oldest.done) recentFailures.delete(oldest.value);
  }
  recentFailures.set(key, Date.now());
}

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

/**
 * Ne garde, dans chaque livre, que les marchés demandés.
 *
 * L'appel amont prend toujours les trois marchés (c'est ce qui permet un seul
 * appel partagé avec le moteur de paris) ; la réponse, elle, reste celle que
 * le client a demandée.
 */
function keepMarkets(events: RawOddsEvent[], markets: string): RawOddsEvent[] {
  const wanted = new Set(markets.split(","));
  return events.map((ev) => ({
    ...ev,
    bookmakers: (ev.bookmakers ?? []).map((b) => ({
      ...b,
      markets: (b.markets ?? []).filter((m) => wanted.has(m.key)),
    })),
  }));
}

// GET /api/odds/bet365/:sportKey?markets=h2h,totals
//
// Le nom de route garde « bet365 » par compatibilité avec les clients déjà
// déployés ; le livre réellement servi est `ODDS_BOOKMAKERS` et chaque
// événement porte son `key`/`title`, que le client affiche.
//
// UN SEUL APPEL AMONT PARTAGÉ (2026-09-27). Cette route appelait The Odds API
// elle-même, en plus de l'appel du moteur de paris (`oddsClient`) : deux
// fenêtres de 5 min, soit jusqu'à ~26 000 crédits/mois en trafic continu, plus
// que le plan 20K entier. Elle lit maintenant le cache de `oddsClient`.
router.get("/bet365/:sportKey", async (req: Request, res: Response) => {
  if (!ODDS_KEY) return res.json([]);

  const sportKey = String(req.params.sportKey).toLowerCase();
  if (!SPORT_KEY_RE.test(sportKey)) {
    return res.status(400).json({ error: "invalid sportKey" });
  }
  // `oddsClient` ne connaît que la NHL, seul sport du produit (le tennis est
  // retiré). Un autre sport n'a rien à servir : pas d'appel facturé pour rien.
  if (sportKey !== "icehockey_nhl") return res.json([]);

  const markets = parseMarkets(req.query.markets);
  const key = `${sportKey}|${markets}`;

  // TTL adaptatif : allongé quand le solde baisse (voir `oddsQuota`).
  const ttl = oddsQuota.proxyTtlMs(ODDS_TTL);

  // Échec récent et rien de frais : on ne rappelle pas l'amont (voir plus haut).
  if (oddsCache.peekFresh(key) === null && failedRecently(key)) {
    const stale = oddsCache.getStale(key);
    if (stale !== null) {
      res.set("Cache-Control", "public, max-age=30");
      return res.json(stale);
    }
    return res.status(502).json([]);
  }

  try {
    const data = await oddsCache.wrap(key, () => timeUpstream('odds', async () =>
      keepMarkets(await fetchRawOddsStrict(), markets)), ttl);
    recentFailures.delete(key);

    // 60 s navigateur/CDN + 5 min de stale-while-revalidate : la vague
    // d'arrivée est absorbée en amont du serveur.
    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    res.json(data);
  } catch (err: any) {
    markFailure(key);
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

// GET /api/odds/extras/:home/:away — marchés de match supplémentaires.
//
// Résultat en 60 min, résultat et total par période, totaux alternatifs…,
// chez le livre d'affichage, pour UN match. Coût maîtrisé côté service
// (`fetchGameExtras` : cache par match, plafond quotidien, réserve visiteurs) ;
// la route ne fait que valider et relayer. Réponse : la liste des livres, même
// forme que `event.bookmakers` du flux principal, pour que le client la fusionne.
const ABBR_RE = /^[A-Za-z]{2,3}$/;
router.get("/extras/:home/:away", async (req: Request, res: Response) => {
  const { home, away } = req.params;
  if (!ABBR_RE.test(home) || !ABBR_RE.test(away)) {
    return res.status(400).json({ error: "invalid team" });
  }
  try {
    const bookmakers = await fetchGameExtras(home, away);
    res.set("Cache-Control", "public, max-age=120, stale-while-revalidate=600");
    res.json({ bookmakers });
  } catch {
    res.json({ bookmakers: [] });
  }
});

// POST /api/odds/legs — le prix du livre d'affichage pour chaque jambe d'un coupon.
//
// Pourquoi une route et pas le client : une jambe ne connaît que son `gameId`
// NHL et sa sélection. Retrouver les deux équipes demande le calendrier NHL
// (côté serveur, en cache), et l'appariement au flux de cotes se fait sur les
// ABRÉVIATIONS (`oddsTeamNames.ts`), que seul le serveur tient.
//
// Coût : ZÉRO crédit de plus — `priceForSelection` lit le cache partagé. Le
// corps est borné (20 jambes, champs typés) et la route passe sous `apiLimiter`
// comme tout `/api`. Une jambe sans prix n'est simplement pas dans la réponse.
const legsSchema = z.object({
  legs: z.array(z.object({
    id:             z.string().min(1).max(120),
    gameId:         z.string().regex(/^\d{6,12}$/),
    marketType:     z.enum(["moneyline", "puck_line", "total_goals"]),
    selectionValue: z.string().min(1).max(12),
    line:           z.number().finite().min(-20).max(20).nullable().optional(),
  })).max(20),
});

router.post("/legs", validateBody(legsSchema), async (req: Request, res: Response) => {
  res.set("Cache-Control", "no-store");
  if (!ODDS_KEY) return res.json({ prices: {} });
  const { legs } = req.body as z.infer<typeof legsSchema>;

  const prices: Record<string, { price: number; bookTitle: string }> = {};
  await Promise.all(legs.map(async (leg) => {
    try {
      const game = await fetchGameById(leg.gameId);
      const home = game?.homeTeam?.abbreviation;
      const away = game?.awayTeam?.abbreviation;
      if (!home || !away) return;
      // Un match commencé n'a plus de cote d'avant-match : ne pas afficher un
      // prix figé comme s'il était encore offert.
      if (game.status !== "scheduled") return;
      const p = await priceForSelection({
        homeAbbr: home, awayAbbr: away, marketType: leg.marketType,
        selectionValue: leg.selectionValue, line: leg.line ?? null,
      });
      if (p) prices[leg.id] = { price: p.price, bookTitle: p.bookTitle };
    } catch { /* jambe sans prix */ }
  }));
  res.json({ prices });
});

// GET /api/odds/sports — available sports/tournaments
router.get("/sports", async (_req: Request, res: Response) => {
  if (!ODDS_KEY) return res.json([]);
  // Même cache d'échec que `/bet365/:sportKey`.
  if (sportsCache.peekFresh("sports") === null && failedRecently("sports")) {
    return res.json(sportsCache.getStale("sports") ?? []);
  }
  try {
    const data = await sportsCache.wrap("sports", () => timeUpstream('odds', async () => {
      const upstream = await fetchOdds(`${ODDS_BASE}/sports?apiKey=${ODDS_KEY}`);
      trackQuota(upstream);
      if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
      return upstream.json();
    }));
    recentFailures.delete("sports");
    res.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
    res.json(data);
  } catch {
    markFailure("sports");
    res.json(sportsCache.getStale("sports") ?? []);
  }
});

export default router;