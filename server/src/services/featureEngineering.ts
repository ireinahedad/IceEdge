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
import { getStartingGoalie } from './startingGoalies';
import { getScratches } from './scratches';

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
}

// ── Feature types (mirror Python Pydantic models) ─────────────────────────────

export interface GameFeatures {
  home_win_pct:        number;   // 0–1
  away_win_pct:        number;
  home_goals_for_pg:   number;
  away_goals_for_pg:   number;
  home_goals_against_pg: number;
  away_goals_against_pg: number;
  home_pp_pct:         number;   // %
  away_pp_pct:         number;
  home_pk_pct:         number;
  away_pk_pct:         number;
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

async function getTeam(id: string): Promise<any | null> {
  const teams = await fetchTeams();
  const norm = id.toLowerCase();
  return (
    teams.find(
      (t: any) =>
        t.id?.toLowerCase() === norm ||
        t.abbreviation?.toLowerCase() === norm
    ) ?? null
  );
}

/** Parse last-10 string like "7-2-1" → win% */
function parseLastTen(last10: string | undefined): number {
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
  const includeOdds = opts.includeOdds !== false;   // défaut : true
  const [home, away] = await Promise.all([getTeam(homeId), getTeam(awayId)]);

  // Stats spéciales + tirs (PP/PK réels — absents des standings) et repos.
  // Tolérance aux pannes : chaque source a un fallback neutre.
  const homeAbbr = home?.abbreviation ?? homeId;
  const awayAbbr = away?.abbreviation ?? awayId;

  // Cotes live (facultatif) — noms complets pour le matching The Odds API.
  const homeName = home?.name ?? homeAbbr;
  const awayName = away?.name ?? awayAbbr;

  const [summaryRes, homeRestRes, awayRestRes, oddsRes, totalsRes,
         homeTravelRes, awayTravelRes] = await Promise.allSettled([
    fetchTeamSummaryStats(),
    fetchTeamRestInfo(homeAbbr),
    fetchTeamRestInfo(awayAbbr),
    includeOdds ? fetchOddsImplied(homeName, awayName) : Promise.resolve(null),
    includeOdds ? fetchTotalsOdds(homeName, awayName)  : Promise.resolve(null),
    // Voyage : les deux équipes jouent dans l'aréna de l'équipe à domicile.
    fetchTeamTravel(homeAbbr, homeAbbr),
    fetchTeamTravel(awayAbbr, homeAbbr),
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
    home_pp_pct:           homeSum?.ppPct ?? home?.ppPct ?? 20,
    away_pp_pct:           awaySum?.ppPct ?? away?.ppPct ?? 20,
    home_pk_pct:           homeSum?.pkPct ?? home?.pkPct ?? 80,
    away_pk_pct:           awaySum?.pkPct ?? away?.pkPct ?? 80,
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
    line,
    // ── v4 — cotes live (si dispo) → le service Python active le blend
    home_odds_decimal:     odds?.homeOdds,
    away_odds_decimal:     odds?.awayOdds,
    total_line_market:     totals?.line,
    // ── v4 — gardien partant : override explicite de l'appelant, sinon le
    //    fichier manuel starting_goalies.json (exceptions), sinon rien (le
    //    service Python utilise sa moyenne pondérée par usage).
    home_goalie:           opts.homeGoalie ?? getStartingGoalie(homeAbbr),
    away_goalie:           opts.awayGoalie ?? getStartingGoalie(awayAbbr),
    home_stars_missing:    opts.homeStarsMissing,
    away_stars_missing:    opts.awayStarsMissing,
    // ── v4 — absents confirmés : override de l'appelant, sinon fichier manuel
    //    scratches.json (exceptions). Le service Python en dérive stars_missing,
    //    star_power (bons joueurs retirés) et stars_out_weight (absence pondérée).
    home_scratches:        opts.homeScratches ?? getScratches(homeAbbr),
    away_scratches:        opts.awayScratches ?? getScratches(awayAbbr),
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

  // For prop types not covered by the main stats (hits, blocks, pim, saves, wins, shutouts),
  // inject a sensible per-game rate via shots_per_game so the Python Poisson model
  // can use it via its extended rate_map.
  const SPECIAL_RATES: Record<string, number> = {
    hits:     2.1,   // skater average across positions
    blocks:   0.5,   // average blocked shots/game
    pim:      0.50,  // average penalty min/game
    saves:    27.0,  // league-avg goalie saves per start
    wins:     0.50,  // goalie wins ~50% of starts
    shutouts: 0.10,  // shutout ~10% of starts
  };
  const specialRate = SPECIAL_RATES[propType];

  return {
    goals_per_game:   (player.goals   ?? 0) / gp,
    assists_per_game: (player.assists  ?? 0) / gp,
    points_per_game:  (player.points   ?? 0) / gp,
    shots_per_game:   specialRate != null ? specialRate : (player.shots ?? 0) / gp,
    games_played:     gp,
    line,
    prop_type: propType,
    selection,
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
