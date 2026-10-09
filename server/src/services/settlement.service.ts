/**
 * settlement.service.ts — Automatic bet settlement.
 *
 * Checks pending slips against real NHL results (official NHL API) and
 * resolves them automatically:
 *   - every leg must reference a finished game (legs carry `gameId` and
 *     `selectionValue`, stored at bet time)
 *   - any lost leg → the whole slip is a loss (parlay semantics)
 *   - all legs won → the slip is a win
 *   - unsupported markets or unfinished games → the slip stays pending
 *
 * XP is risk-based (see xpForOutcome in slip.service):
 *   win  → more XP the riskier the bet was
 *   loss → more XP lost the safer the bet was
 *   The loss penalty is proportional to the number of lost legs:
 *   winning every leg but one costs far less than losing them all.
 *
 * Supported markets:
 *   - Game markets: moneyline, total_goals (over/under), puck_line.
 *   - Player-prop markets (via boxscore, once the game is final): anytime_goal
 *     (respects the leg's line, e.g. "Over 1.5 goals"), shots_ou, assists_ou,
 *     points_ou, blocked_shots_ou, hits_ou, penalty_minutes_ou, time_on_ice_ou,
 *     goalie_saves_ou, goalie_win, goalie_shutout, faceoff_wins_ou (via
 *     play-by-play — a heavier fetch, kept separate from the boxscore ones).
 *   - Player-prop markets (via the landing endpoint's scoring summary — goal
 *     order + strength state, once the game is final): first_goal_scorer,
 *     last_goal_scorer, pp_point, pp_goal.
 *   - Team markets (via the same scoring summary): first_team_score,
 *     last_team_score, team_total_goals, team_pp_goals, clean_sheet,
 *     team_score_every_period.
 *   - both_teams_score (via the final score) — see the block for why the final
 *     score settles it correctly even after a shootout.
 *   - Period markets (via the same scoring summary): period1/2/3_winner,
 *     period1/2/3_total_goals, highest_scoring_period.
 *   Each leg needs gameId recorded at bet time, plus subjectId (player or
 *   team id) for the markets that need one.
 *
 *   - Les marchés de match restants, ajoutés en sept. 2026 après l'audit qui a
 *     trouvé des coupons figés : game_to_ot, ot_so_winner (« gagne en OT/SO »,
 *     inconditionnel), ot_winner (CONDITIONNEL — annulé sans prolongation, comme
 *     chez les books), regulation_result, alt_puck_line, winning_margin,
 *     team_penalty_kill, total_penalties.
 *
 * Plus AUCUN marché proposé à l'écran n'est sans règle ici. C'est une propriété
 * à tenir, pas un état de fait : le `default` de `decideLeg` annule désormais
 * une jambe dont le marché est inconnu (au lieu de la laisser figer le coupon),
 * et le compteur `voided` de `SettlementSummary` grimpe quand ça arrive. Un
 * marché ajouté à l'écran sans règle ici se signale donc tout seul.
 *
 * ── Où est l'équipe d'un pari ───────────────────────────────────────────────
 *
 * À deux endroits selon l'écran qui l'a posé — `selectionValue` depuis la page
 * match, `subjectId` depuis le sélecteur de marché (qui met `"yes"` dans
 * `selectionValue` par défaut). `pickTeam` lit les deux, plus les littéraux
 * `home` / `away` d'`alt_puck_line`. Ne lire que le premier écartait en silence
 * tous les paris posés depuis le sélecteur.
 */

import { pool } from '../db/connection';
import {
  fetchGameById, fetchGameBoxscore, fetchGameScoringPlays, fetchGameFaceoffWins,
  type BoxscorePlayerStats, type ScoringGoal,
} from './nhlApiClient';
import { applyXpDelta, xpForOutcome } from './slip.service';
import { logger } from '../logger';
import { withJobLock } from './jobLock';
import { mapLimit } from './concurrency';
import { parseMarginBucket } from './prediction/marginPeriods';

/**
 * `void` : la jambe ne sera JAMAIS décidable — marché sans règle de règlement,
 * champ manquant à la prise du pari, égalité sur la ligne. Elle sort du calcul
 * du coupon au lieu de le figer. `unknown` reste « pas encore » : match non
 * terminé, ou amont muet. Voir `settleLeg` pour le passage de l'un à l'autre.
 */
export type LegResult = 'win' | 'loss' | 'void' | 'unknown';

// Small per-run cache so a slip with 5 legs on the same game fetches it once
type GameCache     = Map<string, any | null>;
type BoxCache      = Map<string, Map<string, BoxscorePlayerStats> | null>;
type ScoringCache  = Map<string, ScoringGoal[] | null>;
type FaceoffCache  = Map<string, Map<string, number> | null>;

async function getFinalGame(gameId: string, cache: GameCache): Promise<any | null> {
  if (cache.has(gameId)) return cache.get(gameId);
  let game: any | null = null;
  try {
    const g = await fetchGameById(String(gameId));
    if (g?.status === 'final' && g.homeTeam?.score != null && g.awayTeam?.score != null) {
      game = g;
    }
  } catch { /* game not found / API down → stays unknown */ }
  cache.set(gameId, game);
  return game;
}

/** Boxscore stats for one player in one (final) game, or null if unavailable. */
async function getPlayerBox(
  gameId: string,
  playerId: string,
  gameCache: GameCache,
  boxCache: BoxCache,
): Promise<BoxscorePlayerStats | null> {
  const game = await getFinalGame(gameId, gameCache);
  if (!game) return null; // only trust the boxscore once the game is final

  if (!boxCache.has(gameId)) {
    let box: Map<string, BoxscorePlayerStats> | null = null;
    try { box = await fetchGameBoxscore(gameId); } catch { box = null; }
    boxCache.set(gameId, box);
  }
  return boxCache.get(gameId)?.get(String(playerId)) ?? null;
}

/** Chronological goal list for one (final) game, or null if unavailable. */
async function getScoringPlays(
  gameId: string,
  gameCache: GameCache,
  scoringCache: ScoringCache,
): Promise<ScoringGoal[] | null> {
  const game = await getFinalGame(gameId, gameCache);
  if (!game) return null; // only trust the scoring summary once the game is final

  if (!scoringCache.has(gameId)) {
    let goals: ScoringGoal[] | null = null;
    try { goals = await fetchGameScoringPlays(gameId); } catch { goals = null; }
    scoringCache.set(gameId, goals);
  }
  return scoringCache.get(gameId) ?? null;
}

/** Faceoff win counts by player for one (final) game, or null if unavailable. */
async function getFaceoffWins(
  gameId: string,
  gameCache: GameCache,
  faceoffCache: FaceoffCache,
): Promise<Map<string, number> | null> {
  const game = await getFinalGame(gameId, gameCache);
  if (!game) return null; // only trust play-by-play once the game is final

  if (!faceoffCache.has(gameId)) {
    let wins: Map<string, number> | null = null;
    try { wins = await fetchGameFaceoffWins(gameId); } catch { wins = null; }
    faceoffCache.set(gameId, wins);
  }
  return faceoffCache.get(gameId) ?? null;
}

/**
 * Goals scored per team, per regulation period (index 0 = P1, 1 = P2, 2 = P3).
 * OT/SO goals are excluded — period1/2/3 markets only cover regulation.
 */
function periodGoalCounts(goals: ScoringGoal[]): { home: number[]; away: number[] } {
  const home = [0, 0, 0];
  const away = [0, 0, 0];
  for (const g of goals) {
    if (g.periodType !== 'REG' || g.periodNumber < 1 || g.periodNumber > 3) continue;
    (g.isHome ? home : away)[g.periodNumber - 1]++;
  }
  return { home, away };
}

const PLAYER_STAT_MARKETS: Record<string, keyof BoxscorePlayerStats> = {
  shots_ou:           'shots',
  assists_ou:         'assists',
  points_ou:          'points',
  blocked_shots_ou:   'blockedShots',
  hits_ou:            'hits',
  penalty_minutes_ou: 'pim',
  time_on_ice_ou:     'toi',
};

/** Abréviations des deux équipes d'un match, en minuscules (forme de `selectionValue`). */
function teamIds(game: any): { homeId: string; awayId: string } {
  return {
    homeId: String(game.homeTeam.abbreviation ?? '').toLowerCase(),
    awayId: String(game.awayTeam.abbreviation ?? '').toLowerCase(),
  };
}

/**
 * L'équipe sur laquelle porte une jambe, d'où qu'elle vienne.
 *
 * ── Deux vocabulaires, une seule lecture ────────────────────────────────────
 *
 * L'équipe d'un pari est enregistrée à DEUX endroits selon l'écran qui l'a
 * posé, et le règlement n'en lisait qu'un :
 *
 *   · page match — `settlementFields` retombe sur le sujet quand la tuile n'a
 *     pas de sélection propre, donc `selectionValue` contient l'abréviation ;
 *   · sélecteur de marché — `selectionValue` vaut la sélection du marché, et
 *     pour un marché qui n'en propose aucune elle vaut `"yes"` par défaut
 *     (`MarketSelectorSheet`). L'équipe n'est QUE dans `subjectId`.
 *
 * Résultat : un simple « moneyline » ajouté depuis le sélecteur arrivait ici
 * avec `selectionValue = "yes"`, ne correspondait à aucune des deux équipes, et
 * n'était jamais réglé. Le marché le plus courant de l'application, par le
 * chemin le plus courant.
 *
 * On lit donc les deux, dans cet ordre : une sélection explicite l'emporte (elle
 * est plus précise — elle peut désigner l'adversaire du sujet), le sujet sert de
 * repli.
 */
