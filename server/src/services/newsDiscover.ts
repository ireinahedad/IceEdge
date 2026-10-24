/**
 * newsDiscover.ts — la partie PURE de `npm run news:discover`
 * (NEWS_CONSENSUS_PLAN.md, étape 2).
 *
 * But : trouver 1 à 3 comptes Bluesky par équipe qui n'a pas de source dédiée,
 * au lieu de deviner des handles (9 échecs sur 12 le 2026-10-23). Le script
 * cherche des profils (`app.bsky.actor.searchActors`, public, sans clé), puis
 * passe chaque candidat au même contrôle que `news:check`. Rien n'est écrit :
 * la sortie est une liste à relire, et c'est le user qui valide chaque ajout.
 */

import { teamsInText, flagsOf } from './newsFeed';
import type { NewsSource } from '../data/newsSources';

/** Ville et surnom de chaque équipe, pour composer les recherches. */
export const TEAM_NAMES: Record<string, { city: string; nick: string }> = {
  ANA: { city: 'Anaheim', nick: 'Ducks' },        BOS: { city: 'Boston', nick: 'Bruins' },
  BUF: { city: 'Buffalo', nick: 'Sabres' },       CGY: { city: 'Calgary', nick: 'Flames' },
  CAR: { city: 'Carolina', nick: 'Hurricanes' },  CHI: { city: 'Chicago', nick: 'Blackhawks' },
  COL: { city: 'Colorado', nick: 'Avalanche' },   CBJ: { city: 'Columbus', nick: 'Blue Jackets' },
  DAL: { city: 'Dallas', nick: 'Stars' },         DET: { city: 'Detroit', nick: 'Red Wings' },
  EDM: { city: 'Edmonton', nick: 'Oilers' },      FLA: { city: 'Florida', nick: 'Panthers' },
  LAK: { city: 'Los Angeles', nick: 'Kings' },    MIN: { city: 'Minnesota', nick: 'Wild' },
  MTL: { city: 'Montreal', nick: 'Canadiens' },   NSH: { city: 'Nashville', nick: 'Predators' },
  NJD: { city: 'New Jersey', nick: 'Devils' },    NYI: { city: 'New York', nick: 'Islanders' },
  NYR: { city: 'New York', nick: 'Rangers' },     OTT: { city: 'Ottawa', nick: 'Senators' },
  PHI: { city: 'Philadelphia', nick: 'Flyers' },  PIT: { city: 'Pittsburgh', nick: 'Penguins' },
  SJS: { city: 'San Jose', nick: 'Sharks' },      SEA: { city: 'Seattle', nick: 'Kraken' },
  STL: { city: 'St. Louis', nick: 'Blues' },      TBL: { city: 'Tampa Bay', nick: 'Lightning' },
  TOR: { city: 'Toronto', nick: 'Maple Leafs' },  UTA: { city: 'Utah', nick: 'Mammoth' },
  VAN: { city: 'Vancouver', nick: 'Canucks' },    VGK: { city: 'Vegas', nick: 'Golden Knights' },
  WSH: { city: 'Washington', nick: 'Capitals' },  WPG: { city: 'Winnipeg', nick: 'Jets' },
};

/** Équipes sans source dédiée (ou celles demandées en argument, si valides). */
export function teamsToSearch(sources: NewsSource[], asked: string[] = []): string[] {
  const all = Object.keys(TEAM_NAMES);
  const wanted = asked.map((t) => t.toUpperCase()).filter((t) => all.includes(t));
  if (wanted.length > 0) return [...new Set(wanted)];
  const covered = new Set(sources.map((s) => s.team).filter(Boolean));
  return all.filter((t) => !covered.has(t)).sort();
}

/** Les recherches de profils pour une équipe. */
export function searchQueries(team: string): string[] {
  const { city, nick } = TEAM_NAMES[team];
  return [`${nick} beat writer`, `${nick} reporter`, `${city} hockey`, nick];
}

export interface Actor { handle: string; displayName?: string; description?: string }

