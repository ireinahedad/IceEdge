/**
 * nhl/teamSeasons.ts — statistiques de saison : par joueur, par adversaire,
 * officielles, leaders et résumé des équipes. Point d'entrée public : `../nhlApiClient.ts`.
 */

import { currentSeason, previousSeason, fetchNHL, fetchStats, getCached, parseToiMinutes, setCached } from './core';

/**
 * Last 6 NHL regular seasons of per-player stats for a team — powers the
 * Bet365-style charts grid. Players are split into skaters and goalies, and a
 * player traded mid-season (multiple NHL rows for the same seasonId) is folded
 * into a single per-season entry: counting stats are summed, goalie rate stats
 * (SV%, GAA) are games-weighted.
 */
export async function fetchTeamPlayerSeasons(abbr: string): Promise<any> {
  const upper    = abbr.toUpperCase();
  const cacheKey = `player_seasons_${upper}`;
  const cached   = getCached<any>(cacheKey);
  if (cached) return cached;

  const season     = currentSeason();
  const rosterData = await fetchNHL<any>(`v1/roster/${upper}/${season}`);
  const skaterRoster: any[] = [
    ...(rosterData.forwards   ?? []),
    ...(rosterData.defensemen ?? []),
  ];
  const goalieRoster: any[] = rosterData.goalies ?? [];
  const allPlayers          = [...skaterRoster, ...goalieRoster];

  const landings = await Promise.allSettled(
    allPlayers.map(p => fetchNHL<any>(`v1/player/${p.id}/landing`))
  );

  const skaters: any[]        = [];
  const goalies: any[]        = [];
  const seasonIds: Set<number> = new Set();

  for (let i = 0; i < allPlayers.length; i++) {
    const roster = allPlayers[i];
    const res    = landings[i];
    if (res.status === 'rejected') continue;
    const data     = res.value as any;
    const isGoalie = (roster.positionCode ?? data.position) === 'G';

    // NHL regular-season rows only.
    const rows: any[] = (data.seasonTotals ?? []).filter(
      (s: any) => s.leagueAbbrev === 'NHL' && s.gameTypeId === 2
    );
    if (rows.length === 0) continue;

    // Fold split seasons (traded mid-year) into one entry per seasonId.
    const bySeason = new Map<number, any>();
    for (const s of rows) {
      const id  = Number(s.season);
      const gp  = s.gamesPlayed ?? 0;
      const cur = bySeason.get(id) ?? {
        seasonId: id, gp: 0, goals: 0, assists: 0, points: 0, plusMinus: 0,
        shots: 0, ppPoints: 0, wins: 0, shutouts: 0, _svW: 0, _gaaW: 0,
        pim: 0, powerPlayGoals: 0, shorthandedPoints: 0, _foW: 0, _toiW: 0,
        losses: 0, otLosses: 0,
      };
      cur.gp  += gp;
      cur.pim += s.pim ?? 0;
      if (isGoalie) {
        cur.wins     += s.wins     ?? 0;
        cur.losses   += s.losses   ?? 0;
        cur.otLosses += s.otLosses ?? 0;
        cur.shutouts += s.shutouts ?? 0;
        cur._svW     += (s.savePctg        ?? 0) * gp;
        cur._gaaW    += (s.goalsAgainstAvg ?? 0) * gp;
      } else {
        cur.goals             += s.goals             ?? 0;
        cur.assists            += s.assists           ?? 0;
        cur.points             += s.points            ?? 0;
        cur.plusMinus          += s.plusMinus         ?? 0;
        cur.shots              += s.shots             ?? 0;
        cur.ppPoints           += s.powerPlayPoints   ?? 0;
        cur.powerPlayGoals     += s.powerPlayGoals    ?? 0;
        cur.shorthandedPoints  += s.shorthandedPoints ?? 0;
        cur._foW               += (s.faceoffWinningPctg ?? 0) * gp;
        cur._toiW              += parseToiMinutes(s.avgToi) * gp;
      }
      bySeason.set(id, cur);
    }

    // Newest 6 seasons, finalised.
    const seasons = [...bySeason.values()]
      .sort((a, b) => b.seasonId - a.seasonId)
      .slice(0, 6)
      .map((s) => {
        seasonIds.add(s.seasonId);
        if (isGoalie) {
          s.savePct = s.gp > 0 ? Math.round((s._svW  / s.gp) * 1000) / 1000 : null;
          s.gaa     = s.gp > 0 ? Math.round((s._gaaW / s.gp) * 100)  / 100  : null;
        } else {
          s.shootingPct = s.shots > 0 ? Math.round((s.goals / s.shots) * 1000) / 10 : 0;
          s.faceoffPct  = s.gp > 0 ? Math.round((s._foW  / s.gp) * 1000) / 10 : null;
          s.avgToi      = s.gp > 0 ? Math.round((s._toiW / s.gp) * 100)  / 100 : null;
        }
        delete s._svW; delete s._gaaW; delete s._foW; delete s._toiW;
        return s;
      });

    const entry = {
      id:       String(roster.id),
      name:     [roster.firstName?.default, roster.lastName?.default].filter(Boolean).join(' '),
      position: roster.positionCode ?? (isGoalie ? 'G' : 'F'),
      number:   roster.sweaterNumber ?? 0,
      seasons,
    };
    (isGoalie ? goalies : skaters).push(entry);
  }

  // Column headers = the 6 most-recent seasons present across the roster.
  const seasonList = [...seasonIds].sort((a, b) => b - a).slice(0, 6);
  const recent     = seasonList[0];
  const recentVal  = (p: any, k: string) =>
    p.seasons.find((s: any) => s.seasonId === recent)?.[k] ?? -1;

  skaters.sort((a, b) => recentVal(b, 'points') - recentVal(a, 'points'));
  goalies.sort((a, b) => recentVal(b, 'gp')     - recentVal(a, 'gp'));

  const out = { teamAbbr: upper, seasonIds: seasonList, skaters, goalies };
  setCached(cacheKey, out, 30 * 60_000);
  return out;
}

