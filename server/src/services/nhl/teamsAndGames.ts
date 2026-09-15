/**
 * nhl/teamsAndGames.ts — équipes, classement, calendrier et matchs.
 * Point d'entrée public : `../nhlApiClient.ts`.
 */

import { MOCK_TEAMS_FULL, MOCK_GAMES_FULL } from '../../data/mockNhl';
import { TEAM_META, USE_MOCK, fetchNHL, getCached, parseToiMinutes, setCached } from './core';

// --- Teams / Standings ----------------------------------------------------

function _splitPct(wins?: number, losses?: number, otLosses?: number): number {
  const gp = (wins ?? 0) + (losses ?? 0) + (otLosses ?? 0);
  return gp > 0 ? +((wins ?? 0) / gp).toFixed(4) : 0.5;
}

export async function fetchTeams(): Promise<any[]> {
  if (USE_MOCK) return MOCK_TEAMS_FULL as any[];
  const cached = getCached<any[]>('teams');
  if (cached) return cached;

  const data = await fetchNHL<any>('v1/standings/now');
  const teams = (data.standings ?? []).map((s: any) => {
    const abbr: string = s.teamAbbrev?.default ?? '';
    const meta = TEAM_META[abbr] ?? { emoji: '🏒', color: '#86d1ea' };

    // `gp` était `s.gamesPlayed || 1`. Tant que `standings/now` renvoie la
    // saison terminée, ça ne se voyait pas. Le jour où il bascule sur la
    // nouvelle saison à 0 match joué, ce `|| 1` transformait CHAQUE moyenne en
    // `0 / 1 = 0.00` — et un 0 qui veut dire « aucune donnée » traverse tous les
    // replis en aval, parce qu'ils sont écrits `?? 3.0` (qui ne rattrape que
    // null/undefined) et pas `|| 3.0`. Résultat : le modèle aurait servi des
    // prédictions bâties sur une ligue où personne ne marque, sans une seule
    // erreur dans les journaux.
    //
    // Les TOTAUX (buts, victoires, points) restent à 0 : à 0 match joué, c'est
    // la vérité. Ce sont les TAUX qui passent à `null`, seule valeur qui dit
    // « je ne sais pas » — et que les `??` en aval rattrapent correctement.
    const gp     = s.gamesPlayed ?? 0;
    const played = gp > 0;
    return {
      id:           abbr,
      name:         s.teamFullName?.default ?? s.teamName?.default ?? abbr,
      abbreviation: abbr,
      city:         s.placeName?.default ?? '',
      conference:   s.conferenceName ?? '',
      division:     s.divisionName   ?? '',
      emoji:        meta.emoji,
      color:        meta.color,
      gamesPlayed:  gp,
      wins:         s.wins     ?? 0,
      losses:       s.losses   ?? 0,
      otLosses:     s.otLosses ?? 0,
      points:       s.points   ?? 0,
      winPct:       played ? Math.round((s.winPctg ?? 0) * 100) : null,
      homeRecord:   `${s.homeWins ?? 0}-${s.homeLosses ?? 0}-${s.homeOtLosses ?? 0}`,
      awayRecord:   `${s.roadWins ?? 0}-${s.roadLosses ?? 0}-${s.roadOtLosses ?? 0}`,
      streak:       s.streakCode && s.streakCount ? `${s.streakCode}${s.streakCount}` : '',
      goalsFor:            s.goalFor     ?? 0,
      goalsAgainst:        s.goalAgainst ?? 0,
      goalsForPerGame:     played ? +((s.goalFor     ?? 0) / gp).toFixed(2) : null,
      goalsAgainstPerGame: played ? +((s.goalAgainst ?? 0) / gp).toFixed(2) : null,
      // NOTE: powerPlayPctg/penaltyKillPctg n'existent PAS dans standings —
      // les vrais PP/PK viennent de fetchTeamSummaryStats() (api.nhle.com/stats/rest)
      // Le `: 0` de repli disait « 0 % en avantage numérique » là où il fallait
      // dire « je ne sais pas » : `?? 20` en aval ne pouvait pas le rattraper.
      ppPct: played && s.powerPlayPctg   != null ? Math.round(s.powerPlayPctg   * 1000) / 10 : null,
      pkPct: played && s.penaltyKillPctg != null ? Math.round(s.penaltyKillPctg * 1000) / 10 : null,
      // Forme récente L10 (ex: "7-2-1") — consommé par parseLastTen().
      // À 0 match joué, l'API renvoie "0-0-0", que parseLastTen lisait comme
      // 0 victoire sur 10 — une équipe en pleine déroute plutôt qu'une saison
      // pas commencée. `null` déclenche le repli neutre.
      last10: played ? `${s.l10Wins ?? 5}-${s.l10Losses ?? 4}-${s.l10OtLosses ?? 1}` : null,
      // Splits domicile / extérieur (win% simple)
      homeWinPct: _splitPct(s.homeWins, s.homeLosses, s.homeOtLosses),
      roadWinPct: _splitPct(s.roadWins, s.roadLosses, s.roadOtLosses),
      // Série signée : W3 → +3, L2 → -2
      streakSigned: (s.streakCode === 'W' ? 1 : -1) * (s.streakCount ?? 0),
    };
  });

  setCached('teams', teams, 5 * 60_000);
  return teams;
}

