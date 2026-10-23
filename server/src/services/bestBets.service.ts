/**
 * bestBets.service.ts
 * ------------------------------------------------------------------
 * Scans upcoming NHL games + top players across ALL bet markets,
 * scores every individual bet with the rule engine, then enriches the
 * strongest candidates with the ML model. The "display" score is
 * ML-first (falls back to rules when the ML service is unavailable).
 *
 * Returns the top-N individual bets sorted by prediction score.
 * Powers GET /api/predict/best-bets and the homepage "Best Bets" list.
 */

import {
  fetchGamesByDate,
  fetchTopPlayers,
} from './nhlApiClient';
import {
  predictMoneyline,
  predictTotalGoals,
  predictPuckLine,
  predictAnytimeGoal,
  predictShotsOU,
  predictPointsOU,
  predictPPPoint,
} from './predictionEngine';
import {
  buildGameFeatures,
} from './featureEngineering';
import { mlApiClient } from './mlApiClient';
import { priceForSelection } from './oddsClient';
import { TtlCache } from './ttlCache';
import { getGameMlBundle, mlBundleKey, type GameMlBundle } from './gameMlBundle';
import { ladderAtLeast, playerModelK } from './prediction/playerDispersion';
import { probAtLeast } from './prediction/playerRates';
import { mapLimit } from './concurrency';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BestBet {
  id:             string;
  subjectType:    'game' | 'player';
  marketType:     string;
  marketLabel:    string;
  subjectId:      string;   // game id or player id
  subjectName:    string;   // "BOS vs NYR" or "Connor McDavid"
  subjectLogo:    string;   // emoji fallback
  teamAbbr:       string | null;  // for building a team logo client-side
  label:          string;   // "BOS to win", "Over 5.5", "McDavid anytime goal"
  selection:      string;
  /** Machine-readable selection ('over' | 'under' | 'yes' | team abbr) — required for automatic settlement. */
  selectionValue: string;
  selectionShort: string;
  context:        string;   // "vs NYR · 7:00 PM ET"
  line:           number | null;
  gameId:         string | null;
  teamId:         string | null;
  playerId:       string | null;
  rulePct:        number;
  mlPct:          number | null;
  score:          number;   // display score = mlPct ?? rulePct
  source:         'ml' | 'rules';
  confidence:     'very_high' | 'high' | 'medium' | 'low' | 'very_low';
  /**
   * Vrai prix du livre d'affichage (BetRivers par défaut) pour ce pari,
   * ou `null` quand le livre ne le cote pas — presque tous les marchés joueurs.
   * Jamais déduit du modèle : voir `priceForSelection`.
   */
  bookPrice:      number | null;
  bookTitle:      string | null;
  /**
   * EV du pari au prix du livre, `score/100 × bookPrice − 1` ; `null` sans prix.
   * Pour information : la liste est triée par PROBABILITÉ (issues les plus
   * probables), pas par valeur — les value bets sont une autre section.
   */
  ev:             number | null;
  /**
   * Le match du pari : jour NHL, mise au jeu ISO, domicile / visiteur
   * (abréviations). Ajouté le 2026-10-04 pour « Best Parlay »
   * (`bestParlays.service.ts`), qui ne garde que des matchs pas commencés,
   * d'une même journée, et chiffre la corrélation des jambes d'un même match.
   */
  game:           BestBetGame | null;
}

export interface BestBetGame {
  date:         string | null;
  startTimeUTC: string | null;
  home:         string;
  away:         string;
}

