/**
 * pickem.ts — la partie PURE du pick'em ICEEDGE (NEWS_CONSENSUS_PLAN.md, F3,
 * étape 5 session A) : quand le vote se ferme, et ce que la page affiche.
 * `pickem.service.ts` fait les appels.
 */

/** Sous ce nombre de votants, pas de pourcentage : « Pas encore assez de votes ». */
export const PICKEM_MIN_VOTES = 10;

/** Ce qu'il faut savoir du match pour un vote. */
export interface PickemGame {
  home: string;
  away: string;
  /** Heure PRÉVUE de la mise au jeu, ms UTC ; NaN si inconnue. */
  startMs: number;
  status: string;
}

/**
 * Vote fermé : statut live / final, ou heure PRÉVUE atteinte (même règle que
 * `gameHasStarted` des coupons). Heure inconnue → fermé : un vote accepté
 * après la mise au jeu fausserait le classement, un vote refusé ne coûte qu'un
 * « réessayez ».
 */
export function pickemLocked(g: PickemGame, now: number): boolean {
  const s = g.status.toLowerCase();
  if (s === 'live' || s === 'final') return true;
  return !Number.isFinite(g.startMs) || g.startMs <= now;
}

export interface PickemSide { team: string; votes: number; pct: number | null }

export interface PickemState {
  gameId: string;
  home: PickemSide;
  away: PickemSide;
  total: number;
  /** Faux sous `PICKEM_MIN_VOTES` : les `pct` sont alors `null`. */
  enough: boolean;
  minVotes: number;
  locked: boolean;
  /** ISO, ou null si inconnue. */
  startsAt: string | null;
  /** Équipe choisie par l'utilisateur connecté, sinon null. */
  myVote: string | null;
}

/**
 * Totaux → état affiché. Les votes pour une équipe qui n'est plus dans le match
 * (cas théorique : match réaffecté) sont ignorés, pas comptés ailleurs.
 * Les pourcentages sont arrondis et somment à 100.
 */
export function pickemState(
  gameId: string,
  g: PickemGame,
  counts: Record<string, number>,
  myVote: string | null,
  now: number,
  minVotes = PICKEM_MIN_VOTES,
): PickemState {
  const h = Math.max(0, counts[g.home] ?? 0);
  const a = Math.max(0, counts[g.away] ?? 0);
  const total = h + a;
  const enough = total >= minVotes;
  const hp = enough ? Math.round((h / total) * 100) : null;
  return {
    gameId,
    home: { team: g.home, votes: h, pct: hp },
    away: { team: g.away, votes: a, pct: hp == null ? null : 100 - hp },
    total,
    enough,
    minVotes,
    locked: pickemLocked(g, now),
    startsAt: Number.isFinite(g.startMs) ? new Date(g.startMs).toISOString() : null,
    myVote: myVote === g.home || myVote === g.away ? myVote : null,
  };
}

export const GAME_ID_RE = /^\d{6,12}$/;
export const TEAM_RE = /^[A-Z]{2,4}$/;