export async function fetchTeamByAbbr(abbr: string): Promise<any> {
  const all  = await fetchTeams();
  const team = all.find(t => t.abbreviation.toLowerCase() === abbr.toLowerCase());
  if (!team) throw Object.assign(new Error('Team not found'), { status: 404 });
  return team;
}

// --- Games ----------------------------------------------------------------

function parseGameState(state: string): string {
  const MAP: Record<string, string> = {
    FUT: 'scheduled', PRE: 'scheduled',
    LIVE: 'live',     CRIT: 'live',
    FINAL: 'final',   OVER: 'final', OFF: 'final',
  };
  return MAP[state] ?? state?.toLowerCase() ?? 'scheduled';
}

function formatGame(g: any, date?: string): any {
  const homeAbbr = g.homeTeam?.abbrev ?? '';
  const awayAbbr = g.awayTeam?.abbrev ?? '';
  const homeMeta = TEAM_META[homeAbbr] ?? { emoji: '🏒', color: '#86d1ea' };
  const awayMeta = TEAM_META[awayAbbr] ?? { emoji: '🏒', color: '#86d1ea' };

  let startTime = '';
  if (g.startTimeUTC) {
    startTime = new Date(g.startTimeUTC).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit',
      timeZone: 'America/New_York', hour12: true,
    }) + ' ET';
  }

  const gameDate = date ?? g.gameDate ?? g.startTimeUTC?.slice(0, 10) ?? '';

  return {
    id:          String(g.id),
    gameDate,
    startTime,
    startTimeUTC: g.startTimeUTC ?? null, // raw ISO — used by settlement scheduling
    status:      parseGameState(g.gameState ?? ''),
    period:      g.periodDescriptor?.number ?? null,
    clock:       g.clock?.timeRemaining ?? null,
    venue:       g.venue?.default ?? '',
    gameType:    g.gameType === 3 ? 'playoff' : 'regular',
    overUnder:   null,
    homeWinPct:  50,
    awayWinPct:  50,
    homeTeam: {
      id:           homeAbbr,
      abbreviation: homeAbbr,
      name:         g.homeTeam?.commonName?.default ?? g.homeTeam?.name?.default ?? homeAbbr,
      emoji:        homeMeta.emoji,
      score:        g.homeTeam?.score ?? null,
      odds:         null,
    },
    awayTeam: {
      id:           awayAbbr,
      abbreviation: awayAbbr,
      name:         g.awayTeam?.commonName?.default ?? g.awayTeam?.name?.default ?? awayAbbr,
      emoji:        awayMeta.emoji,
      score:        g.awayTeam?.score ?? null,
      odds:         null,
    },
  };
}

export async function fetchGamesByDate(date: string): Promise<any[]> {
  if (USE_MOCK) return MOCK_GAMES_FULL as any[];
  const key    = `schedule:${date}`;
  const cached = getCached<any[]>(key);
  if (cached) return cached;

  const data     = await fetchNHL<any>(`v1/schedule/${date}`);
  const dayEntry = (data.gameWeek ?? []).find((w: any) => w.date === date);
  if (!dayEntry?.games?.length) return [];

  const games = dayEntry.games.map((g: any) => formatGame(g, date));
  const ttl   = games.some((g: any) => g.status === 'live') ? 30_000 : 5 * 60_000;
  setCached(key, games, ttl);
  
  return games;
}

