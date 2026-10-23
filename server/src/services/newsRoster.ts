/**
 * newsRoster.ts — la partie PURE de F4 (NEWS_CONSENSUS_PLAN.md, étape 3) :
 * les transactions déduites en comparant les effectifs LNH d'un jour à l'autre.
 *
 * Remplace le canal #league-transactions (bot PuckPedia) sans source payante :
 * `v1/roster/{équipe}/current` est l'API LNH déjà utilisée partout ailleurs.
 * `newsRoster.service.ts` ne fait que les appels et l'écriture.
 *
 * ── Ce qu'un écart d'effectif veut dire ─────────────────────────────────────
 * Un joueur qui apparaît ou disparaît de l'effectif LNH : échange, rappel,
 * renvoi dans la Ligue américaine, ballottage, signature. L'API ne dit pas
 * LEQUEL — l'extrait reste donc factuel (« ajouté », « retiré », « passe de
 * TOR à VGK ») et le lien mène à la fiche du joueur sur nhl.com.
 *
 * ── Les deux pièges écartés ici ─────────────────────────────────────────────
 * • Pas d'effectif de la veille (1er tour, nouvelle équipe) : on enregistre la
 *   base, on n'annonce rien. Sinon 32 effectifs entiers deviendraient 800 « ajouts ».
 * • Effectif vide ou bascule de saison (`current` qui change de saison) : un
 *   écart énorme n'est pas une soirée de transactions. Au-delà de
 *   `MAX_CHANGES_PER_TEAM`, l'équipe est rebasée sans nouvelle.
 */

export interface RosterPlayer {
  id: number;
  name: string;
  /** C, L, R, D, G (positionCode LNH). */
  pos: string;
  num: number | null;
}

export type RosterEventKind = 'added' | 'removed' | 'moved';

export interface RosterEvent {
  kind: RosterEventKind;
  player: RosterPlayer;
  /** added/removed : [équipe]. moved : [arrivée, départ] — l'arrivée d'abord. */
  teams: string[];
}

/** Une soirée réelle dépasse rarement 3-4 mouvements par équipe ; 8 laisse de la marge. */
export const MAX_CHANGES_PER_TEAM = 8;

/** Heure (ET) à partir de laquelle le tour quotidien est dû. */
export const ROSTER_HOUR_ET = 12;

export const ROSTER_AUTHOR = 'NHL.com';

// ── Lecture d'une réponse `v1/roster` ──────────────────────────────────────

/** Effectif LNH → joueurs. Une entrée sans id est ignorée, pas fatale. */
export function parseRoster(json: unknown): RosterPlayer[] {
  const d = json as any;
  const all = [...(d?.forwards ?? []), ...(d?.defensemen ?? []), ...(d?.goalies ?? [])];
  const out: RosterPlayer[] = [];
  const seen = new Set<number>();
  for (const p of all) {
    const id = Number(p?.id);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    const name = [p?.firstName?.default, p?.lastName?.default].filter((s) => typeof s === 'string' && s).join(' ');
    const num = Number(p?.sweaterNumber);
    out.push({
      id,
      name: name || `#${id}`,
      pos: typeof p?.positionCode === 'string' ? p.positionCode : '',
      num: Number.isInteger(num) && num > 0 ? num : null,
    });
  }
  return out;
}

// ── État de la veille (job_state, une clé par équipe) ──────────────────────

export const stateKey = (abbr: string) => `news-roster:${abbr}`;
export const DAY_KEY = 'news-roster:day';

export function encodeRoster(players: RosterPlayer[]): string {
  return JSON.stringify([...players].sort((a, b) => a.id - b.id));
}

/** Valeur illisible → `null` (traitée comme « pas de veille » : rebase sans nouvelle). */
export function decodeRoster(raw: string | null | undefined): RosterPlayer[] | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    return arr.filter((p) => p && Number.isInteger(p.id));
  } catch {
    return null;
  }
}

// ── Comparaison ────────────────────────────────────────────────────────────