function pickTeam(leg: any, game: any): { homeId: string; awayId: string; sel: string } | null {
  const { homeId, awayId } = teamIds(game);
  for (const candidate of [leg?.selectionValue, leg?.subjectId]) {
    if (candidate == null) continue;
    const v = String(candidate).trim().toLowerCase();
    if (v === homeId || v === awayId) return { homeId, awayId, sel: v };
    // `alt_puck_line` désigne son camp par « home » / « away » plutôt que par
    // une abréviation (`betMarkets.ts`). C'est un troisième vocabulaire, et il
    // ne coûte que ces deux lignes.
    if (v === 'home') return { homeId, awayId, sel: homeId };
    if (v === 'away') return { homeId, awayId, sel: awayId };
  }
  return null;
}

/**
 * Le côté « oui / non » d'un marché binaire, traduit en over/under.
 *
 * Même histoire que `pickTeam` : la tuile « Scores a PP Goal » annonce `yes`,
 * le sélecteur de marché annonce `over` — c'est le même pari. Le règlement ne
 * comprenait que le second.
 */
function overUnderSide(selectionValue: unknown): 'over' | 'under' | null {
  const v = String(selectionValue ?? '').trim().toLowerCase();
  if (v === 'over'  || v === 'yes') return 'over';
  if (v === 'under' || v === 'no')  return 'under';
  return null;
}

/**
 * Match terminé + équipe choisie par la jambe. `null` si le match n'est pas
 * fini ou si ni la sélection ni le sujet ne désignent une des deux équipes.
 */
async function teamPick(
  leg: any, cache: GameCache,
): Promise<{ game: any; homeId: string; awayId: string; sel: string } | null> {
  const game = await getFinalGame(String(leg.gameId), cache);
  if (!game) return null;
  const pick = pickTeam(leg, game);
  return pick ? { game, ...pick } : null;
}