/**
 * Per-opponent splits for a team's current roster in a given season — powers
 * the "average per game against a chosen team" column. For every player we pull
 * the season game log and bucket their stats by `opponentAbbrev`, so the client
 * can compute an average vs any opponent without re-fetching. Counting stats are
 * summed per opponent; the client divides by games-vs-opponent for the average.
 */
export async function fetchTeamOpponentSplits(abbr: string, season: string): Promise<any> {
  const upper    = abbr.toUpperCase();
  const cacheKey = `opp_splits_${upper}_${season}`;
  const cached   = getCached<any>(cacheKey);
  if (cached) return cached;

  const rosterData = await fetchNHL<any>(`v1/roster/${upper}/${currentSeason()}`);
  const players = [
    ...(rosterData.forwards   ?? []).map((p: any) => ({ ...p, isGoalie: false })),
    ...(rosterData.defensemen ?? []).map((p: any) => ({ ...p, isGoalie: false })),
    ...(rosterData.goalies    ?? []).map((p: any) => ({ ...p, isGoalie: true  })),
  ];

  const logs = await Promise.allSettled(
    players.map(p => fetchNHL<any>(`v1/player/${p.id}/game-log/${season}/2`)),
  );

  const opponents: Set<string> = new Set();
  const skaters: any[] = [];
  const goalies: any[] = [];

  for (let i = 0; i < players.length; i++) {
    const p   = players[i];
    const res = logs[i];
    if (res.status === 'rejected') continue;
    const gameLog: any[] = (res.value as any).gameLog ?? [];
    if (gameLog.length === 0) continue;

    // Chronological (NHL returns most-recent-first) → per-game series for the
    // line chart, plus the per-opponent buckets for the vs-team column.
    const ordered = [...gameLog].sort((a, b) => String(a.gameDate).localeCompare(String(b.gameDate)));

    const vs: Record<string, any> = {};
    const series: any[] = [];
    for (const g of ordered) {
      series.push(p.isGoalie
        ? {
            wins: g.decision === 'W' ? 1 : 0,
            shutouts:     g.shutouts     ?? 0,
            saves:        g.saves        ?? 0,
            shotsAgainst: g.shotsAgainst ?? 0,
            goalsAgainst: g.goalsAgainst ?? 0,
            savePct:      g.savePctg ?? null,
          }
        : {
            goals:     g.goals           ?? 0,
            assists:   g.assists         ?? 0,
            points:    g.points          ?? 0,
            plusMinus: g.plusMinus       ?? 0,
            shots:     g.shots           ?? 0,
            ppPoints:  g.powerPlayPoints ?? 0,
          });

      const opp = g.opponentAbbrev;
      if (!opp) continue;
      opponents.add(opp);
      const cur = vs[opp] ?? (p.isGoalie
        ? { gp: 0, wins: 0, shutouts: 0, saves: 0, shotsAgainst: 0, goalsAgainst: 0 }
        : { gp: 0, goals: 0, assists: 0, points: 0, plusMinus: 0, shots: 0, ppPoints: 0 });
      cur.gp += 1;
      if (p.isGoalie) {
        if (g.decision === 'W') cur.wins += 1;
        cur.shutouts     += g.shutouts     ?? 0;
        cur.saves        += g.saves        ?? 0;
        cur.shotsAgainst += g.shotsAgainst ?? 0;
        cur.goalsAgainst += g.goalsAgainst ?? 0;
      } else {
        cur.goals     += g.goals           ?? 0;
        cur.assists   += g.assists         ?? 0;
        cur.points    += g.points          ?? 0;
        cur.plusMinus += g.plusMinus       ?? 0;
        cur.shots     += g.shots           ?? 0;
        cur.ppPoints  += g.powerPlayPoints ?? 0;
      }
      vs[opp] = cur;
    }
    (p.isGoalie ? goalies : skaters).push({ id: String(p.id), vs, series });
  }

  const out = {
    teamAbbr:  upper,
    season:    Number(season),
    opponents: [...opponents].sort(),
    skaters,
    goalies,
  };
  setCached(cacheKey, out, 30 * 60_000);
  return out;
}

