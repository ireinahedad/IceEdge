/**
 * mockNhl.ts
 * ------------------------------------------------------------------
 * Rich, self-contained mock NHL dataset used to ARTIFICIALLY populate
 * the app when NHL_USE_MOCK=true (e.g. off-season / offline demo).
 *
 * Shapes mirror the live nhlApiClient outputs exactly so the rest of
 * the pipeline (predictionEngine, featureEngineering, best-bets) works
 * unchanged. Numbers mirror the DB seed for consistency.
 */

// ─── Teams (shape = fetchTeams() output) ──────────────────────────────────────

interface MockTeam {
  id: string; name: string; abbreviation: string; emoji: string; color: string;
  winPct: number; goalsForPerGame: number; goalsAgainstPerGame: number;
  ppPct: number; pkPct: number; last10: string;
  homeWinPct: number; roadWinPct: number; streakSigned: number;
  goalsFor: number; goalsAgainst: number; gamesPlayed: number;
}

export const MOCK_TEAMS_FULL: MockTeam[] = [
  { id: 'BOS', name: 'Boston Bruins',       abbreviation: 'BOS', emoji: '🐻', color: '#FFB81C', winPct: 68, goalsForPerGame: 3.4, goalsAgainstPerGame: 2.7, ppPct: 24.1, pkPct: 83.5, last10: '7-2-1', homeWinPct: 0.65, roadWinPct: 0.58, streakSigned:  4, goalsFor: 265, goalsAgainst: 211, gamesPlayed: 78 },
  { id: 'NYR', name: 'New York Rangers',    abbreviation: 'NYR', emoji: '🗽', color: '#0038A8', winPct: 61, goalsForPerGame: 3.1, goalsAgainstPerGame: 2.8, ppPct: 22.3, pkPct: 81.2, last10: '6-3-1', homeWinPct: 0.60, roadWinPct: 0.55, streakSigned: -1, goalsFor: 242, goalsAgainst: 218, gamesPlayed: 78 },
  { id: 'TOR', name: 'Toronto Maple Leafs', abbreviation: 'TOR', emoji: '🍁', color: '#003E7E', winPct: 59, goalsForPerGame: 3.2, goalsAgainstPerGame: 2.9, ppPct: 21.8, pkPct: 79.6, last10: '5-4-1', homeWinPct: 0.58, roadWinPct: 0.55, streakSigned:  2, goalsFor: 249, goalsAgainst: 226, gamesPlayed: 78 },
  { id: 'MTL', name: 'Montreal Canadiens',  abbreviation: 'MTL', emoji: '🔴', color: '#AF1E2D', winPct: 49, goalsForPerGame: 2.8, goalsAgainstPerGame: 3.1, ppPct: 18.4, pkPct: 78.3, last10: '4-5-1', homeWinPct: 0.51, roadWinPct: 0.47, streakSigned:  1, goalsFor: 218, goalsAgainst: 242, gamesPlayed: 78 },
  { id: 'CHI', name: 'Chicago Blackhawks',  abbreviation: 'CHI', emoji: '🦅', color: '#CF0A2C', winPct: 39, goalsForPerGame: 2.6, goalsAgainstPerGame: 3.5, ppPct: 16.2, pkPct: 76.1, last10: '2-7-1', homeWinPct: 0.40, roadWinPct: 0.34, streakSigned: -3, goalsFor: 202, goalsAgainst: 272, gamesPlayed: 78 },
  { id: 'DET', name: 'Detroit Red Wings',   abbreviation: 'DET', emoji: '🐙', color: '#CE1126', winPct: 46, goalsForPerGame: 2.9, goalsAgainstPerGame: 3.0, ppPct: 17.9, pkPct: 80.1, last10: '5-4-1', homeWinPct: 0.49, roadWinPct: 0.45, streakSigned:  2, goalsFor: 226, goalsAgainst: 234, gamesPlayed: 78 },
  { id: 'VGK', name: 'Vegas Golden Knights',abbreviation: 'VGK', emoji: '🃏', color: '#B4975A', winPct: 64, goalsForPerGame: 3.3, goalsAgainstPerGame: 2.6, ppPct: 23.7, pkPct: 84.1, last10: '7-2-1', homeWinPct: 0.63, roadWinPct: 0.55, streakSigned:  3, goalsFor: 257, goalsAgainst: 203, gamesPlayed: 78 },
  { id: 'EDM', name: 'Edmonton Oilers',     abbreviation: 'EDM', emoji: '🛢️', color: '#FF4C00', winPct: 57, goalsForPerGame: 3.6, goalsAgainstPerGame: 3.2, ppPct: 28.4, pkPct: 78.9, last10: '4-5-1', homeWinPct: 0.58, roadWinPct: 0.53, streakSigned: -2, goalsFor: 281, goalsAgainst: 250, gamesPlayed: 78 },
  { id: 'COL', name: 'Colorado Avalanche',  abbreviation: 'COL', emoji: '🏔️', color: '#6F263D', winPct: 66, goalsForPerGame: 3.7, goalsAgainstPerGame: 2.8, ppPct: 25.2, pkPct: 82.7, last10: '8-1-1', homeWinPct: 0.63, roadWinPct: 0.58, streakSigned:  5, goalsFor: 289, goalsAgainst: 218, gamesPlayed: 78 },
  { id: 'FLA', name: 'Florida Panthers',    abbreviation: 'FLA', emoji: '🐆', color: '#041E42', winPct: 62, goalsForPerGame: 3.3, goalsAgainstPerGame: 2.7, ppPct: 22.8, pkPct: 83.0, last10: '6-3-1', homeWinPct: 0.61, roadWinPct: 0.56, streakSigned:  2, goalsFor: 257, goalsAgainst: 210, gamesPlayed: 78 },
];