/** Decide a single leg from the final score (or, for player/team props, the boxscore / scoring summary). */
async function decideLeg(
  leg: any, cache: GameCache, boxCache: BoxCache, scoringCache: ScoringCache, faceoffCache: FaceoffCache,
): Promise<LegResult> {
  // `gameId` est indispensable — sans lui on ne sait même pas quel match lire.
  // `selectionValue`, NON : « le joueur marque », « l'équipe blanchit », « le
  // match va en prolongation » n'ont pas de sélection, et la refuser d'entrée
  // écartait ces paris avant même d'atteindre leur règle. Chaque branche vérifie
  // ce dont ELLE a besoin.
  if (!leg?.gameId) return 'unknown';

  if (leg.marketType === 'faceoff_wins_ou') {
    if (!leg.subjectId) return 'unknown';
    const line = Number(leg.line);
    if (!Number.isFinite(line)) return 'unknown';
    const wins = await getFaceoffWins(String(leg.gameId), cache, faceoffCache);
    if (!wins) return 'unknown';
    const value = wins.get(String(leg.subjectId)) ?? 0;
    const sel = String(leg.selectionValue).toLowerCase();
    if (value === line) return 'unknown'; // push
    if (sel === 'over')  return value > line ? 'win' : 'loss';
    if (sel === 'under') return value < line ? 'win' : 'loss';
    return 'unknown';
  }

  if (leg.marketType === 'anytime_goal') {
    if (!leg.subjectId) return 'unknown';
    // Line defaults to 0.5 ("scores at least once"), but also generalizes to
    // "Over 1.5" etc. — the client sets an explicit line for those.
    const line = Number.isFinite(Number(leg.line)) ? Number(leg.line) : 0.5;
    const stats = await getPlayerBox(String(leg.gameId), String(leg.subjectId), cache, boxCache);
    if (!stats) return 'unknown';
    return stats.goals > line ? 'win' : 'loss';
  }

  if (leg.marketType === 'goalie_win') {
    if (!leg.subjectId) return 'unknown';
    const stats = await getPlayerBox(String(leg.gameId), String(leg.subjectId), cache, boxCache);
    if (!stats || !stats.decision) return 'unknown';
    return stats.decision.toUpperCase() === 'W' ? 'win' : 'loss';
  }

  if (leg.marketType === 'goalie_shutout') {
    if (!leg.subjectId) return 'unknown';
    const stats = await getPlayerBox(String(leg.gameId), String(leg.subjectId), cache, boxCache);
    if (!stats || stats.goalsAgainst == null) return 'unknown';
    return stats.goalsAgainst === 0 ? 'win' : 'loss';
  }

  if (leg.marketType === 'goalie_saves_ou') {
    if (!leg.subjectId) return 'unknown';
    const line = Number(leg.line);
    if (!Number.isFinite(line)) return 'unknown';
    const stats = await getPlayerBox(String(leg.gameId), String(leg.subjectId), cache, boxCache);
    if (!stats || stats.saves == null) return 'unknown';
    const sel = String(leg.selectionValue).toLowerCase();
    if (stats.saves === line) return 'unknown'; // push
    if (sel === 'over')  return stats.saves > line ? 'win' : 'loss';
    if (sel === 'under') return stats.saves < line ? 'win' : 'loss';
    return 'unknown';
  }

  if (leg.marketType === 'first_goal_scorer' || leg.marketType === 'last_goal_scorer') {
    if (!leg.subjectId) return 'unknown';
    const goals = await getScoringPlays(String(leg.gameId), cache, scoringCache);
    if (!goals) return 'unknown';
    if (goals.length === 0) return 'unknown'; // no goals scored (rare 0-0 → SO game) — can't verify either way
    const target = leg.marketType === 'first_goal_scorer' ? goals[0] : goals[goals.length - 1];
    return target.playerId === String(leg.subjectId) ? 'win' : 'loss';
  }

  if (leg.marketType === 'pp_point' || leg.marketType === 'pp_goal') {
    if (!leg.subjectId) return 'unknown';
    const goals = await getScoringPlays(String(leg.gameId), cache, scoringCache);
    if (!goals) return 'unknown';
    const subjectId = String(leg.subjectId);
    const involved = goals.some((g) => {
      if (g.strength !== 'pp') return false;
      if (leg.marketType === 'pp_goal') return g.playerId === subjectId; // scorer only
      return g.playerId === subjectId || g.assistPlayerIds.includes(subjectId); // scorer or assist
    });
    return involved ? 'win' : 'loss';
  }

  // ── Team markets ──────────────────────────────────────────────────────────
  if (leg.marketType === 'first_team_score' || leg.marketType === 'last_team_score') {
    const pick = await teamPick(leg, cache);
    if (!pick) return 'unknown';
    const { homeId, awayId, sel } = pick;
    const goals = await getScoringPlays(String(leg.gameId), cache, scoringCache);
    if (!goals) return 'unknown';
    if (goals.length === 0) return 'unknown'; // no goals scored at all — can't verify either way
    const target = leg.marketType === 'first_team_score' ? goals[0] : goals[goals.length - 1];
    const winner = target.isHome ? homeId : awayId;
    return sel === winner ? 'win' : 'loss';
  }

  if (leg.marketType === 'team_total_goals' || leg.marketType === 'team_pp_goals') {
    const game = await getFinalGame(String(leg.gameId), cache);
    if (!game) return 'unknown';
    const pick = pickTeam(leg, game);
    if (!pick) return 'void';
    const { homeId } = pick;
    const teamId = pick.sel;

    /**
     * Ligne implicite pour « Scores a PP Goal ».
     *
     * La tuile de la page match annonce `team_pp_goals` + `yes`, sans ligne :
     * « marque au moins un but en avantage numérique », c'est-à-dire plus de
     * 0,5. Le sélecteur de marché, lui, envoie une ligne explicite. Sans ce
     * défaut, la tuile — le chemin le plus utilisé — était refusée faute de
     * ligne, alors que son sens ne laisse aucune place au doute.
     *
     * `team_total_goals` n'a PAS de défaut : « plus de combien ? » n'a pas de
     * réponse évidente, et en inventer une réglerait un pari sur une ligne que
     * le joueur n'a jamais vue.
     */
    const line = Number.isFinite(Number(leg.line))
      ? Number(leg.line)
      : (leg.marketType === 'team_pp_goals' ? 0.5 : NaN);
    if (!Number.isFinite(line)) return 'void';

    const side = overUnderSide(leg.selectionValue);
    if (!side) return 'void';

    let value: number;
    if (leg.marketType === 'team_total_goals') {
      value = Number(teamId === homeId ? game.homeTeam.score : game.awayTeam.score);
    } else {
      const goals = await getScoringPlays(String(leg.gameId), cache, scoringCache);
      if (!goals) return 'unknown';
      const isHomeTeam = teamId === homeId;
      value = goals.filter((g) => g.strength === 'pp' && g.isHome === isHomeTeam).length;
    }
    if (!Number.isFinite(value)) return 'unknown';
    if (value === line) return 'void'; // égalité sur la ligne
    return side === 'over'
      ? (value > line ? 'win' : 'loss')
      : (value < line ? 'win' : 'loss');
  }

  if (leg.marketType === 'clean_sheet') {
    const pick = await teamPick(leg, cache);
    if (!pick) return 'void';
    const { game, homeId, sel } = pick;
    const opponentScore = Number(sel === homeId ? game.awayTeam.score : game.homeTeam.score);
    if (!Number.isFinite(opponentScore)) return 'unknown';
    // La tuile n'offre que le côté « oui », mais le sélecteur de marché peut
    // offrir « non ». `null` (aucune sélection lisible) = le côté « oui », qui
    // est le sens du marché quand personne ne dit le contraire.
    const shutout = opponentScore === 0;
    const side = overUnderSide(leg.selectionValue);
    return (side === 'under') === !shutout ? 'win' : 'loss';
  }

  if (leg.marketType === 'both_teams_score') {
    const game = await getFinalGame(String(leg.gameId), cache);
    if (!game) return 'unknown';

    // Le côté du pari. Jusqu'au correctif BTTS de sept. 2026, `selectionValue`
    // portait l'abréviation de l'équipe à domicile pour les DEUX tuiles (le
    // côté n'existait pas) : ces paris-là sont indécidables et doivent rester
    // en attente. D'où la comparaison stricte à 'yes' / 'no' — un défaut par
    // « tout ce qui n'est pas no vaut yes » réglerait d'anciens paris à pile ou
    // face.
    const sel = String(leg.selectionValue ?? '').toLowerCase();
    if (sel !== 'yes' && sel !== 'no') return 'unknown';

    const homeScore = Number(game.homeTeam?.score);
    const awayScore = Number(game.awayTeam?.score);
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return 'unknown';

    // POURQUOI LE SCORE FINAL SUFFIT, TIRS DE BARRAGE COMPRIS.
    //
    // Les bookmakers règlent BTTS prolongation incluse mais fusillade exclue, et
    // le but de fusillade est justement un but comptable, pas un vrai but. Or
    // il ne peut CHANGER la réponse dans aucun cas :
    //
    //   · fusillade ⇒ égalité après prolongation, donc score k–k ;
    //   · si k ≥ 1, les deux équipes ont déjà marqué → « oui » dans tous les cas ;
    //   · si k = 0, la fusillade donne 1–0 → une équipe reste à zéro → « non ».
    //
    // Le score final et la règle « hors fusillade » donnent donc toujours le
    // même verdict, et on peut se passer du détail des buts.
    //
    // SEUIL. « Les deux marquent 2+ / 3+ » (tableau de la page match) porte sa
    // ligne dans `leg.line` (1.5, 2.5). Sans ligne = 1+, la tuile historique.
    // Le même raisonnement vaut à tout seuil j : une fusillade transforme k–k
    // en (k+1)–k, et le perdant reste à k — le verdict « les deux ≥ j » ne
    // change donc jamais.
    const line = Number.isFinite(Number(leg.line)) ? Number(leg.line) : 0.5;
    const bothScored = homeScore > line && awayScore > line;
    return (sel === 'yes') === bothScored ? 'win' : 'loss';
  }

  if (leg.marketType === 'team_score_every_period') {
    const pick = await teamPick(leg, cache);
    if (!pick) return 'unknown';
    const { homeId, sel } = pick;
    const goals = await getScoringPlays(String(leg.gameId), cache, scoringCache);
    if (!goals) return 'unknown';
    const { home, away } = periodGoalCounts(goals);
    const counts = sel === homeId ? home : away;
    return counts.every((c) => c >= 1) ? 'win' : 'loss';
  }

  // ── Period markets ────────────────────────────────────────────────────────
  /**
   * « Qui mène après la période N » — buts CUMULÉS jusqu'à la fin de la
   * période N. C'est un marché à TROIS issues depuis que la carte de chaque
   * période propose aussi « égalité » (sélection `draw`).
   *
   * Une égalité rendait `unknown` : la jambe restait « en attente » à jamais,
   * et figeait le coupon entier. Face à une tuile « égalité » offerte à côté,
   * l'égalité est une issue comme une autre — le pari sur une équipe est perdu.
   */
  const periodWinnerMatch = /^period([123])_winner$/.exec(String(leg.marketType));
  if (periodWinnerMatch) {
    const n = Number(periodWinnerMatch[1]);
    const isDraw = String(leg.selectionValue ?? '').trim().toLowerCase() === 'draw';
    const game = await getFinalGame(String(leg.gameId), cache);
    if (!game) return 'unknown';
    // `draw` avant `pickTeam` : celui-ci retomberait sur `subjectId` et lirait
    // un pari « égalité » comme un pari sur l'équipe à domicile.
    const pick = isDraw ? null : pickTeam(leg, game);
    if (!isDraw && !pick) return 'void';
    const goals = await getScoringPlays(String(leg.gameId), cache, scoringCache);
    if (!goals) return 'unknown';
    const { home, away } = periodGoalCounts(goals);
    const homeCum = home.slice(0, n).reduce((a, b) => a + b, 0);
    const awayCum = away.slice(0, n).reduce((a, b) => a + b, 0);
    if (isDraw) return homeCum === awayCum ? 'win' : 'loss';
    if (homeCum === awayCum) return 'loss';
    const { homeId, awayId } = teamIds(game);
    const winner = homeCum > awayCum ? homeId : awayId;
    return pick!.sel === winner ? 'win' : 'loss';
  }

  const periodTotalMatch = /^period([123])_total_goals$/.exec(String(leg.marketType));
  if (periodTotalMatch) {
    const n = Number(periodTotalMatch[1]);
    const line = Number(leg.line);
    if (!Number.isFinite(line)) return 'unknown';
    const goals = await getScoringPlays(String(leg.gameId), cache, scoringCache);
    if (!goals) return 'unknown';
    const { home, away } = periodGoalCounts(goals);
    const total = home[n - 1] + away[n - 1];
    const sel = String(leg.selectionValue).toLowerCase();
    if (total === line) return 'unknown'; // push
    if (sel === 'over')  return total > line ? 'win' : 'loss';
    if (sel === 'under') return total < line ? 'win' : 'loss';
    return 'unknown';
  }

  if (leg.marketType === 'highest_scoring_period') {
    const goals = await getScoringPlays(String(leg.gameId), cache, scoringCache);
    if (!goals) return 'unknown';
    const { home, away } = periodGoalCounts(goals);
    const totals = [0, 1, 2].map((i) => home[i] + away[i]);
    const max = Math.max(...totals);
    const leaders = totals.reduce<number[]>((acc, v, i) => (v === max ? [...acc, i] : acc), []);
    const sel = String(leg.selectionValue).toLowerCase();
    // Égalité en tête (dont 0-0-0) : PERDU pour P1/P2/P3. C'est ce que le prix
    // annonce — le modèle chiffre « cette période a STRICTEMENT le plus de
    // buts », l'égalité étant une issue à part (`tie`). Rendre `unknown`
    // laissait la jambe en attente pour toujours (INCOHERENCES_ML §16).
    if (leaders.length !== 1) return sel === 'tie' ? 'win' : 'loss';
    if (sel === 'tie') return 'loss';
    return sel === `p${leaders[0] + 1}` ? 'win' : 'loss';
  }

  const statKey = PLAYER_STAT_MARKETS[leg.marketType as string];
  if (statKey) {
    if (!leg.subjectId) return 'unknown';
    const line = Number(leg.line);
    if (!Number.isFinite(line)) return 'unknown';
    const stats = await getPlayerBox(String(leg.gameId), String(leg.subjectId), cache, boxCache);
    if (!stats) return 'unknown';
    const value = stats[statKey];
    if (typeof value !== 'number') return 'unknown';
    const sel = String(leg.selectionValue).toLowerCase();
    if (value === line) return 'unknown'; // push (rare -- lines are usually X.5)
    if (sel === 'over')  return value > line ? 'win' : 'loss';
    if (sel === 'under') return value < line ? 'win' : 'loss';
    return 'unknown';
  }

  const game = await getFinalGame(String(leg.gameId), cache);
  if (!game) return 'unknown';

  const hs = Number(game.homeTeam.score);
  const as = Number(game.awayTeam.score);
  const { homeId, awayId } = teamIds(game);
  const sel = String(leg.selectionValue).toLowerCase();

  switch (leg.marketType) {
    case 'moneyline': {
      // `pickTeam` et non `sel` : depuis le sélecteur de marché, l'équipe est
      // dans `subjectId` et `selectionValue` vaut `"yes"`. Comparer `sel` aux
      // deux abréviations écartait donc tous les moneylines posés par ce
      // chemin — le marché le plus courant, par le chemin le plus courant.
      const pick = pickTeam(leg, game);
      if (!pick) return 'void';
      if (hs === as) return 'void'; // pas de nul en NHL — garde-fou
      return pick.sel === (hs > as ? homeId : awayId) ? 'win' : 'loss';
    }

    case 'total_goals': {
      const line = Number(leg.line);
      if (!Number.isFinite(line)) return 'unknown';
      const total = hs + as;
      if (total === line) return 'unknown'; // push → leave pending
      if (sel === 'over')  return total > line ? 'win' : 'loss';
      if (sel === 'under') return total < line ? 'win' : 'loss';
      return 'unknown';
    }

    /**
     * Puck line.
     *
     * Trois formes de jambe arrivent ici, et deux étaient refusées :
     *
     *  1. « domicile −1,5 » — sujet et sélection portent l'équipe, mais la
     *     LIGNE n'est nulle part : elle est dans le libellé de la tuile, pas
     *     dans `leg.line`. Sans elle, `Number.isFinite` refusait le pari.
     *  2. « visiteur +1,5 » — la tuile est le complément exact de la première
     *     (pas d'égalité possible sur une demi-ligne), donc elle annonce le même
     *     marché côté « non », avec le DOMICILE pour sujet. `sel` valait `"no"`,
     *     qui n'est aucune des deux équipes.
     *  3. sélecteur de marché — l'équipe est dans `subjectId`, `selectionValue`
     *     vaut `"yes"`, et la ligne peut manquer (ce marché n'offre pas de
     *     choix de ligne).
     *
     * −1,5 comme défaut : c'est la seule puck line du hockey, et c'est ce que
     * les trois écrans affichent. `negative` renverse le verdict pour la forme 2.
     */
    case 'puck_line': {
      const pick = pickTeam(leg, game);
      if (!pick) return 'void';
      const negative = String(leg.selectionValue ?? '').trim().toLowerCase() === 'no';
      const line = Number.isFinite(Number(leg.line)) ? Number(leg.line) : -1.5;
      const teamScore = pick.sel === homeId ? hs : as;
      const oppScore  = pick.sel === homeId ? as : hs;
      const adjusted  = teamScore + line;
      if (adjusted === oppScore) return 'void'; // égalité sur la ligne
      const covers = adjusted > oppScore;
      return (negative ? !covers : covers) ? 'win' : 'loss';
    }

    /**
     * « L'équipe gagne en prolongation ou en fusillade » — les tuiles
     * `ml-home-ot` / `ml-away-ot` de Match Betting.
     *
     * Ce marché s'appelait `game_to_ot` jusqu'au correctif de sept. 2026, avec
     * la sélection `yes` — donc exactement ce qu'annonçait la tuile « Goes to
     * OT » juste à côté. Les deux paris étaient indiscernables une fois
     * enregistrés, et c'est pour ça qu'aucun des deux n'était réglé : trancher
     * l'un aurait crédité l'autre. `nhlPredictions.ts` leur donne désormais un
     * marché à eux, et la sélection porte l'abréviation de l'équipe.
     *
     * ⚠️ Les jambes ANTÉRIEURES au correctif portent encore `game_to_ot` + `yes`
     * et restent ambiguës : rien ici ne peut les distinguer. Elles tombent donc
     * dans `game_to_ot` ci-dessous, qui les règle comme « le match va en
     * prolongation » — ce qui est le sens de ce nom de marché, et ce que le
     * script `settle:stuck` montre avant d'écrire quoi que ce soit.
     */
    case 'ot_so_winner': {
      const pick = pickTeam(leg, game);
      if (!pick) return 'void';
      const past = await wentPastRegulation(game, String(leg.gameId), cache, scoringCache);
      if (past == null) return 'unknown';
      if (!past) return 'loss';              // réglé en 60 min → la tuile perd
      if (hs === as) return 'void';          // impossible sur un match final
      return pick.sel === (hs > as ? homeId : awayId) ? 'win' : 'loss';
    }

    /**
     * Score exact — score FINAL (but de prolongation / fusillade compris),
     * celui de `game.homeTeam.score` / `game.awayTeam.score`.
     *
     * Sélection dans l'ordre DOMICILE–VISITEUR (« 1-3 » = le visiteur gagne
     * 3–1), ou `home_other` / `away_other` : ce camp gagne en marquant 5 buts
     * ou plus — la ligne « Other » du tableau, qui regroupe tout ce que les
     * lignes 1-0 … 4-3 ne couvrent pas.
     */
    case 'correct_score': {
      if (!Number.isFinite(hs) || !Number.isFinite(as)) return 'unknown';
      const m = /^(\d{1,2})-(\d{1,2})$/.exec(sel);
      if (m) return hs === Number(m[1]) && as === Number(m[2]) ? 'win' : 'loss';
      if (sel === 'home_other') return hs > as && hs >= 5 ? 'win' : 'loss';
      if (sel === 'away_other') return as > hs && as >= 5 ? 'win' : 'loss';
      return 'void';
    }

    /** « Le match va en prolongation » — les tuiles `ot-yes` / `ot-no`. */
    case 'game_to_ot': {
      if (sel !== 'yes' && sel !== 'no') return 'void';
      const past = await wentPastRegulation(game, String(leg.gameId), cache, scoringCache);
      if (past == null) return 'unknown';
      return (sel === 'yes') === past ? 'win' : 'loss';
    }

    /**
     * Écart de victoire.
     *
     * Le seau est lu par `parseMarginBucket`, la MÊME fonction que le moteur de
     * probabilité (`marginPeriods.ts`) et que le calcul de corrélation d'un
     * coupon (`gameParlay.ts`). C'est ce qui garantit que le chiffre annoncé et
     * le règlement parlent du même pari : l'UI a deux vocabulaires ("1" / "3+"
     * côté tuiles, "home_1" / "away_2plus" côté sélecteur de marché) et les
     * réconcilier une deuxième fois ici les aurait fait diverger tôt ou tard.
     *
     * L'écart est compté du point de vue du SUJET, et la prolongation ne
     * l'annule pas — c'est la convention de `gameParlay.legWins`, qui est la
     * référence puisque c'est elle qui chiffre le coupon.
     */
    case 'winning_margin': {
      // Ici le sujet est la référence du seau, pas la sélection : « home_1 »
      // veut dire « le DOMICILE gagne par 1 », que le sujet soit l'un ou
      // l'autre — c'est `parseMarginBucket` qui fait la bascule, à partir de
      // `isHome`. D'où `subjectId` et non `pickTeam`, qui préférerait la
      // sélection.
      const subjectId = String(leg.subjectId ?? '').toLowerCase();
      if (subjectId !== homeId && subjectId !== awayId) return 'void';
      const subjectIsHome = typeof leg.isHome === 'boolean'
        ? leg.isHome
        : subjectId === homeId;
      const bucket = parseMarginBucket(String(leg.selectionValue ?? ''), subjectIsHome);
      if (!bucket) return 'void';
      const margin = subjectIsHome ? hs - as : as - hs;
      switch (bucket) {
        case 'win_1':      return margin ===  1 ? 'win' : 'loss';
        case 'win_2':      return margin ===  2 ? 'win' : 'loss';
        case 'win_3plus':  return margin >=  3 ? 'win' : 'loss';
        case 'win_2plus':  return margin >=  2 ? 'win' : 'loss';
        case 'lose_1':     return margin === -1 ? 'win' : 'loss';
        case 'lose_2':     return margin === -2 ? 'win' : 'loss';
        case 'lose_3plus': return margin <= -3 ? 'win' : 'loss';
        case 'lose_2plus': return margin <= -2 ? 'win' : 'loss';
        default:           return 'void';
      }
    }

    /**
     * « Kills All Penalties » — l'équipe ne concède aucun but en infériorité.
     *
     * Compté sur les buts en avantage numérique de l'ADVERSAIRE, la même source
     * que `team_pp_goals` juste au-dessus. Une équipe qui n'a pris aucune
     * pénalité gagne cette tuile : c'est la convention des books (« a tué
     * toutes ses pénalités » est vrai quand il n'y en avait aucune), et c'est
     * aussi ce que le modèle chiffre — `pkAll = (PK%)^occasions` tend vers 1
     * quand les occasions tendent vers 0.
     */
    case 'team_penalty_kill': {
      const teamId = String(leg.subjectId ?? '').toLowerCase();
      if (teamId !== homeId && teamId !== awayId) return 'void';
      if (sel !== 'yes' && sel !== 'no') return 'void';
      const goals = await getScoringPlays(String(leg.gameId), cache, scoringCache);
      if (!goals) return 'unknown';
      const oppIsHome = teamId !== homeId;
      const ppAgainst = goals.filter((g) => g.strength === 'pp' && g.isHome === oppIsHome).length;
      return (sel === 'yes') === (ppAgainst === 0) ? 'win' : 'loss';
    }

    /** Vainqueur après 60 minutes. Le miroir exact de `ot_so_winner`. */
    case 'regulation_result': {
      const pick = pickTeam(leg, game);
      if (!pick) return 'void';
      const past = await wentPastRegulation(game, String(leg.gameId), cache, scoringCache);
      if (past == null) return 'unknown';
      if (past) return 'loss';               // allé en prolongation → personne ne gagne « en 60 »
      if (hs === as) return 'void';
      return pick.sel === (hs > as ? homeId : awayId) ? 'win' : 'loss';
    }

    /**
     * Vainqueur de la prolongation — CONDITIONNEL, contrairement à
     * `ot_so_winner`.
     *
     * Pas de prolongation = pari sans objet, donc `void` : c'est la règle des
     * books, et c'est aussi pourquoi `gameParlay.SCORE_DERIVABLE` l'exclut. Le
     * compter perdu ferait payer au joueur une issue sur laquelle il n'a jamais
     * parié.
     */
    case 'ot_winner': {
      const pick = pickTeam(leg, game);
      if (!pick) return 'void';
      const past = await wentPastRegulation(game, String(leg.gameId), cache, scoringCache);
      if (past == null) return 'unknown';
      if (!past) return 'void';
      if (hs === as) return 'void';
      return pick.sel === (hs > as ? homeId : awayId) ? 'win' : 'loss';
    }

    /** Puck line alternative (−2,5 / +2,5…). Même arithmétique que `puck_line`. */
    case 'alt_puck_line': {
      const pick = pickTeam(leg, game);
      if (!pick) return 'void';
      const line = Number(leg.line);
      if (!Number.isFinite(line)) return 'void';   // pas de défaut : la ligne EST le pari
      const teamScore = pick.sel === homeId ? hs : as;
      const oppScore  = pick.sel === homeId ? as : hs;
      const adjusted  = teamScore + line;
      if (adjusted === oppScore) return 'void';
      return adjusted > oppScore ? 'win' : 'loss';
    }

    /**
     * Minutes de pénalité du match, les deux équipes confondues.
     *
     * La feuille de match porte `pim` par joueur — c'est déjà la source des
     * props « minutes de pénalité » d'un joueur. Les additionner donne le total
     * du match, et ce marché cesse d'être le dernier de la liste à n'avoir
     * aucune règle.
     */
    case 'total_penalties': {
      const side = overUnderSide(leg.selectionValue);
      const line = Number(leg.line);
      if (!side || !Number.isFinite(line)) return 'void';
      if (!boxCache.has(String(leg.gameId))) {
        let box: Map<string, BoxscorePlayerStats> | null = null;
        try { box = await fetchGameBoxscore(String(leg.gameId)); } catch { box = null; }
        boxCache.set(String(leg.gameId), box);
      }
      const box = boxCache.get(String(leg.gameId));
      if (!box) return 'unknown';
      let total = 0;
      for (const st of box.values()) total += Number(st.pim ?? 0);
      if (total === line) return 'void';
      return side === 'over'
        ? (total > line ? 'win' : 'loss')
        : (total < line ? 'win' : 'loss');
    }

    default:
      // Marché sans règle de règlement. Le match est FINAL ici (on est passé
      // par `getFinalGame`), donc l'attente ne donnera rien de plus : la jambe
      // est annulée et sort du coupon plutôt que de le figer.
      return 'void';
  }
}