/** `app.bsky.actor.searchActors` → profils. Entrée malformée ignorée. */
export function parseActors(json: unknown): Actor[] {
  const list = (json as any)?.actors;
  if (!Array.isArray(list)) return [];
  return list
    .filter((a: any) => typeof a?.handle === 'string' && a.handle !== 'handle.invalid')
    .map((a: any) => ({
      handle: a.handle,
      displayName: typeof a.displayName === 'string' ? a.displayName : undefined,
      description: typeof a.description === 'string' ? a.description : undefined,
    }));
}

/** Le profil parle-t-il de l'équipe, de sa ville ou de hockey ? (pré-tri avant de lire le fil) */
export function profileMatches(a: Actor, team: string): boolean {
  const { city, nick } = TEAM_NAMES[team];
  const text = `${a.displayName ?? ''} ${a.description ?? ''}`.toLowerCase();
  return [nick.toLowerCase(), city.toLowerCase(), 'hockey', 'nhl'].some((w) => text.includes(w))
    || teamsInText(`${a.displayName ?? ''} ${a.description ?? ''}`).includes(team);
}

export interface CandidateCheck {
  handle: string;
  label: string;
  team: string;
  /** Publications des 7 derniers jours. */
  active: number;
  /** Publications qui citent l'équipe. */
  teamPosts: number;
  /** Publications avec un drapeau gardien / alignement (ce que le fil cherche). */
  flagged: number;
  /** L'équipe la plus citée par le compte, et combien de fois. */
  top: [string, number] | null;
  profileMatch: boolean;
  verdict: 'ok' | 'inactif' | 'autre équipe' | 'cite peu l\'équipe';
  score: number;
}

/**
 * Même règles que `news:check`, plus une exigence : le compte doit citer
 * l'équipe au moins 2 fois en 7 jours (1 fois si son profil la nomme). Un
 * journaliste attitré écrit souvent « Eichel out tonight » sans nommer Vegas,
 * d'où la tolérance — mais un candidat inconnu doit faire ses preuves.
 */
export function checkCandidate(
  a: Actor, team: string, posts: Array<{ text: string; postedAt: Date }>, now: number,
): CandidateCheck {
  const recent = posts.filter((p) => now - p.postedAt.getTime() < 7 * 24 * 3600_000);
  const counts = new Map<string, number>();
  let teamPosts = 0, flagged = 0;
  for (const p of recent) {
    const cited = teamsInText(p.text);
    for (const t of cited) counts.set(t, (counts.get(t) ?? 0) + 1);
    if (cited.includes(team)) teamPosts++;
    if (flagsOf(p.text).some((f) => f === 'goalie' || f === 'lineup')) flagged++;
  }
  const top = [...counts.entries()].sort((x, y) => y[1] - x[1])[0] ?? null;
  const profileMatch = profileMatches(a, team);
  const wrongTeam = top !== null && top[0] !== team && top[1] >= 3 && (counts.get(team) ?? 0) * 2 < top[1];
  const verdict: CandidateCheck['verdict'] =
    recent.length < 3 ? 'inactif'
    : wrongTeam ? 'autre équipe'
    : teamPosts >= 2 || (profileMatch && teamPosts >= 1) ? 'ok'
    : 'cite peu l\'équipe';
  const score = Math.round((teamPosts * 2 + flagged * 3 + Math.min(recent.length, 20) * 0.2 + (profileMatch ? 2 : 0)) * 10) / 10;
  return {
    handle: a.handle, label: (a.displayName || a.handle).trim(), team,
    active: recent.length, teamPosts, flagged, top, profileMatch, verdict, score,
  };
}

/** Les meilleurs candidats « ok » d'une équipe, du plus fort au plus faible. */
export function bestCandidates(checks: CandidateCheck[], max = 3): CandidateCheck[] {
  return checks.filter((c) => c.verdict === 'ok').sort((a, b) => b.score - a.score).slice(0, max);
}

/** Ligne prête à coller dans `NEWS_SOURCES`. */
export function sourceLine(c: CandidateCheck): string {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `  { handle: '${esc(c.handle)}', team: '${c.team}', label: '${esc(c.label)}' },`;
}
