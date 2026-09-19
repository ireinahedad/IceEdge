/**
 * bench/upstream.ts — amont synthétique (NHL, The Odds API, service ML).
 *
 * POURQUOI UN BOUCHON ET PAS LE VRAI RÉSEAU
 *
 * Les questions que ces bancs posent — « combien d'appels sortants partent
 * quand le nombre de visiteurs double ? », « combien quand le nombre de matchs
 * double ? » — ont une réponse EXACTE et reproductible seulement si l'amont est
 * déterministe. Le vrai réseau ajoute du bruit (latence variable, pannes, quota
 * consommé) sans rien apprendre de plus : la déduplication et les caches sont
 * de la mécanique interne, ils ne dépendent pas de qui répond en face.
 *
 * Et surtout : tirer contre la vraie API vide le quota The Odds API et
 * fabrique une facture. Le bouchon répond la même chose, gratuitement, en
 * comptant tout.
 *
 * CE QUE LE BOUCHON GARDE DU VRAI CODE : absolument tout sauf `fetch`. Les
 * clients (`fetchNHL`, `oddsClient`, `mlApiClient`), leurs caches, leur
 * déduplication, leurs timeouts et leurs disjoncteurs sont le code de
 * production, importé tel quel.
 *
 * LA LIGUE EST PARAMÉTRABLE — `setLeague({ teams, games, players })`. C'est
 * l'axe du banc « explosion avec le nombre de matchs/équipes/joueurs » : on
 * double le nombre de matchs et on regarde si le nombre d'appels sortants
 * double, triple, ou reste constant.
 */

// ── Groupes d'amont ─────────────────────────────────────────────────────────

export type Group = 'nhl-web' | 'nhl-stats' | 'nhl-search' | 'odds' | 'ml' | 'autre';

export interface Call {
  group: Group;
  url: string;
  /**
   * Ce qui identifie l'APPEL, pas seulement l'adresse : méthode + URL + corps.
   *
   * Sans le corps, les 30 inférences ML de `getBestBets` — toutes des POST sur
   * `/predict/game` avec des features différentes — passeraient pour 30 appels
   * en double sur une seule URL, et le banc crierait au troupeau là où il n'y a
   * que du travail légitime. L'inverse serait pire : deux requêtes vraiment
   * identiques doivent, elles, se voir.
   */
  key: string;
  startedAt: number;
}

/** Journal de TOUS les appels sortants émis depuis le dernier `reset()`. */
export const calls: Call[] = [];

export function reset(): void {
  calls.length = 0;
}

export function counts(): Record<Group, number> {
  const out: Record<Group, number> = {
    'nhl-web': 0, 'nhl-stats': 0, 'nhl-search': 0, odds: 0, ml: 0, autre: 0,
  };
  for (const c of calls) out[c.group] += 1;
  return out;
}

export function total(group?: Group): number {
  return group ? calls.filter((c) => c.group === group).length : calls.length;
}

/** Nombre d'appels DISTINCTS (méthode + URL + corps). L'écart avec `total`
 *  est le gaspillage : le même appel émis deux fois, c'est une déduplication
 *  qui n'a pas pris. */
export function distinct(group?: Group): number {
  const s = new Set<string>();
  for (const c of calls) if (!group || c.group === group) s.add(c.key);
  return s.size;
}

/** Les appels les plus répétés, pour désigner nommément le coupable. */
export function topRepeats(n = 5): Array<{ url: string; n: number }> {
  const m = new Map<string, { url: string; n: number }>();
  for (const c of calls) {
    const e = m.get(c.key) ?? { url: c.url, n: 0 };
    e.n += 1;
    m.set(c.key, e);
  }
  return [...m.values()].sort((a, b) => b.n - a.n).slice(0, n);
}

// ── Taille de la ligue simulée ──────────────────────────────────────────────

export interface LeagueSize {
  /** Équipes au classement (plafonné à 32, la vraie ligue). */
  teams: number;
  /** Matchs par journée de calendrier. */
  games: number;
  /** Joueurs rendus par les classements de pointeurs. */
  players: number;
}

let league: LeagueSize = { teams: 32, games: 12, players: 50 };

export function setLeague(next: Partial<LeagueSize>): void {
  league = { ...league, ...next };
}

export function getLeague(): LeagueSize {
  return { ...league };
}

// ── Latences simulées ───────────────────────────────────────────────────────

export interface Latencies { nhl: number; odds: number; ml: number }

let latency: Latencies = { nhl: 120, odds: 200, ml: 60 };

export function setLatency(next: Partial<Latencies>): void {
  latency = { ...latency, ...next };
}

