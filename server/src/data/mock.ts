// ─────────────────────────────────────────────────────────────
// MOCK GAMES
// ─────────────────────────────────────────────────────────────

export const MOCK_GAMES = [
  {
    id: "g1",
    gameDate: "2026-04-27",
    startTime: "7:00 PM ET",
    status: "live",
    period: 3,
    clock: "14:22",

    homeTeam: {
      id: 6,
      abbreviation: "BOS",
      name: "Boston Bruins",
      score: 3,
    },

    awayTeam: {
      id: 3,
      abbreviation: "NYR",
      name: "New York Rangers",
      score: 2,
    },

    venue: "TD Garden",
    gameType: "regular",
  },
  {
    id: "g2",
    gameDate: "2026-04-27",
    startTime: "7:30 PM ET",
    status: "live",
    period: 2,
    clock: "08:47",

    homeTeam: {
      id: 10,
      abbreviation: "TOR",
      name: "Toronto Maple Leafs",
      score: 1,
    },

    awayTeam: {
      id: 8,
      abbreviation: "MTL",
      name: "Montreal Canadiens",
      score: 1,
    },

    venue: "Scotiabank Arena",
    gameType: "regular",
  },
  {
    id: "g3",
    gameDate: "2026-04-27",
    startTime: "9:00 PM ET",
    status: "scheduled",

    homeTeam: {
      id: 16,
      abbreviation: "CHI",
      name: "Chicago Blackhawks",
    },

    awayTeam: {
      id: 17,
      abbreviation: "DET",
      name: "Detroit Red Wings",
    },

    venue: "United Center",
    gameType: "regular",
  },
] as const;

// ─────────────────────────────────────────────────────────────
// MOCK TEAMS
// ─────────────────────────────────────────────────────────────

export const MOCK_TEAMS = [
  {
    id: 6,
    name: "Boston Bruins",
    abbreviation: "BOS",
    city: "Boston",
    conference: "Eastern",
    division: "Atlantic",
  },
  {
    id: 3,
    name: "New York Rangers",
    abbreviation: "NYR",
    city: "New York",
    conference: "Eastern",
    division: "Metropolitan",
  },
  {
    id: 10,
    name: "Toronto Maple Leafs",
    abbreviation: "TOR",
    city: "Toronto",
    conference: "Eastern",
    division: "Atlantic",
  },
  {
    id: 8,
    name: "Montreal Canadiens",
    abbreviation: "MTL",
    city: "Montreal",
    conference: "Eastern",
    division: "Atlantic",
  },
] as const;

// ─────────────────────────────────────────────────────────────
// MOCK PLAYERS
// ─────────────────────────────────────────────────────────────

export const MOCK_PLAYERS = [
  {
    id: 8477493,
    firstName: "Connor",
    lastName: "McDavid",
    fullName: "Connor McDavid",
    teamId: 22,
    teamAbbr: "EDM",
    position: "C",
    jerseyNumber: 97,
  },
  {
    id: 8478402,
    firstName: "Nathan",
    lastName: "MacKinnon",
    fullName: "Nathan MacKinnon",
    teamId: 21,
    teamAbbr: "COL",
    position: "C",
    jerseyNumber: 29,
  },
  {
    id: 8478483,
    firstName: "David",
    lastName: "Pastrnak",
    fullName: "David Pastrnak",
    teamId: 6,
    teamAbbr: "BOS",
    position: "RW",
    jerseyNumber: 88,
  },
] as const;

// ─────────────────────────────────────────────────────────────
// MOCK TEAM STATS
// keyed by "teamId" as string (important for service lookup)
// ─────────────────────────────────────────────────────────────

export const MOCK_TEAM_STATS: Record<string, any> = {
  "6": {
    teamId: 6,
    gamesPlayed: 78,
    wins: 48,
    losses: 22,
    otLosses: 8,
    points: 104,

    goalsFor: 265,
    goalsAgainst: 211,
    goalsForPerGame: 3.4,
    goalsAgainstPerGame: 2.7,

    powerPlayPct: 24.1,
    penaltyKillPct: 83.5,

    shotsForPerGame: 34.2,
    shotsAgainstPerGame: 28.1,

    faceoffWinPct: 52.3,

    homeRecord: "26-10-4",
    awayRecord: "22-12-4",

    last10: "7-2-1",
    streak: "W4",
  },

  "3": {
    teamId: 3,
    gamesPlayed: 78,
    wins: 45,
    losses: 24,
    otLosses: 9,
    points: 99,

    goalsFor: 242,
    goalsAgainst: 218,
    goalsForPerGame: 3.1,
    goalsAgainstPerGame: 2.8,

    powerPlayPct: 22.3,
    penaltyKillPct: 81.2,

    shotsForPerGame: 32.1,
    shotsAgainstPerGame: 29.4,

    faceoffWinPct: 50.1,

    homeRecord: "24-11-5",
    awayRecord: "21-13-4",

    last10: "6-3-1",
    streak: "L1",
  },
};

// ─────────────────────────────────────────────────────────────
// OPTIONAL: MOCK ODDS (needed for MVP EV engine)
// ─────────────────────────────────────────────────────────────

export const MOCK_ODDS = [
  {
    gameId: "g1",
    bookmaker: "bet365",
    market: "moneyline",
    selection: "BOS",
    odds: 1.85,
  },
  {
    gameId: "g1",
    bookmaker: "bet365",
    market: "moneyline",
    selection: "NYR",
    odds: 2.05,
  },
];