/**
 * nhl/restTravel.ts — jours de repos, back-to-back et fatigue de déplacement.
 * Point d'entrée public : `../nhlApiClient.ts`.
 */

import { computeTravel, TravelGame, TravelFeatures } from '../travel';
import { fetchNHL, getCached, setCached } from './core';

// --- Repos / back-to-back ---------------------------------------------------

export interface TeamRestInfo {
  restDays: number;   // jours depuis le dernier match (cap 7)
  b2b:      0 | 1;    // back-to-back (a joué hier)
  dense3in4: number;  // nb de matchs joués dans les 3 jours précédents (= 3-en-4)
}

/** Date du jour en heure de l'Est (les gameDate NHL sont en ET). */
function todayET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * TTL d'un résultat NÉGATIF (repli, calendrier illisible, aucun match trouvé).
 *
 * POURQUOI IL EXISTE. `fetchTeamRestInfo` et `fetchTeamTravel` renvoyaient leur
 * repli SANS le mettre en cache : seul le chemin qui trouve quelque chose
 * appelait `setCached`. Conséquence, chaque requête qui tombait sur un cas vide
 * refaisait l'appel calendrier — et le cas vide n'est pas rare, c'est le cas
 * NORMAL en intersaison et en début de saison, quand `played.length === 0` pour
 * les 32 équipes. La landing tire ~32 prédictions d'un coup : autant d'appels
 * `club-schedule-season`, à chaque chargement, indéfiniment.
 *
 * Plus court que les 6 h du chemin nominal, parce qu'un négatif peut être
 * transitoire (API en panne, calendrier pas encore publié) et qu'on ne veut pas
 * rester aveugle une demi-journée après le premier match de la saison.
 */
const NEGATIVE_TTL_MS = 15 * 60_000;

/**
 * Calendrier de saison d'une équipe — UNE seule requête par équipe et par jour.
 *
 * `fetchTeamRestInfo` et `fetchTeamTravel` interrogent le même point d'entrée
 * (`club-schedule-season/{TEAM}/now`) mais mettaient en cache leurs résultats
 * DÉRIVÉS, sous deux clés différentes. Lancées ensemble — le cas de
 * `Promise.allSettled` dans `buildGameFeatures` — la déduplication en vol de
 * `fetchNHL` les fusionnait, donc le problème restait invisible. Lancées à des
 * moments différents, la seconde repayait la requête : le repos met en cache
 * `rest:TOR:…`, le voyage cherche `travel:TOR:TOR:…`, ne trouve rien, et
 * rappelle la NHL pour une réponse déjà reçue.
 *
 * Mettre le calendrier BRUT en cache règle les deux cas d'un coup, et rend le
 * voyage gratuit une fois le repos calculé.
 */
async function fetchTeamSeasonGames(abbr: string): Promise<any[]> {
  const upper = abbr.toUpperCase();
  const key   = `schedule:${upper}:${todayET()}`;
  const cached = getCached<any[]>(key);
  if (cached) return cached;

  const data  = await fetchNHL<any>(`v1/club-schedule-season/${upper}/now`);
  const games = (data.games ?? []) as any[];
  // Même un calendrier vide est une réponse : la garder évite de rappeler la
  // NHL à chaque prédiction en intersaison.
  setCached(key, games, games.length ? 6 * 60 * 60_000 : NEGATIVE_TTL_MS);
  return games;
}

/**
 * Plafond des jours de repos — même valeur que `build_dataset.py::add_schedule`
 * (`min(jours, 7)`). Au-delà, le modèle ne distingue plus rien.
 */
export const MAX_REST_DAYS = 7;

/**
 * Repos d'une équipe qui n'a encore joué AUCUN match cette saison.
 *
 * À l'entraînement, le premier match d'une saison est à des mois du dernier
 * match de la précédente : `rest_days` y vaut le plafond, 7, et jamais autre
 * chose. Le service recevait ici le repli générique (2 jours) — une valeur que
 * le modèle n'a jamais vue pour un match d'ouverture, et qui pèse sur
 * `atk_rest_days`/`def_rest_days` (modèle de score), `rest_days_diff`
 * (classifieur) et `days_rest` (modèle joueur). Cf. ml/INCOHERENCES_ML.md §1.
 */
export const SEASON_START_REST: Readonly<TeamRestInfo> =
  Object.freeze({ restDays: MAX_REST_DAYS, b2b: 0, dense3in4: 0 });

const FINISHED = ['OFF', 'FINAL', 'OVER'];
/** États de calendrier d'un match qui n'aura pas lieu à sa date (reporté, annulé). */
const NOT_HAPPENING = ['PPD', 'CNCL', 'SUSP'];