// ── Données synthétiques ────────────────────────────────────────────────────

const ABBRS = [
  'ANA', 'BOS', 'BUF', 'CGY', 'CAR', 'CHI', 'COL', 'CBJ',
  'DAL', 'DET', 'EDM', 'FLA', 'LAK', 'MIN', 'MTL', 'NSH',
  'NJD', 'NYI', 'NYR', 'OTT', 'PHI', 'PIT', 'SEA', 'SJS',
  'STL', 'TBL', 'TOR', 'UTA', 'VAN', 'VGK', 'WPG', 'WSH',
];

/** Les noms complets EXACTS attendus par `TEAM_NAME_TO_ABBR` (teamSeasons.ts).
 *  Un nom qui ne correspond pas fait silencieusement disparaître l'équipe de
 *  `fetchTeamSummaryStats` — donc le banc mesurerait un chemin mort. */
const FULL_NAME: Record<string, string> = {
  ANA: 'Anaheim Ducks',        BOS: 'Boston Bruins',
  BUF: 'Buffalo Sabres',       CGY: 'Calgary Flames',
  CAR: 'Carolina Hurricanes',  CHI: 'Chicago Blackhawks',
  COL: 'Colorado Avalanche',   CBJ: 'Columbus Blue Jackets',
  DAL: 'Dallas Stars',         DET: 'Detroit Red Wings',
  EDM: 'Edmonton Oilers',      FLA: 'Florida Panthers',
  LAK: 'Los Angeles Kings',    MIN: 'Minnesota Wild',
  MTL: 'Montreal Canadiens',   NSH: 'Nashville Predators',
  NJD: 'New Jersey Devils',    NYI: 'New York Islanders',
  NYR: 'New York Rangers',     OTT: 'Ottawa Senators',
  PHI: 'Philadelphia Flyers',  PIT: 'Pittsburgh Penguins',
  SEA: 'Seattle Kraken',       SJS: 'San Jose Sharks',
  STL: 'St. Louis Blues',      TBL: 'Tampa Bay Lightning',
  TOR: 'Toronto Maple Leafs',  UTA: 'Utah Mammoth',
  VAN: 'Vancouver Canucks',    VGK: 'Vegas Golden Knights',
  WPG: 'Winnipeg Jets',        WSH: 'Washington Capitals',
};

/**
 * Identifiant du match `i` d'une soirée de banc, et ses deux équipes.
 *
 * SOURCE UNIQUE, exportée : `pgstub` fabrique des tickets qui parient sur ces
 * équipes, et le bouchon amont sert le résultat de ces mêmes matchs. Recopier
 * l'appariement des deux côtés, c'est signer un banc qui rend « unknown » le
 * jour où l'un des deux change — et un ticket non réglé ressemble exactement à
 * un règlement qui ne marche pas.
 */
export const BENCH_GAME_ID_BASE = 2025020100;

export function benchGameId(i: number): string {
  return String(BENCH_GAME_ID_BASE + i);
}

export function benchGameTeams(i: number): [string, string] {
  const t = ABBRS;
  return [t[(i * 2) % t.length].toLowerCase(), t[(i * 2 + 1) % t.length].toLowerCase()];
}

/**
 * Matchs terminés ou non. Les tickets ne se règlent que contre un match FINAL
 * portant un score : tant que ce drapeau est faux, `settleLeg` rend « unknown »
 * et la passe ne règle rien — ce qui est le bon comportement, et une excellente
 * façon de vérifier que le banc mesure bien le chemin de règlement.
 */
let gamesFinal = false;
export function setGamesFinal(v: boolean): void { gamesFinal = v; }

/** Score final servi par le bouchon : le domicile gagne 4-2. */
export const BENCH_FINAL_SCORE = { home: 4, away: 2 };

function teamsInPlay(): string[] {
  return ABBRS.slice(0, Math.min(Math.max(league.teams, 2), ABBRS.length));
}

/** Pseudo-aléatoire DÉTERMINISTE : deux exécutions du banc doivent produire
 *  exactement les mêmes chiffres, sinon on ne peut comparer aucun run. */
