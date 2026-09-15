/**
 * featureEngineering.ts
 * Converts raw NHL API data into structured feature vectors
 * ready to POST to the Python ML service.
 */
import {
  fetchTeams,
  fetchPlayerById,
  fetchTeamSummaryStats,
  fetchTeamRestInfo,
  fetchTeamTravel,
  TeamSummaryStats,
  TeamRestInfo,
} from './nhlApiClient';
import { getArena } from '../data/arenas';
import { fetchOddsImplied, fetchTotalsOdds } from './oddsClient';
import { getStartingGoalies } from './startingGoalies';
import { getScratchesDay } from './scratches';
import { getTeam } from './prediction/scoreModel';

/** Options d'enrichissement pour buildGameFeatures (cotes live, lineup). */
export interface GameFeatureOpts {
  /** Inclure les cotes live → active le blend modèle⊕marché (défaut true).
   *  Mettre à false pour obtenir la proba PURE du modèle (détection de value). */
  includeOdds?: boolean;
  homeGoalie?: string;
  awayGoalie?: string;
  homeStarsMissing?: number;
  awayStarsMissing?: number;
  /** Absents confirmés (noms MoneyPuck). Défaut : lus dans scratches.json. */
  homeScratches?: string[];
  awayScratches?: string[];
  /**
   * Le SUJET de la question est-il l'équipe à domicile ? (défaut : true)
   *
   * `homeId`/`awayId` décrivent le MATCH — l'aréna, le voyage, l'avantage de la
   * glace. Ce drapeau dit de quel côté se place la question. Les deux étaient
   * confondus : la route `/ml` passait le sujet en `homeId`, donc la tuile
   * « extérieur » demandait « P(le visiteur gagne chez lui) » et les deux tuiles
   * moneyline d'un match totalisaient 109–112 %.
   */
  subjectIsHome?: boolean;
  /**
   * Calculer les features de voyage (distance, fuseaux, road-trip, altitude) ?
   * Défaut : NON.
   *
   * MESURÉ le 2026-09-13 : aucune de ces valeurs ne change la sortie du service
   * Python. Ses modèles entraînés consomment 15 features (`training_report.json`)
   * qui sont toutes des statistiques MoneyPuck roulantes, de l'ELO, du repos et
   * des cotes ; le repli en régression logistique n'utilise que win%, buts,
   * PP et PK. Faire varier distance, fuseaux, jours d'absence, longueur de
   * road-trip, get-away et altitude d'un extrême à l'autre laisse la probabilité
   * servie strictement identique.
   *
   * `nhlPredictions.ts` les garde, LUI : son `fatigueFactor` les lit vraiment
   * (`predictionFactors.ts`). C'est pour ça que le calcul reste en place plutôt
   * que d'être supprimé — il est simplement désactivé là où il ne sert à rien.
   */
  includeTravel?: boolean;
  /**
   * Côté d'un marché BINAIRE servi sous un seul `market_type` : « yes » / « no »
   * (BTTS, blanchissage, prolongation, but en AN, désavantage numérique…).
   * Le service Python price toujours le côté « oui » puis prend le complément
   * quand ce champ vaut « no ». Sans lui, les deux tuiles d'un même marché
   * recevaient le MÊME pourcentage (BTTS 90 % / 90 %).
   * Ignoré pour les marchés qui portent déjà leur côté dans le `market_type`
   * (`total_goals_over` / `total_goals_under`) et pour les marchés d'équipe,
   * où la sélection est une abréviation.
   */
  selection?: string;
}

// ── Feature types (mirror Python Pydantic models) ─────────────────────────────