/** Un match déjà joué entre deux équipes, vu du club demandé (`team`). */
export interface HeadToHeadGame {
  gameId:   string;
  date:     string;
  isHome:   boolean;
  goalsFor: number;
  goalsAgainst: number;
  /** `REG` | `OT` | `SO`. */
  lastPeriodType: string;
}

/**
 * Les derniers matchs JOUÉS entre `team` et `opp` (saison en cours puis
 * précédente, saison régulière et séries), du plus récent au plus ancien, vus
 * de `team`. Source : le calendrier du club (`club-schedule-season`), déjà lu
 * par `fetchTeamSeasonOfficial`.
 *
 * Donnée seule pour l'instant : son poids dans les règles et le modèle ML sera
 * MESURÉ sur l'historique avant d'être utilisé (voir `STATUS.md`). Une saison
 * illisible est simplement absente ; aucune valeur n'est inventée.
 */
export async function fetchHeadToHead(team: string, opp: string, limit = 10): Promise<HeadToHeadGame[]> {
  const t = team.toUpperCase(), o = opp.toUpperCase();
  const cacheKey = `h2h_${t}_${o}`;
  const cached = getCached<HeadToHeadGame[]>(cacheKey);
  if (cached) return cached;

  const out: HeadToHeadGame[] = [];
  for (const season of [currentSeason(), previousSeason()]) {
    try {
      const sched = await fetchNHL<any>(`v1/club-schedule-season/${t}/${season}`);
      for (const g of sched.games ?? []) {
        if (g.gameType !== 2 && g.gameType !== 3) continue;
        const home = g.homeTeam?.abbrev, away = g.awayTeam?.abbrev;
        if (!((home === t && away === o) || (home === o && away === t))) continue;
        const hs = g.homeTeam?.score, as = g.awayTeam?.score;
        if (hs == null || as == null) continue;   // pas encore joué
        const isHome = home === t;
        out.push({
          gameId: String(g.id), date: String(g.gameDate ?? ''), isHome,
          goalsFor: isHome ? hs : as, goalsAgainst: isHome ? as : hs,
          lastPeriodType: String(g.gameOutcome?.lastPeriodType ?? 'REG'),
        });
      }
    } catch { /* saison illisible : absente */ }
  }
  out.sort((a, b) => b.date.localeCompare(a.date));
  const recent = out.slice(0, limit);
  setCached(cacheKey, recent, 30 * 60_000);
  return recent;
}