export interface RosterDiff {
  events: RosterEvent[];
  /** Équipes rebasées sans nouvelle (écart trop grand). */
  rebased: string[];
  /** Équipes vues pour la 1re fois (pas de veille). */
  baseline: string[];
}

/**
 * `prev` : effectifs de la veille ; `cur` : ceux lus aujourd'hui, SEULEMENT
 * pour les équipes lues avec succès et non vides (une équipe absente de `cur`
 * n'est pas comparée, et sa veille est conservée par l'appelant).
 *
 * Un joueur retiré de A et ajouté à B le même jour devient UNE nouvelle
 * « moved », rattachée aux deux équipes.
 */
export function diffRosters(
  prev: Map<string, RosterPlayer[]>,
  cur: Map<string, RosterPlayer[]>,
  maxPerTeam = MAX_CHANGES_PER_TEAM,
): RosterDiff {
  const added: Array<{ team: string; p: RosterPlayer }> = [];
  const removed: Array<{ team: string; p: RosterPlayer }> = [];
  const rebased: string[] = [];
  const baseline: string[] = [];

  for (const team of [...cur.keys()].sort()) {
    const now = cur.get(team)!;
    const before = prev.get(team);
    if (!before) { baseline.push(team); continue; }
    const beforeIds = new Set(before.map((p) => p.id));
    const nowIds = new Set(now.map((p) => p.id));
    const a = now.filter((p) => !beforeIds.has(p.id));
    const r = before.filter((p) => !nowIds.has(p.id));
    if (a.length + r.length > maxPerTeam) { rebased.push(team); continue; }
    for (const p of a) added.push({ team, p });
    for (const p of r) removed.push({ team, p });
  }

  const events: RosterEvent[] = [];
  const movedIds = new Set<number>();
  for (const { team, p } of added) {
    const from = removed.find((x) => x.p.id === p.id);
    if (from) {
      movedIds.add(p.id);
      events.push({ kind: 'moved', player: p, teams: [team, from.team] });
    } else {
      events.push({ kind: 'added', player: p, teams: [team] });
    }
  }
  for (const { team, p } of removed) {
    if (!movedIds.has(p.id)) events.push({ kind: 'removed', player: p, teams: [team] });
  }
  return { events, rebased, baseline };
}

// ── Ligne `news_items` ─────────────────────────────────────────────────────

const label = (p: RosterPlayer) => {
  const bits = [p.pos, p.num != null ? `#${p.num}` : ''].filter(Boolean).join(', ');
  return bits ? `${p.name} (${bits})` : p.name;
};

/** Même langue que le reste du fil (publications d'équipes et de journalistes). */
export function excerptFor(e: RosterEvent): string {
  switch (e.kind) {
    case 'moved':   return `Roster move: ${label(e.player)} leaves ${e.teams[1]} for ${e.teams[0]}.`;
    case 'added':   return `Roster move: ${label(e.player)} added to the ${e.teams[0]} roster.`;
    case 'removed': return `Roster move: ${label(e.player)} removed from the ${e.teams[0]} roster.`;
  }
}

export const playerUrl = (id: number) => `https://www.nhl.com/player/${id}`;

/**
 * Identité de la nouvelle : le jour (ET) en fait partie, pour qu'un joueur
 * renvoyé puis rappelé dans la même quinzaine donne deux nouvelles.
 */
export function externalIdFor(e: RosterEvent, dayET: string): string {
  return `${dayET}:${e.kind}:${e.player.id}:${e.teams.join('-')}`;
}

// ── Échéance quotidienne ───────────────────────────────────────────────────

/** Jour (AAAA-MM-JJ) et heure (0-23) à New York. */
export function etParts(now: number): { day: string; hour: number } {
  const d = new Date(now);
  const day = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(d));
  return { day, hour };
}

/** Dû : il est au moins midi (ET) et le tour d'aujourd'hui n'est pas encore fait. */
export function rosterDue(now: number, lastDay: string | null): boolean {
  const { day, hour } = etParts(now);
  return hour >= ROSTER_HOUR_ET && lastDay !== day;
}
