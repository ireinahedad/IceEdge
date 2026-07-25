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

  // --- Teams ----------------------------------------------------------------

  async getTeams() {
    return nhlApi.fetchTeams();
  }

  async getTeamStats(id: string) {
    const t = await nhlApi.fetchTeamByAbbr(id);
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
      powerPlayPct:        t.ppPct,
      penaltyKillPct:      t.pkPct,
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
      penaltyMinutes:   null,
      blockedShots:     null,
      hits:             null,
      timeOnIce:        null,
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