/** Date `AAAA-MM-JJ` valide, sinon `null`. */
function isoDateOr(d: string | undefined): string | null {
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/**
 * Jours de repos AVANT le match du `gameDate` (heure de l'Est, défaut :
 * aujourd'hui), via le calendrier de saison.
 *
 * Le repos se mesure à la DATE DU MATCH, pas à aujourd'hui (ml/INCOHERENCES_ML.md
 * §2). Pour un match de demain, le match de ce soir compte déjà comme le
 * précédent : c'est exactement ce que l'entraînement voit (`build_dataset.py`
 * mesure l'écart entre deux matchs consécutifs). On retient donc :
 *   • avant aujourd'hui : les matchs TERMINÉS (un match passé non terminé a
 *     été reporté) ;
 *   • d'aujourd'hui à la veille du match : les matchs PRÉVUS, sauf reportés ou
 *     annulés.
 */
export async function fetchTeamRestInfo(abbr: string, gameDate?: string): Promise<TeamRestInfo> {
  const upper  = abbr.toUpperCase();
  const today  = todayET();
  const target = isoDateOr(gameDate) ?? today;
  // `today` reste dans la clé : la même date de match se recalcule chaque jour,
  // à mesure que les matchs intermédiaires sont joués (ou reportés).
  const key    = `rest:${upper}:${today}:${target}`;
  const cached = getCached<TeamRestInfo>(key);
  if (cached) return cached;

  // Repli quand on ne SAIT PAS (panne, calendrier vide) — pas le début de saison.
  const fallback: TeamRestInfo = { restDays: 2, b2b: 0, dense3in4: 0 };
  try {
    const games = await fetchTeamSeasonGames(upper);
    const played = games
      .filter((g: any) => {
        const d = String(g.gameDate ?? '');
        if (g.gameType !== 2 || !d || d >= target) return false;
        return d < today
          ? FINISHED.includes(g.gameState)
          : !NOT_HAPPENING.includes(String(g.gameScheduleState ?? 'OK'));
      })
      .map((g: any) => g.gameDate as string)
      .sort();

    // Calendrier vide (pas encore publié, réponse illisible) : on ne sait pas.
    if (!games.length) {
      setCached(key, fallback, NEGATIVE_TTL_MS);
      return fallback;
    }

    // Calendrier publié mais aucun match joué : c'est le DÉBUT DE SAISON, une
    // réponse et non un échec — repos au plafond, comme à l'entraînement. Court
    // TTL quand même : le premier match joué doit être vu dans la journée.
    if (!played.length) {
      const info = { ...SEASON_START_REST };
      setCached(key, info, NEGATIVE_TTL_MS);
      return info;
    }

    const now      = new Date(target + 'T12:00:00');
    const lastDate = new Date(played[played.length - 1] + 'T12:00:00');
    const days     = Math.round((now.getTime() - lastDate.getTime()) / 86_400_000);
    // 3-en-4 : matchs joués dans les 3 jours précédents (même déf. que build_dataset).
    const dense3in4 = played.filter((d: string) => {
      const diff = Math.round((now.getTime() - new Date(d + 'T12:00:00').getTime()) / 86_400_000);
      return diff >= 1 && diff <= 3;
    }).length;
    const info: TeamRestInfo = {
      restDays: Math.min(Math.max(days, 0), MAX_REST_DAYS),
      b2b:      days === 1 ? 1 : 0,
      dense3in4,
    };
    setCached(key, info, 6 * 60 * 60_000);   // cache 6 h
    return info;
  } catch {
    // Panne franche : on met aussi le repli en cache, brièvement. Sans ça, une
    // API NHL en difficulté se prend la rafale entière de la landing.
    setCached(key, fallback, NEGATIVE_TTL_MS);
    return fallback;
  }
}

// --- Voyage / fuseaux / altitude / road-trip --------------------------------

/**
 * Features voyage/calendrier d'une équipe pour un match à jouer dans l'aréna
 * `venueAbbr` (= équipe à domicile du match). Reconstruit la séquence de la
 * saison (matchs joués + à venir) depuis club-schedule-season et applique la
 * logique PURE de travel.ts — identique à build_dataset.py::add_travel.
 * Renvoie null si le calendrier est indisponible (l'appelant met des neutres).
 */
export async function fetchTeamTravel(
  abbr: string,
  venueAbbr: string,
  gameDate?: string,
): Promise<TravelFeatures | null> {
  const team   = abbr.toUpperCase();
  const venue  = venueAbbr.toUpperCase();
  const target = isoDateOr(gameDate);
  const key    = `travel:${team}:${venue}:${todayET()}:${target ?? ''}`;
  // Enveloppe volontaire : `getCached` rend `null` aussi bien pour « absent »
  // que pour « présent et valant null ». Sans elle, un négatif mis en cache
  // serait relu comme un défaut de cache et l'appel calendrier repartirait —
  // exactement ce qu'on vient de corriger.
  const cached = getCached<{ v: TravelFeatures | null }>(key);
  if (cached) return cached.v;

  try {
    const seasonGames = await fetchTeamSeasonGames(team);
    const today = todayET();
    const games = seasonGames
      .filter((g: any) => g.gameType === 2 && g.gameDate)   // saison régulière
      .map((g: any) => ({
        date:     g.gameDate as string,
        homeAbbr: (g.homeTeam?.abbrev ?? '').toUpperCase(),
        state:    g.gameState as string,
      }))
      .sort((a: any, b: any) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    if (!games.length) {
      setCached(key, { v: null }, NEGATIVE_TTL_MS);
      return null;
    }

    const seq: TravelGame[] = games.map((g: any) => ({
      date: g.date, venueAbbr: g.homeAbbr, isHome: g.homeAbbr === team,
    }));

    // Match courant = celui de `gameDate` dans cet aréna quand la date est
    // donnée ; sinon le prochain match non terminé disputé dans cet aréna.
    let idx = target
      ? games.findIndex((g: any) => g.homeAbbr === venue && g.date === target)
      : -1;
    if (idx < 0) idx = games.findIndex(
      (g: any) => g.homeAbbr === venue &&
        !['OFF', 'FINAL', 'OVER'].includes(g.state) && g.date >= today,
    );
    if (idx < 0) idx = games.findIndex((g: any) => g.homeAbbr === venue && g.date >= today);
    // Aucun match à venir dans cet aréna : réponse stable pour la journée, pas
    // un échec. Ne pas la garder faisait refetcher le calendrier à chaque appel.
    if (idx < 0) {
      setCached(key, { v: null }, NEGATIVE_TTL_MS);
      return null;
    }

    const info = computeTravel(seq, idx);
    setCached(key, { v: info }, 6 * 60 * 60_000);   // cache 6 h
    return info;
  } catch {
    setCached(key, { v: null }, NEGATIVE_TTL_MS);
    return null;
  }
}