/** Une rencontre jouée entre deux clubs, telle qu'affichée (domicile / visiteur). */
export interface HeadToHeadSeasonGame {
  gameId:    string;
  date:      string;
  homeAbbr:  string;
  awayAbbr:  string;
  homeScore: number;
  awayScore: number;
  /** 2 = saison régulière, 3 = séries. */
  gameType:  2 | 3;
  /** `REG` | `OT` | `SO`. */
  lastPeriodType: string;
}

export interface HeadToHeadSeason {
  /** Id NHL à 8 chiffres, ex. `20252026`. */
  season: string;
  games:  HeadToHeadSeasonGame[];
}

/**
 * TOUTES les rencontres jouées entre `team` et `opp` sur UNE saison (régulière
 * + séries), de la plus récente à la plus ancienne. Sert la section dépliable
 * « Saison précédente » du face-à-face de la page match : un seul appel au
 * calendrier du club, au lieu de balayer la saison semaine par semaine.
 *
 * Contrairement à `fetchHeadToHead`, une erreur de l'amont REMONTE : le client
 * doit pouvoir afficher « impossible de charger » plutôt que « aucune
 * rencontre », qui serait une affirmation fausse. Seul un 404 (club absent de
 * cette saison, ex. une franchise relocalisée) vaut liste vide.
 */
export async function fetchHeadToHeadSeason(team: string, opp: string, season: string): Promise<HeadToHeadSeason> {
  const t = team.toUpperCase(), o = opp.toUpperCase();
  // Même liste quel que soit le sens de la demande : TOR/MTL = MTL/TOR.
  const [a, b] = [t, o].sort();
  const cacheKey = `h2h_season_${a}_${b}_${season}`;
  const cached = getCached<HeadToHeadSeason>(cacheKey);
  if (cached) return cached;

  let sched: any;
  try {
    sched = await fetchNHL<any>(`v1/club-schedule-season/${t}/${season}`);
  } catch (err: any) {
    if (err?.status !== 404) throw err;
    sched = { games: [] };
  }

  const games: HeadToHeadSeasonGame[] = [];
  for (const g of sched?.games ?? []) {
    if (g.gameType !== 2 && g.gameType !== 3) continue;
    const home = g.homeTeam?.abbrev, away = g.awayTeam?.abbrev;
    if (!((home === t && away === o) || (home === o && away === t))) continue;
    const hs = g.homeTeam?.score, as = g.awayTeam?.score;
    if (hs == null || as == null) continue;   // pas encore joué
    games.push({
      gameId: String(g.id), date: String(g.gameDate ?? ''),
      homeAbbr: home, awayAbbr: away, homeScore: hs, awayScore: as,
      gameType: g.gameType,
      lastPeriodType: String(g.gameOutcome?.lastPeriodType ?? 'REG'),
    });
  }
  games.sort((x, y) => y.date.localeCompare(x.date));

  const out: HeadToHeadSeason = { season, games };
  // Une saison terminée ne bougera plus ; la saison en cours, si.
  setCached(cacheKey, out, season < currentSeason() ? 6 * 60 * 60_000 : 30 * 60_000);
  return out;
}

/**
 * Official team stats for a given season (NHL stats API team/summary) plus
 * per-opponent goals-for / goals-against / wins derived from that season's
 * schedule — powers the team-stats table (rows = metrics, same 3 columns).
 */
