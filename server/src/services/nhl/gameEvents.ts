/**
 * nhl/gameEvents.ts — feuille de match, buts marqués et mises au jeu d'un match
 * terminé (utilisés pour régler les paris). Point d'entrée public : `../nhlApiClient.ts`.
 */

import { USE_MOCK, fetchNHL, getCached, parseToiMinutes, setCached } from './core';

// --- Boxscore (per-player final stats, used for player-prop settlement) ---

export interface BoxscorePlayerStats {
  playerId:      string;
  goals:         number;
  assists:       number;
  points:        number;
  shots:         number;
  hits:          number;
  blockedShots:  number;
  pim:           number;
  /** Minutes on ice (decimal), parsed from the "MM:SS" boxscore string. */
  toi:           number;
  /** Goalie only — undefined for skaters. */
  saves?:        number;
  shotsAgainst?: number;
  goalsAgainst?: number;
  decision?:     string; // 'W' | 'L' | 'O'
}

function numOrUndefined(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Parses NHL's "27/30" saves/shots-against string into { saves, shotsAgainst }. */
function parseSavesString(s: unknown): { saves?: number; shotsAgainst?: number } {
  if (typeof s !== 'string' || !s.includes('/')) return {};
  const [a, b] = s.split('/').map((x) => Number(x.trim()));
  return { saves: Number.isFinite(a) ? a : undefined, shotsAgainst: Number.isFinite(b) ? b : undefined };
}

function normalizeSkater(p: any): BoxscorePlayerStats {
  const goals   = numOrUndefined(p.goals)   ?? 0;
  const assists = numOrUndefined(p.assists) ?? 0;
  return {
    playerId:     String(p.playerId ?? p.id),
    goals,
    assists,
    points:       numOrUndefined(p.points) ?? (goals + assists),
    shots:        numOrUndefined(p.sog ?? p.shots ?? p.shotsOnGoal) ?? 0,
    hits:         numOrUndefined(p.hits) ?? 0,
    blockedShots: numOrUndefined(p.blockedShots ?? p.blockedShotsAgainst) ?? 0,
    pim:          numOrUndefined(p.pim ?? p.penaltyMinutes) ?? 0,
    toi:          parseToiMinutes(p.toi),
  };
}

function normalizeGoalie(p: any): BoxscorePlayerStats {
  const parsed = parseSavesString(p.saveShotsAgainst);
  return {
    playerId:     String(p.playerId ?? p.id),
    goals:        numOrUndefined(p.goals)   ?? 0,
    assists:      numOrUndefined(p.assists) ?? 0,
    points:       numOrUndefined(p.points)  ?? 0,
    shots:        0,
    hits:         0,
    blockedShots: 0,
    pim:          numOrUndefined(p.pim ?? p.penaltyMinutes) ?? 0,
    toi:          parseToiMinutes(p.toi),
    saves:        numOrUndefined(p.saves) ?? parsed.saves,
    shotsAgainst: numOrUndefined(p.shotsAgainst) ?? parsed.shotsAgainst,
    goalsAgainst: numOrUndefined(p.goalsAgainst),
    decision:     typeof p.decision === 'string' ? p.decision : undefined,
  };
}

/**
 * L'état d'un match tel que l'annonce le boxscore lui-même.
 *
 * Même table que `parseGameState` dans `teamsAndGames.ts` — dupliquée plutôt
 * qu'importée pour ne pas faire dépendre ce module de celui-là pour six lignes
 * (les deux sont des feuilles du même dossier, et `teamsAndGames` est le plus
 * lourd des deux).
 */
function boxscoreState(raw: unknown): 'scheduled' | 'live' | 'final' {
  const MAP: Record<string, 'scheduled' | 'live' | 'final'> = {
    FUT: 'scheduled', PRE: 'scheduled',
    LIVE: 'live',     CRIT: 'live',
    FINAL: 'final',   OVER: 'final', OFF: 'final',
  };
  return MAP[String(raw ?? '')] ?? 'scheduled';
}

/**
 * Feuille de match d'une partie : playerId → statistiques, les deux formations
 * réunies. `null` quand le boxscore ne peut être ni récupéré ni lu — les
 * appelants doivent le traiter comme « on ne sait pas encore », JAMAIS comme
 * des statistiques à zéro.
 *
 * ── Le cache dépend de l'état du match ──────────────────────────────────────
 *
 * Il était de 6 heures, sans condition, sous le commentaire « Final boxscores
 * never change ». C'était vrai de l'unique appelant de l'époque — le règlement
 * des paris, qui ne lit un match qu'une fois terminé — et faux de l'endpoint :
 * `v1/gamecenter/:id/boxscore` se met à jour PENDANT la partie. La première
 * lecture d'un match en cours gelait donc ses chiffres pour six heures, c'est-
 * à-dire pour tout le match et une bonne partie de la soirée.
 *
 * Trois régimes, alignés sur ceux que `nhlApiClient` applique déjà ailleurs :
 *
 *   • `final`     → 6 h. Un match terminé ne change effectivement plus.
 *   • `live`      → 30 s. Les grilles de paris joueur affichent ces compteurs
 *                   en direct ; au-delà d'une demi-minute, l'écran ment.
 *   • `scheduled` → AUCUN cache. Le boxscore d'un match à venir est une coquille
 *                   vide ; la mettre en cache ferait démarrer le match avec des
 *                   zéros figés, et 30 s de retard sur le premier but.
 */
export interface GameBoxscore {
  state: 'scheduled' | 'live' | 'final';
  players: Map<string, BoxscorePlayerStats>;
}

export async function fetchGameBoxscoreFull(gameId: string): Promise<GameBoxscore | null> {
  if (USE_MOCK) return null; // no boxscore data in mock mode — player props stay pending

  const cacheKey = `box:${gameId}`;
  const cached = getCached<GameBoxscore>(cacheKey);
  if (cached) return cached;

  let data: any;
  try {
    data = await fetchNHL<any>(`v1/gamecenter/${gameId}/boxscore`);
  } catch {
    return null;
  }

  const stats = data?.playerByGameStats;
  if (!stats) return null;

  const players = new Map<string, BoxscorePlayerStats>();
  try {
    for (const side of [stats.awayTeam, stats.homeTeam]) {
      if (!side) continue;
      for (const p of [...(side.forwards ?? []), ...(side.defense ?? [])]) {
        const s = normalizeSkater(p);
        players.set(s.playerId, s);
      }
      for (const p of side.goalies ?? []) {
        const s = normalizeGoalie(p);
        players.set(s.playerId, s);
      }
    }
  } catch {
    return null; // unexpected shape → don't guess, let settlement stay pending
  }

  if (players.size === 0) return null;

  const out: GameBoxscore = { state: boxscoreState(data.gameState), players };
  if (out.state === 'final')     setCached(cacheKey, out, 6 * 60 * 60_000);
  else if (out.state === 'live') setCached(cacheKey, out, 30_000);
  // `scheduled` : rien en cache — voir l'en-tête ci-dessus.

  return out;
}

/**
 * La feuille seule — signature d'origine, conservée pour le règlement des
 * paris, qui n'a que faire de l'état (il ne lit que des matchs terminés).
 */
export async function fetchGameBoxscore(gameId: string): Promise<Map<string, BoxscorePlayerStats> | null> {
  const full = await fetchGameBoxscoreFull(gameId);
  return full?.players ?? null;
}

// --- Scoring plays (goal order + strength state, used for first/last goal
// scorer and power-play point settlement) -----------------------------------

export interface ScoringGoal {
  playerId:        string;
  assistPlayerIds: string[];
  /** 'ev' | 'pp' | 'sh' — power-play/shorthanded/even-strength. */
  strength:        string;
  /** True if the home team scored this goal. */
  isHome:          boolean;
  periodNumber:    number;
  periodType:      string; // 'REG' | 'OT' | 'SO'
  /** Seconds elapsed within the period — used to order goals within a period. */
  elapsedSeconds:  number;
}

function parseTimeToSeconds(s: unknown): number {
  if (typeof s !== 'string' || !s.includes(':')) return 0;
  const [m, sec] = s.split(':').map((x) => Number(x.trim()));
  if (!Number.isFinite(m) || !Number.isFinite(sec)) return 0;
  return m * 60 + sec;
}

/**
 * Fetches the final game's scoring summary (goal-by-goal, in chronological
 * order, with strength state) via the landing endpoint. Returns null if it
 * can't be fetched or parsed — callers must treat that as "can't settle yet".
 * Shootout goals are excluded (they aren't "goals" for scorer/PP props).
 */
export async function fetchGameScoringPlays(gameId: string): Promise<ScoringGoal[] | null> {
  if (USE_MOCK) return null; // no scoring-play data in mock mode

  const cacheKey = `scoring:${gameId}`;
  const cached = getCached<ScoringGoal[]>(cacheKey);
  if (cached) return cached;

  let data: any;
  try {
    data = await fetchNHL<any>(`v1/gamecenter/${gameId}/landing`);
  } catch {
    return null;
  }

  const periods = data?.summary?.scoring;
  if (!Array.isArray(periods)) return null;

  const out: ScoringGoal[] = [];
  try {
    for (const period of periods) {
      const periodType = String(period?.periodDescriptor?.periodType ?? '');
      if (periodType === 'SO') continue; // shootout attempts aren't "goals"
      const periodNumber = Number(period?.periodDescriptor?.number ?? 0);
      for (const g of period?.goals ?? []) {
        if (g?.playerId == null) continue;
        if (typeof g.isHome !== 'boolean') throw new Error('unexpected goal shape'); // caught below → null
        out.push({
          playerId:        String(g.playerId),
          assistPlayerIds: (g.assists ?? []).map((a: any) => String(a.playerId)).filter(Boolean),
          strength:        String(g.strength ?? 'ev').toLowerCase(),
          isHome:          g.isHome,
          periodNumber,
          periodType,
          elapsedSeconds:  parseTimeToSeconds(g.timeInPeriod),
        });
      }
    }
  } catch {
    return null; // unexpected shape → don't guess, let settlement stay pending
  }

  // Chronological order: by period, then by elapsed time within the period.
  out.sort((a, b) => a.periodNumber - b.periodNumber || a.elapsedSeconds - b.elapsedSeconds);

  // Final games' scoring never changes — cache for a long time.
  setCached(cacheKey, out, 6 * 60 * 60_000);
  return out;
}

// --- Faceoff wins (play-by-play) --------------------------------------------
// The boxscore only exposes a faceoff *percentage* per player, not a raw win
// count, so "Over/Under N faceoff wins" can't be settled from it. The full
// play-by-play feed lists every individual faceoff event with a winner, so we
// tally those instead. This is a heavier fetch than the boxscore (the full
// event log for the game), which is exactly why this market was left for
// later rather than shipped with the others.

/**
 * Fetches the final game's play-by-play log and tallies faceoff wins per
 * player. Returns null if it can't be fetched or parsed.
 */
export async function fetchGameFaceoffWins(gameId: string): Promise<Map<string, number> | null> {
  if (USE_MOCK) return null; // no play-by-play data in mock mode

  const cacheKey = `faceoffs:${gameId}`;
  const cached = getCached<Map<string, number>>(cacheKey);
  if (cached) return cached;

  let data: any;
  try {
    data = await fetchNHL<any>(`v1/gamecenter/${gameId}/play-by-play`);
  } catch {
    return null;
  }

  const plays = data?.plays;
  if (!Array.isArray(plays)) return null;

  const out = new Map<string, number>();
  try {
    for (const play of plays) {
      if (play?.typeDescKey !== 'faceoff') continue;
      const winnerId = play?.details?.winningPlayerId;
      if (winnerId == null) continue;
      const key = String(winnerId);
      out.set(key, (out.get(key) ?? 0) + 1);
    }
  } catch {
    return null; // unexpected shape → don't guess, let settlement stay pending
  }

  // Final games' play-by-play never changes — cache for a long time.
  setCached(cacheKey, out, 6 * 60 * 60_000);
  return out;
}
