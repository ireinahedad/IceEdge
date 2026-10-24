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

// ── Session B : semaine, classement, choix du modèle, annonce ────────────────

/** Minimum de picks RÉGLÉS dans la semaine pour être classé. */
export const PICKEM_MIN_WEEK_PICKS = 10;

const etDay = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const etHour = (ms: number) =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms)));
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Minuit à New York ce jour-là, en ms UTC (04:00 UTC l'été, 05:00 l'hiver). */
export function etMidnightUtc(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  for (const off of [4, 5]) {
    const t = Date.UTC(y, m - 1, d, off);
    if (etDay(t) === day && etHour(t) === 0) return t;
  }
  return Date.UTC(y, m - 1, d, 5);
}

export interface WeekBounds { start: number; end: number; monday: string; sunday: string }

/**
 * Semaine lundi → dimanche, heure de l'Est (`offset` : 0 = en cours, −1 = la
 * précédente). Un vote compte dans la semaine de la mise au jeu PRÉVUE.
 */
export function weekBoundsET(now: number, offset = 0): WeekBounds {
  const today = etDay(now);
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 = dimanche
  const monday = addDays(today, -((dow + 6) % 7) + 7 * offset);
  const nextMonday = addDays(monday, 7);
  return { start: etMidnightUtc(monday), end: etMidnightUtc(nextMonday), monday, sunday: addDays(monday, 6) };
}

/** Le choix du modèle à partir de sa probabilité de victoire du DOMICILE (0–100). Égalité → domicile. */
export function modelPick(homePct: number, home: string, away: string): string {
  return homePct >= 50 ? home : away;
}

export interface WeekRow {
  userId: string; username: string; displayName: string | null;
  avatar: string | null; avatarUrl: string | null;
  picks: number; wins: number;
}
export interface RankedRow extends WeekRow { rank: number; pct: number }

/**
 * Classés : au moins `minPicks` picks réglés. Tri : taux exact, puis victoires,
 * puis picks, puis nom (stable). Même taux, mêmes victoires et mêmes picks =
 * même rang.
 */
export function rankWeek(rows: WeekRow[], minPicks = PICKEM_MIN_WEEK_PICKS): RankedRow[] {
  const eligible = rows.filter((r) => r.picks >= minPicks && r.picks > 0)
    .sort((a, b) => (b.wins / b.picks - a.wins / a.picks) || (b.wins - a.wins) || (b.picks - a.picks)
      || a.username.localeCompare(b.username));
  const out: RankedRow[] = [];
  eligible.forEach((r, i) => {
    const prev = out[i - 1];
    const tied = prev && prev.wins === r.wins && prev.picks === r.picks;
    out.push({ ...r, rank: tied ? prev.rank : i + 1, pct: Math.round((r.wins / r.picks) * 100) });
  });
  return out;
}

// ── Session C : rappel « votes fermés dans 1 h » ──────────────────────────────

/**
 * Le rappel part au tour de NewsSync qui ouvre la fenêtre des matchs (1re mise
 * au jeu − 1 h). Les tours sont aux 15 min : on accepte [−65 min, −30 min) pour
 * ne pas le rater sur un tour un peu décalé, et jamais plus d'une fois par jour.
 */
export const REMINDER_FROM_MS = 65 * 60_000;
export const REMINDER_UNTIL_MS = 30 * 60_000;

export function reminderDue(now: number, firstStartMs: number | null, lastDay: string | null): { due: boolean; day: string } {
  const day = etDay(now);
  if (firstStartMs == null || !Number.isFinite(firstStartMs) || lastDay === day) return { due: false, day };
  const until = firstStartMs - now;
  return { due: until <= REMINDER_FROM_MS && until > REMINDER_UNTIL_MS, day };
}

/** Texte du rappel, dans les deux langues (vouvoiement en français). */
export function reminderPayload(first: { away: string; home: string }, games: number): {
  fr: { title: string; body: string; url: string }; en: { title: string; body: string; url: string };
} {
  const m = `${first.away} @ ${first.home}`;
  const more = games > 1;
  return {
    fr: {
      title: "Pick'em : votes fermés dans 1 h",
      body: more ? `${m} ouvre la soirée (${games} matchs). Faites vos choix avant la mise au jeu.`
                 : `${m} commence dans 1 h. Faites votre choix avant la mise au jeu.`,
      url: '/league',
    },
    en: {
      title: "Pick'em: picks lock in 1 h",
      body: more ? `${m} opens the night (${games} games). Make your picks before puck drop.`
                 : `${m} starts in 1 h. Make your pick before puck drop.`,
      url: '/league',
    },
  };
}