function seeded(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function standings() {
  return teamsInPlay().map((abbr, i) => {
    const gp = 20;
    const wins = 6 + Math.floor(seeded(i) * 9);
    const losses = gp - wins - 2;
    return {
      teamAbbrev:   { default: abbr },
      teamFullName: { default: FULL_NAME[abbr] },
      teamName:     { default: FULL_NAME[abbr] },
      placeName:    { default: FULL_NAME[abbr].split(' ')[0] },
      conferenceName: i % 2 ? 'Eastern' : 'Western',
      divisionName:   i % 4 ? 'Atlantic' : 'Metropolitan',
      gamesPlayed: gp,
      wins, losses, otLosses: 2,
      points: wins * 2 + 2,
      winPctg: wins / gp,
      goalFor:     50 + Math.floor(seeded(i + 100) * 30),
      goalAgainst: 50 + Math.floor(seeded(i + 200) * 30),
      homeWins: Math.floor(wins / 2), homeLosses: 3, homeOtLosses: 1,
      roadWins: Math.ceil(wins / 2),  roadLosses: 3, roadOtLosses: 1,
      streakCode: 'W', streakCount: 2,
    };
  });
}

/** `games` matchs du jour, appariés sans qu'une équipe joue deux fois. */
function gamesForDate(date: string, state = 'FUT') {
  const t = teamsInPlay();
  const n = Math.min(league.games, Math.floor(t.length / 2));
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    const home = t[i * 2];
    const away = t[i * 2 + 1];
    out.push({
      id: Number(date.replace(/-/g, '').slice(2)) * 100 + i,
      season: 20252026,
      gameType: 2,
      gameDate: date,
      startTimeUTC: `${date}T23:00:00Z`,
      gameState: state,
      venue: { default: `${FULL_NAME[home]} Arena` },
      periodDescriptor: { number: state === 'LIVE' ? 2 : null },
      clock: { timeRemaining: '12:34' },
      homeTeam: { abbrev: home, commonName: { default: FULL_NAME[home] }, score: state === 'FUT' ? null : 2 },
      awayTeam: { abbrev: away, commonName: { default: FULL_NAME[away] }, score: state === 'FUT' ? null : 1 },
    });
  }
  return out;
}

function todayIso(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function gameWeek(from: string) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    return { date, games: gamesForDate(date) };
  });
}

/** Un joueur par identifiant, réparti sur les équipes qui jouent ce soir. */
function playerRow(idx: number) {
  const t = teamsInPlay();
  const abbr = t[idx % t.length];
  const gp = 20;
  const pts = 30 - Math.floor(idx / 2);
  return {
    id: 8470000 + idx,
    firstName: { default: `Prenom${idx}` },
    lastName:  { default: `Nom${idx}` },
    teamAbbrev: abbr,
    positionCode: idx % 7 === 0 ? 'D' : 'C',
    sweaterNumber: (idx % 98) + 1,
    gamesPlayed: gp,
    goals: Math.max(1, Math.floor(pts / 2)),
    assists: Math.max(1, Math.ceil(pts / 2)),
    points: Math.max(1, pts),
    value: Math.max(1, pts),
    plusMinus: 3,
    shots: 60,
    shootingPctg: 0.12,
    powerPlayPoints: Math.max(0, Math.floor(pts / 4)),
  };
}

function playerLanding(playerId: string) {
  const idx = Number(playerId) - 8470000;
  const p = playerRow(Number.isFinite(idx) && idx >= 0 ? idx : 0);
  return {
    playerId: Number(playerId),
    firstName: p.firstName,
    lastName:  p.lastName,
    currentTeamAbbrev: p.teamAbbrev,
    position: p.positionCode,
    sweaterNumber: p.sweaterNumber,
    seasonTotals: [{
      leagueAbbrev: 'NHL',
      gameTypeId: 2,
      season: 20252026,
      gamesPlayed: p.gamesPlayed,
      goals: p.goals,
      assists: p.assists,
      points: p.points,
      plusMinus: p.plusMinus,
      shots: p.shots,
      shootingPctg: p.shootingPctg,
      powerPlayPoints: p.powerPlayPoints,
      pim: 12,
      avgToi: '18:42',
    }],
  };
}

/** Calendrier de saison d'une équipe — sert `fetchTeamRestInfo` / `fetchTeamTravel`. */
function clubSchedule(abbr: string) {
  const games: any[] = [];
  for (let back = 1; back <= 20; back++) {
    const d = new Date();
    d.setDate(d.getDate() - back * 2);
    const date = d.toISOString().slice(0, 10);
    const opp = ABBRS[(ABBRS.indexOf(abbr) + back) % ABBRS.length];
    games.push({
      id: 2025020000 + back,
      gameType: 2,
      gameState: 'OFF',
      gameDate: date,
      homeTeam: { abbrev: back % 2 ? abbr : opp, score: 3 },
      awayTeam: { abbrev: back % 2 ? opp : abbr, score: 2 },
    });
  }
  return { games };
}

