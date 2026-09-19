/**
 * nhl.service.ts
 * All NHL data is fetched live from the official NHL Stats API via nhlApiClient.
 * The DB is only used for user-specific records (bets, profiles, chat).
 */

import * as nhlApi from './nhlApiClient';

export class NHLService {

  // --- Games ----------------------------------------------------------------

  async getGamesByDate(date?: string) {
    const d = date || new Date().toISOString().split('T')[0];
    return nhlApi.fetchGamesByDate(d);
  }

  async getGamesRange(start: string, end: string) {
    return nhlApi.fetchGamesRange(start, end);
  }

  async getScheduleAnchor() {
    return nhlApi.fetchScheduleAnchor();
  }

  async getLiveGames() {
    return nhlApi.fetchLiveGames();
  }

  async getGame(id: string) {
    return nhlApi.fetchGameById(id);
  }

  async getGameDetail(id: string) {
    return nhlApi.fetchGameDetail(id);
  }

  // --- Teams ----------------------------------------------------------------

  async getTeams() {
    return nhlApi.fetchTeams();
  }

  async getTeamStats(id: string) {
    const t = await nhlApi.fetchTeamByAbbr(id);
    // PP% / PK% : `standings` ne les porte PAS (powerPlayPctg/penaltyKillPctg y
    // sont absents, d'où le 0 de fetchTeams), ils vivent dans team/summary. Sans
    // cette fusion, la page d'une équipe affichait « PK% — » et calculait ses
    // règles spéciales sur 0 % — le moteur de prédiction, lui, lisait déjà la
    // bonne source, ce qui faisait dire deux chiffres différents au même écran.
    // Le try/catch est là pour que le reste de la fiche sorte quand même si
    // team/summary tombe (il expire au bout de 8 s comme les autres appels).
    let summary: { ppPct: number; pkPct: number } | undefined;
    try {
      summary = (await nhlApi.fetchTeamSummaryStats())[t.abbreviation];
    } catch { /* PP/PK indisponibles : on reste sur ce que porte le standings */ }
    return {
      teamId:              t.id,
      name:                t.name,
      abbreviation:        t.abbreviation,
      city:                t.city,
      conference:          t.conference,
      division:            t.division,
      color:               t.color,
      emoji:               t.emoji,
      gamesPlayed:         t.gamesPlayed,
      wins:                t.wins,
      losses:              t.losses,
      otLosses:            t.otLosses,
      points:              t.points,
      goalsFor:            t.goalsFor,
      goalsAgainst:        t.goalsAgainst,
      goalsForPerGame:     t.goalsForPerGame,
      goalsAgainstPerGame: t.goalsAgainstPerGame,
      powerPlayPct:        t.ppPct || summary?.ppPct || 0,
      penaltyKillPct:      t.pkPct || summary?.pkPct || 0,
      homeRecord:          t.homeRecord,
      awayRecord:          t.awayRecord,
      streak:              t.streak,
      winPct:              t.winPct,
    };
  }

  async getTeamLastNGames(id: string, n: number) {
    const stats = await this.getTeamStats(id);
    const gp    = stats.gamesPlayed || 1;
    const ratio = n / gp;
    return {
      ...stats,
      gamesPlayed:  n,
      wins:         Math.round(stats.wins         * ratio),
      losses:       Math.round(stats.losses       * ratio),
      goalsFor:     Math.round(stats.goalsFor     * ratio),
      goalsAgainst: Math.round(stats.goalsAgainst * ratio),
    };
  }

  // --- Players --------------------------------------------------------------

  async searchPlayers(q: string) {
    return nhlApi.searchPlayers(q);
  }

  async getAllPlayerStats() {
    return nhlApi.fetchTopPlayers();
  }

  async getTeamRoster(abbr: string) {
    return nhlApi.fetchTeamRoster(abbr);
  }

  async getTeamPlayerSeasons(abbr: string) {
    return nhlApi.fetchTeamPlayerSeasons(abbr);
  }

  async getTeamOpponentSplits(abbr: string, season: string) {
    return nhlApi.fetchTeamOpponentSplits(abbr, season);
  }

  async getTeamSeasonOfficial(abbr: string, season: string) {
    return nhlApi.fetchTeamSeasonOfficial(abbr, season);
  }

  async getAllTeamsSeason(season?: string) {
    return nhlApi.fetchAllTeamsSeason(season);
  }

  async getPlayerLeaders(
    season: string | undefined,
    view: 'skater' | 'goalie',
    sort: string,
    limit: number,
  ) {
    return nhlApi.fetchPlayerLeaders(season, view, sort, limit);
  }

  async getPlayer(id: string) {
    return nhlApi.fetchPlayerById(id);
  }

  async getPlayerStats(id: string) {
    const p = await nhlApi.fetchPlayerById(id);
    return {
      playerId:         p.id,
      fullName:         p.name,
      teamAbbr:         p.teamAbbr,
      season:           null,
      gamesPlayed:      p.gamesPlayed,
      goals:            p.goals,
      assists:          p.assists,
      points:           p.points,
      plusMinus:        p.plusMinus,
      shots:            p.shots,
      shootingPct:      p.shotPct,
      powerPlayGoals:   null,
      powerPlayPoints:  p.ppPoints,
      shortHandedGoals: null,
      // ⚠️ Ces quatre champs étaient écrits `null` EN DUR, alors que
      // `fetchPlayerById` les remonte (`penaltyMinutes`, `avgToi`) ou les
      // remonte depuis le câblage du rapport `realtime` (`blockedShots`,
      // `hits`). Ce DTO les jetait juste avant la sortie.
      //
      // Conséquence à l'écran : `PlayerPrediction` garde ses groupes de marchés
      // « Blocked Shots », « Hits » et « Penalty Minutes » derrière un `> 0`
      // sur ces valeurs. `null ?? 0` valant 0, la garde était toujours fausse —
      // trois groupes de paris écrits et jamais rendus une seule fois. Le
      // commentaire de `fetchPlayerById` explique même que `pim` et `avgToi`
      // avaient été ajoutés exprès ; ils n'ont jamais traversé cette couche.
      penaltyMinutes:   p.penaltyMinutes ?? null,
      blockedShots:     p.blockedShots ?? null,
      hits:             p.hits ?? null,
      timeOnIce:        p.avgToi ?? null,
      faceoffWinPct:    null,
      lastFive:         p.lastFive,
      winImpact:        p.winImpact,
    };
  }

  // --- Standings ------------------------------------------------------------

  async getStandings() {
    const teams = await nhlApi.fetchTeams();
    const grouped: Record<string, any> = {};

    for (const t of teams) {
      const key = `${t.conference}-${t.division}`;
      if (!grouped[key]) {
        grouped[key] = { conference: t.conference, division: t.division, teams: [] };
      }
      grouped[key].teams.push({
        rank: grouped[key].teams.length + 1,
        team: {
          id:           t.id,
          name:         t.name,
          abbreviation: t.abbreviation,
          emoji:        t.emoji,
        },
        stats: {
          gamesPlayed:      t.gamesPlayed,
          wins:             t.wins,
          losses:           t.losses,
          otLosses:         t.otLosses,
          points:           t.points,
          winPct:           t.winPct,
          goalDifferential: t.goalsFor - t.goalsAgainst,
          streak:           t.streak,
        },
      });
    }
    return Object.values(grouped);
  }
}