export async function fetchTeamSeasonOfficial(abbr: string, season: string): Promise<any> {
  const upper    = abbr.toUpperCase();
  const cacheKey = `team_season_${upper}_${season}`;
  const cached   = getCached<any>(cacheKey);
  if (cached) return cached;

  // Official summary for the season.
  let official: any = null;
  try {
    const cayenne = encodeURIComponent(`seasonId=${season} and gameTypeId=2`);
    const data = await fetchStats<any>(
      `${STATS_BASE}/team/summary?limit=-1&cayenneExp=${cayenne}`,
      'team summary',
    );
    const row  = (data.data ?? []).find(
      (t: any) => TEAM_NAME_TO_ABBR[t.teamFullName ?? ''] === upper,
    );
    if (row) {
      // `row.gamesPlayed || 82` annonçait une saison complète pour une équipe
      // qui n'a pas joué, et divisait les totaux par 82 → des moyennes à 0.00.
      const gp     = row.gamesPlayed ?? 0;
      const played = gp > 0;
      official = {
        gamesPlayed:         gp,
        wins:                row.wins   ?? 0,
        losses:              row.losses ?? 0,
        points:              row.points ?? 0,
        goalsFor:            row.goalsFor     ?? 0,
        goalsAgainst:        row.goalsAgainst ?? 0,
        goalsForPerGame:     played ? +(row.goalsForPerGame     ?? (row.goalsFor     ?? 0) / gp).toFixed(2) : null,
        goalsAgainstPerGame: played ? +(row.goalsAgainstPerGame ?? (row.goalsAgainst ?? 0) / gp).toFixed(2) : null,
        ppPct:               played ? Math.round((row.powerPlayPct   ?? 0) * 1000) / 10 : null,
        pkPct:               played ? Math.round((row.penaltyKillPct ?? 0) * 1000) / 10 : null,
        pointPct:            played ? Math.round((row.pointPct       ?? 0) * 1000) / 10 : null,
        faceoffPct:          played ? Math.round((row.faceoffWinPct  ?? 0) * 1000) / 10 : null,
        shotsForPerGame:     played ? +(row.shotsForPerGame     ?? 0).toFixed(2) : null,
        shotsAgainstPerGame: played ? +(row.shotsAgainstPerGame ?? 0).toFixed(2) : null,
      };
    }
  } catch { /* summary unavailable → official stays null */ }

  // Per-opponent splits + record breakdowns from the season schedule (played
  // games only). Result type: win / OT-loss (OT or SO) / regulation loss.
  const vsOpponent: Record<string, any> = {};
  type PlayedGame = { isHome: boolean; result: 'W' | 'OT' | 'L'; diff: number };
  const played: PlayedGame[] = [];
  try {
    const sched = await fetchNHL<any>(`v1/club-schedule-season/${upper}/${season}`);
    const games = (sched.games ?? [])
      .filter((g: any) => g.gameType === 2)
      .sort((a: any, b: any) => String(a.gameDate).localeCompare(String(b.gameDate)));
    for (const g of games) {
      const home = g.homeTeam?.abbrev;
      const away = g.awayTeam?.abbrev;
      const hs   = g.homeTeam?.score;
      const as   = g.awayTeam?.score;
      if (hs == null || as == null) continue; // not yet played
      const isHome = home === upper;
      const opp    = isHome ? away : home;
      const gf     = isHome ? hs : as;
      const ga     = isHome ? as : hs;
      const lastPeriod = g.gameOutcome?.lastPeriodType ?? 'REG';
      const win = gf > ga;
      const otl = !win && (lastPeriod === 'OT' || lastPeriod === 'SO');
      const result: 'W' | 'OT' | 'L' = win ? 'W' : otl ? 'OT' : 'L';

      played.push({ isHome, result, diff: Math.abs(gf - ga) });

      if (opp) {
        const cur = vsOpponent[opp] ?? { gp: 0, goalsFor: 0, goalsAgainst: 0, wins: 0, losses: 0, otLosses: 0 };
        cur.gp += 1; cur.goalsFor += gf; cur.goalsAgainst += ga;
        if (win) cur.wins += 1; else if (otl) cur.otLosses += 1; else cur.losses += 1;
        vsOpponent[opp] = cur;
      }
    }
  } catch { /* schedule unavailable → vsOpponent/record stay empty */ }

  const tally = (list: PlayedGame[]) => {
    const r = { w: 0, l: 0, otl: 0 };
    for (const g of list) { if (g.result === 'W') r.w += 1; else if (g.result === 'OT') r.otl += 1; else r.l += 1; }
    return r;
  };
  let streak = '';
  if (played.length) {
    const last = played[played.length - 1].result;
    let n = 0;
    for (let i = played.length - 1; i >= 0 && played[i].result === last; i--) n += 1;
    streak = `${last}${n}`;
  }
  const record = played.length
    ? {
        overall: tally(played),
        home:    tally(played.filter((g) => g.isHome)),
        away:    tally(played.filter((g) => !g.isHome)),
        last10:  tally(played.slice(-10)),
        oneGoal: tally(played.filter((g) => g.diff === 1)),
        streak,
      }
    : null;

  const out = { teamAbbr: upper, season: Number(season), official, vsOpponent, record };
  setCached(cacheKey, out, 30 * 60_000);
  return out;
}

