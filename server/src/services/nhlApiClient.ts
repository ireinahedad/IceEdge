/**
 * nhlApiClient.ts
 * Fetches real-time data from the official NHL Stats API (api-web.nhle.com/v1).
 * Results are cached in memory with per-endpoint TTLs.
 *
 * Point d'entrée public, inchangé pour les appelants et les `vi.mock` des tests.
 * Le code vit dans `./nhl/` depuis le 2026-09-15 (le fichier faisait 2008 lignes) :
 *
 *   core.ts           mode mock, cache TTL, dédoublonnage, fetch avec délai, TEAM_META
 *   teamsAndGames.ts  équipes, classement, calendrier, matchs, fiche de match
 *   gameEvents.ts     feuille de match, buts marqués, mises au jeu (règlement des paris)
 *   players.ts        meilleurs joueurs, fiche joueur, recherche, effectif
 *   teamSeasons.ts    saisons par joueur, splits par adversaire, stats officielles, leaders
 *   restTravel.ts     repos, back-to-back, déplacements
 */

export {
  USE_MOCK,
} from './nhl/core';
export {
  fetchTeams,
  fetchTeamByAbbr,
  fetchGamesByDate,
  fetchGamesRange,
  fetchScheduleAnchor,
  fetchLiveGames,
  fetchGameById,
  fetchGameDetail,
} from './nhl/teamsAndGames';
export {
  fetchGameBoxscore,
  fetchGameBoxscoreFull,
  fetchGameScoringPlays,
  fetchGameFaceoffWins,
} from './nhl/gameEvents';
export type {
  BoxscorePlayerStats,
  GameBoxscore,
  ScoringGoal,
} from './nhl/gameEvents';
export {
  fetchTopPlayers,
  fetchPlayerById,
  searchPlayers,
  fetchTeamRoster,
} from './nhl/players';
export {
  fetchTeamPlayerSeasons,
  fetchTeamOpponentSplits,
  fetchTeamSeasonOfficial,
  fetchPlayerLeaders,
  fetchAllTeamsSeason,
  fetchTeamSummaryStats,
  fetchHeadToHead,
} from './nhl/teamSeasons';
export type {
  TeamSummaryStats,
  HeadToHeadGame,
} from './nhl/teamSeasons';
export {
  fetchTeamRestInfo,
  fetchTeamTravel,
} from './nhl/restTravel';
export type {
  TeamRestInfo,
} from './nhl/restTravel';
