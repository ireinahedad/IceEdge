import { Router } from 'express';
import { NHLService } from '../services/nhl.service';
import { buildGameMarkets, buildTeamMarkets, buildPlayerMarkets } from '../services/nhlPredictions';
import { FactorWeights } from '../services/predictionFactors';
import { publicCache, privateCache, publicPolicy, TTL } from '../middleware/httpCache.middleware';
import { staleFallback } from '../middleware/staleFallback.middleware';

const router = Router();
const nhl    = new NHLService();

// --- Repli sur la dernière réponse connue ----------------------------------
//
// Trouvé par le tir S1 du 2026-08-03 : quand l'API NHL est devenue injoignable,
// ces routes ont propagé des 500 alors que le proxy Odds, lui, sert déjà du
// périmé (`getStale`) dans la même situation. Monté ici, en tête du routeur,
// donc valable aussi pour toute route ajoutée plus tard.
//
// Sûr à cet endroit précis parce qu'AUCUNE route de ce fichier ne lit l'identité
// de l'appelant (c'est déjà l'hypothèse qui autorise `publicCache` juste
// au-dessus) : la clé de repli est l'URL, et deux visiteurs sur la même URL ont
// droit à la même réponse. Ne jamais le monter sur un routeur authentifié.
router.use(staleFallback);

// --- Cache HTTP ------------------------------------------------------------
//
// Aucune route de ce fichier ne lit l'identité de l'appelant : la réponse est
// identique pour tout le monde, donc cachable par un cache PARTAGÉ (CDN). Les
// `max-age` reprennent les TTL déjà en vigueur côté serveur dans
// `nhlApiClient` — on ne choisit pas de nouveaux chiffres, on cesse simplement
// de garder pour nous une fraîcheur qu'on connaît déjà.
//
// Conséquence directe sur le scénario dimensionnant : la vague d'arrivée sur la
// landing tape le CDN, pas Railway.

/**
 * Un match terminé ne changera plus jamais ; un match en cours change toutes
 * les 30 s. `nhlApiClient` fait déjà cette distinction (TTL 6 h vs 30 s) — sans
 * cela on la perdrait au passage HTTP en cachant 30 s des scores définitifs de
 * la saison dernière.
 *
 * Posé AVANT `res.json`, donc prioritaire sur le middleware (qui ne touche pas
 * à un `Cache-Control` déjà présent).
 */
function cacheByGameStatus(res: any, payload: any): void {
  const status = Array.isArray(payload)
    ? (payload.every((g: any) => g?.status === 'final') && payload.length > 0 ? 'final' : 'mixed')
    : payload?.status;
  if (status === 'final') res.set('Cache-Control', publicPolicy(TTL.FINAL));
}