/** `'YYYY-MM-DD'` décalé de `n` jours (UTC, comme les `gameDate` de la NHL). */
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const WEEK_TTL = 10 * 60_000;

/**
 * Une semaine de calendrier NHL, mise en cache **sous sa propre date de début**.
 *
 * CE QUE ÇA CORRIGE (ligne S de l'audit) — la version précédente mettait en
 * cache le RÉSULTAT ASSEMBLÉ sous `range:<début>:<fin>`. Les bornes viennent du
 * calendrier côté client : chaque plage consultée créait sa propre clé, deux
 * plages qui se chevauchent de six jours sur sept ne partageaient rien, et le
 * cache s'auto-évinçait (FIFO) au fil de la navigation. Le nombre de clés
 * suivait le nombre de plages distinctes ; il suit maintenant le nombre de
 * semaines, c'est-à-dire ~52 par saison.
 *
 * La clé est la date de début renvoyée par l'API, pas celle demandée : deux
 * curseurs tombant dans la même semaine doivent partager une entrée. La
 * recherche remonte donc jusqu'à six jours en arrière et vérifie que la semaine
 * trouvée couvre bien le curseur — aucune hypothèse sur le jour où commence une
 * semaine NHL, qui n'est pas à nous de décider.
 *
 * Une semaine vide (hors saison) est mémorisée elle aussi, sous la date
 * demandée : sans ça, un balayage d'août refait ses 45 appels à chaque fois.
 */
async function fetchScheduleWeek(cursor: string): Promise<any[]> {
  const exact = getCached<any[]>(`sched:week:${cursor}`);
  if (exact) return exact;

  for (let back = 1; back < 7; back++) {
    const week = getCached<any[]>(`sched:week:${addDays(cursor, -back)}`);
    if (week?.length) {
      const dates = week.map((d: any) => String(d.date));
      const first = dates.reduce((a, b) => (a < b ? a : b));
      const last  = dates.reduce((a, b) => (a > b ? a : b));
      if (first <= cursor && cursor <= last) return week;
    }
  }

  let week: any[] = [];
  try {
    const data = await fetchNHL<any>(`v1/schedule/${cursor}`);
    week = (data.gameWeek ?? []) as any[];
  } catch {
    // Jour sans données exploitables : l'appelant avancera d'un jour. Rien n'est
    // mémorisé — un échec réseau ne doit pas se transformer en semaine vide de
    // dix minutes.
    return [];
  }

  setCached(`sched:week:${cursor}`, week, WEEK_TTL);
  const firstDate = week.length
    ? week.map((d: any) => String(d.date)).reduce((a, b) => (a < b ? a : b))
    : null;
  if (firstDate && firstDate !== cursor) setCached(`sched:week:${firstDate}`, week, WEEK_TTL);
  return week;
}

/**
 * Retourne tous les matchs (joués + à venir) entre deux dates incluses, en
 * parcourant l'endpoint hebdomadaire v1/schedule/{date} semaine par semaine.
 * Utilisé par la page calendrier (schedule) côté client.
 *  - start / end : 'YYYY-MM-DD' (end doit être >= start).
 *  - L'amplitude est bornée à 45 jours pour limiter les appels upstream.
 *
 * L'assemblage n'est plus mis en cache : ce sont les semaines qui le sont
 * (cf. `fetchScheduleWeek`). Recomposer une plage revient à parcourir sept
 * semaines déjà en mémoire — quelques centaines d'itérations — là où la clé par
 * plage faisait croître le cache avec le nombre de plages consultées.
 */