/**
 * Le match est-il allé au-delà des 60 minutes ?
 *
 * `null` = on ne sait pas encore (rien d'exploitable dans la fiche ET résumé
 * des buts indisponible) — surtout pas `false`, qui ferait perdre une tuile OT
 * sur un silence de l'amont.
 *
 * Deux sources, parce qu'aucune n'est suffisante seule : `periodDescriptor` est
 * la réponse directe mais peut manquer sur une fiche partielle, et le résumé des
 * buts porte `periodType` sur chaque but mais ne dit rien d'un 0–0 réglé en
 * fusillade — cas où le but de fusillade est justement présent et tranche.
 */
async function wentPastRegulation(
  game: any,
  gameId: string,
  cache: GameCache,
  scoringCache: ScoringCache,
): Promise<boolean | null> {
  // ⚠️ `Number(null)` vaut 0, et 0 est fini. Sans ce test explicite, une fiche
  // sans `periodDescriptor` — le cas même qu'on veut traiter — passerait pour
  // « période 0 connue », donc pour un match réglé en 60 minutes, et une tuile
  // OT gagnante serait déclarée perdue sur une donnée absente.
  const period = game?.period == null ? NaN : Number(game.period);
  if (Number.isFinite(period) && period >= 4) return true;

  const goals = await getScoringPlays(gameId, cache, scoringCache);
  if (!goals) return Number.isFinite(period) ? false : null;
  if (goals.some((g) => g.periodType && g.periodType !== 'REG')) return true;

  // La fiche donne une période finale, et elle est < 4 : c'est une réponse, pas
  // une absence de réponse.
  if (Number.isFinite(period)) return false;

  // Ni période, ni but hors temps réglementaire. Des buts qui sont TOUS en
  // 'REG' disent que le match s'est réglé en 60 minutes ; zéro but ne dit rien
  // du tout (un 0–0 se règle en fusillade), d'où le `null`.
  return goals.length > 0 ? false : null;
}