export interface GameFeatures {
  home_win_pct:        number;   // 0–1
  away_win_pct:        number;
  home_goals_for_pg:   number;
  away_goals_for_pg:   number;
  home_goals_against_pg: number;
  away_goals_against_pg: number;
  /**
   * PP% / PK% (0-100), ou `undefined` quand on n'a AUCUNE donnée.
   *
   * Ces champs valaient auparavant 20 / 80 par défaut côté Node, et le service
   * Python réécrivait ensuite « tout PK sous 50 % » en 80 %. Les deux couches
   * comblaient le trou, si bien que le seuil Python ne pouvait plus frapper que
   * des valeurs RÉELLES : une équipe qui a tué 1 pénalité sur 3 en octobre
   * (33 %) était silencieusement promue à la moyenne de ligue.
   *
   * L'absence de donnée se dit maintenant par l'absence de champ, et une valeur
   * basse est prise au sérieux.
   */
  home_pp_pct?:        number;   // %
  away_pp_pct?:        number;
  home_pk_pct?:        number;
  away_pk_pct?:        number;
  home_last10_win_pct: number;   // 0–1 (from streak/last10 if available)
  away_last10_win_pct: number;
  // ── Nouvelles features (v2) — miroir de ml_service.py GameFeatures
  home_home_win_pct:     number; // record à domicile (0–1)
  away_road_win_pct:     number; // record à l'extérieur (0–1)
  home_streak:           number; // série signée (+3 = 3 victoires)
  away_streak:           number;
  home_shots_for_pg:     number;
  away_shots_for_pg:     number;
  home_shots_against_pg: number;
  away_shots_against_pg: number;
  home_faceoff_pct:      number; // %
  away_faceoff_pct:      number;
  home_rest_days:        number; // 0–7
  away_rest_days:        number;
  home_b2b:              0 | 1;  // back-to-back
  away_b2b:              0 | 1;
  home_3in4?:            number; // matchs joués dans les 3 jours précédents
  away_3in4?:            number;
  // ── v5 — voyage / fuseaux / altitude / road-trip (miroir build_dataset)
  home_distance_km?:     number; away_distance_km?:     number;
  home_tz_shift?:        number; away_tz_shift?:        number;
  home_days_away?:       number; away_days_away?:       number;
  home_road_trip_len?:   number; away_road_trip_len?:   number;
  home_road_game_num?:   number; away_road_game_num?:   number;
  home_getaway?:         0 | 1;  away_getaway?:         0 | 1;
  home_alt_gain?:        number; away_alt_gain?:        number;
  venue_altitude_m?:     number; // altitude du terrain (aréna domicile)
  // ── ELO (v3) — le service Python résout les ratings via elo_ratings.json
  home_team?:            string; // abréviation, ex. "TOR"
  away_team?:            string;
  market_type:         string;   // "moneyline" | "puck_line" | "total_goals_over" | "total_goals_under"
  selection?:          string;   // côté d'un marché binaire : "yes" | "no"
  /** Le sujet de la question reçoit-il ? Cf. `GameFeatureOpts.subjectIsHome`. */
  subject_is_home?:    boolean;
  line?:               number;   // for total goals markets
  // ── v4 — cotes live du marché (décimal) → active le blend modèle⊕marché Python
  home_odds_decimal?:    number;
  away_odds_decimal?:    number;
  total_line_market?:    number;
  // ── v4 — contexte lineup (optionnel)
  home_goalie?:          string; // nom du gardien partant si connu
  away_goalie?:          string;
  home_stars_missing?:   number; // top joueurs absents (blessures) — legacy
  away_stars_missing?:   number;
  home_scratches?:       string[]; // absents confirmés (noms MoneyPuck)
  away_scratches?:       string[];
}

export interface PlayerPropFeatures {
  goals_per_game:   number;
  assists_per_game: number;
  points_per_game:  number;
  shots_per_game:   number;
  games_played:     number;
  line:             number;
  prop_type:        string;  // "goals" | "assists" | "points" | "shots" | "pp_point"
  selection:        string;  // "over" | "under"
  /** La cadence envoyée est-elle une moyenne de ligue plutôt qu'une mesure ? */
  rate_is_league_average?: boolean;
}