// --- Team summary stats (PP/PK réels, tirs, mises au jeu) -------------------
// api.nhle.com/stats/rest — l'endpoint standings n'a PAS ces champs.

const STATS_BASE = 'https://api.nhle.com/stats/rest/en';

/**
 * League leaders for a season — powers the "All Players" charts page.
 *
 * Uses the NHL stats REST summary endpoints, which (unlike the leaders
 * endpoints in api-web) return a full stat line per player AND support
 * server-side sorting, so we can ask for "top N by <metric>" directly.
 *
 * Rows come back shaped like the client's `PlayerSeasonStat` so the existing
 * metric formatters on the charts page can render them unchanged.
 */
const LEADER_SORT_SKATER: Record<string, string> = {
  points: 'points', goals: 'goals', assists: 'assists', plusMinus: 'plusMinus',
  shots: 'shots', ppPoints: 'ppPoints', shootingPct: 'shootingPct',
  pim: 'penaltyMinutes', powerPlayGoals: 'ppGoals', shorthandedPoints: 'shPoints',
  faceoffPct: 'faceoffWinPct', avgToi: 'timeOnIcePerGame',
};
const LEADER_SORT_GOALIE: Record<string, string> = {
  wins: 'wins', savePct: 'savePct', gaa: 'goalsAgainstAverage',
  shutouts: 'shutouts', losses: 'losses', otLosses: 'otLosses',
};

export async function fetchPlayerLeaders(
  seasonArg: string | undefined,
  view: 'skater' | 'goalie',
  sortKey: string,
  limit: number,
): Promise<any> {
  const season   = seasonArg && /^\d{8}$/.test(seasonArg) ? seasonArg : currentSeason();
  const isGoalie = view === 'goalie';
  const map      = isGoalie ? LEADER_SORT_GOALIE : LEADER_SORT_SKATER;
  const key      = map[sortKey] ? sortKey : (isGoalie ? 'wins' : 'points');
  const prop     = map[key];
  // GAA sorts ascending (lower is better); every other metric is "more is better".
  const dir      = key === 'gaa' ? 'ASC' : 'DESC';
  const n        = Math.min(Math.max(limit || 20, 1), 100);

  const cacheKey = `leaders_${season}_${view}_${key}_${n}`;
  const cached   = getCached<any>(cacheKey);
  if (cached) return cached;

  const sort    = encodeURIComponent(JSON.stringify([{ property: prop, direction: dir }]));
  const cayenne = encodeURIComponent(`seasonId=${season} and gameTypeId=2`);
  const data = await fetchStats<any>(
    `${STATS_BASE}/${isGoalie ? 'goalie' : 'skater'}/summary` +
      `?isAggregate=false&isGame=false&start=0&limit=${n}&sort=${sort}&cayenneExp=${cayenne}`,
    'player leaders',
  );

  const players = (data.data ?? []).map((r: any) => ({
    id:       String(r.playerId),
    name:     isGoalie ? r.goalieFullName : r.skaterFullName,
    // `teamAbbrevs` is comma-separated when a player was traded mid-season.
    teamAbbr: String(r.teamAbbrevs ?? '').split(',')[0].trim().toUpperCase(),
    position: isGoalie ? 'G' : (r.positionCode ?? 'F'),
    stat: isGoalie
      ? {
          seasonId: Number(season),
          gp:       r.gamesPlayed ?? 0,
          wins:     r.wins     ?? 0,
          losses:   r.losses   ?? 0,
          otLosses: r.otLosses ?? 0,
          shutouts: r.shutouts ?? 0,
          savePct:  r.savePct != null ? Math.round(r.savePct * 1000) / 1000 : null,
          gaa:      r.goalsAgainstAverage != null
            ? Math.round(r.goalsAgainstAverage * 100) / 100
            : null,
        }
      : {
          seasonId:          Number(season),
          gp:                r.gamesPlayed ?? 0,
          goals:             r.goals      ?? 0,
          assists:           r.assists    ?? 0,
          points:            r.points     ?? 0,
          plusMinus:         r.plusMinus  ?? 0,
          shots:             r.shots      ?? 0,
          ppPoints:          r.ppPoints   ?? 0,
          pim:               r.penaltyMinutes ?? 0,
          powerPlayGoals:    r.ppGoals    ?? 0,
          shorthandedPoints: r.shPoints   ?? 0,
          // NHL returns these as 0–1 ratios; the client expects 0–100.
          shootingPct: r.shootingPct   != null ? Math.round(r.shootingPct   * 1000) / 10 : 0,
          faceoffPct:  r.faceoffWinPct != null ? Math.round(r.faceoffWinPct * 1000) / 10 : null,
          // ...and time-on-ice per game in seconds; the client expects minutes.
          avgToi: r.timeOnIcePerGame != null
            ? Math.round((r.timeOnIcePerGame / 60) * 100) / 100
            : null,
        },
  }));

  const out = { season: Number(season), view, sort: key, players };
  setCached(cacheKey, out, 30 * 60_000);
  return out;
}

