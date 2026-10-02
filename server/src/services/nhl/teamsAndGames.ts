/**
 * nhl/teamsAndGames.ts — équipes, classement, calendrier et matchs.
 * Point d'entrée public : `../nhlApiClient.ts`.
 */

import { MOCK_TEAMS_FULL, MOCK_GAMES_FULL } from '../../data/mockNhl';
import { TEAM_META, USE_MOCK, currentSeason, fetchNHL, getCached, parseToiMinutes, setCached } from './core';

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
  const season = currentSeason();
  const teams = (data.standings ?? []).map((s: any) => {
    /**
     * ⚠️ `standings/now` ne rend PAS forcément la saison en cours.
     *
     * Entre la fin des séries et le premier match d'octobre, la LNH continue de
     * servir le classement FINAL de la saison écoulée sous cette URL. L'app
     * l'affichait tel quel : au 19 septembre, la fiche d'une équipe annonçait
     * « 48-22-8 » pour une saison où elle n'a pas joué une minute, sans que
     * rien à l'écran ne dise de quelle année il s'agissait. Le chiffre était
     * vrai, la phrase qu'il formait ne l'était pas.
     *
     * On compare donc le `seasonId` de la ligne à la saison en cours. S'il est
     * antérieur, l'équipe est traitée comme n'ayant pas encore joué : totaux à
     * zéro (c'est la vérité) et TAUX à `null` (« je ne sais pas »), exactement
     * l'état que les `??` en aval savent déjà rattraper — c'est le même
     * traitement que `gamesPlayed === 0`, et il est déjà éprouvé.
     *
     * `seasonId` absent d'une réponse : on ne conclut rien et on garde la ligne
     * telle quelle, plutôt que de vider toutes les fiches sur un champ manquant.
     */
    const rowSeason = s.seasonId != null ? String(s.seasonId) : null;
    const stale     = rowSeason != null && rowSeason < season;
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
    const gp     = stale ? 0 : (s.gamesPlayed ?? 0);
    const played = gp > 0;
    /** Un total de la saison écoulée n'est pas un total de la saison en cours. */
    const n = (v: unknown): number => (stale ? 0 : ((v as number) ?? 0));
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
      wins:         n(s.wins),
      losses:       n(s.losses),
      otLosses:     n(s.otLosses),
      points:       n(s.points),
      winPct:       played ? Math.round((s.winPctg ?? 0) * 100) : null,
      homeRecord:   `${n(s.homeWins)}-${n(s.homeLosses)}-${n(s.homeOtLosses)}`,
      awayRecord:   `${n(s.roadWins)}-${n(s.roadLosses)}-${n(s.roadOtLosses)}`,
      streak:       !stale && s.streakCode && s.streakCount ? `${s.streakCode}${s.streakCount}` : '',
      goalsFor:            n(s.goalFor),
      goalsAgainst:        n(s.goalAgainst),
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
      // `_splitPct` rend déjà 0.5 — « je ne sais pas » — sur zéro match joué.
      homeWinPct: _splitPct(n(s.homeWins), n(s.homeLosses), n(s.homeOtLosses)),
      roadWinPct: _splitPct(n(s.roadWins), n(s.roadLosses), n(s.roadOtLosses)),
      // Série signée : W3 → +3, L2 → -2
      streakSigned: stale ? 0 : (s.streakCode === 'W' ? 1 : -1) * (s.streakCount ?? 0),
      /** La saison à laquelle se rapporte cette fiche — l'écran peut la dater. */
      statsSeason: rowSeason ?? season,
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

// --- Matchs passés (recherche « Passé » de la page Stats › Tous les matchs) --
//
// Ce ne sont pas les résultats qu'on coupe, ce sont les CRITÈRES qui sont
// choisis pour qu'une recherche ramène en moyenne au plus ~25 matchs :
//   · toute la ligue → UN jour (une soirée NHL : 16 matchs au plus) ;
//   · une équipe    → UN mois (~12-16), ses séries (0-28, ~10 en moyenne), ou
//                     ses rencontres contre UN adversaire (3-4 par saison).
// Domicile/extérieur, victoire/défaite et la fin du match ne font que réduire.

/** Garde-fou serveur seulement — aucun critère légitime n'en approche. */
const PAST_SAFETY_CAP = 40;

export type PastScope = 'day' | 'month' | 'playoffs' | 'opp';

export interface PastGamesQuery {
  /** Id NHL à 8 chiffres, ex. `20252026`. */
  season:    string;
  scope:     PastScope;
  /** `day` : `YYYY-MM-DD`. */
  date?:     string;
  /** `month` / `playoffs` / `opp` : le club vu de qui on cherche. Possible aussi avec `day`. */
  team?:     string;
  /** `month` : `YYYY-MM`. */
  month?:    string;
  /** `opp` : l'adversaire. */
  opp?:      string;
  /** Vu de `team`. */
  venue?:    'home' | 'away';
  /** Vu de `team` : victoire ou défaite, toutes fins confondues. */
  result?:   'W' | 'L';
  /** Comment le match s'est terminé. */
  decision?: 'REG' | 'OT' | 'SO';
}

export interface PastGamesPage {
  season: string;
  games:  any[];
  /**
   * `day` seulement : la soirée NHL la plus proche avant / après ce jour (null
   * si aucune dans la semaine voisine). Les flèches ‹ › sautent les soirs sans
   * match au lieu d'afficher « aucun match » un jour sur trois.
   */
  prevDay?: string | null;
  nextDay?: string | null;
}

const FINAL_STATES = new Set(['OFF', 'FINAL', 'OVER']);

/** Le match brut (calendrier hebdo ou calendrier de club) passe-t-il les filtres ? */
function pastGameMatches(g: any, q: PastGamesQuery, date: string): boolean {
  if (!FINAL_STATES.has(String(g.gameState ?? ''))) return false;
  if (g.season != null && String(g.season) !== q.season) return false;
  const gt = Number(g.gameType);
  // Jour et mois : tout ce qui s'est joué (préparatoire comprise, en septembre).
  // Séries : séries seulement. Adversaire : saison + séries.
  if (q.scope === 'playoffs' && gt !== 3) return false;
  if (q.scope === 'opp' && gt !== 2 && gt !== 3) return false;
  if (gt !== 1 && gt !== 2 && gt !== 3) return false;   // matchs d'étoiles, 4 Nations…
  if (q.scope === 'day' && date !== q.date) return false;
  if (q.scope === 'month' && !date.startsWith(q.month ?? '')) return false;

  const lpt = String(g.gameOutcome?.lastPeriodType ?? 'REG').toUpperCase();
  if (q.decision && lpt !== q.decision) return false;

  if (q.team) {
    const home = String(g.homeTeam?.abbrev ?? '').toUpperCase();
    const away = String(g.awayTeam?.abbrev ?? '').toUpperCase();
    const t = q.team;
    if (home !== t && away !== t) return false;
    const isHome = home === t;
    if (q.scope === 'opp' && (isHome ? away : home) !== q.opp) return false;
    if (q.venue === 'home' && !isHome) return false;
    if (q.venue === 'away' && isHome) return false;
    if (q.result) {
      const hs = Number(g.homeTeam?.score), as = Number(g.awayTeam?.score);
      if (!Number.isFinite(hs) || !Number.isFinite(as)) return false;
      if ((q.result === 'W') !== (isHome ? hs > as : as > hs)) return false;
    }
  }
  return true;
}

function formatPastGame(g: any, date: string): any {
  const gt = Number(g.gameType);
  return {
    ...formatGame(g, date),
    gameType: gt === 3 ? 'playoff' : gt === 1 ? 'preseason' : 'regular',
    lastPeriodType: String(g.gameOutcome?.lastPeriodType ?? 'REG').toUpperCase(),
  };
}

/**
 * Les journées du calendrier NHL entre deux dates incluses, chacune une fois.
 * `fetchScheduleWeek(c)` rend une semaine qui CONTIENT `c` — pas forcément qui
 * commence à `c` (une semaine en cache peut finir ce jour-là) : on avance donc
 * après la dernière date reçue, comme `fetchGamesRange`, sans trou.
 */
async function scheduleDays(start: string, end: string): Promise<any[]> {
  const byDate = new Map<string, any>();
  let c = start;
  for (let guard = 0; guard < 20 && c <= end; guard++) {
    const week = await fetchScheduleWeek(c);
    let maxDate = c;
    for (const d of week) {
      const dd = String(d.date);
      if (dd > maxDate) maxDate = dd;
      if (dd >= start && dd <= end && !byDate.has(dd)) byDate.set(dd, d);
    }
    const stepped = addDays(maxDate, 1);
    c = stepped > c ? stepped : addDays(c, 1);
  }
  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/** Plus récent d'abord ; à date égale, l'id le plus grand d'abord. */
function byNewest(a: any, b: any): number {
  return a.gameDate === b.gameDate ? Number(b.id) - Number(a.id) : b.gameDate.localeCompare(a.gameDate);
}

/**
 * Matchs JOUÉS correspondant aux critères, du plus récent au plus ancien.
 *
 *   · `day`  : la semaine NHL qui contient ce jour (en cache), filtrée au jour.
 *   · sinon  : UN appel au calendrier du club (`club-schedule-season`), filtré.
 */
export async function fetchPastGames(q: PastGamesQuery): Promise<PastGamesPage> {
  if (USE_MOCK) {
    const games = (MOCK_GAMES_FULL as any[])
      .filter((g) => g.status === 'final' && (!q.team || g.homeTeam.abbreviation === q.team || g.awayTeam.abbreviation === q.team))
      .sort(byNewest)
      .slice(0, PAST_SAFETY_CAP);
    return { season: q.season, games };
  }

  let rows: Array<{ g: any; date: string }> = [];
  let prevDay: string | null = null, nextDay: string | null = null;
  if (q.scope === 'day') {
    const date = q.date!;
    // Une semaine de part et d'autre du jour, pour trouver les soirées
    // voisines. Les semaines sont en cache dix minutes.
    const days = await scheduleDays(addDays(date, -7), addDays(date, 7));
    const day = days.find((d: any) => String(d.date) === date);
    rows = (day?.games ?? []).map((g: any) => ({ g, date }));
    const played = (d: any) => (d.games ?? []).some((g: any) => String(g.season) === q.season);
    for (const d of days) {
      const dd = String(d.date);
      if (!played(d)) continue;
      if (dd < date && (!prevDay || dd > prevDay)) prevDay = dd;
      if (dd > date && (!nextDay || dd < nextDay)) nextDay = dd;
    }
  } else {
    const key = `club_sched:${q.team}:${q.season}`;
    let raw = getCached<any[]>(key);
    if (!raw) {
      try {
        const data = await fetchNHL<any>(`v1/club-schedule-season/${q.team}/${q.season}`);
        raw = (data?.games ?? []) as any[];
      } catch (err: any) {
        // Club absent de cette saison (franchise relocalisée, expansion) : vide.
        if (err?.status !== 404) throw err;
        raw = [];
      }
      setCached(key, raw, q.season < currentSeason() ? 6 * 60 * 60_000 : 10 * 60_000);
    }
    rows = raw.map((g) => ({ g, date: String(g.gameDate ?? g.startTimeUTC?.slice(0, 10) ?? '') }));
  }

  const games = rows
    .filter(({ g, date }) => pastGameMatches(g, q, date))
    .map(({ g, date }) => formatPastGame(g, date))
    .sort(byNewest)
    .slice(0, PAST_SAFETY_CAP);
  return q.scope === 'day' ? { season: q.season, games, prevDay, nextDay } : { season: q.season, games };
}

export async function fetchLiveGames(): Promise<any[]> {
  if (USE_MOCK) return (MOCK_GAMES_FULL as any[]).filter((g) => g.status === 'live');
  const cached = getCached<any[]>('live');
  if (cached) return cached;

  // ⚠️ 2026-09-29 : on lisait `v1/scoreboard/now`, dont les matchs sont rangés
  // sous `gamesByDate[].games` — `data.games` n'y existe PAS, donc la liste
  // était TOUJOURS vide et la section « En direct » de l'accueil n'a jamais
  // rien montré (constaté le soir de l'ouverture : FLA-CAR et MTL-TOR en
  // direct, accueil vide). `v1/score/now` a bien un `games` au premier niveau,
  // avec la période et l'horloge de chaque match. Les deux formes sont lues,
  // pour qu'un changement de l'API ne vide plus la section en silence.
  const data  = await fetchNHL<any>('v1/score/now');
  const all: any[] = Array.isArray(data.games)
    ? data.games
    : (data.gamesByDate ?? []).flatMap((d: any) => d.games ?? []);
  const games = all
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
      // Identifiant NHL du buteur : c'est lui qui tranche « premier buteur »
      // pendant le match (le nom seul ne se compare pas sûrement à l'effectif).
      playerId: g?.playerId != null ? String(g.playerId) : null,
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
    // Situation EN COURS (avantage numérique, gardien retiré) : `situationCode`
    // = gardien visiteur, patineurs visiteur, patineurs domicile, gardien
    // domicile (« 1451 » = avantage domicile à 5 contre 4). Absente hors direct.
    situation: L.situation
      ? { code: String(L.situation.situationCode ?? ''), secondsRemaining: Number(L.situation.secondsRemaining ?? NaN) }
      : null,
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
