import 'dotenv/config';
import { hash as bcryptHash } from '@node-rs/bcrypt';
import { pool } from './connection';
import { logger } from '../logger';

// ============================================================
//  SEED — all mock data from the app goes into the DB here
// ============================================================

export async function seedAll(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await seedUsers(client);
    await seedNHLTeams(client);
    await seedNHLTeamStats(client);
    await seedNHLGames(client);
    await seedNHLOdds(client);
    await seedNHLPlayers(client);
    await seedNHLPlayerStats(client);
    await seedUserProfiles(client);
    await seedUserBets(client);
    // Chat is NOT seeded: rooms, messages and members are real user data only.

    await client.query('COMMIT');
    logger.info('[Seed] ✓ All data seeded successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ============================================================
//  USERS (auth accounts)
// ============================================================

async function seedUsers(client: any): Promise<void> {
  const users = [
    { email: 'admin@iceedge.dev',        username: 'admin',          password: 'Admin1234!',   firstName: 'Alice',   lastName: 'Admin',    role: 'admin' },
    { email: 'jdupont@iceedge.dev',      username: 'jdupont',        password: 'Password1!',   firstName: 'Jean',    lastName: 'Dupont',   role: 'user' },
    { email: 'hockey_oracle@iceedge.dev',username: 'hockey_oracle',  password: 'Password1!',   firstName: 'Max',     lastName: 'Oracle',   role: 'user' },
    { email: 'icepick_pro@iceedge.dev',  username: 'icepick_pro',    password: 'Password1!',   firstName: 'IcePick', lastName: 'Pro',      role: 'user' },
    { email: 'slapshot@iceedge.dev',     username: 'slapshot_stats', password: 'Password1!',   firstName: 'Slapshot',lastName: 'Stats',    role: 'user' },
    { email: 'puckwizard@iceedge.dev',   username: 'puckwizard',     password: 'Password1!',   firstName: 'Puck',    lastName: 'Wizard',   role: 'user' },
    { email: 'faceoff@iceedge.dev',      username: 'faceoff_king',   password: 'Password1!',   firstName: 'Faceoff', lastName: 'King',     role: 'user' },
    { email: 'overtime@iceedge.dev',     username: 'overtime_ox',    password: 'Password1!',   firstName: 'OT',      lastName: 'Ox',       role: 'user' },
    { email: 'coldreads@iceedge.dev',    username: 'cold_reads',     password: 'Password1!',   firstName: 'Cold',    lastName: 'Reads',    role: 'user' },
    { email: 'netminder@iceedge.dev',    username: 'netminder99',    password: 'Password1!',   firstName: 'Net',     lastName: 'Minder',   role: 'user' },
    { email: 'blueline@iceedge.dev',     username: 'blueline_bets',  password: 'Password1!',   firstName: 'Blue',    lastName: 'Line',     role: 'user' },
  ];

  for (const u of users) {
    const exists = await client.query('SELECT id FROM users WHERE username = $1', [u.username]);
    if (exists.rows.length > 0) continue;
    const hash = await bcryptHash(u.password, 11);
    await client.query(
      `INSERT INTO users (email, username, password_hash, first_name, last_name, role)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [u.email, u.username, hash, u.firstName, u.lastName, u.role]
    );
  }}

// ============================================================
//  NHL TEAMS
// ============================================================

async function seedNHLTeams(client: any): Promise<void> {
  const teams = [
    { id: 6,  name: 'Boston Bruins',          abbr: 'BOS', city: 'Boston',       conf: 'Eastern', div: 'Atlantic',      color: '#FFB81C', emoji: '🐻' },
    { id: 3,  name: 'New York Rangers',        abbr: 'NYR', city: 'New York',     conf: 'Eastern', div: 'Metropolitan',  color: '#0038A8', emoji: '🗽' },
    { id: 10, name: 'Toronto Maple Leafs',     abbr: 'TOR', city: 'Toronto',      conf: 'Eastern', div: 'Atlantic',      color: '#003E7E', emoji: '🍁' },
    { id: 8,  name: 'Montreal Canadiens',      abbr: 'MTL', city: 'Montreal',     conf: 'Eastern', div: 'Atlantic',      color: '#AF1E2D', emoji: '🔵' },
    { id: 16, name: 'Chicago Blackhawks',      abbr: 'CHI', city: 'Chicago',      conf: 'Western', div: 'Central',       color: '#CF0A2C', emoji: '🦅' },
    { id: 17, name: 'Detroit Red Wings',       abbr: 'DET', city: 'Detroit',      conf: 'Eastern', div: 'Atlantic',      color: '#CE1126', emoji: '🏒' },
    { id: 54, name: 'Vegas Golden Knights',    abbr: 'VGK', city: 'Las Vegas',    conf: 'Western', div: 'Pacific',       color: '#B4975A', emoji: '⚔️' },
    { id: 22, name: 'Edmonton Oilers',         abbr: 'EDM', city: 'Edmonton',     conf: 'Western', div: 'Pacific',       color: '#FF4C00', emoji: '🛢️' },
    { id: 21, name: 'Colorado Avalanche',      abbr: 'COL', city: 'Denver',       conf: 'Western', div: 'Central',       color: '#6F263D', emoji: '🏔️' },
    { id: 13, name: 'Florida Panthers',        abbr: 'FLA', city: 'Sunrise',      conf: 'Eastern', div: 'Atlantic',      color: '#C8102E', emoji: '🐆' },
  ];

  for (const t of teams) {
    await client.query(
      `INSERT INTO nhl_teams (id, name, abbreviation, city, conference, division, color, emoji)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO NOTHING`,
      [t.id, t.name, t.abbr, t.city, t.conf, t.div, t.color, t.emoji]
    );
  }
  // Reset sequence
  await client.query(`SELECT setval('nhl_teams_id_seq', (SELECT MAX(id) FROM nhl_teams))`);}

// ============================================================
//  NHL TEAM STATS
// ============================================================

async function seedNHLTeamStats(client: any): Promise<void> {
  const stats = [
    { teamId: 6,  gp: 78, w: 48, l: 22, otl: 8,  pts: 104, gf: 265, ga: 211, gfpg: 3.4, gapg: 2.7, pp: 24.1, pk: 83.5, sfpg: 34.2, sapg: 28.1, fo: 52.3, home: '26-10-4', away: '22-12-4', l10: '7-2-1', streak: 'W4', winPct: 68 },
    { teamId: 3,  gp: 78, w: 45, l: 24, otl: 9,  pts: 99,  gf: 242, ga: 218, gfpg: 3.1, gapg: 2.8, pp: 22.3, pk: 81.2, sfpg: 32.1, sapg: 29.4, fo: 50.1, home: '24-11-5', away: '21-13-4', l10: '6-3-1', streak: 'L1', winPct: 61 },
    { teamId: 10, gp: 78, w: 44, l: 25, otl: 9,  pts: 97,  gf: 249, ga: 226, gfpg: 3.2, gapg: 2.9, pp: 21.8, pk: 79.6, sfpg: 31.4, sapg: 29.8, fo: 49.5, home: '23-12-5', away: '21-13-4', l10: '5-4-1', streak: 'W2', winPct: 59 },
    { teamId: 8,  gp: 78, w: 38, l: 31, otl: 9,  pts: 85,  gf: 218, ga: 242, gfpg: 2.8, gapg: 3.1, pp: 18.4, pk: 78.3, sfpg: 28.6, sapg: 32.1, fo: 48.2, home: '20-15-5', away: '18-16-4', l10: '4-5-1', streak: 'W1', winPct: 49 },
    { teamId: 16, gp: 78, w: 28, l: 41, otl: 9,  pts: 65,  gf: 202, ga: 272, gfpg: 2.6, gapg: 3.5, pp: 16.2, pk: 76.1, sfpg: 26.8, sapg: 33.4, fo: 47.1, home: '15-20-5', away: '13-21-4', l10: '2-7-1', streak: 'L3', winPct: 39 },
    { teamId: 17, gp: 78, w: 35, l: 33, otl: 10, pts: 80,  gf: 226, ga: 234, gfpg: 2.9, gapg: 3.0, pp: 17.9, pk: 80.1, sfpg: 29.2, sapg: 30.8, fo: 49.8, home: '19-16-5', away: '16-17-5', l10: '5-4-1', streak: 'W2', winPct: 46 },
    { teamId: 54, gp: 78, w: 46, l: 22, otl: 10, pts: 102, gf: 257, ga: 203, gfpg: 3.3, gapg: 2.6, pp: 23.7, pk: 84.1, sfpg: 33.8, sapg: 27.4, fo: 51.6, home: '25-10-5', away: '21-12-5', l10: '7-2-1', streak: 'W3', winPct: 64 },
    { teamId: 22, gp: 78, w: 43, l: 26, otl: 9,  pts: 95,  gf: 281, ga: 250, gfpg: 3.6, gapg: 3.2, pp: 28.4, pk: 78.9, sfpg: 35.6, sapg: 31.2, fo: 52.1, home: '23-13-4', away: '20-13-5', l10: '4-5-1', streak: 'L2', winPct: 57 },
    { teamId: 21, gp: 78, w: 47, l: 21, otl: 10, pts: 104, gf: 289, ga: 218, gfpg: 3.7, gapg: 2.8, pp: 25.2, pk: 82.7, sfpg: 36.1, sapg: 28.6, fo: 53.4, home: '25-10-5', away: '22-11-5', l10: '8-1-1', streak: 'W5', winPct: 66 },
    { teamId: 13, gp: 78, w: 44, l: 24, otl: 10, pts: 98,  gf: 257, ga: 210, gfpg: 3.3, gapg: 2.7, pp: 22.8, pk: 83.0, sfpg: 33.4, sapg: 28.2, fo: 50.8, home: '23-12-5', away: '21-12-5', l10: '6-3-1', streak: 'W2', winPct: 62 },
  ];

  for (const s of stats) {
    await client.query(
      `INSERT INTO nhl_team_stats
        (team_id, games_played, wins, losses, ot_losses, points,
         goals_for, goals_against, goals_for_per_game, goals_against_per_game,
         power_play_pct, penalty_kill_pct, shots_for_per_game, shots_against_per_game,
         faceoff_win_pct, home_record, away_record, last10, streak, win_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (team_id, season) DO UPDATE SET
         games_played = EXCLUDED.games_played, wins = EXCLUDED.wins`,
      [s.teamId, s.gp, s.w, s.l, s.otl, s.pts, s.gf, s.ga, s.gfpg, s.gapg,
       s.pp, s.pk, s.sfpg, s.sapg, s.fo, s.home, s.away, s.l10, s.streak, s.winPct]
    );
  }}

// ============================================================
//  NHL GAMES
// ============================================================

async function seedNHLGames(client: any): Promise<void> {
  const games = [
    { id: 'g1', date: '2026-04-27', time: '7:00 PM ET',  status: 'live',      period: 3, clock: '14:22', homeId: 6,  awayId: 3,  homeScore: 3, awayScore: 2, venue: 'TD Garden',        homeOdds: -145, awayOdds: 125,  ou: 6.0, homeWinPct: 62, awayWinPct: 38 },
    { id: 'g2', date: '2026-04-27', time: '7:30 PM ET',  status: 'live',      period: 2, clock: '08:47', homeId: 10, awayId: 8,  homeScore: 1, awayScore: 1, venue: 'Scotiabank Arena', homeOdds: -110, awayOdds: -110, ou: 5.5, homeWinPct: 54, awayWinPct: 46 },
    { id: 'g3', date: '2026-04-27', time: '9:00 PM ET',  status: 'scheduled', period: null, clock: null, homeId: 16, awayId: 17, homeScore: 0, awayScore: 0, venue: 'United Center',    homeOdds: 180,  awayOdds: -210, ou: 5.5, homeWinPct: 33, awayWinPct: 67 },
    { id: 'g4', date: '2026-04-27', time: '9:30 PM ET',  status: 'scheduled', period: null, clock: null, homeId: 54, awayId: 22, homeScore: 0, awayScore: 0, venue: 'T-Mobile Arena',   homeOdds: -125, awayOdds: 105,  ou: 6.5, homeWinPct: 58, awayWinPct: 42 },
    { id: 'g5', date: '2026-04-28', time: '7:00 PM ET',  status: 'scheduled', period: null, clock: null, homeId: 21, awayId: 13, homeScore: 0, awayScore: 0, venue: 'Ball Arena',       homeOdds: -130, awayOdds: 110,  ou: 6.0, homeWinPct: 60, awayWinPct: 40 },
    { id: 'g6', date: '2026-04-28', time: '10:00 PM ET', status: 'scheduled', period: null, clock: null, homeId: 22, awayId: 54, homeScore: 0, awayScore: 0, venue: 'Rogers Place',     homeOdds: 105,  awayOdds: -125, ou: 6.5, homeWinPct: 44, awayWinPct: 56 },
  ];

  for (const g of games) {
    await client.query(
      `INSERT INTO nhl_games
        (id, game_date, start_time, status, period, clock,
         home_team_id, away_team_id, home_score, away_score,
         venue, home_odds, away_odds, over_under, home_win_pct, away_win_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (id) DO NOTHING`,
      [g.id, g.date, g.time, g.status, g.period, g.clock,
       g.homeId, g.awayId, g.homeScore, g.awayScore,
       g.venue, g.homeOdds, g.awayOdds, g.ou, g.homeWinPct, g.awayWinPct]
    );
  }}

// ============================================================
//  NHL ODDS
// ============================================================

async function seedNHLOdds(client: any): Promise<void> {
  const odds = [
    { gameId: 'g1', bookmaker: 'bet365',    market: 'moneyline', selection: 'BOS', odds: 1.85 },
    { gameId: 'g1', bookmaker: 'bet365',    market: 'moneyline', selection: 'NYR', odds: 2.05 },
    { gameId: 'g1', bookmaker: 'draftkings',market: 'total',     selection: 'over 6.0', odds: 1.91 },
    { gameId: 'g2', bookmaker: 'bet365',    market: 'moneyline', selection: 'TOR', odds: 1.92 },
    { gameId: 'g2', bookmaker: 'bet365',    market: 'moneyline', selection: 'MTL', odds: 1.94 },
    { gameId: 'g3', bookmaker: 'draftkings',market: 'moneyline', selection: 'DET', odds: 1.53 },
    { gameId: 'g3', bookmaker: 'draftkings',market: 'moneyline', selection: 'CHI', odds: 2.70 },
    { gameId: 'g4', bookmaker: 'bet365',    market: 'moneyline', selection: 'VGK', odds: 1.80 },
    { gameId: 'g4', bookmaker: 'bet365',    market: 'moneyline', selection: 'EDM', odds: 2.10 },
    { gameId: 'g5', bookmaker: 'bet365',    market: 'moneyline', selection: 'COL', odds: 1.77 },
    { gameId: 'g5', bookmaker: 'bet365',    market: 'moneyline', selection: 'FLA', odds: 2.15 },
  ];

  for (const o of odds) {
    await client.query(
      `INSERT INTO nhl_odds (game_id, bookmaker, market, selection, odds)
       VALUES ($1,$2,$3,$4,$5)`,
      [o.gameId, o.bookmaker, o.market, o.selection, o.odds]
    );
  }}

// ============================================================
//  NHL PLAYERS
// ============================================================

async function seedNHLPlayers(client: any): Promise<void> {
  const players = [
    { id: 8478402, first: 'Nathan',   last: 'MacKinnon', full: 'Nathan MacKinnon', teamId: 21, pos: 'C',  num: 29 },
    { id: 8478483, first: 'David',    last: 'Pastrnak',  full: 'David Pastrnak',   teamId: 6,  pos: 'RW', num: 88 },
    { id: 8477934, first: 'Leon',     last: 'Draisaitl', full: 'Leon Draisaitl',   teamId: 22, pos: 'C',  num: 29 },
    { id: 8479318, first: 'Matthew',  last: 'Tkachuk',   full: 'Matthew Tkachuk',  teamId: 13, pos: 'LW', num: 19 },
    { id: 8479420, first: 'Mitch',    last: 'Marner',    full: 'Mitch Marner',     teamId: 10, pos: 'RW', num: 16 },
    { id: 8477493, first: 'Connor',   last: 'McDavid',   full: 'Connor McDavid',   teamId: 22, pos: 'C',  num: 97 },
    { id: 8479987, first: 'Mikko',    last: 'Rantanen',  full: 'Mikko Rantanen',   teamId: 21, pos: 'RW', num: 96 },
    { id: 8480801, first: 'Jack',     last: 'Hughes',    full: 'Jack Hughes',      teamId: 3,  pos: 'C',  num: 86 },
  ];

  for (const p of players) {
    await client.query(
      `INSERT INTO nhl_players (id, first_name, last_name, full_name, team_id, position, jersey_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO NOTHING`,
      [p.id, p.first, p.last, p.full, p.teamId, p.pos, p.num]
    );
  }}

// ============================================================
//  NHL PLAYER STATS
// ============================================================

async function seedNHLPlayerStats(client: any): Promise<void> {
  const stats = [
    { pid: 8478402, gp: 72, g: 42, a: 64, pts: 106, pm: 38,  sh: 312, spct: 13.5, ppg: 14, ppp: 38, shg: 1, pim: 26, bs: 22, hits: 48,  toi: 22.4, fopct: 55.2, lastFive: [1,3,2,1,4], wi: 81 },
    { pid: 8478483, gp: 74, g: 47, a: 51, pts: 98,  pm: 29,  sh: 334, spct: 14.1, ppg: 18, ppp: 31, shg: 0, pim: 36, bs: 14, hits: 72,  toi: 19.8, fopct: null,  lastFive: [2,1,3,0,2], wi: 78 },
    { pid: 8477934, gp: 73, g: 38, a: 58, pts: 96,  pm: 22,  sh: 280, spct: 13.6, ppg: 16, ppp: 41, shg: 0, pim: 44, bs: 12, hits: 85,  toi: 20.6, fopct: 51.8,  lastFive: [1,2,1,3,1], wi: 76 },
    { pid: 8479318, gp: 74, g: 35, a: 55, pts: 90,  pm: 26,  sh: 261, spct: 13.4, ppg: 12, ppp: 28, shg: 0, pim: 58, bs: 18, hits: 142, toi: 18.9, fopct: null,  lastFive: [0,2,2,1,3], wi: 74 },
    { pid: 8479420, gp: 72, g: 28, a: 56, pts: 84,  pm: 19,  sh: 210, spct: 13.3, ppg: 10, ppp: 33, shg: 0, pim: 22, bs: 16, hits: 34,  toi: 20.2, fopct: 48.6,  lastFive: [1,2,0,3,1], wi: 70 },
    { pid: 8477493, gp: 75, g: 41, a: 76, pts: 117, pm: 18,  sh: 290, spct: 14.1, ppg: 17, ppp: 52, shg: 0, pim: 30, bs: 8,  hits: 25,  toi: 22.1, fopct: 53.4,  lastFive: [3,2,1,4,2], wi: 89 },
    { pid: 8479987, gp: 73, g: 37, a: 50, pts: 87,  pm: 31,  sh: 295, spct: 12.5, ppg: 11, ppp: 27, shg: 0, pim: 28, bs: 20, hits: 56,  toi: 19.4, fopct: null,  lastFive: [2,1,1,2,2], wi: 72 },
    { pid: 8480801, gp: 71, g: 33, a: 49, pts: 82,  pm: 15,  sh: 245, spct: 13.5, ppg: 9,  ppp: 25, shg: 0, pim: 18, bs: 10, hits: 28,  toi: 19.1, fopct: 54.2,  lastFive: [2,0,2,1,2], wi: 68 },
  ];

  for (const s of stats) {
    const lastFiveArr = `{${s.lastFive.join(',')}}`;
    await client.query(
      `INSERT INTO nhl_player_stats
        (player_id, games_played, goals, assists, points, plus_minus, shots, shooting_pct,
         pp_goals, pp_points, sh_goals, penalty_minutes, blocked_shots, hits,
         time_on_ice, faceoff_win_pct, last_five, win_impact)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (player_id, season) DO UPDATE SET goals = EXCLUDED.goals`,
      [s.pid, s.gp, s.g, s.a, s.pts, s.pm, s.sh, s.spct,
       s.ppg, s.ppp, s.shg, s.pim, s.bs, s.hits,
       s.toi, s.fopct, lastFiveArr, s.wi]
    );
  }}

// ============================================================
//  USER PROFILES
// ============================================================

async function seedUserProfiles(client: any): Promise<void> {
  const profiles = [
    { username: 'jdupont',        display: 'Jean Dupont',   avatar: '🏒', team: 'MTL', bio: 'MTL die-hard. Sharp on period betting and player props.', tier: 'sharp',    score: 742 },
    { username: 'hockey_oracle',  display: 'The Oracle',    avatar: '🔮', team: 'BOS', bio: 'Data-driven predictions since 2022.', tier: 'legend',   score: 961 },
    { username: 'icepick_pro',    display: 'IcePick Pro',   avatar: '🏆', team: 'VGK', bio: 'Playoff specialist.', tier: 'legend',   score: 908 },
    { username: 'slapshot_stats', display: 'Slapshot',      avatar: '🎯', team: 'COL', bio: 'Stats nerd. Love the metrics.', tier: 'sharp',    score: 871 },
    { username: 'puckwizard',     display: 'Puck Wizard',   avatar: '🧙', team: 'EDM', bio: 'McDavid believer.', tier: 'sharp',    score: 718 },
    { username: 'faceoff_king',   display: 'Faceoff King',  avatar: '👑', team: 'TOR', bio: 'Faceoff % is an edge.', tier: 'analyst',  score: 681 },
    { username: 'overtime_ox',    display: 'OT Ox',         avatar: '🐂', team: 'NYR', bio: 'OT specialist.', tier: 'analyst',  score: 644 },
    { username: 'cold_reads',     display: 'Cold Reads',    avatar: '❄️', team: 'FLA', bio: 'Ice-cold analysis.', tier: 'analyst',  score: 612 },
    { username: 'netminder99',    display: 'Netminder',     avatar: '🥅', team: 'BOS', bio: 'Goalie prop specialist.', tier: 'rookie',   score: 589 },
    { username: 'blueline_bets',  display: 'Blueline',      avatar: '🔵', team: 'DET', bio: 'Defense wins championships.', tier: 'rookie',   score: 554 },
  ];

  for (const p of profiles) {
    const user = await client.query('SELECT id FROM users WHERE username = $1', [p.username]);
    if (!user.rows[0]) continue;
    const userId = user.rows[0].id;

    await client.query(
      `INSERT INTO user_profiles (user_id, display_name, avatar, favorite_team, bio, tier, performance_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, p.display, p.avatar, p.team, p.bio, p.tier, p.score]
    );
  }

  // Badges for jdupont
  const jdupont = await client.query('SELECT id FROM users WHERE username = $1', ['jdupont']);
  if (jdupont.rows[0]) {
    const uid = jdupont.rows[0].id;
    const badges = [
      { badgeId: 'sharp_shooter',   label: 'Sharp Shooter',   desc: 'Maintained 70%+ hit rate over 20 bets',   icon: '🎯', earnedAt: '2025-11-15', tier: 'gold' },
      { badgeId: 'ice_analyst',     label: 'Ice Analyst',     desc: 'Placed 50+ predictions',                  icon: '📊', earnedAt: '2026-01-03', tier: 'silver' },
      { badgeId: 'underdog_hunter', label: 'Underdog Hunter', desc: 'Won 3+ picks under 40% probability',       icon: '🦁', earnedAt: '2026-02-20', tier: 'silver' },
      { badgeId: 'early_adopter',   label: 'Early Adopter',   desc: 'Joined ArakIce in its first month',        icon: '⭐', earnedAt: '2025-10-01', tier: 'platinum' },
    ];
    for (const b of badges) {
      await client.query(
        `INSERT INTO user_badges (user_id, badge_id, label, description, icon, earned_at, tier)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (user_id, badge_id) DO NOTHING`,
        [uid, b.badgeId, b.label, b.desc, b.icon, b.earnedAt, b.tier]
      );
    }
  }}

// ============================================================
//  USER BETS
// ============================================================

async function seedUserBets(client: any): Promise<void> {
  const user = await pool.query('SELECT id FROM users WHERE username = $1', ['jdupont']);
  if (!user.rows[0]) return;
  const userId = user.rows[0].id;

  const existing = await pool.query('SELECT COUNT(*) FROM user_bets WHERE user_id = $1', [userId]);
  if (parseInt(existing.rows[0].count) > 0) {    return;
  }

  const bets = [
    { placedAt: '2026-04-27T19:00:00Z', mType: 'moneyline',    mLabel: 'Moneyline',    sel: 'Boston Bruins to win',     selShort: 'BOS ML',      subName: 'Boston Bruins',      subLogo: '🐻', prob: 68, isParlay: false, parlayLegs: null, outcome: 'pending', gameInfo: 'BOS vs NYR · Apr 27' },
    { placedAt: '2026-04-26T20:00:00Z', mType: 'shots_ou',     mLabel: 'Shots O/U',    sel: 'Over 3.5 shots',           selShort: 'O 3.5 SOG',   subName: 'David Pastrnak',     subLogo: '🐻', prob: 72, isParlay: false, parlayLegs: null, outcome: 'win',     gameInfo: 'BOS vs TOR · Apr 26' },
    { placedAt: '2026-04-26T20:00:00Z', mType: 'moneyline',    mLabel: 'Moneyline',    sel: 'Toronto Maple Leafs to win',selShort: 'TOR ML',      subName: 'Toronto Maple Leafs',subLogo: '🍁', prob: 54, isParlay: true,  parlayLegs: 3,    outcome: 'win',     gameInfo: 'TOR vs MTL · Apr 26' },
    { placedAt: '2026-04-25T19:30:00Z', mType: 'total_goals',  mLabel: 'Total Goals',  sel: 'Over 5.5',                 selShort: 'O 5.5',       subName: 'VGK vs EDM',         subLogo: '⚔️', prob: 62, isParlay: false, parlayLegs: null, outcome: 'loss',    gameInfo: 'VGK vs EDM · Apr 25' },
    { placedAt: '2026-04-24T19:00:00Z', mType: 'anytime_goal', mLabel: 'Anytime Goal', sel: 'Connor McDavid to score',  selShort: 'McDavid ATG', subName: 'Connor McDavid',     subLogo: '🛢️', prob: 55, isParlay: false, parlayLegs: null, outcome: 'win',     gameInfo: 'EDM vs COL · Apr 24' },
    { placedAt: '2026-04-23T20:00:00Z', mType: 'puck_line',    mLabel: 'Puck Line',    sel: 'COL -1.5',                 selShort: 'COL -1.5',    subName: 'Colorado Avalanche', subLogo: '🏔️', prob: 44, isParlay: false, parlayLegs: null, outcome: 'win',     gameInfo: 'COL vs CHI · Apr 23' },
    { placedAt: '2026-04-22T19:00:00Z', mType: 'moneyline',    mLabel: 'Moneyline',    sel: 'Detroit Red Wings to win', selShort: 'DET ML',      subName: 'Detroit Red Wings',  subLogo: '🏒', prob: 46, isParlay: false, parlayLegs: null, outcome: 'loss',    gameInfo: 'DET vs BOS · Apr 22' },
  ];

  for (const b of bets) {
    await pool.query(
      `INSERT INTO user_bets
        (user_id, placed_at, market_type, market_label, selection, selection_short,
         subject_name, subject_logo, probability, is_parlay, parlay_legs, outcome, game_info)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [userId, b.placedAt, b.mType, b.mLabel, b.sel, b.selShort,
       b.subName, b.subLogo, b.prob, b.isParlay, b.parlayLegs, b.outcome, b.gameInfo]
    );
  }}

// ============================================================
//  Run directly: ts-node src/db/seed.ts
// ============================================================

if (require.main === module) {
  (async () => {
    try {
      await seedAll();
    } catch (err) {
      logger.error({ err }, '[Seed] Failed');
      process.exit(1);
    } finally {
      await pool.end();
    }
  })();
}