export async function fetchGamesRange(start: string, end: string): Promise<any[]> {
  // Borne l'amplitude (sécurité : évite les balayages illimités).
  const MAX_SPAN = 45;
  if (addDays(start, MAX_SPAN) < end) end = addDays(start, MAX_SPAN);

  if (USE_MOCK) {
    return (MOCK_GAMES_FULL as any[]).filter(
      (g) => g.gameDate >= start && g.gameDate <= end,
    );
  }

  const seen = new Set<string>();
  const out: any[] = [];
  let cursor = start;

  // Parcourt la fenêtre semaine par semaine. Ne s'arrête JAMAIS sur une semaine
  // vide (ex. début octobre avant le coup d'envoi) : on avance toujours, sinon
  // on manquerait les matchs situés plus loin dans le mois. Garde-fou large
  // (une itération par jour dans le pire cas) — les semaines sont en cache.
  for (let guard = 0; guard < MAX_SPAN + 2 && cursor <= end; guard++) {
    const week = await fetchScheduleWeek(cursor);

    let maxDate = cursor;
    for (const day of week) {
      if (day.date > maxDate) maxDate = day.date;
      if (day.date < start || day.date > end) continue;
      for (const g of day.games ?? []) {
        const id = String(g.id);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(formatGame(g, day.date));
      }
    }

    // Avance après la dernière date couverte par la semaine ; si la semaine
    // n'a fait progresser le curseur d'aucun jour (réponse vide), on avance
    // d'un jour pour ne rien sauter.
    const stepped = addDays(maxDate, 1);
    cursor = stepped > cursor ? stepped : addDays(cursor, 1);
  }

  out.sort((a, b) =>
    a.gameDate === b.gameDate
      ? String(a.id).localeCompare(String(b.id))
      : a.gameDate.localeCompare(b.gameDate),
  );

  return out;
}

/**
 * Point d'ancrage du calendrier : renvoie la date « courante » selon l'API NHL
 * (et non l'horloge de la machine) + les bornes de la saison si disponibles.
 * Permet à la page calendrier de s'ouvrir sur le bon mois même si l'horloge
 * locale est décalée par rapport aux données réelles de l'API.
 */
export async function fetchScheduleAnchor(): Promise<{ today: string; seasonStart: string; seasonEnd: string }> {
  const clockToday = new Date().toISOString().slice(0, 10);

  if (USE_MOCK) {
    const dates = (MOCK_GAMES_FULL as any[]).map((g) => g.gameDate).sort();
    return { today: dates[0] ?? clockToday, seasonStart: dates[0] ?? '', seasonEnd: dates[dates.length - 1] ?? '' };
  }

  const cached = getCached<{ today: string; seasonStart: string; seasonEnd: string }>('sched:anchor');
  if (cached) return cached;

  const data = await fetchNHL<any>('v1/schedule/now');
  const out = {
    today:       data.gameWeek?.[0]?.date ?? clockToday,
    seasonStart: data.regularSeasonStartDate ?? data.preSeasonStartDate ?? '',
    seasonEnd:   data.playoffEndDate ?? data.regularSeasonEndDate ?? '',
  };
  setCached('sched:anchor', out, 60 * 60_000); // 1 h
  return out;
}

export async function fetchLiveGames(): Promise<any[]> {
  if (USE_MOCK) return (MOCK_GAMES_FULL as any[]).filter((g) => g.status === 'live');
  const cached = getCached<any[]>('live');
  if (cached) return cached;

  const data  = await fetchNHL<any>('v1/scoreboard/now');
  const games = (data.games ?? [])
    .filter((g: any) => g.gameState === 'LIVE' || g.gameState === 'CRIT')
    .map((g: any) => formatGame(g));

  setCached('live', games, 30_000);
  return games;
}

/**
 * Cette fonction était la seule du module à ne rien mettre en cache, alors
 * qu'elle est appelée par `/api/nhl/games/:id`, par `/api/nhl/predictions/game/:id`
 * (via `buildGameMarkets`) et par CHAQUE `POST /api/predict/single` portant un
 * `gameId` (via `resolveSubjects`). La déduplication de `fetchNHL` ne couvrait
 * que les appels strictement simultanés : deux requêtes espacées de 100 ms
 * repartaient toutes les deux vers la NHL.
 *
 * Le TTL suit l'état du match, comme `fetchGamesByDate` et `fetchGameDetail` le
 * font déjà : un match terminé ne changera plus jamais, un match en cours change
 * à chaque but.
 *
 * Un échec n'est jamais mémorisé — un `gameId` pas encore publié par la NHL doit
 * pouvoir apparaître à la requête suivante, pas être figé en 404 pour 6 h.
 */
export async function fetchGameById(gameId: string): Promise<any> {
  if (USE_MOCK) {
    const g = (MOCK_GAMES_FULL as any[]).find((x) => x.id === gameId);
    if (g) return g;
    throw Object.assign(new Error('Game not found'), { status: 404 });
  }

  const key    = `game:${gameId}`;
  const cached = getCached<any>(key);
  if (cached) return cached;

  let game: any;
  try {
    const data = await fetchNHL<any>(`v1/gamecenter/${gameId}/landing`);
    game = formatGame(data);
  } catch {
    throw Object.assign(new Error('Game not found'), { status: 404 });
  }

  setCached(
    key,
    game,
    game.status === 'final' ? 6 * 60 * 60_000 : game.status === 'live' ? 30_000 : 5 * 60_000,
  );
  return game;
}