const TEAM_NAME_TO_ABBR: Record<string, string> = {
  'Anaheim Ducks': 'ANA',         'Arizona Coyotes': 'ARI',
  'Boston Bruins': 'BOS',         'Buffalo Sabres': 'BUF',
  'Calgary Flames': 'CGY',        'Carolina Hurricanes': 'CAR',
  'Chicago Blackhawks': 'CHI',    'Colorado Avalanche': 'COL',
  'Columbus Blue Jackets': 'CBJ', 'Dallas Stars': 'DAL',
  'Detroit Red Wings': 'DET',     'Edmonton Oilers': 'EDM',
  'Florida Panthers': 'FLA',      'Los Angeles Kings': 'LAK',
  'Minnesota Wild': 'MIN',        'Montréal Canadiens': 'MTL',
  'Montreal Canadiens': 'MTL',    'Nashville Predators': 'NSH',
  'New Jersey Devils': 'NJD',     'New York Islanders': 'NYI',
  'New York Rangers': 'NYR',      'Ottawa Senators': 'OTT',
  'Philadelphia Flyers': 'PHI',   'Pittsburgh Penguins': 'PIT',
  'San Jose Sharks': 'SJS',       'Seattle Kraken': 'SEA',
  'St. Louis Blues': 'STL',       'Tampa Bay Lightning': 'TBL',
  'Toronto Maple Leafs': 'TOR',   'Utah Hockey Club': 'UTA',
  'Utah Mammoth': 'UTA',          'Vancouver Canucks': 'VAN',
  'Vegas Golden Knights': 'VGK',  'Washington Capitals': 'WSH',
  'Winnipeg Jets': 'WPG',
};

/**
 * Every team's season summary in one call — powers the "All Teams" charts page.
 * The NHL team/summary endpoint returns all 32 rows at once, so the client can
 * sort them locally; no per-metric round trip is needed the way it is for
 * players (where the league has ~940 skaters and we only want the top N).
 */