/**
 * Combien de temps on laisse une jambe indécise avant de l'annuler.
 *
 * `decideLeg` rend `unknown` pour deux raisons opposées : le match n'est pas
 * fini (légitime, il faut attendre), ou l'amont n'a rien voulu dire (une panne,
 * qui se répare). Les distinguer champ par champ demanderait de classer une
 * quarantaine de points de sortie, et une erreur de classement annulerait un
 * vrai pari sur un hoquet passager de l'API.
 *
 * Le temps les sépare mieux : la passe de règlement tourne toutes les 2 à 15
 * minutes, plus un filet horaire. Une jambe encore indécise 24 h après le début
 * du match ne l'est pas par accident — c'est structurel, et attendre davantage
 * ne fera que prolonger un coupon figé.
 */
const VOID_AFTER_MS = Number(process.env.SETTLEMENT_VOID_AFTER_H || 24) * 3_600_000;

/**
 * Filet des jambes SANS `gameId` (anciens clients, chemin d'ajout oublié).
 * Rien à dater côté NHL : on date par le coupon. Une semaine couvre largement
 * un match posé à l'avance ; au-delà, la jambe ne sera jamais réglée.
 */
const NO_GAME_VOID_AFTER_MS = Number(process.env.SETTLEMENT_NO_GAME_VOID_AFTER_H || 168) * 3_600_000;

/** Identifiant de match NHL : saison (4) + type (2) + numéro (4). */
const NHL_GAME_ID = /^\d{10}$/;

/** Marchés over/under : sans ligne ni côté, `decideLeg` ne peut que les annuler. */
const OVER_UNDER_MARKETS = new Set<string>([
  'total_goals', 'faceoff_wins_ou', 'goalie_saves_ou', 'alt_puck_line', 'total_penalties',
  'period1_total_goals', 'period2_total_goals', 'period3_total_goals',
  ...Object.keys(PLAYER_STAT_MARKETS),
]);

/**
 * Ce qui empêcherait une jambe d'être réglée automatiquement, vérifié AU DÉPÔT
 * du coupon. `null` = la jambe est réglable.
 *
 * Le règlement sait annuler une jambe indécidable une fois le match terminé,
 * mais une jambe sans match n'a pas de « fin de match » : elle figeait le coupon
 * en attente pour toujours. La refuser ici, c'est attraper TOUT chemin d'ajout
 * — présent ou futur — qui oublierait ces champs, au lieu de le découvrir des
 * jours plus tard sur un coupon bloqué.
 */
export function legSettlementProblem(leg: any): string | null {
  const gameId = leg?.gameId == null ? '' : String(leg.gameId).trim();
  if (!NHL_GAME_ID.test(gameId)) return 'missing or invalid gameId';
  if (!leg?.marketType) return 'missing marketType';
  if (OVER_UNDER_MARKETS.has(String(leg.marketType))) {
    if (!Number.isFinite(Number(leg.line)) || leg.line == null) return 'missing line';
    if (String(leg.marketType) !== 'alt_puck_line' && !overUnderSide(leg.selectionValue)) {
      return 'missing over/under selection';
    }
  }
  return null;
}

/** Début du match, en millisecondes. `null` si la fiche ne le dit pas. */
function gameStartMs(game: any): number | null {
  const iso = game?.startTimeUTC ?? (game?.gameDate ? `${game.gameDate}T00:00:00Z` : null);
  if (!iso) return null;
  const t = Date.parse(String(iso));
  return Number.isFinite(t) ? t : null;
}

/**
 * Décide une jambe, puis convertit une indécision DURABLE en annulation.
 *
 * C'est ici que « le coupon ne peut plus se figer » est garanti, et pas dans les
 * quarante `return` de `decideLeg` : quelle que soit la raison de l'indécision —
 * marché inconnu, champ absent, égalité sur la ligne, ancienne jambe ambiguë,
 * amont définitivement muet — passé le délai, la jambe sort du coupon.
 */