function teamSummaryRows() {
  return {
    data: teamsInPlay().map((abbr, i) => ({
      teamFullName: FULL_NAME[abbr],
      gamesPlayed: 20,
      wins: 10, losses: 8, points: 22,
      goalsFor: 60, goalsAgainst: 58,
      goalsForPerGame: 3.0, goalsAgainstPerGame: 2.9,
      powerPlayPct: 0.18 + seeded(i) * 0.08,
      penaltyKillPct: 0.78 + seeded(i + 50) * 0.08,
      shotsForPerGame: 28 + seeded(i + 60) * 6,
      shotsAgainstPerGame: 28 + seeded(i + 70) * 6,
      faceoffWinPct: 0.48 + seeded(i + 80) * 0.05,
      pointPct: 0.55,
    })),
  };
}

function oddsEvents() {
  const t = teamsInPlay();
  const n = Math.min(league.games, Math.floor(t.length / 2));
  return Array.from({ length: n }, (_, i) => ({
    id: `evt${i}`,
    sport_key: 'icehockey_nhl',
    commence_time: `${todayIso()}T23:00:00Z`,
    home_team: FULL_NAME[t[i * 2]],
    away_team: FULL_NAME[t[i * 2 + 1]],
    bookmakers: [{
      key: 'bet365',
      title: 'Bet365',
      markets: [
        { key: 'h2h',    outcomes: [
          { name: FULL_NAME[t[i * 2]],     price: 1.85 },
          { name: FULL_NAME[t[i * 2 + 1]], price: 2.05 },
        ] },
        { key: 'totals', outcomes: [
          { name: 'Over',  price: 1.90, point: 6.0 },
          { name: 'Under', price: 1.92, point: 6.0 },
        ] },
        { key: 'spreads', outcomes: [
          { name: FULL_NAME[t[i * 2]],     price: 2.40, point: -1.5 },
          { name: FULL_NAME[t[i * 2 + 1]], price: 1.60, point:  1.5 },
        ] },
      ],
    }],
  }));
}

function mlPrediction(seed: string) {
  const h = [...seed].reduce((a, c) => a + c.charCodeAt(0), 0);
  return {
    probability: 40 + (h % 40),
    confidence:  55 + (h % 30),
    feature_importances: [
      { name: 'home_win_pct', importance: 0.31, direction: 'positive' },
      { name: 'rest_days',    importance: 0.12, direction: 'positive' },
    ],
    model_version: 'bench-1',
    model_type: 'gradient_boosting',
    explanation: 'banc de charge — valeur synthétique',
    probability_std: 4.2,
    uncertainty: 0.2,
  };
}

// ── Réponse HTTP minimale ───────────────────────────────────────────────────

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  const h = new Map(Object.entries({
    'content-type': 'application/json',
    ...headers,
  }));
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// ── Le routeur de bouchon ───────────────────────────────────────────────────

function groupOf(url: string): Group {
  if (url.includes('api-web.nhle.com'))     return 'nhl-web';
  if (url.includes('api.nhle.com'))         return 'nhl-stats';
  if (url.includes('search.d3.nhle.com'))   return 'nhl-search';
  if (url.includes('the-odds-api.com'))     return 'odds';
  if (url.includes('localhost:8000')
   || url.includes('/predict/'))            return 'ml';
  return 'autre';
}