// Games
// `/games?date=` : le TTL serveur descend à 30 s dès qu'un match de la journée
// est en direct, d'où le plafond bas ici. Une date entièrement jouée bascule
// sur 6 h via cacheByGameStatus.
router.get('/games', publicCache(TTL.LIVE), async (req, res) => {
  try {
    const games = await nhl.getGamesByDate(req.query.date as string);
    cacheByGameStatus(res, games);
    res.json(games);
  }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Calendrier : tous les matchs entre deux dates (YYYY-MM-DD) incluses.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** NHL season id, e.g. 20252026. */
const SEASON_ID = /^\d{8}$/;
router.get('/games/range', publicCache(TTL.MEDIUM), async (req, res) => {
  const start = String(req.query.start ?? '');
  const end   = String(req.query.end ?? '');
  if (!ISO_DATE.test(start) || !ISO_DATE.test(end) || end < start) {
    res.status(400).json({ error: 'Invalid start/end (expected YYYY-MM-DD, end >= start)' });
    return;
  }
  try {
    const games = await nhl.getGamesRange(start, end);
    // Une plage entièrement passée (navigation dans l'historique du calendrier)
    // est figée : 6 h au lieu de 10 min.
    cacheByGameStatus(res, games);
    res.json(games);
  }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Ancre du calendrier : date courante + bornes de saison selon l'API NHL.
router.get('/schedule/anchor', publicCache(TTL.HOUR), async (_req, res) => {
  try { res.json(await nhl.getScheduleAnchor()); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

router.get('/games/live', publicCache(TTL.LIVE), async (_req, res) => {
  try { res.json(await nhl.getLiveGames()); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Charts: full detail for one game (landing + boxscore merged).
// Before '/games/:id' so "detail" isn't captured as an id.
router.get('/games/:id/detail', publicCache(TTL.LIVE), async (req, res) => {
  try {
    const detail = await nhl.getGameDetail(req.params.id);
    cacheByGameStatus(res, detail);
    res.json(detail);
  }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Contrairement aux autres, `fetchGameById` n'a AUCUN cache serveur : chaque
// appel part vers l'API NHL (seule la déduplication en vol de `fetchNHL` le
// protège d'une rafale simultanée). L'en-tête HTTP est donc ici le seul cache
// qui existe pour cette route — d'autant plus utile.
router.get('/games/:id', publicCache(TTL.LIVE), async (req, res) => {
  try {
    const game = await nhl.getGame(req.params.id);
    cacheByGameStatus(res, game);
    res.json(game);
  }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Teams
router.get('/teams', publicCache(TTL.SHORT), async (_req, res) => {
  try { res.json(await nhl.getTeams()); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Charts: every team's season summary (All Teams page). Declared before the
// '/teams/:id/...' routes so "season-summary" isn't captured as a team id.
router.get('/teams/season-summary', publicCache(TTL.LONG), async (req, res) => {
  const season = req.query.season != null ? String(req.query.season) : undefined;
  if (season != null && !SEASON_ID.test(season)) {
    res.status(400).json({ error: 'Invalid season (expected 8-digit seasonId, e.g. 20252026)' });
    return;
  }
  try { res.json(await nhl.getAllTeamsSeason(season)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

router.get('/teams/:id/stats', publicCache(TTL.SHORT), async (req, res) => {
  try { res.json(await nhl.getTeamStats(req.params.id)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

router.get('/teams/:id/last/:n', publicCache(TTL.SHORT), async (req, res) => {
  try { res.json(await nhl.getTeamLastNGames(req.params.id, parseInt(req.params.n))); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Players
// Recherche : sans cache serveur non plus, et la clé est du texte libre — le
// cache navigateur est ce qui évite de repartir vers NHL Search à chaque
// frappe corrigée. `private` (et non `public`) : une requête de recherche est
// une trace de navigation, rien qui doive dormir dans un cache partagé.
router.get('/players/search', privateCache(TTL.SHORT), async (req, res) => {
  try { res.json(await nhl.searchPlayers(req.query.q as string ?? '')); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

router.get('/players', publicCache(TTL.MEDIUM), async (_req, res) => {
  try { res.json(await nhl.getAllPlayerStats()); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Charts: league leaders for a season (top N by a chosen metric).
// Declared before '/players/:id' so "leaders" isn't swallowed as an id.
// Every input is whitelisted or clamped downstream: `season` must be an
// 8-digit id, `sort` is looked up in a fixed map, `limit` is clamped 1–100.
type LeaderQuery =
  | { ok: true; season?: string; view: 'skater' | 'goalie'; sort: string; limit: number }
  | { ok: false };

function parseLeaderQuery(q: any): LeaderQuery {
  const season = q.season != null ? String(q.season) : undefined;
  if (season != null && !SEASON_ID.test(season)) return { ok: false };
  const limit = Number(q.limit ?? 20);
  return {
    ok: true,
    season,
    view: q.view === 'goalie' ? 'goalie' : 'skater',
    sort: String(q.sort ?? ''),
    limit: Number.isFinite(limit) ? limit : 20,
  };
}

const BAD_SEASON = { error: 'Invalid season (expected 8-digit seasonId, e.g. 20252026)' };

router.get('/players/leaders', publicCache(TTL.LONG), async (req, res) => {
  const p = parseLeaderQuery(req.query);
  if (!p.ok) { res.status(400).json(BAD_SEASON); return; }
  try { res.json(await nhl.getPlayerLeaders(p.season, p.view, p.sort, p.limit)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

router.get('/teams/:abbr/roster', publicCache(TTL.LONG), async (req, res) => {
  try { res.json(await nhl.getTeamRoster(req.params.abbr)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Bet365-style charts: last 6 seasons of per-player stats (skaters + goalies).
router.get('/teams/:abbr/player-seasons', publicCache(TTL.LONG), async (req, res) => {
  try { res.json(await nhl.getTeamPlayerSeasons(req.params.abbr)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Charts: per-opponent player splits for a season (avg-per-game-vs-team column).
router.get('/teams/:abbr/opponent-splits/:season', publicCache(TTL.LONG), async (req, res) => {
  if (!SEASON_ID.test(req.params.season)) {
    res.status(400).json({ error: 'Invalid season (expected 8-digit seasonId, e.g. 20252026)' });
    return;
  }
  try { res.json(await nhl.getTeamOpponentSplits(req.params.abbr, req.params.season)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Charts: official team stats for a season + per-opponent GF/GA/W from schedule.
router.get('/teams/:abbr/season-official/:season', publicCache(TTL.LONG), async (req, res) => {
  if (!SEASON_ID.test(req.params.season)) {
    res.status(400).json({ error: 'Invalid season (expected 8-digit seasonId, e.g. 20252026)' });
    return;
  }
  try { res.json(await nhl.getTeamSeasonOfficial(req.params.abbr, req.params.season)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Comme `/games/:id`, `fetchPlayerById` n'a pas de cache serveur : l'en-tête
// HTTP est le seul cache de ces deux routes.
router.get('/players/:id', publicCache(TTL.MEDIUM), async (req, res) => {
  try { res.json(await nhl.getPlayer(req.params.id)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

router.get('/players/:id/stats', publicCache(TTL.MEDIUM), async (req, res) => {
  try { res.json(await nhl.getPlayerStats(req.params.id)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Parse les poids personnalisés depuis la query (?wQuality=&wHomeIce=&...).
// Retourne undefined si aucun n'est fourni → le moteur utilise les poids par défaut.
function parseWeights(q: any): FactorWeights | undefined {
  const keys: Array<[keyof FactorWeights, string]> = [
    ['quality', 'wQuality'], ['homeIce', 'wHomeIce'], ['fatigue', 'wFatigue'],
    ['odds', 'wOdds'], ['injuries', 'wInjuries'], ['lineup', 'wLineup'],
  ];
  if (!keys.some(([, qk]) => q[qk] != null)) return undefined;
  const w: any = {};
  for (const [k, qk] of keys) {
    const v = Number(q[qk]);
    w[k] = Number.isFinite(v) && v >= 0 ? v : 0;
  }
  return w as FactorWeights;
}

// Predictions
// Déterministes à entrées égales (les poids personnalisés font partie de
// l'URL, donc de la clé de cache). Le cache HTTP est ici le SEUL — ces trois
// routes recalculent tout à chaque appel, y compris les prédictions dérivées.
// 5 min : les données sources (équipes, joueurs) ne bougent pas plus vite.
router.get('/predictions/game/:gameId', publicCache(TTL.SHORT), async (req, res) => {
  try { res.json(await buildGameMarkets(req.params.gameId, parseWeights(req.query))); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

router.get('/predictions/team/:abbr', publicCache(TTL.SHORT), async (req, res) => {
  try { res.json(await buildTeamMarkets(req.params.abbr)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

router.get('/predictions/player/:playerId', publicCache(TTL.SHORT), async (req, res) => {
  try { res.json(await buildPlayerMarkets(req.params.playerId)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Standings — dérivé de `fetchTeams` (TTL serveur 5 min).
router.get('/standings', publicCache(TTL.SHORT), async (_req, res) => {
  try { res.json(await nhl.getStandings()); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

export default router;