async function settleLeg(
  leg: any, cache: GameCache, boxCache: BoxCache, scoringCache: ScoringCache, faceoffCache: FaceoffCache,
  placedAt?: Date | string,
): Promise<LegResult> {
  const result = await decideLeg(leg, cache, boxCache, scoringCache, faceoffCache);
  if (result !== 'unknown') return result;

  if (!leg?.gameId) {
    // Rien à dater côté NHL : l'âge du coupon sert de filet.
    const placed = placedAt == null ? NaN : new Date(placedAt).getTime();
    return Number.isFinite(placed) && Date.now() - placed >= NO_GAME_VOID_AFTER_MS ? 'void' : 'unknown';
  }
  const game = await getFinalGame(String(leg.gameId), cache);
  if (!game) return 'unknown';                  // match pas encore final : attendre est la bonne réponse

  const start = gameStartMs(game);
  if (start == null) return 'unknown';
  return Date.now() - start >= VOID_AFTER_MS ? 'void' : 'unknown';
}

export interface SettlementSummary {
  checked:  number;
  settled:  number;
  wins:     number;
  losses:   number;
  /** Coupons dont TOUTES les jambes ont été annulées. Un compteur qui grimpe
   *  est le signal qu'un marché proposé à l'écran n'a pas de règle de
   *  règlement — voir le `default` de `decideLeg`. */
  voided:   number;
  /** Faux quand la passe s'est arrêtée sur son plafond ou son budget temps —
   *  il reste donc des tickets réglables. Une valeur durablement fausse est LE
   *  signal que la file se remplit plus vite qu'elle ne se vide. */
  exhausted: boolean;
}

export interface SettleOptions {
  /** Plafond de tickets EXAMINÉS sur la passe (pas par lot). */
  max?: number;
  /** Budget temps de la passe. Doit rester sous le TTL du bail du job appelant. */
  budgetMs?: number;
  /** Taille d'un lot lu en base. */
  batch?: number;
}

/** Lot lu en base par aller-retour. 100 : assez pour amortir la latence, assez
 *  peu pour que le budget temps soit vérifié souvent. */
const SETTLE_BATCH = Number(process.env.SETTLEMENT_BATCH) || 100;
/** Plafond par défaut. Ce n'est plus lui qui borne la passe en pratique — le
 *  budget temps le fait — mais il empêche une boucle infinie si la pagination
 *  n'avance pas. */
const SETTLE_MAX_DEFAULT = Number(process.env.SETTLEMENT_MAX_SLIPS) || 5_000;
const SETTLE_BUDGET_DEFAULT_MS = Number(process.env.SETTLEMENT_BUDGET_MS) || 2 * 60_000;
/** Jambes d'un même ticket traitées en parallèle. Petit : les jambes partagent
 *  les caches de passe et, en dessous, `fetchNHL` déduplique déjà les appels en
 *  vol — au-delà de quelques unités on n'achète plus de latence, on ne fait
 *  qu'élargir les rafales vers l'API NHL. */
const LEG_CONCURRENCY = Number(process.env.SETTLEMENT_LEG_CONCURRENCY) || 4;

/**
 * Règle des jambes ISOLÉES, hors de tout coupon — les Best Bets journalisés
 * dans `best_bet_log` (migration 042, page /dev/profit).
 *
 * Exactement la règle des coupons (`settleLeg`, donc l'annulation des jambes
 * durablement indécidables comprise) : un best bet est jugé comme le serait la
 * même jambe posée par un utilisateur. Les caches sont partagés sur l'appel —
 * 40 best bets sur 8 matchs coûtent 8 récupérations de match, pas 40.
 *
 * `leg` : `{ gameId, marketType, selectionValue, line, subjectId }`, avec
 * `subjectId` = id du joueur pour un pari joueur, id du match sinon.
 */
export async function settleStandaloneLegs(legs: any[]): Promise<LegResult[]> {
  const cache: GameCache = new Map();
  const boxCache: BoxCache = new Map();
  const scoringCache: ScoringCache = new Map();
  const faceoffCache: FaceoffCache = new Map();
  return mapLimit(legs, LEG_CONCURRENCY, (leg) =>
    settleLeg(leg, cache, boxCache, scoringCache, faceoffCache).catch((): LegResult => 'unknown'));
}

/**
 * Settle pending slips. If `userId` is given, only that user's slips.
 * Safe to call concurrently: the UPDATE is guarded by outcome = 'pending'.
 *
 * PAGINATION (audit, ligne H) — la passe boucle jusqu'à épuisement de la file
 * plutôt que de s'arrêter à 100 ou 200 tickets. Avec l'ancien plafond fixe, une
 * soirée à 2 000 tickets se vidait à 200/heure : des utilisateurs attendaient
 * des JOURS le règlement de leur pari alors que le résultat était connu.
 *
 * La pagination est par CURSEUR `(placed_at, id)` et non par `OFFSET`. Un ticket
 * examiné mais non réglable — marché non auto-réglé, match pas encore final —
 * reste `pending` : une seconde requête `LIMIT` sans curseur renverrait
 * exactement les mêmes lignes, et la boucle tournerait sur place indéfiniment.
 *
 * Les quatre caches sont créés UNE fois pour toute la passe : régler 300 tickets
 * portant sur les 10 mêmes matchs coûte 10 récupérations, pas 300. C'est
 * l'essentiel du bénéfice du « regroupement par match » de l'audit, sans en
 * réorganiser la boucle.
 */
/**
 * Règles du parlay, jambes annulées comprises. `null` = le coupon reste en
 * attente.
 *
 * Une jambe `void` sort du calcul — comme chez les books, qui retirent du
 * coupon une jambe annulée au lieu de la compter perdue. L'ordre n'est pas
 * indifférent :
 *
 *   1. une seule jambe perdue fait tomber le coupon, MÊME s'il reste des jambes
 *      indécises : le résultat ne peut plus changer, donc attendre ne ferait que
 *      retarder le règlement ;
 *   2. sinon, une jambe encore indécise laisse le coupon en attente — la
 *      distinction `void` / `unknown` est faite dans `settleLeg`, et c'est elle
 *      qui garantit qu'« en attente » veut toujours dire « pas encore », jamais
 *      « plus jamais » ;
 *   3. toutes les jambes décidées et gagnées → gagné ;
 *   4. toutes annulées → `void`, sans XP dans un sens ni dans l'autre.
 *
 * Exporté parce que `scripts/settle-stuck-slips.ts` doit annoncer EXACTEMENT ce
 * que la passe écrira. Deux implémentations de cette règle, c'est la garantie
 * qu'un jour l'aperçu et l'écriture ne diront plus la même chose.
 */
export function resolveSlipOutcome(results: LegResult[]): 'win' | 'loss' | 'void' | null {
  if (results.length === 0) return null;
  if (results.includes('loss')) return 'loss';
  if (results.includes('unknown')) return null;
  if (results.some((r) => r === 'win')) return 'win';
  return 'void';
}

/**
 * Résultats de jambe d'un ticket qui RESTE en attente.
 *
 * POURQUOI. `results` n'était conservé que lorsque le ticket se réglait. Un
 * pari en cours dont deux matchs sur trois sont terminés n'avait donc RIEN à
 * montrer : l'écran affichait trois lignes identiques, alors que le serveur
 * venait de décider deux d'entre elles et les jetait. C'est l'information la
 * plus regardée d'un pari en cours — « est-ce que ça tient toujours ? ».
 *
 * Deux règles, et elles comptent :
 *
 *   · on n'écrit JAMAIS `unknown`. Une jambe indécise n'a pas de résultat ; le
 *     mot dans le JSON ferait une écriture par passe pour ne rien dire.
 *   · on ne RETIRE jamais un résultat déjà posé. Un amont momentanément muet
 *     (NHL API en panne, match introuvable) redonne `unknown` : effacer le ✓
 *     de la veille ferait clignoter l'écran sans qu'aucun fait n'ait changé.
 *
 * L'écriture est donc rare — au plus une par jambe et par ticket, le jour où
 * son match devient final — et le `WHERE outcome = 'pending'` empêche d'écraser
 * les jambes d'un ticket qu'une passe concurrente vient de régler.
 */
async function persistPartialLegResults(
  slipId:  string,
  legs:    any[],
  results: LegResult[],
): Promise<void> {
  let changed = false;
  const next = legs.map((leg, i) => {
    const r = results[i] ?? 'unknown';
    if (r === 'unknown' || leg?.result === r) return leg;
    changed = true;
    return { ...leg, result: r };
  });
  if (!changed) return;

  try {
    await pool.query(
      `UPDATE bet_slips SET legs = $1::jsonb WHERE id = $2 AND outcome = 'pending'`,
      [JSON.stringify(next), slipId],
    );
  } catch (err: any) {
    // Le détail d'affichage ne doit jamais faire tomber la passe de règlement.
    logger.warn({ err: err?.message, slipId }, '[Settlement] résultats partiels non enregistrés');
  }
}

