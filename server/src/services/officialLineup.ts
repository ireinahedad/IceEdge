// ============================================================
//  Alignement officiel du soir — API NHL, sans saisie
// ============================================================
// Mesuré en direct le 2026-10-01 (SEA–CGY, 1re soirée 2026-27, interrogé
// toutes les 45 s à 2,5 min) :
//
//   • T−2 h : `gamecenter/{id}/play-by-play → rosterSpots` passe de vide à
//     l'EFFECTIF de 23 joueurs par équipe — pas encore l'alignement ;
//   • T−30 min : `gamecenter/{id}/right-rail → gameInfo.scratches` commence à
//     publier les absents officiels, équipe par équipe et par morceaux
//     (CGY 2 à T−27, SEA 1 à T−25), et `rosterSpots` perd ces joueurs ;
//   • T−9 à T−7 min : les deux équipes tombent à 20 HABILLÉS (18 patineurs +
//     2 gardiens) — l'alignement définitif (SEA 20 + 3 absents, CGY 20 + 3).
//   • le gardien PARTANT n'y est jamais (les deux gardiens sont listés) : il
//     reste dans la saisie manuelle (`startingGoalies.ts`).
//
// Deux niveaux, donc :
//   • `scratches` — chaque absent publié compte tout de suite (T−30 min) ;
//   • `confirmed` — l'alignement est DÉFINITIF (20 habillés, ou match
//     commencé : feuille du `boxscore`, plus légère que le play-by-play d'un
//     match en cours). Seul un alignement confirmé est transmis au modèle et
//     peut faire revenir un blessé de longue durée.
//
// Ce module ne fait que LIRE. La fusion avec la saisie manuelle — qui reste
// prioritaire — est faite par `scratches.ts`.

import { fetchNHL, getCached, setCached, USE_MOCK } from './nhl/core';
import { easternToday } from './startingGoalies';

export interface LineupPlayer { id: number; name: string; pos: string }

export interface TeamLineup {
  gameId: number;
  abbr: string;
  /** Alignement définitif publié (sinon `dressed` est encore l'effectif). */
  confirmed: boolean;
  dressed: LineupPlayer[];
  scratches: LineupPlayer[];
}

/** Aucun alignement n'existe plus de ~2 h avant le match : inutile de demander avant. */
const LOOKAHEAD_MS = 3 * 60 * 60_000;
/** Alignement complet = 18 patineurs + 2 gardiens. Au-dessus : encore l'effectif. */
const DRESSED_MAX = 20;
const DRESSED_MIN = 18;
const STARTED = new Set(['LIVE', 'CRIT', 'FINAL', 'OFF']);

const fullName = (p: any): string =>
  [p?.firstName?.default, p?.lastName?.default].filter(Boolean).join(' ').trim()
  || String(p?.name?.default ?? '').trim();

function toPlayer(p: any): LineupPlayer | null {
  // `playerId` dans rosterSpots et la feuille de match, `id` dans les absents.
  const id = Number(p?.playerId ?? p?.id);
  if (!Number.isFinite(id)) return null;
  return { id, name: fullName(p), pos: String(p?.positionCode ?? p?.position ?? '') };
}