export async function fetchAllTeamsSeason(seasonArg?: string): Promise<any> {
  const season   = seasonArg && /^\d{8}$/.test(seasonArg) ? seasonArg : currentSeason();
  const cacheKey = `all_teams_${season}`;
  const cached   = getCached<any>(cacheKey);
  if (cached) return cached;

  const cayenne = encodeURIComponent(`seasonId=${season} and gameTypeId=2`);
  const data = await fetchStats<any>(
    `${STATS_BASE}/team/summary?limit=-1&cayenneExp=${cayenne}`,
    'team summary',
  );

  const teams = (data.data ?? []).map((row: any) => {
    const gp = row.gamesPlayed || 0;
    const gf = row.goalsFor     ?? 0;
    const ga = row.goalsAgainst ?? 0;
    return {
      abbr: TEAM_NAME_TO_ABBR[row.teamFullName ?? ''] ?? '',
      name: row.teamFullName ?? '',
      gamesPlayed: gp,
      wins:     row.wins     ?? 0,
      losses:   row.losses   ?? 0,
      otLosses: row.otLosses ?? 0,
      points:   row.points   ?? 0,
      goalsFor: gf,
      goalsAgainst: ga,
      goalDiff: gf - ga,
      goalsForPerGame:     +(row.goalsForPerGame     ?? (gp ? gf / gp : 0)).toFixed(2),
      goalsAgainstPerGame: +(row.goalsAgainstPerGame ?? (gp ? ga / gp : 0)).toFixed(2),
      shotsForPerGame:     +(row.shotsForPerGame     ?? 0).toFixed(2),
      shotsAgainstPerGame: +(row.shotsAgainstPerGame ?? 0).toFixed(2),
      // NHL sends these as 0–1 ratios; the client renders 0–100.
      ppPct:      Math.round((row.powerPlayPct   ?? 0) * 1000) / 10,
      pkPct:      Math.round((row.penaltyKillPct ?? 0) * 1000) / 10,
      pointPct:   Math.round((row.pointPct       ?? 0) * 1000) / 10,
      faceoffPct: Math.round((row.faceoffWinPct  ?? 0) * 1000) / 10,
      shutouts:   row.teamShutouts ?? 0,
    };
  // A renamed franchise missing from the abbreviation map would have no logo
  // and no working link, so drop it rather than render a dead row.
  }).filter((x: any) => x.abbr);

  const out = { season: Number(season), teams };
  setCached(cacheKey, out, 30 * 60_000);
  return out;
}

export interface TeamSummaryStats {
  ppPct:           number;  // 0–100
  pkPct:           number;  // 0–100
  shotsForPg:      number;
  shotsAgainstPg:  number;
  faceoffPct:      number;  // 0–100
}

/** PP%, PK%, tirs/match et mises au jeu de la saison en cours, par abréviation. */
export async function fetchTeamSummaryStats(): Promise<Record<string, TeamSummaryStats>> {
  const cached = getCached<Record<string, TeamSummaryStats>>('teamSummary');
  if (cached) return cached;

  const cayenne = encodeURIComponent(
    `seasonId=${currentSeason()} and gameTypeId=2`
  );
  const data = await fetchStats<any>(
    `${STATS_BASE}/team/summary?limit=-1&cayenneExp=${cayenne}`,
    'team/summary',
  );

  const out: Record<string, TeamSummaryStats> = {};
  for (const t of data.data ?? []) {
    const abbr = TEAM_NAME_TO_ABBR[t.teamFullName ?? ''];
    if (!abbr) continue;
    // Une ligne à 0 match joué porte des taux à 0 (PP 0 %, PK 0 %, 0 tir/match).
    // L'ABSENCE de la clé fait retomber `featureEngineering` sur ses valeurs
    // neutres ; sa PRÉSENCE à 0 les court-circuite, parce que le repli est
    // écrit `??`. Mieux vaut ne rien dire que dire zéro.
    if ((t.gamesPlayed ?? 0) < 1) continue;
    out[abbr] = {
      ppPct:          Math.round((t.powerPlayPct   ?? 0.20) * 1000) / 10,
      pkPct:          Math.round((t.penaltyKillPct ?? 0.80) * 1000) / 10,
      shotsForPg:     +(t.shotsForPerGame     ?? 30).toFixed(2),
      shotsAgainstPg: +(t.shotsAgainstPerGame ?? 30).toFixed(2),
      faceoffPct:     Math.round((t.faceoffWinPct  ?? 0.50) * 1000) / 10,
    };
  }

  setCached('teamSummary', out, 10 * 60_000);
  return out;
}