export async function settlePendingSlips(userId?: string, opts: SettleOptions = {}): Promise<SettlementSummary> {
  const max      = opts.max      ?? SETTLE_MAX_DEFAULT;
  const budgetMs = opts.budgetMs ?? SETTLE_BUDGET_DEFAULT_MS;
  const batch    = Math.max(1, opts.batch ?? SETTLE_BATCH);
  const deadline = Date.now() + budgetMs;

  const summary: SettlementSummary = { checked: 0, settled: 0, wins: 0, losses: 0, voided: 0, exhausted: true };
  const cache: GameCache = new Map();
  const boxCache: BoxCache = new Map();
  const scoringCache: ScoringCache = new Map();
  const faceoffCache: FaceoffCache = new Map();

  // Curseur de pagination : dernier (placed_at, id) examiné.
  let cursorAt: string | null = null;
  let cursorId: string | null = null;

  while (summary.checked < max) {
    const limit = Math.min(batch, max - summary.checked);
    const params: unknown[] = [limit];
    let where = `outcome = 'pending'`;
    if (userId)   { where += ` AND user_id = $${params.length + 1}`; params.push(userId); }
    if (cursorAt) {
      where += ` AND (placed_at, id) > ($${params.length + 1}::timestamptz, $${params.length + 2}::uuid)`;
      params.push(cursorAt, cursorId);
    }

    const { rows: slips } = await pool.query(
      `SELECT id, user_id AS "userId", legs, placed_at AS "placedAt",
              combined_probability AS "combinedProbability"
       FROM bet_slips
       WHERE ${where}
       ORDER BY placed_at ASC, id ASC
       LIMIT $1`,
      params,
    );
    if (slips.length === 0) break;   // file vide → `exhausted` reste vrai

    for (const slip of slips) {
      summary.checked++;
      cursorAt = slip.placedAt instanceof Date ? slip.placedAt.toISOString() : String(slip.placedAt);
      cursorId = String(slip.id);

      const legs: any[] = Array.isArray(slip.legs) ? slip.legs : [];
      if (legs.length === 0) continue;

      // Jambes en parallèle borné : un ticket de 6 jambes sur 6 matchs
      // différents prenait 6 allers-retours NHL en série.
      const results: LegResult[] = await mapLimit(legs, LEG_CONCURRENCY,
        (leg) => settleLeg(leg, cache, boxCache, scoringCache, faceoffCache, slip.placedAt));

      const outcome = resolveSlipOutcome(results);
      if (!outcome) {
        // Au moins une jambe encore indécise : le ticket reste en attente,
        // mais les jambes DÉJÀ décidées sont conservées pour l'écran
        // (voir `persistPartialLegResults`).
        await persistPartialLegResults(slip.id, legs, results);
        continue;
      }
      // Jambes qui FONT partie du pari — tout sauf les annulées. Une jambe
      // encore indécise en fait partie (le coupon n'est réglé ici que parce
      // qu'une autre est perdue, celle-là aurait pu être gagnée) ; une jambe
      // annulée, non.
      const inPlay = results.filter((r) => r !== 'void').length;

      let xp: number;
      if (outcome === 'void') {
        // Aucune jambe n'a été jugée : ni gain ni pénalité. Le coupon quitte la
        // file, ce qui est le seul but — le compter perdu punirait le joueur
        // pour un marché que le serveur ne sait pas régler.
        xp = 0;
      } else if (outcome === 'win') {
        xp = xpForOutcome('win', slip.combinedProbability);
      } else {
        // Loss penalty scales with HOW MANY legs were lost:
        // losing 1 leg out of 4 costs a quarter of the full penalty,
        // losing them all costs the full risk-based penalty.
        //
        // Le dénominateur exclut les jambes ANNULÉES : elles ne font pas partie
        // du pari, donc les garder diluerait la pénalité — perdre sa seule
        // jambe valide coûterait un quart si trois autres avaient été annulées.
        const lostLegs = results.filter((r) => r === 'loss').length;
        const fullPenalty = Math.abs(xpForOutcome('loss', slip.combinedProbability));
        xp = -Math.max(3, Math.round(fullPenalty * (lostLegs / Math.max(1, inPlay))));
      }

      // Résultat de CHAQUE jambe, conservé.
      //
      // `results` était calculé puis jeté : seul l'`outcome` global du ticket
      // survivait. La page joueur doit pouvoir montrer QUELLE jambe a fait
      // tomber un parlay — l'information la plus recherchée en ouvrant un
      // ticket perdu — et la recalculer à l'affichage voudrait dire rejouer les
      // appels NHL à chaque consultation.
      //
      // Fusionné dans le même UPDATE que l'`outcome`, jamais dans un second :
      // c'est le `WHERE outcome = 'pending'` qui rend le règlement idempotent
      // face au job périodique ET au déclenchement manuel. Une écriture séparée
      // sortirait de cette garde et pourrait laisser un ticket réglé sans son
      // détail.
      const settledLegs = legs.map((leg, i) => ({ ...leg, result: results[i] ?? 'unknown' }));

      // Guard against double settlement (interval job + manual trigger)
      const upd = await pool.query(
        `UPDATE bet_slips
         SET outcome = $1, resolved_at = NOW(), xp_awarded = $2, legs = $3::jsonb
         WHERE id = $4 AND outcome = 'pending'`,
        [outcome, xp, JSON.stringify(settledLegs), slip.id],
      );
      if (!upd.rowCount) continue;

      await applyXpDelta(slip.userId, xp);

      summary.settled++;
      if (outcome === 'win') summary.wins++;
      else if (outcome === 'loss') summary.losses++;
      else summary.voided++;
    }

    // Budget vérifié entre deux lots, jamais au milieu : un ticket entamé va
    // toujours à son terme, sinon on paierait ses appels NHL sans écrire le
    // résultat.
    if (Date.now() >= deadline) { summary.exhausted = false; break; }
    if (slips.length < limit)   break;                  // dernier lot → file vide
  }

  if (summary.checked >= max) summary.exhausted = false;
  if (!summary.exhausted) {
    logger.warn(summary, '[Settlement] passe interrompue (budget ou plafond) — des tickets restent en attente');
  }
  return summary;
}

/**
 * Ce que la prochaine passe ferait des coupons en attente, SANS rien écrire.
 *
 * Sert au script `settle:stuck`, dont tout l'intérêt est de montrer avant
 * d'agir : un règlement est irréversible (l'XP est appliquée, `outcome` ne
 * revient jamais à `pending`), donc la personne qui le déclenche doit pouvoir
 * lire jambe par jambe ce qui va être décidé.
 *
 * Passe par les mêmes `settleLeg` et `resolveSlipOutcome` que la passe réelle —
 * c'est la seule façon que l'aperçu ne mente pas.
 */
export interface SlipLegPreview {
  label:          string;
  marketType:     string;
  selectionValue: string | null;
  subjectId:      string | null;
  gameId:         string | null;
  result:         LegResult;
}

export interface SlipPreview {
  id:       string;
  userId:   string;
  placedAt: string;
  legs:     SlipLegPreview[];
  /** `null` = resterait en attente. */
  outcome:  'win' | 'loss' | 'void' | null;
}

export async function previewPendingSlips(userId?: string, limit = 200): Promise<SlipPreview[]> {
  const params: unknown[] = [limit];
  let where = `outcome = 'pending'`;
  if (userId) { where += ` AND user_id = $2`; params.push(userId); }

  const { rows: slips } = await pool.query(
    `SELECT id, user_id AS "userId", legs, placed_at AS "placedAt"
       FROM bet_slips
      WHERE ${where}
      ORDER BY placed_at ASC
      LIMIT $1`,
    params,
  );

  const cache: GameCache = new Map();
  const boxCache: BoxCache = new Map();
  const scoringCache: ScoringCache = new Map();
  const faceoffCache: FaceoffCache = new Map();

  const out: SlipPreview[] = [];
  for (const slip of slips) {
    const legs: any[] = Array.isArray(slip.legs) ? slip.legs : [];
    const results: LegResult[] = await mapLimit(legs, LEG_CONCURRENCY,
      (leg) => settleLeg(leg, cache, boxCache, scoringCache, faceoffCache, slip.placedAt));
    out.push({
      id:       String(slip.id),
      userId:   String(slip.userId),
      placedAt: slip.placedAt instanceof Date ? slip.placedAt.toISOString() : String(slip.placedAt),
      legs: legs.map((leg, i) => ({
        label:          String(leg?.marketLabel ?? leg?.selection ?? leg?.marketType ?? '?'),
        marketType:     String(leg?.marketType ?? '?'),
        selectionValue: leg?.selectionValue != null ? String(leg.selectionValue) : null,
        subjectId:      leg?.subjectId      != null ? String(leg.subjectId)      : null,
        gameId:         leg?.gameId         != null ? String(leg.gameId)         : null,
        result:         results[i] ?? 'unknown',
      })),
      outcome: resolveSlipOutcome(results),
    });
  }
  return out;
}