export interface TeamFuturesFeatures {
  win_pct:          number;   // 0–100
  goals_for_pg:     number;
  goals_against_pg: number;
  pp_pct:           number;
  pk_pct:           number;
  conference_rank:  number;   // 1–16
  prop_type:        string;   // "cup" | "conf" | "playoff"
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Parse last-10 string like "7-2-1" → win%. `null` (saison pas commencée) → 0.5. */
function parseLastTen(last10: string | null | undefined): number {
  if (!last10) return 0.5;
  const [w, , ] = last10.split('-').map(Number);
  return isNaN(w) ? 0.5 : Math.min(1, w / 10);
}

// ── Public builders ───────────────────────────────────────────────────────────

export async function buildGameFeatures(
  homeId: string,
  awayId: string,
  marketType: string = 'moneyline',
  line?: number,
  opts: GameFeatureOpts = {}
): Promise<GameFeatures> {
  const includeOdds   = opts.includeOdds !== false;    // défaut : true
  const includeTravel = opts.includeTravel === true;   // défaut : false
  const [home, away] = await Promise.all([getTeam(homeId), getTeam(awayId)]);

  // Stats spéciales + tirs (PP/PK réels — absents des standings) et repos.
  // Tolérance aux pannes : chaque source a un fallback neutre.
  const homeAbbr = home?.abbreviation ?? homeId;
  const awayAbbr = away?.abbreviation ?? awayId;

  // Cotes live (facultatif) — noms complets pour le matching The Odds API.
  const homeName = home?.name ?? homeAbbr;
  const awayName = away?.name ?? awayAbbr;

  const [summaryRes, homeRestRes, awayRestRes, oddsRes, totalsRes,
         homeTravelRes, awayTravelRes, goaliesRes, scratchesRes] = await Promise.allSettled([
    fetchTeamSummaryStats(),
    fetchTeamRestInfo(homeAbbr),
    fetchTeamRestInfo(awayAbbr),
    includeOdds ? fetchOddsImplied(homeName, awayName) : Promise.resolve(null),
    includeOdds ? fetchTotalsOdds(homeName, awayName)  : Promise.resolve(null),
    // Voyage : les deux équipes jouent dans l'aréna de l'équipe à domicile.
    // Désactivé par défaut — cf. `GameFeatureOpts.includeTravel`.
    includeTravel ? fetchTeamTravel(homeAbbr, homeAbbr) : Promise.resolve(null),
    includeTravel ? fetchTeamTravel(awayAbbr, homeAbbr) : Promise.resolve(null),
    // Gardiens partants et absents du soir : en base depuis la migration 034
    // (les fichiers `ml/data/*.json` n'existaient pas dans le conteneur, donc
    // ces deux features étaient TOUJOURS vides en production). La journée
    // entière est lue en un accès, pas une lecture par équipe.
    getStartingGoalies(),
    getScratchesDay(),
  ]);

  const odds   = oddsRes.status   === 'fulfilled' ? oddsRes.value   : null;
  const totals = totalsRes.status === 'fulfilled' ? totalsRes.value : null;

  const summary: Record<string, TeamSummaryStats> =
    summaryRes.status === 'fulfilled' ? summaryRes.value : {};
  const homeRest: TeamRestInfo =
    homeRestRes.status === 'fulfilled' ? homeRestRes.value : { restDays: 2, b2b: 0, dense3in4: 0 };
  const awayRest: TeamRestInfo =
    awayRestRes.status === 'fulfilled' ? awayRestRes.value : { restDays: 2, b2b: 0, dense3in4: 0 };

  // Voyage : null si calendrier indispo → champs laissés undefined (neutres).
  const homeTravel = homeTravelRes.status === 'fulfilled' ? homeTravelRes.value : null;
  const awayTravel = awayTravelRes.status === 'fulfilled' ? awayTravelRes.value : null;
  const venueAlt = getArena(homeAbbr)?.alt;

  // Saisie manuelle du jour. Repli sur un objet vide : une base injoignable doit
  // retirer la feature, pas casser la prédiction (c'est déjà ce que faisait le
  // `catch` du chargeur de fichier).
  const goaliesToday   = goaliesRes.status   === 'fulfilled' ? goaliesRes.value   : {};
  const scratchesToday = scratchesRes.status === 'fulfilled' ? scratchesRes.value : {};

  const homeSum = summary[homeAbbr.toUpperCase()];
  const awaySum = summary[awayAbbr.toUpperCase()];

  return {
    home_win_pct:          ((home?.winPct          || 50) / 100),
    away_win_pct:          ((away?.winPct          || 50) / 100),
    home_goals_for_pg:     home?.goalsForPerGame  || 3.0,
    away_goals_for_pg:     away?.goalsForPerGame  || 3.0,
    home_goals_against_pg: home?.goalsAgainstPerGame || 3.0,
    away_goals_against_pg: away?.goalsAgainstPerGame || 3.0,
    // PP/PK depuis l'API stats (source fiable), fallback standings puis neutre
    // Pas de repli à 20/80 ici : « inconnu » doit rester distinct de « faible ».
    home_pp_pct:           homeSum?.ppPct ?? home?.ppPct,
    away_pp_pct:           awaySum?.ppPct ?? away?.ppPct,
    home_pk_pct:           homeSum?.pkPct ?? home?.pkPct,
    away_pk_pct:           awaySum?.pkPct ?? away?.pkPct,
    home_last10_win_pct:   parseLastTen(home?.last10),
    away_last10_win_pct:   parseLastTen(away?.last10),
    // ── Nouvelles features (v2)
    home_home_win_pct:     home?.homeWinPct ?? 0.54,
    away_road_win_pct:     away?.roadWinPct ?? 0.46,
    home_streak:           home?.streakSigned ?? 0,
    away_streak:           away?.streakSigned ?? 0,
    home_shots_for_pg:     homeSum?.shotsForPg     ?? 30,
    away_shots_for_pg:     awaySum?.shotsForPg     ?? 30,
    home_shots_against_pg: homeSum?.shotsAgainstPg ?? 30,
    away_shots_against_pg: awaySum?.shotsAgainstPg ?? 30,
    home_faceoff_pct:      homeSum?.faceoffPct ?? 50,
    away_faceoff_pct:      awaySum?.faceoffPct ?? 50,
    home_rest_days:        homeRest.restDays,
    away_rest_days:        awayRest.restDays,
    home_b2b:              homeRest.b2b,
    away_b2b:              awayRest.b2b,
    home_3in4:             homeRest.dense3in4,
    away_3in4:             awayRest.dense3in4,
    // ── v5 — voyage / fuseaux / altitude / road-trip
    home_distance_km:      homeTravel?.distance_km,
    away_distance_km:      awayTravel?.distance_km,
    home_tz_shift:         homeTravel?.tz_shift,
    away_tz_shift:         awayTravel?.tz_shift,
    home_days_away:        homeTravel?.days_away,
    away_days_away:        awayTravel?.days_away,
    home_road_trip_len:    homeTravel?.road_trip_len,
    away_road_trip_len:    awayTravel?.road_trip_len,
    home_road_game_num:    homeTravel?.road_game_num,
    away_road_game_num:    awayTravel?.road_game_num,
    home_getaway:          homeTravel?.getaway,
    away_getaway:          awayTravel?.getaway,
    home_alt_gain:         homeTravel?.alt_gain,
    away_alt_gain:         awayTravel?.alt_gain,
    venue_altitude_m:      venueAlt,
    home_team:             homeAbbr.toUpperCase(),
    away_team:             awayAbbr.toUpperCase(),
    market_type:           marketType,
    selection:             opts.selection,
    subject_is_home:       opts.subjectIsHome !== false,
    line,
    // ── v4 — cotes live (si dispo) → le service Python active le blend
    home_odds_decimal:     odds?.homeOdds,
    away_odds_decimal:     odds?.awayOdds,
    total_line_market:     totals?.line,
    // ── v4 — gardien partant : override explicite de l'appelant, sinon le
    //    saisie manuelle du jour (kind `starting_goalies`, exceptions), sinon
    //    rien (le service Python utilise sa moyenne pondérée par usage).
    home_goalie:           opts.homeGoalie ?? goaliesToday[homeAbbr.toUpperCase()],
    away_goalie:           opts.awayGoalie ?? goaliesToday[awayAbbr.toUpperCase()],
    home_stars_missing:    opts.homeStarsMissing,
    away_stars_missing:    opts.awayStarsMissing,
    // ── v4 — absents confirmés : override de l'appelant, sinon fichier manuel
    //    du jour (kind `scratches`). Le service Python en dérive stars_missing,
    //    star_power (bons joueurs retirés) et stars_out_weight (absence pondérée).
    home_scratches:        opts.homeScratches ?? scratchesToday[homeAbbr.toUpperCase()] ?? [],
    away_scratches:        opts.awayScratches ?? scratchesToday[awayAbbr.toUpperCase()] ?? [],
  };
}

export async function buildPlayerPropFeatures(
  playerId: string,
  propType: string,
  line: number,
  selection: string = 'over'
): Promise<PlayerPropFeatures> {
  const player = await fetchPlayerById(playerId);
  const gp = Math.max(player.gamesPlayed ?? 1, 1);

  // ── Cadences des marchés hors statistiques principales ────────────────────
  //
  // Ces marchés (mises en échec, tirs bloqués, pénalités, arrêts…) ne sont pas
  // dans `goals/assists/points/shots` : leur cadence voyage vers le service
  // Python par `shots_per_game`, que `rate_map` relit sous le bon nom.
  //
  // CE QU'IL Y AVAIT ICI : une table de constantes de ligue — `saves: 27.0`,
  // `hits: 2.1`, `blocks: 0.5`, `pim: 0.50` — servie pour TOUS les joueurs. Deux
  // gardiens qui voient réellement 30.1 et 22.1 tirs par match recevaient le
  // même 44 %, et le service renvoyait « player averages 27.00 saves/game » en
  // nommant le joueur. Un chiffre de ligue présenté comme une mesure sur lui.
  //
  // Ce qui EST par joueur l'est maintenant vraiment : `fetchPlayerById` remonte
  // `shotsAgainst`/`goalsAgainst` (gardiens) et `penaltyMinutes` pour tout le
  // monde. Le reste reste une moyenne de ligue, mais le dit.

  /** Arrêts réellement effectués par CE gardien, par match. */
  const goalieSaves = (): number | null => {
    const sa = player.shotsAgainst, ga2 = player.goalsAgainst;
    if (sa == null || ga2 == null || sa <= 0) return null;
    const saves = Math.max(0, sa - ga2) / gp;
    return saves > 0 ? saves : null;
  };

  const perPlayer: Record<string, () => number | null> = {
    saves: goalieSaves,
    pim:   () => (player.penaltyMinutes != null ? player.penaltyMinutes / gp : null),
  };

  /** Moyennes de ligue — aucune source par joueur dans l'API utilisée ici. */
  const LEAGUE_AVERAGES: Record<string, number> = {
    hits:     2.1,   // skater average across positions
    blocks:   0.5,   // average blocked shots/game
    saves:   27.0,   // repli quand le gardien n'a pas encore de saison
    pim:      0.50,
    wins:     0.50,  // goalie wins ~50% of starts
    shutouts: 0.10,  // shutout ~10% of starts
  };

  const measured    = perPlayer[propType]?.() ?? null;
  const leagueRate  = LEAGUE_AVERAGES[propType];
  const specialRate = measured ?? leagueRate;

  return {
    goals_per_game:   (player.goals   ?? 0) / gp,
    assists_per_game: (player.assists  ?? 0) / gp,
    points_per_game:  (player.points   ?? 0) / gp,
    shots_per_game:   specialRate != null ? specialRate : (player.shots ?? 0) / gp,
    games_played:     gp,
    line,
    prop_type: propType,
    selection,
    // Le service Python formule son explication au nom du joueur (« player
    // averages X/game »). Ce drapeau lui dit quand il n'a pas le droit : la
    // cadence est alors une moyenne de ligue, pas une mesure sur lui.
    rate_is_league_average: leagueRate != null && measured === null,
  };
}

export async function buildTeamFuturesFeatures(
  teamId: string,
  propType: string
): Promise<TeamFuturesFeatures> {
  const [team, allTeams] = await Promise.all([getTeam(teamId), fetchTeams()]);

  const confTeams: any[] = allTeams
    .filter((t: any) => t.conference === (team?.conference ?? 'Eastern'))
    .sort((a: any, b: any) => (b.points ?? 0) - (a.points ?? 0));

  const rank =
    confTeams.findIndex(
      (t: any) => t.id?.toLowerCase() === (team?.id ?? '').toLowerCase()
    ) + 1 || 8;

  return {
    win_pct:          team?.winPct          || 50,
    goals_for_pg:     team?.goalsForPerGame || 3.0,
    goals_against_pg: team?.goalsAgainstPerGame || 3.0,
    pp_pct:           team?.ppPct || 20,
    pk_pct:           team?.pkPct || 80,
    conference_rank:  rank,
    prop_type:        propType,
  };
}