/**
 * Everything the game page needs, in one payload: the landing feed (score,
 * shots, scoring summary, stars, state) merged with the boxscore (per-player
 * lines, which is the only place hits/blocks/giveaways live).
 *
 * Both are fetched together because a game page always wants both, and the
 * boxscore is empty for games that haven't started — in which case the caller
 * still gets the header/matchup half and shows season form instead.
 */
export async function fetchGameDetail(gameId: string): Promise<any> {
  const cacheKey = `game_detail_${gameId}`;
  const cached = getCached<any>(cacheKey);
  if (cached) return cached;

  const [landingRes, boxRes] = await Promise.allSettled([
    fetchNHL<any>(`v1/gamecenter/${gameId}/landing`),
    fetchNHL<any>(`v1/gamecenter/${gameId}/boxscore`),
  ]);
  if (landingRes.status === 'rejected') {
    throw Object.assign(new Error('Game not found'), { status: 404 });
  }
  const L = landingRes.value as any;
  const B = boxRes.status === 'fulfilled' ? (boxRes.value as any) : null;

  const state  = parseGameState(L.gameState ?? '');
  const isFinal = state === 'final';

  const side = (tm: any) => ({
    abbr:  tm?.abbrev ?? '',
    name:  [tm?.placeName?.default, tm?.commonName?.default].filter(Boolean).join(' '),
    score: tm?.score ?? null,
    sog:   tm?.sog ?? null,
  });

  // --- Goals per period ---
  // `summary.scoring` only contains periods that had goals, so the columns are
  // built from the game's actual period structure and then filled in. Deriving
  // them from the scoring array alone would silently drop a scoreless period.
  const tally = new Map<string, { home: number; away: number }>();
  let sawOT = false;
  let sawSO = false;
  for (const p of L.summary?.scoring ?? []) {
    const type = String(p?.periodDescriptor?.periodType ?? 'REG');
    const num  = Number(p?.periodDescriptor?.number ?? 0);
    const label = type === 'SO' ? 'SO' : type === 'OT' ? 'OT' : String(num);
    if (label === 'OT') sawOT = true;
    if (label === 'SO') sawSO = true;
    const cur = tally.get(label) ?? { home: 0, away: 0 };
    for (const g of p?.goals ?? []) (g?.isHome ? cur.home++ : cur.away++);
    tally.set(label, cur);
  }

  const regPeriods = Number(L.regPeriods ?? 3);
  const lastType   = String(L.periodDescriptor?.periodType ?? 'REG');
  const lastNum    = Number(L.periodDescriptor?.number ?? regPeriods);
  const labels: string[] = [];
  for (let i = 1; i <= regPeriods; i++) labels.push(String(i));
  if (sawOT || lastType === 'OT' || lastNum > regPeriods) labels.push('OT');
  if (sawSO || lastType === 'SO') labels.push('SO');

  const periods = labels.map((label) => ({
    label,
    home: tally.get(label)?.home ?? 0,
    away: tally.get(label)?.away ?? 0,
  }));

  // --- Flat scoring summary ---
  const scoring = (L.summary?.scoring ?? []).flatMap((p: any) => {
    const type = String(p?.periodDescriptor?.periodType ?? 'REG');
    const num  = Number(p?.periodDescriptor?.number ?? 0);
    const label = type === 'SO' ? 'SO' : type === 'OT' ? 'OT' : String(num);
    return (p?.goals ?? []).map((g: any) => ({
      period:   label,
      time:     g?.timeInPeriod ?? '',
      teamAbbr: g?.teamAbbrev?.default ?? '',
      scorer:   g?.name?.default ?? '',
      assists:  (g?.assists ?? []).map((a: any) => a?.name?.default ?? '').filter(Boolean),
      strength: g?.strength ?? 'ev',
      isHome:   !!g?.isHome,
      homeScore: g?.homeScore ?? null,
      awayScore: g?.awayScore ?? null,
    }));
  });

  const threeStars = (L.summary?.threeStars ?? []).map((s: any) => ({
    star:     s?.star ?? 0,
    id:       String(s?.playerId ?? ''),
    name:     s?.name?.default ?? '',
    teamAbbr: s?.teamAbbrev ?? '',
    position: s?.position ?? '',
    goals:    s?.goals ?? 0,
    assists:  s?.assists ?? 0,
    points:   s?.points ?? 0,
  }));

  // --- Per-player lines + aggregated team totals from the boxscore ---
  const mapSkater = (p: any) => ({
    id:           String(p?.playerId ?? ''),
    name:         p?.name?.default ?? '',
    number:       p?.sweaterNumber ?? 0,
    position:     p?.position ?? '',
    goals:        p?.goals   ?? 0,
    assists:      p?.assists ?? 0,
    points:       p?.points  ?? 0,
    plusMinus:    p?.plusMinus ?? 0,
    sog:          p?.sog ?? 0,
    hits:         p?.hits ?? 0,
    blockedShots: p?.blockedShots ?? 0,
    pim:          p?.pim ?? 0,
    giveaways:    p?.giveaways ?? 0,
    takeaways:    p?.takeaways ?? 0,
    toi:          p?.toi ?? '',
    toiMin:       parseToiMinutes(p?.toi),
  });
  const mapGoalie = (p: any) => ({
    id:           String(p?.playerId ?? ''),
    name:         p?.name?.default ?? '',
    number:       p?.sweaterNumber ?? 0,
    saves:        p?.saves ?? 0,
    shotsAgainst: p?.shotsAgainst ?? 0,
    goalsAgainst: p?.goalsAgainst ?? 0,
    savePct:      p?.savePctg ?? null,
    decision:     p?.decision ?? '',
    starter:      !!p?.starter,
    toi:          p?.toi ?? '',
  });

  const pbg = B?.playerByGameStats;
  const teamPlayers = (which: 'homeTeam' | 'awayTeam') => {
    const s = pbg?.[which];
    const skaters = [...(s?.forwards ?? []), ...(s?.defense ?? [])].map(mapSkater);
    const goalies = (s?.goalies ?? []).map(mapGoalie).filter((g: any) => g.toi && g.toi !== '00:00');
    return { skaters, goalies };
  };
  const homePlayers = teamPlayers('homeTeam');
  const awayPlayers = teamPlayers('awayTeam');

  // Team totals are summed from the player lines — the NHL doesn't expose them
  // directly. Faceoff % is deliberately omitted: the boxscore only gives a
  // per-player percentage, which can't be combined into a team figure.
  const totals = (players: { skaters: any[]; goalies: any[] }, sog: number | null, isHome: boolean) => {
    const sum = (k: string) => players.skaters.reduce((a, p) => a + (p[k] ?? 0), 0);
    return {
      sog,
      pim:          sum('pim'),
      hits:         sum('hits'),
      blockedShots: sum('blockedShots'),
      giveaways:    sum('giveaways'),
      takeaways:    sum('takeaways'),
      ppGoals:      scoring.filter((s: any) => s.strength === 'pp' && s.isHome === isHome).length,
    };
  };

  const home = side(L.homeTeam);
  const away = side(L.awayTeam);

  const out = {
    id: String(L.id ?? gameId),
    season: L.season ?? null,
    gameDate: L.gameDate ?? '',
    startTimeUTC: L.startTimeUTC ?? null,
    venue: L.venue?.default ?? '',
    venueLocation: L.venueLocation?.default ?? '',
    gameType: L.gameType === 3 ? 'playoff' : 'regular',
    status: state,
    period: L.periodDescriptor?.number ?? null,
    periodType: L.periodDescriptor?.periodType ?? null,
    clock: L.clock?.timeRemaining ?? null,
    inIntermission: !!L.clock?.inIntermission,
    lastPeriodType: L.gameOutcome?.lastPeriodType ?? null,
    home,
    away,
    periods,
    scoring,
    threeStars,
    teamStats: B
      ? { home: totals(homePlayers, home.sog, true), away: totals(awayPlayers, away.sog, false) }
      : null,
    players: B ? { home: homePlayers, away: awayPlayers } : null,
  };

  // Finished games never change; live ones need to stay fresh.
  setCached(cacheKey, out, isFinal ? 6 * 60 * 60_000 : 30_000);
  return out;
}