interface Candidate extends Omit<BestBet, 'mlPct' | 'score' | 'source' | 'confidence' | 'bookPrice' | 'bookTitle' | 'ev'> {
  /** Domicile / extérieur, pour retrouver le prix du livre. Paris de match seulement. */
  teams?: { home: string; away: string };
  // how to build ML features for this candidate
  ml:
    // `homeId`/`awayId` décrivent le MATCH (qui reçoit) ; `subjectIsHome` dit de
    // quel côté porte la question (défaut : domicile). Voir `GameFeatureOpts`.
    | { kind: 'game'; homeId: string; awayId: string; marketType: string; line?: number; subjectIsHome?: boolean;
        /** Date du match (`gameDate` NHL) : repos, gardiens et absents se lisent à cette date. */
        gameDate?: string }
    | { kind: 'player'; playerId: string; propType: string; line: number; selection: string }
    | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function confidenceFor(pct: number): BestBet['confidence'] {
  if (pct >= 70) return 'very_high';
  if (pct >= 60) return 'high';
  if (pct >= 50) return 'medium';
  if (pct >= 40) return 'low';
  return 'very_low';
}

/** `'YYYY-MM-DD'` du jour NHL (heure de l'Est), décalé de `n` jours. */
export function etDate(n: number, now = new Date()): string {
  const today = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Matchs à proposer : ceux d'aujourd'hui PAS ENCORE COMMENCÉS + ceux de demain.
 *
 * 2026-10-07 (demande du user) : un Best Bet ne porte que sur un match qu'on
 * peut encore parier avant la mise au jeu — ni match en direct, ni match fini.
 *  • Les dates sont celles du jour NHL (heure de l'Est), comme les `gameDate`.
 *    Elles étaient en UTC : à partir de 20 h ET, « aujourd'hui » UTC était déjà
 *    le lendemain — les matchs de fin de soirée sautaient et la fenêtre
 *    débordait sur après-demain.
 *  • On ne garde que le statut `scheduled` ET une mise au jeu dans le futur :
 *    le statut du calendrier est en cache (jusqu'à 5 min), l'heure ne ment pas.
 *  • Les matchs en direct ne sont plus récupérés du tout (`fetchLiveGames`).
 */
async function fetchUpcomingGames(days: number, onlyDate?: string): Promise<any[]> {
  const now = Date.now();
  const dates: string[] = [];
  // Jour choisi sur l'accueil (2026-10-11) : ses seuls matchs, toujours à venir.
  if (onlyDate) dates.push(onlyDate);
  else for (let i = 0; i < days; i++) dates.push(etDate(i, new Date(now)));

  const results = await Promise.allSettled(dates.map((d) => fetchGamesByDate(d)));

  const all: any[] = [];
  for (const r of results) if (r.status === 'fulfilled') all.push(...r.value);

  const seen = new Set<string>();
  const games: any[] = [];
  for (const g of all) {
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    if (g.status !== 'scheduled') continue;            // en direct ou fini
    const start = g.startTimeUTC ? Date.parse(g.startTimeUTC) : NaN;
    if (Number.isFinite(start) && start <= now) continue; // déjà commencé
    games.push(g);
  }
  return games;
}

// ─── Candidate builders (rule scores) ─────────────────────────────────────────

async function buildGameCandidates(g: any): Promise<Candidate[]> {
  const home = g.homeTeam?.abbreviation ?? g.homeTeam?.id ?? '';
  const away = g.awayTeam?.abbreviation ?? g.awayTeam?.id ?? '';
  if (!home || !away) return [];

  const homeLc = String(home).toLowerCase();
  const awayLc = String(away).toLowerCase();
  const when   = g.startTime || g.period || '';
  const matchup = `${home} vs ${away}`;
  const line   = g.overUnder ?? 5.5;
  const gameDate: string | undefined = g.gameDate || undefined;
  const game: BestBetGame = {
    date: gameDate ?? null, startTimeUTC: g.startTimeUTC ?? null,
    home: String(home).toUpperCase(), away: String(away).toUpperCase(),
  };

  const [homeMl, awayMl, overPct, pl] = await Promise.all([
    predictMoneyline(homeLc, awayLc, true),
    predictMoneyline(awayLc, homeLc, false),
    predictTotalGoals(line, 'over', homeLc, awayLc),
    predictPuckLine(homeLc, awayLc, true),
  ]);
  const underPct = Math.max(3, 100 - overPct);

  const ctxHome = `vs ${away}${when ? ` · ${when}` : ''}`;
  const ctxAway = `vs ${home}${when ? ` · ${when}` : ''}`;

  return [
    {
      id: `bb-${g.id}-ml-home`, subjectType: 'game', marketType: 'moneyline', marketLabel: 'Moneyline',
      subjectId: g.id, subjectName: matchup, subjectLogo: '', teamAbbr: home,
      label: `${home} to win`, selection: `${home} to win`, selectionValue: homeLc, selectionShort: `${home} ML`,
      context: ctxHome, line: null, gameId: g.id, teamId: homeLc, playerId: null, rulePct: homeMl,
      teams: { home, away }, game,
      ml: { kind: 'game', homeId: homeLc, awayId: awayLc, gameDate, marketType: 'moneyline' },
    },
    {
      id: `bb-${g.id}-ml-away`, subjectType: 'game', marketType: 'moneyline', marketLabel: 'Moneyline',
      subjectId: g.id, subjectName: matchup, subjectLogo: '', teamAbbr: away,
      label: `${away} to win`, selection: `${away} to win`, selectionValue: awayLc, selectionShort: `${away} ML`,
      context: ctxAway, line: null, gameId: g.id, teamId: awayLc, playerId: null, rulePct: awayMl,
      teams: { home, away }, game,
      // Le visiteur reste le visiteur : jusqu'au 2026-10-02 on inversait les deux
      // équipes, donc le modèle répondait « P(le visiteur gagne CHEZ LUI) » — il
      // recevait l'avantage de la glace (le bug corrigé le 2026-09-09 sur les tuiles).
      ml: { kind: 'game', homeId: homeLc, awayId: awayLc, gameDate, marketType: 'moneyline', subjectIsHome: false },
    },
    {
      id: `bb-${g.id}-over`, subjectType: 'game', marketType: 'total_goals', marketLabel: 'Total Goals O/U',
      subjectId: g.id, subjectName: matchup, subjectLogo: '', teamAbbr: null,
      label: `Over ${line}`, selection: `Over ${line}`, selectionValue: 'over', selectionShort: `O${line}`,
      context: matchup, line, gameId: g.id, teamId: null, playerId: null, rulePct: overPct,
      teams: { home, away }, game,
      ml: { kind: 'game', homeId: homeLc, awayId: awayLc, gameDate, marketType: 'total_goals_over', line },
    },
    {
      id: `bb-${g.id}-under`, subjectType: 'game', marketType: 'total_goals', marketLabel: 'Total Goals O/U',
      subjectId: g.id, subjectName: matchup, subjectLogo: '', teamAbbr: null,
      label: `Under ${line}`, selection: `Under ${line}`, selectionValue: 'under', selectionShort: `U${line}`,
      context: matchup, line, gameId: g.id, teamId: null, playerId: null, rulePct: underPct,
      teams: { home, away }, game,
      ml: { kind: 'game', homeId: homeLc, awayId: awayLc, gameDate, marketType: 'total_goals_under', line },
    },
    {
      id: `bb-${g.id}-pl-home`, subjectType: 'game', marketType: 'puck_line', marketLabel: 'Puck Line',
      subjectId: g.id, subjectName: matchup, subjectLogo: '', teamAbbr: home,
      label: `${home} -1.5`, selection: `${home} -1.5`, selectionValue: homeLc, selectionShort: `${home} -1.5`,
      context: ctxHome, line: -1.5, gameId: g.id, teamId: homeLc, playerId: null, rulePct: pl,
      teams: { home, away }, game,
      ml: { kind: 'game', homeId: homeLc, awayId: awayLc, gameDate, marketType: 'puck_line', line: -1.5 },
    },
  ];
}

/** Le match d'une équipe dans la fenêtre — pour les paris joueur. */
interface TeamGame { matchup: string; when: string; gameId: string; game: BestBetGame }

async function buildPlayerCandidates(
  p: any,
  game: TeamGame,
): Promise<Candidate[]> {
  const pid  = String(p.id);
  const name = p.name ?? 'Player';
  const abbr = (p.teamId ?? '').toUpperCase() || null;
  const logo = '';
  const ctx  = `${game.matchup}${game.when ? ` · ${game.when}` : ''}`;

  const [atg, shots, points, pp] = await Promise.all([
    predictAnytimeGoal(pid).catch(() => 0),
    predictShotsOU(pid, 2.5, 'over').catch(() => 0),
    predictPointsOU(pid, 0.5, 'over').catch(() => 0),
    predictPPPoint(pid).catch(() => 0),
  ]);

  const mk = (
    suffix: string, marketType: string, marketLabel: string, label: string,
    short: string, line: number | null, rulePct: number,
    selectionValue: string, ml: Candidate['ml'],
  ): Candidate => ({
    id: `bb-p-${pid}-${suffix}`, subjectType: 'player', marketType, marketLabel,
    subjectId: pid, subjectName: name, subjectLogo: logo, teamAbbr: abbr,
    label, selection: label, selectionValue, selectionShort: short, context: ctx,
    line, gameId: game.gameId, teamId: null, playerId: pid, rulePct, ml, game: game.game,
  });

  return [
    mk('atg', 'anytime_goal', 'Anytime Goal', `${name} anytime goal`, 'ATG', null, atg, 'yes',
      { kind: 'player', playerId: pid, propType: 'goals', line: 0.5, selection: 'over' }),
    mk('shots', 'shots_ou', 'Shots O/U', `${name} over 2.5 shots`, 'O2.5 SOG', 2.5, shots, 'over',
      { kind: 'player', playerId: pid, propType: 'shots', line: 2.5, selection: 'over' }),
    mk('points', 'points_ou', 'Points O/U', `${name} over 0.5 points`, 'O0.5 PTS', 0.5, points, 'over',
      { kind: 'player', playerId: pid, propType: 'points', line: 0.5, selection: 'over' }),
    mk('pp', 'pp_point', 'PP Point', `${name} power-play point`, 'PPP', 0.5, pp, 'yes',
      { kind: 'player', playerId: pid, propType: 'pp_point', line: 0.5, selection: 'over' }),
  ];
}

// ─── ML enrichment ─────────────────────────────────────────────────────────────
//
// Chaque candidat est chiffré par le PAQUET ML de son match (`gameMlBundle.ts`),
// celui que la page du match affiche : même probabilité ici et là-bas.
// (ml/INCOHERENCES_ML.md §11.) Avant le 2026-10-03 :
//   • seuls les 30 premiers candidats SELON LES RÈGLES recevaient un score ML :
//     un pari que le ML classe haut mais que les règles classent bas n'entrait
//     jamais dans la liste ML ;
//   • les paris joueur passaient par `/predict/player` (Poisson sur la moyenne
//     de saison), pas par le modèle joueur de la page du match.
// Le paquet est en cache 10 minutes par match et partagé avec les pages de
// match et les value bets : chiffrer tous les candidats coûte un paquet par
// match, pas une requête par pari.

/** Statistique du modèle joueur derrière chaque prop des best bets. */
const PLAYER_STAT: Record<string, string> = {
  goals: 'goals', shots: 'shots', points: 'points', pp_point: 'ppPoints',
};

type BundleFor = (gameId: string) => Promise<GameMlBundle | null>;

/** Probabilité en % (entier) d'une issue, sur le paquet ML. `null` = pas de score ML. */
async function mlScore(c: Candidate, bundleFor: BundleFor): Promise<number | null> {
  if (!c.ml || !c.gameId) return null;
  const bundle = await bundleFor(c.gameId);
  if (c.ml.kind === 'player') {
    // Le modèle joueur, comme la page du match. Joueur inconnu du modèle
    // (recrue) : pas de score ML — la page du match lui garde aussi la règle.
    const stat = PLAYER_STAT[c.ml.propType];
    const rate = stat ? bundle?.playerRates?.[c.ml.playerId]?.[stat] : undefined;
    if (rate == null || !Number.isFinite(rate)) return null;
    const ladder = stat === 'pim' ? bundle?.playerPimLadder?.[c.ml.playerId] : undefined;
    const p = ladder?.length
      ? ladderAtLeast(ladder, Math.floor(c.ml.line) + 1)
      : probAtLeast(rate, Math.floor(c.ml.line) + 1, bundle ? playerModelK(bundle, stat, rate) : null);
    return Math.round((c.ml.selection === 'under' ? 1 - p : p) * 100);
  }
  const r = bundle?.byKey?.[mlBundleKey(c.ml.marketType, c.ml.line ?? null, null,
                                        c.ml.subjectIsHome !== false)];
  if (r && typeof r.probability === 'number') {
    const exact = r.probability_exact;
    return Math.round(typeof exact === 'number' && Number.isFinite(exact) ? exact * 100 : r.probability);
  }
  // Question absente du paquet (ligne de total que la page ne cote pas) :
  // appel dédié, mêmes features (date du match comprise).
  try {
    const feats = await buildGameFeatures(c.ml.homeId, c.ml.awayId, c.ml.marketType, c.ml.line,
                                          { subjectIsHome: c.ml.subjectIsHome !== false,
                                            gameDate: c.ml.gameDate });
    const res = await mlApiClient.predictGame(feats);
    return typeof res?.probability === 'number' ? Math.round(res.probability) : null;
  } catch {
    return null; // service ML indisponible → pas de score ML
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────

export interface BestBetsOptions {
  limit?:       number;   // how many bets to return (default 15)
  source?:      'ml' | 'rules';  // preferred display score (default 'ml')
  days?:        number;   // look-ahead window in days (default 2 = tonight + tomorrow)
  maxPlayers?:  number;   // how many top players to scan (default 15)
  /** Ignoré depuis le 2026-10-03 : TOUS les candidats sont chiffrés par le paquet ML. */
  mlDepth?:     number;
  /**
   * Jour NHL (AAAA-MM-JJ) choisi sur l'accueil : seuls ses matchs comptent, et
   * `days` est ignoré. Hors de la fenêtre admise (voir `normalizeDate`) → ignoré.
   */
  date?:        string;
}

interface NormalizedOptions {
  limit:      number;
  source:     'ml' | 'rules';
  days:       number;
  maxPlayers: number;
  mlDepth:    number;
  date?:      string;
}

export interface BestBetsResult {
  bets: BestBet[];
  meta: { generatedAt: string; source: string; mlAvailable: boolean; scanned: number };
}

/**
 * Borne chaque option dans un intervalle sûr. C'est aussi ce qui rend l'espace
 * des clés de cache fini : une requête ne peut pas fabriquer une clé arbitraire.
 */
function normalizeOptions(opts: BestBetsOptions): NormalizedOptions {
  const num = (v: number | undefined, dflt: number, lo: number, hi: number) =>
    Math.min(Math.max(Number.isFinite(v as number) ? Math.trunc(v as number) : dflt, lo), hi);
  return {
    limit:      num(opts.limit,      15, 1, 50),
    source:     opts.source === 'rules' ? 'rules' : 'ml',
    days:       num(opts.days,        2, 1,  7),
    maxPlayers: num(opts.maxPlayers, 15, 0, 40),
    mlDepth:    num(opts.mlDepth,    30, 0, 60),
    date:       normalizeDate(opts.date),
  };
}

/**
 * Date admise : de la veille à J+8 (jour de l'Est). Comme `days`, elle entre
 * dans la clé de cache — la fenêtre garde l'espace des clés fini (10 dates).
 * La veille et J+8 couvrent l'écart entre le jour UTC de l'accueil et le jour
 * NHL de l'Est.
 */
export function normalizeDate(raw: unknown, now = new Date()): string | undefined {
  const d = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return undefined;
  for (let n = -1; n <= 8; n++) if (etDate(n, now) === d) return d;
  return undefined;
}

/**
 * Cache de réponse, TTL 60 s.
 *
 * Un seul appel à `computeBestBets` déclenche des dizaines de requêtes HTTP
 * sortantes (NHL API + jusqu'à `mlDepth` prédictions ML). Sans cache, le coût
 * est linéaire au nombre de visiteurs et sature le service Python bien avant
 * le CPU du serveur Node. `TtlCache.wrap` dédoublonne également les requêtes
 * concurrentes : 500 arrivées simultanées sur un cache froid (typiquement
 * juste après un redéploiement) ne déclenchent qu'UNE exécution.
 *
 * L'objet retourné est partagé entre appelants — il ne doit pas être muté.
 */
const BEST_BETS_TTL = 60_000;
const bestBetsCache = new TtlCache<BestBetsResult>(BEST_BETS_TTL, 50, 'best-bets');
/**
 * Passé le TTL, une liste de moins de 30 min est servie tout de suite pendant
 * qu'un recalcul part en fond (`wrapSwr`, PERF_PLAN.md P1.2) : un calcul à
 * froid faisait attendre 4,9 s. Les paris dont le match a commencé sont de
 * toute façon retirés à l'affichage (`isPastGame`, BestBetsSection).
 */
const BEST_BETS_STALE_MS = Number(process.env.BEST_BETS_STALE_MS) || 30 * 60_000;

/** Plafond de `limit` (cf. `normalizeOptions`) : c'est à cette profondeur que
 *  l'on calcule et met en cache, une fois pour toutes les valeurs demandées. */
const LIMIT_MAX = 50;

/**
 * `limit` N'ENTRE PAS DANS LA CLÉ DE CACHE, et c'est le point de cette fonction.
 *
 * LE DÉFAUT QUE ÇA CORRIGE (banc `loadtest/bench/b8-clecache.ts`, 2026-09-18)
 *
 * La version précédente construisait sa clé avec `limit|days|maxPlayers|source|
 * mlDepth`. Or `limit` ne change pas le calcul : `computeBestBets` trie la
 * liste complète puis la TRONQUE en dernière ligne. Le mettre dans la clé
 * transformait donc 50 façons de demander la même chose en 50 calculs
 * distincts — dans un cache qui n'a que 50 entrées.
 *
 * Mesuré : `?limit=1`, `?limit=2`… `?limit=20` → **19 recalculs complets pour
 * 20 requêtes**, à ~40 ms de CPU chacun, contre ~2 ms servies depuis le cache.
 * Et `best-bets` n'est pas sous `predictLimiter`, seulement sous `apiLimiter`
 * (300 req/min/IP en production) : une seule adresse pouvait donc imposer
 * 300 recalculs par minute et contourner intégralement la protection
 * anti-troupeau que `TtlCache.wrap` apporte — celle-ci ne protège qu'UNE clé,
 * et l'appelant choisissait la sienne.
 *
 * LA RÈGLE GÉNÉRALE, qui vaut au-delà d'ici : un paramètre qui change la
 * PRÉSENTATION d'un résultat n'a rien à faire dans la clé du cache ; seuls
 * ceux qui changent le CALCUL y ont leur place. `days`, `maxPlayers`, `source`
 * et `mlDepth` changent le calcul — ils restent dans la clé.
 *
 * On calcule donc au plafond (`LIMIT_MAX`), on met CELA en cache, et on tranche
 * à la sortie. Les réponses sont identiques à l'octet près pour tout
 * `limit ≤ 50`, et l'espace des clés est divisé par 50.
 *
 * L'objet en cache ne doit pas être muté : `slice` en construit un nouveau, et
 * l'enveloppe retournée est également neuve. `meta` est partagée, en lecture
 * seule comme avant.
 */
export async function getBestBets(opts: BestBetsOptions = {}): Promise<BestBetsResult> {
  const o = normalizeOptions(opts);
  // `mlDepth` n'entre plus dans la clé : il ne change plus le calcul.
  const key = `${o.date ?? o.days}|${o.maxPlayers}|${o.source}`;

  const complet = await bestBetsCache.wrapSwr(key, () => computeBestBets({ ...o, limit: LIMIT_MAX }), BEST_BETS_STALE_MS);

  if (complet.bets.length <= o.limit) return complet;
  return { bets: complet.bets.slice(0, o.limit), meta: complet.meta };
}

async function computeBestBets(o: NormalizedOptions): Promise<BestBetsResult> {
  const { limit, source, days, maxPlayers, date } = o;

  // 1. Gather subjects (only games tonight / next `days` days)
  const [games, allPlayers] = await Promise.all([
    fetchUpcomingGames(days, date).catch(() => []),
    maxPlayers > 0 ? fetchTopPlayers().catch(() => []) : Promise.resolve([]),
  ]);

  // Which teams actually play in this window → team abbr (lowercase) → game info.
  // Player props are ONLY built for players whose team appears here.
  // gameId is required so a player-prop bet placed from here can later be
  // auto-settled — without it, settlement can never look up the boxscore.
  const teamGame = new Map<string, TeamGame>();
  for (const g of games) {
    const home = String(g.homeTeam?.abbreviation ?? g.homeTeam?.id ?? '').toLowerCase();
    const away = String(g.awayTeam?.abbreviation ?? g.awayTeam?.id ?? '').toLowerCase();
    if (!home || !away) continue;
    const matchup = `${home.toUpperCase()} vs ${away.toUpperCase()}`;
    const when    = g.startTime || g.period || '';
    const info: TeamGame = {
      matchup, when, gameId: String(g.id),
      game: { date: g.gameDate || null, startTimeUTC: g.startTimeUTC ?? null,
              home: home.toUpperCase(), away: away.toUpperCase() },
    };
    if (!teamGame.has(home)) teamGame.set(home, info);
    if (!teamGame.has(away)) teamGame.set(away, info);
  }

  // Keep only players whose team is playing, then cap to maxPlayers.
  const playingPlayers = allPlayers
    .filter((p: any) => teamGame.has(String(p.teamId ?? '').toLowerCase()))
    .slice(0, maxPlayers);

  // 2. Build candidates with rule scores
  const candidateGroups = await Promise.all([
    ...games.map((g) => buildGameCandidates(g).catch(() => [] as Candidate[])),
    ...playingPlayers.map((p: any) =>
      buildPlayerCandidates(p, teamGame.get(String(p.teamId).toLowerCase())!).catch(() => [] as Candidate[]),
    ),
  ]);
  const candidates: Candidate[] = candidateGroups.flat();

  // 3. Score ML de TOUS les candidats, par le paquet ML de leur match (un par
  //    match, partagé avec les pages de match). Préchargés 4 par 4 : à froid,
  //    un paquet fait tourner tout un match côté Python.
  // Skip ML entirely when it's disabled (deferred deployment) — avoids wasted
  // calls to an absent Python service and keeps the endpoint fast on rules.
  const mlDisabled = process.env.ML_DISABLED === 'true';
  const toEnrich = (source === 'ml' && !mlDisabled) ? candidates : [];
  const bundles = new Map<string, Promise<GameMlBundle | null>>();
  const bundleFor: BundleFor = (gameId) => {
    if (!bundles.has(gameId)) bundles.set(gameId, getGameMlBundle(gameId).catch(() => null));
    return bundles.get(gameId)!;
  };
  const gameIds = [...new Set(toEnrich.map((c) => c.gameId).filter((g): g is string => !!g))];
  await mapLimit(gameIds, 4, (id) => bundleFor(id));
  const mlResults = await Promise.all(toEnrich.map((c) => mlScore(c, bundleFor)));
  const mlAvailable = mlResults.some((r) => r != null);
  const mlById = new Map<string, number | null>();
  toEnrich.forEach((c, i) => mlById.set(c.id, mlResults[i]));

  // 4. Finalise: display score = ML if present else rules
  const bets: BestBet[] = candidates.map((c) => {
    const mlPct = mlById.has(c.id) ? mlById.get(c.id)! : null;
    const useMl = source === 'ml' && mlPct != null;
    const score = useMl ? mlPct : c.rulePct;
    const { ml, teams, ...rest } = c;
    return {
      ...rest,
      mlPct,
      score,
      source: useMl ? 'ml' : 'rules',
      confidence: confidenceFor(score),
      bookPrice: null,
      bookTitle: null,
      ev: null,
    };
  });

  // 5. Tri : issues les plus PROBABLES d'abord (pas les plus rentables — les
  //    value bets sont une autre section). En mode ML, jamais d'échelles
  //    mélangées : les paris chiffrés par le ML passent d'abord, triés par
  //    leur %, puis ceux sans score ML (joueur inconnu du modèle), par la
  //    règle. Le client, en mode IA, n'affiche de toute façon que les premiers.
  bets.sort((a, b) => (Number(b.source === 'ml') - Number(a.source === 'ml')) || (b.score - a.score));
  const kept = bets.slice(0, limit);

  // 6. Vrais prix du livre d'affichage, pour les seuls paris de match gardés.
  //    Aucun crédit de plus : un seul appel en cache sert toutes les lignes.
  //    Un flux de cotes en panne ne retire aucun pari — il reste sans prix.
  const teamsById = new Map(candidates.map((c) => [c.id, c.teams]));
  await Promise.all(kept.map(async (b) => {
    const teams = teamsById.get(b.id);
    if (!teams) return;
    try {
      const p = await priceForSelection({
        homeAbbr: teams.home, awayAbbr: teams.away, marketType: b.marketType,
        selectionValue: b.selectionValue, line: b.line,
      });
      if (p) {
        b.bookPrice = p.price; b.bookTitle = p.bookTitle;
        b.ev = Math.round(((b.score / 100) * p.price - 1) * 10_000) / 10_000;
      }
    } catch { /* sans prix */ }
  }));

  // 7. Journal des best bets (`best_bet_log`, page /dev/profit). Seulement la
  //    liste de l'accueil — options par défaut — pour que les rangs journalisés
  //    soient ceux que l'utilisateur voit. Sans attendre : un journal en panne
  //    ne retarde ni ne retire aucun pari. Import dynamique : le journal tire
  //    le règlement (et toute sa chaîne), inutile au calcul lui-même.
  //    Depuis le 2026-10-11, l'accueil demande le JOUR choisi : on journalise
  //    celui d'aujourd'hui (le défaut sans date reste journalisé aussi).
  const logged = date ? date === etDate(0) : days === 2;
  if (logged && maxPlayers === 15 && source === 'ml' && process.env.NODE_ENV !== 'test') {
    void import('./bestBetLog.service')
      .then((m) => m.logBestBets(kept))
      .catch(() => { /* journal facultatif */ });
  }

  return {
    bets: kept,
    meta: {
      generatedAt: new Date().toISOString(),
      source,
      mlAvailable,
      scanned: candidates.length,
    },
  };
}

/** Tests uniquement. */
export function _clearBestBetsCache(): void { bestBetsCache.clear(); }