// ─── Games (shape = formatGame() output) ──────────────────────────────────────

function team(abbr: string, score: number | null = null) {
  const t = MOCK_TEAMS_FULL.find((x) => x.abbreviation === abbr)!;
  return { id: t.abbreviation, abbreviation: t.abbreviation, name: t.name, emoji: t.emoji, score, odds: null };
}

const TODAY = new Date().toISOString().slice(0, 10);

export const MOCK_GAMES_FULL: any[] = [
  { id: 'g1', gameDate: TODAY, startTime: '7:00 PM ET',  status: 'live',      period: 3,    clock: '14:22', venue: 'TD Garden',        gameType: 'regular', overUnder: 6.0, homeWinPct: 62, awayWinPct: 38, homeTeam: team('BOS', 3), awayTeam: team('NYR', 2) },
  { id: 'g2', gameDate: TODAY, startTime: '7:30 PM ET',  status: 'live',      period: 2,    clock: '08:47', venue: 'Scotiabank Arena', gameType: 'regular', overUnder: 5.5, homeWinPct: 54, awayWinPct: 46, homeTeam: team('TOR', 1), awayTeam: team('MTL', 1) },
  { id: 'g3', gameDate: TODAY, startTime: '9:00 PM ET',  status: 'scheduled', period: null, clock: null,    venue: 'United Center',    gameType: 'regular', overUnder: 5.5, homeWinPct: 33, awayWinPct: 67, homeTeam: team('CHI'),    awayTeam: team('DET') },
  { id: 'g4', gameDate: TODAY, startTime: '9:30 PM ET',  status: 'scheduled', period: null, clock: null,    venue: 'T-Mobile Arena',   gameType: 'regular', overUnder: 6.5, homeWinPct: 58, awayWinPct: 42, homeTeam: team('VGK'),    awayTeam: team('EDM') },
  { id: 'g5', gameDate: TODAY, startTime: '10:00 PM ET', status: 'scheduled', period: null, clock: null,    venue: 'Ball Arena',       gameType: 'regular', overUnder: 6.0, homeWinPct: 60, awayWinPct: 40, homeTeam: team('COL'),    awayTeam: team('FLA') },
  { id: 'g6', gameDate: TODAY, startTime: '10:30 PM ET', status: 'scheduled', period: null, clock: null,    venue: 'Rogers Place',     gameType: 'regular', overUnder: 6.5, homeWinPct: 44, awayWinPct: 56, homeTeam: team('EDM'),    awayTeam: team('VGK') },
];

// ─── Players (shape = fetchTopPlayers() / fetchPlayerById() output) ────────────

interface MockPlayer {
  id: string; name: string; teamId: string; teamAbbr: string; position: string; number: number;
  goals: number; assists: number; points: number; plusMinus: number; shots: number;
  shotPct: number; ppPoints: number; gamesPlayed: number; lastFive: number[]; winImpact: number;
}

function mkPlayer(
  id: number, name: string, abbr: string, pos: string, num: number,
  gp: number, g: number, a: number, shots: number, ppPoints: number,
): MockPlayer {
  const points = g + a;
  return {
    id: String(id), name, teamId: abbr.toLowerCase(), teamAbbr: abbr, position: pos, number: num,
    goals: g, assists: a, points, plusMinus: 0, shots,
    shotPct: shots > 0 ? Math.round((g / shots) * 1000) / 10 : 0,
    ppPoints, gamesPlayed: gp, lastFive: [], winImpact: Math.min(99, Math.round((points / gp) * 100)),
  };
}

export const MOCK_TOP_PLAYERS: MockPlayer[] = [
  mkPlayer(8477493, 'Connor McDavid',   'EDM', 'C',  97, 75, 41, 76, 290, 52),
  mkPlayer(8478402, 'Nathan MacKinnon', 'COL', 'C',  29, 72, 42, 64, 312, 38),
  mkPlayer(8478483, 'David Pastrnak',   'BOS', 'RW', 88, 74, 47, 51, 334, 31),
  mkPlayer(8477934, 'Leon Draisaitl',   'EDM', 'C',  29, 73, 38, 58, 280, 41),
  mkPlayer(8479318, 'Matthew Tkachuk',  'FLA', 'LW', 19, 74, 35, 55, 261, 28),
  mkPlayer(8479987, 'Mikko Rantanen',   'COL', 'RW', 96, 73, 37, 50, 295, 27),
  mkPlayer(8479420, 'Mitch Marner',     'TOR', 'RW', 16, 72, 28, 56, 210, 33),
  mkPlayer(8480801, 'Jack Hughes',      'NYR', 'C',  86, 71, 33, 49, 245, 25),
];

export const MOCK_PLAYER_BY_ID: Record<string, MockPlayer> = Object.fromEntries(
  MOCK_TOP_PLAYERS.map((p) => [p.id, p]),
);
