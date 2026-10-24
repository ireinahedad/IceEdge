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

/** Annonce du lundi est-elle due ? Lundi (ET), à partir de 10 h, une fois par semaine. */
export function announceDue(now: number, lastAnnouncedMonday: string | null): { due: boolean; week: WeekBounds } {
  const week = weekBoundsET(now, -1);
  const isMonday = new Date(`${etDay(now)}T12:00:00Z`).getUTCDay() === 1;
  return { due: isMonday && etHour(now) >= 10 && lastAnnouncedMonday !== week.monday, week };
}

const shortDate = (day: string, fr: boolean) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(fr ? 'fr-CA' : 'en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Texte du message (bilingue : les salons mêlent les deux langues). `null` = personne de classé. */
export function announceText(
  week: WeekBounds, ranked: RankedRow[], model: { games: number; wins: number },
): string | null {
  const top = ranked.filter((r) => r.rank === 1).slice(0, 3);
  if (top.length === 0) return null;
  const who = top.map((r) => `@${r.username}`).join(', ');
  const score = `${top[0].wins}/${top[0].picks} (${top[0].pct} %)`;
  const mPct = model.games > 0 ? Math.round((model.wins / model.games) * 100) : null;
  const fr = `🏆 Pick'em de la semaine du ${shortDate(week.monday, true)} au ${shortDate(week.sunday, true)} : ${who} — ${score}.`
    + (mPct != null ? ` Le modèle ICEEDGE : ${model.wins}/${model.games} (${mPct} %) sur les mêmes matchs.` : '');
  const en = `🏆 Pick'em of the week (${shortDate(week.monday, false)}–${shortDate(week.sunday, false)}): ${who} — ${score}.`
    + (mPct != null ? ` ICEEDGE model: ${model.wins}/${model.games} (${mPct}%) on the same games.` : '');
  return `${fr}\n${en}`;
}