// ── Event-driven background job ──────────────────────────────────────────────
//
// Instead of blindly re-settling every N minutes, the job watches the games
// actually referenced by pending slips and settles as soon as one turns FINAL:
//   1. cheap SQL: collect distinct gameIds from pending slips (no API call
//      when there is nothing pending)
//   2. poll only those games' status
//   3. when a game newly becomes final → run settlePendingSlips
// A slow fallback pass still runs hourly as a safety net (e.g. games that
// finished while the check was failing, or player-prop slips).

/** Distinct gameIds referenced by pending slips. */
async function pendingGameIds(): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT leg->>'gameId' AS "gameId"
     FROM bet_slips, jsonb_array_elements(legs) AS leg
     WHERE outcome = 'pending' AND leg->>'gameId' IS NOT NULL`,
  );
  return rows.map((r: any) => String(r.gameId));
}

// Games we already know are final — no need to re-poll or re-trigger for them.
const knownFinal = new Set<string>();

/** What one check pass observed — drives when the scheduler should wake next. */
interface CheckResult {
  /** Any slip is still pending (open bets exist). */
  pending: boolean;
  /** A referenced game has started (or its start time is unknown) and isn't
   *  final yet → poll fast until it settles. */
  live: boolean;
  /** ms until the earliest *future* pending game starts, or null if none are
   *  in the future (all live/unknown, or nothing pending). */
  soonestStartMs: number | null;
}

async function checkFinishedGames(): Promise<CheckResult> {
  const gameIds = await pendingGameIds();
  if (gameIds.length === 0) {
    return { pending: false, live: false, soonestStartMs: null }; // zero API calls
  }

  const now = Date.now();
  let newlyFinal = false;
  let live = false;
  let soonestStartMs: number | null = null;

  for (const id of gameIds) {
    if (knownFinal.has(id)) { newlyFinal = true; continue; } // final but slip still pending → retry settle
    try {
      const g = await fetchGameById(id);
      if (g?.status === 'final') {
        knownFinal.add(id);
        newlyFinal = true;
        continue;
      }
      // Not final → is it live/imminent, or still in the future?
      const startMs = g?.startTimeUTC ? new Date(g.startTimeUTC).getTime() : NaN;
      if (!Number.isFinite(startMs) || startMs <= now) {
        live = true; // started (awaiting final) or unknown start → poll fast
      } else {
        const until = startMs - now;
        soonestStartMs = soonestStartMs == null ? until : Math.min(soonestStartMs, until);
      }
    } catch {
      live = true; // API down / game not found → be safe, keep polling fast
    }
  }

  if (newlyFinal) {
    // Budget sous le TTL du bail `settlement-check` (5 min), en laissant de la
    // marge pour les appels NHL déjà faits ci-dessus. Ce qui ne rentre pas est
    // repris au tour suivant : la file n'est jamais perdue, seulement étalée.
    await settlePendingSlips(undefined, { budgetMs: 3 * 60_000 });
  }

  // Don't let the set grow forever across a long-running process
  if (knownFinal.size > 2000) knownFinal.clear();

  return { pending: true, live, soonestStartMs };
}

// ── Event-driven scheduler ───────────────────────────────────────────────────
//
// The check no longer polls on a fixed clock. It reschedules itself based on
// what's actually pending, so a serverless Postgres (e.g. Neon) can scale its
// compute to zero while nothing is happening:
//   - nothing pending          → sleep `idleMs` (long)
//   - a game is live/imminent  → poll every `activeMs` (fast) until it settles
//   - all pending games future → sleep until `preRollMs` before the earliest
//                                start (capped at `maxSleepMs`)
// A newly placed bet calls notifySlipPlaced() to wake the job immediately so it
// can re-plan its horizon instead of waiting out a long sleep.

const minToMs = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n * 60_000 : fallback;
};

let checkTimer: NodeJS.Timeout | null = null;
let activeMs   = 2 * 60_000;
let idleMs     = 15 * 60_000;
let preRollMs  = 2 * 60_000;
const maxSleepMs = 6 * 60 * 60_000; // safety re-check horizon (schedule changes, missed kicks)

/** Delay (ms) until the next check, from what the last pass observed. */
function nextDelay(r: CheckResult): number {
  if (!r.pending) return idleMs;                 // no open bets → let the DB sleep
  if (r.live) return activeMs;                    // a game is on → poll fast
  if (r.soonestStartMs != null) {                 // all pending games are upcoming
    const wake = r.soonestStartMs - preRollMs;
    return Math.min(Math.max(wake, activeMs), maxSleepMs);
  }
  return activeMs;                                // pending but timing unknown → be safe
}

function armCheck(delay: number): void {
  if (checkTimer) clearTimeout(checkTimer);
  checkTimer = setTimeout(runCheck, delay);
  checkTimer.unref();
}

/**
 * TTL des baux. Le check est court (quelques requêtes + appels NHL) ; la passe
 * de rattrapage boucle jusqu'à épuisement de la file, d'où un TTL bien plus
 * large. Ces valeurs majorent la durée observée, elles ne la mesurent pas :
 * elles sont là pour qu'une instance TUÉE ne bloque pas le job indéfiniment, pas
 * pour interrompre un job lent.
 *
 * Chaque TTL doit rester STRICTEMENT supérieur au budget temps passé à
 * `settlePendingSlips` par le job correspondant (3 min sous un bail de 5,
 * 10 min sous un bail de 15) : c'est le budget qui arrête la passe, jamais le
 * bail — sinon une deuxième instance reprendrait le travail pendant que la
 * première l'exécute encore.
 */
const CHECK_LOCK_TTL_MS    = 5 * 60_000;
const FALLBACK_LOCK_TTL_MS = 15 * 60_000;

/**
 * Un tour de check, sous verrou.
 *
 * Le verrou n'est pas ce qui protège de la double-comptabilisation — c'est
 * l'`UPDATE … WHERE outcome = 'pending'` de `settleLeg` qui le fait, et il reste
 * la vraie ligne de défense. Le verrou évite le travail redondant : N instances
 * qui interrogent l'API NHL pour les mêmes matchs, N fois.
 *
 * Quand une autre instance détient le bail, on se replanifie quand même — à la
 * cadence active, pas à la cadence longue : si l'instance détentrice meurt, on
 * doit pouvoir reprendre la main en quelques minutes plutôt qu'au prochain
 * réveil lointain. Le coût d'un tour perdu est d'un seul INSERT.
 */
async function runCheck(): Promise<void> {
  let delay = activeMs;
  try {
    const outcome = await withJobLock('settlement-check', CHECK_LOCK_TTL_MS, checkFinishedGames);
    if (outcome.ran) delay = nextDelay(outcome.result);
  } catch (err: any) {
    logger.warn({ err: err.message }, '[Settlement] check failed'); // retry at active cadence
  }
  armCheck(delay);
}

/**
 * Wake the settlement check now (debounced to a few seconds) so a freshly
 * placed bet re-plans the wake horizon instead of waiting out a long idle
 * sleep. No-op if the job hasn't been started (e.g. tests).
 */
export function notifySlipPlaced(): void {
  if (checkTimer) armCheck(5_000);
}

/**
 * Background job — call once at server startup.
 *
 * Cadence knobs (env, minutes):
 *   - SETTLEMENT_POLL_MIN       fast interval while a game is live (default 2)
 *   - SETTLEMENT_IDLE_POLL_MIN  interval while nothing is pending (default 15 in
 *                               production, else same as active)
 *   - SETTLEMENT_PREROLL_MIN    how early before a game's start to begin polling (default 2)
 *   - SETTLEMENT_FALLBACK_MIN   safety-net full settlement pass (default 60)
 * To restore a plain fixed poll every 5 min, set SETTLEMENT_POLL_MIN=5 and
 * SETTLEMENT_IDLE_POLL_MIN=5.
 */
export function startSettlementJob(): void {
  activeMs  = minToMs(process.env.SETTLEMENT_POLL_MIN, 2 * 60_000);
  const idleDefault = process.env.NODE_ENV === 'production' ? 15 * 60_000 : activeMs;
  idleMs    = minToMs(process.env.SETTLEMENT_IDLE_POLL_MIN, idleDefault);
  preRollMs = minToMs(process.env.SETTLEMENT_PREROLL_MIN, 2 * 60_000);
  const fallbackMs = minToMs(process.env.SETTLEMENT_FALLBACK_MIN, 60 * 60_000);

  const fallback = async () => {
    try {
      await withJobLock('settlement-fallback', FALLBACK_LOCK_TTL_MS,
        () => settlePendingSlips(undefined, { budgetMs: 10 * 60_000 }));
    } catch (err: any) {
      logger.warn({ err: err.message }, '[Settlement] fallback failed');
    }
  };

  // Catch-up pass shortly after boot (games may have finished while the server
  // was down), then event-driven checks + periodic fallback safety net.
  setTimeout(fallback, 30_000).unref();
  armCheck(activeMs);
  setInterval(fallback, fallbackMs).unref();
}