function bodyFor(url: string): unknown {
  // — Service ML —
  if (url.includes('/predict/game'))   return mlPrediction(url + 'g');
  if (url.includes('/predict/player')) return mlPrediction(url + 'p');
  if (url.includes('/predict/team'))   return mlPrediction(url + 't');

  // — The Odds API —
  if (url.includes('the-odds-api.com/v4/sports/') && url.includes('/odds')) return oddsEvents();
  if (url.includes('the-odds-api.com/v4/sports'))  return [{ key: 'icehockey_nhl', title: 'NHL', active: true }];

  // — api.nhle.com/stats/rest —
  if (url.includes('/team/summary'))   return teamSummaryRows();
  if (url.includes('/skater/summary') || url.includes('/goalie/summary')) return { data: [] };

  // — api-web.nhle.com —
  if (url.includes('v1/standings/now')) return { standings: standings() };
  if (url.includes('v1/scoreboard/now')) return { games: gamesForDate(todayIso(), 'LIVE') };
  if (url.includes('v1/schedule/now')) {
    return {
      gameWeek: gameWeek(todayIso()),
      regularSeasonStartDate: '2025-10-07',
      playoffEndDate: '2026-06-20',
    };
  }
  const sched = url.match(/v1\/schedule\/(\d{4}-\d{2}-\d{2})/);
  if (sched) return { gameWeek: gameWeek(sched[1]) };

  const club = url.match(/v1\/club-schedule-season\/([A-Z]{3})\//);
  if (club) return clubSchedule(club[1]);

  if (url.includes('v1/skater-stats-leaders/')) {
    const limit = Number(url.match(/limit=(\d+)/)?.[1] ?? 50);
    const n = Math.min(limit, league.players);
    const rows = Array.from({ length: n }, (_, i) => playerRow(i));
    return url.includes('categories=goals') ? { goals: rows } : { points: rows };
  }

  const landing = url.match(/v1\/player\/(\d+)\/landing/);
  if (landing) return playerLanding(landing[1]);

  const roster = url.match(/v1\/roster\/([A-Z]{3})\//);
  if (roster) {
    const t = teamsInPlay();
    const base = t.indexOf(roster[1]) * 20;
    const mk = (k: number) => ({ id: 8470000 + base + k, firstName: { default: `P${k}` }, lastName: { default: 'X' } });
    return {
      forwards: Array.from({ length: 12 }, (_, k) => mk(k)),
      defensemen: Array.from({ length: 6 }, (_, k) => mk(k + 12)),
      goalies: Array.from({ length: 2 }, (_, k) => mk(k + 18)),
    };
  }

  const gc = url.match(/v1\/gamecenter\/(\d+)\/(landing|boxscore|play-by-play)/);
  if (gc) {
    const id = Number(gc[1]);
    // Match d'une soirée de banc (B14) : équipes déduites de l'identifiant,
    // donc cohérentes avec les tickets que `pgstub` a fabriqués.
    const idx = id - BENCH_GAME_ID_BASE;
    const deSoiree = idx >= 0 && idx < 100;
    const [dom, vis] = deSoiree
      ? benchGameTeams(idx)
      : [(gamesForDate(todayIso())[0]?.homeTeam?.abbrev ?? 'BOS').toLowerCase(),
         (gamesForDate(todayIso())[0]?.awayTeam?.abbrev ?? 'NYR').toLowerCase()];
    const fini = gamesFinal && deSoiree;
    return {
      id,
      gameState: fini ? 'OFF' : 'FUT',
      gameDate: todayIso(),
      startTimeUTC: `${todayIso()}T23:00:00Z`,
      homeTeam: {
        abbrev: dom.toUpperCase(),
        commonName: { default: FULL_NAME[dom.toUpperCase()] ?? dom.toUpperCase() },
        score: fini ? BENCH_FINAL_SCORE.home : null,
      },
      awayTeam: {
        abbrev: vis.toUpperCase(),
        commonName: { default: FULL_NAME[vis.toUpperCase()] ?? vis.toUpperCase() },
        score: fini ? BENCH_FINAL_SCORE.away : null,
      },
      playerByGameStats: { homeTeam: { forwards: [], defense: [], goalies: [] }, awayTeam: { forwards: [], defense: [], goalies: [] } },
      summary: { scoring: [] },
      plays: [],
    };
  }

  // Tout le reste : une forme vide et valide plutôt qu'une erreur, pour qu'un
  // appel non prévu se voie dans le journal (`autre`) sans faire tomber le banc.
  return {};
}

/** Empreinte courte et stable d'un corps de requête. */
function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

let installed = false;
let realFetch: typeof globalThis.fetch;

/**
 * Remplace `globalThis.fetch`. À appeler AVANT le premier import de l'app :
 * les clients capturent `fetch` à l'appel, mais certains modules lisent des
 * variables d'environnement à l'import, donc l'ordre compte de toute façon.
 */
export function install(): void {
  if (installed) return;
  installed = true;
  realFetch = globalThis.fetch;

  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    const group = groupOf(url);
    const method = String(init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : '';
    const key = `${method} ${url}${body ? ' ' + hash(body) : ''}`;

    // Le pilote du banc parle au serveur local en HTTP direct (module `http`),
    // donc rien de légitime ne doit sortir par ici. Un appel non classé est
    // journalisé mais sert quand même une réponse vide.
    calls.push({ group, url, key, startedAt: Date.now() });

    const ms = group === 'odds' ? latency.odds : group === 'ml' ? latency.ml : latency.nhl;
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));

    const headers = group === 'odds'
      ? { 'x-requests-remaining': '480', 'x-requests-used': '20' }
      : {};
    return jsonResponse(bodyFor(url), headers);
  };
}

export function uninstall(): void {
  if (!installed) return;
  (globalThis as any).fetch = realFetch;
  installed = false;
}