/** Lineup d'un match, ou `null` si rien d'exploitable. Ne lève jamais. */
export async function fetchGameLineup(
  gameId: number, state: string, homeAbbr: string, awayAbbr: string,
): Promise<{ home: TeamLineup; away: TeamLineup } | null> {
  const key = `official_lineup:${gameId}`;
  const hit = getCached<{ home: TeamLineup; away: TeamLineup }>(key);
  if (hit) return hit;

  try {
    const started = STARTED.has(state);
    const [main, rail] = await Promise.all([
      fetchNHL<any>(`v1/gamecenter/${gameId}/${started ? 'boxscore' : 'play-by-play'}`),
      fetchNHL<any>(`v1/gamecenter/${gameId}/right-rail`).catch(() => null),
    ]);
    const ids: Record<'home' | 'away', number> = {
      home: Number(main?.homeTeam?.id), away: Number(main?.awayTeam?.id),
    };
    const build = (side: 'home' | 'away', abbr: string): TeamLineup => {
      let dressed: LineupPlayer[];
      if (started) {
        const t = main?.playerByGameStats?.[`${side}Team`] ?? {};
        dressed = [...(t.forwards ?? []), ...(t.defense ?? []), ...(t.goalies ?? [])]
          .map(toPlayer).filter((p): p is LineupPlayer => !!p);
      } else {
        dressed = (main?.rosterSpots ?? [])
          .filter((r: any) => Number(r?.teamId) === ids[side])
          .map(toPlayer).filter((p: LineupPlayer | null): p is LineupPlayer => !!p);
      }
      const scratches = ((rail?.gameInfo?.[`${side}Team`]?.scratches) ?? [])
        .map(toPlayer).filter((p: LineupPlayer | null): p is LineupPlayer => !!p);
      // Pas « des absents publiés » : ils arrivent par morceaux (CGY à 21
      // habillés + 2 absents pendant 20 minutes), l'effectif n'est pas encore
      // l'alignement.
      const confirmed = dressed.length >= DRESSED_MIN && (started || dressed.length <= DRESSED_MAX);
      return { gameId, abbr, confirmed, dressed, scratches };
    };
    const out = { home: build('home', homeAbbr), away: build('away', awayAbbr) };
    // Définitif : on le garde la soirée. Sinon : on redemande dans 2 minutes.
    setCached(key, out, out.home.confirmed && out.away.confirmed ? 6 * 60 * 60_000 : 2 * 60_000);
    return out;
  } catch {
    return null;
  }
}

/**
 * Ce que la NHL a publié pour une journée (heure de l'Est), par abréviation :
 * les équipes dont l'alignement est confirmé OU qui ont déjà des absents
 * officiels. Absente de la réponse = rien de publié.
 */
export async function getOfficialLineupsDay(dateISO?: string): Promise<Record<string, TeamLineup>> {
  if (USE_MOCK) return {};
  const date = dateISO ?? easternToday();
  const key = `official_lineups_day:${date}`;
  const hit = getCached<Record<string, TeamLineup>>(key);
  if (hit) return hit;

  const out: Record<string, TeamLineup> = {};
  try {
    const sched = await fetchNHL<any>(`v1/schedule/${date}`);
    const day = (sched?.gameWeek ?? []).find((w: any) => w.date === date);
    const now = Date.now();
    const games = (day?.games ?? []).filter((g: any) => {
      const start = Date.parse(g?.startTimeUTC ?? '');
      return Number.isFinite(start) && start - now <= LOOKAHEAD_MS;
    });
    const lineups = await Promise.all(games.map((g: any) => fetchGameLineup(
      Number(g.id), String(g.gameState ?? ''),
      String(g.homeTeam?.abbrev ?? '').toUpperCase(), String(g.awayTeam?.abbrev ?? '').toUpperCase(),
    )));
    for (const l of lineups) {
      for (const t of l ? [l.home, l.away] : []) {
        if (t.abbr && (t.confirmed || t.scratches.length > 0)) out[t.abbr] = t;
      }
    }
  } catch { /* calendrier indisponible → aucun alignement, comme avant */ }
  // Une minute : le passage effectif → alignement doit être vu vite, et
  // chaque match a déjà son propre cache.
  setCached(key, out, 60_000);
  return out;
}

/**
 * Clés de comparaison d'un nom : nom complet sans accents, et « initiale +
 * nom de famille » — la feuille de match d'un match commencé n'a que
 * « A. Matthews ».
 */
export function nameKeys(name: string): string[] {
  const n = name.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!n) return [];
  const parts = n.split(' ');
  const last = parts.slice(1).join(' ');
  return last ? [n, `${parts[0][0]}. ${last}`.replace('.. ', '. ')] : [n];
}

/** Le joueur nommé `name` est-il habillé dans cet alignement DÉFINITIF ? */
export function isDressed(lineup: TeamLineup | undefined, name: string): boolean {
  if (!lineup?.confirmed) return false;
  const keys = new Set(lineup.dressed.flatMap((p) => nameKeys(p.name)));
  return nameKeys(name).some((k) => keys.has(k));
}
