/**
 * nhl/core.ts — socle partagé du client NHL : mode mock, cache TTL,
 * dédoublonnage des requêtes en vol, fetch avec délai, métadonnées d'équipe.
 * Point d'entrée public : `../nhlApiClient.ts`.
 */

import { TtlCache } from '../ttlCache';
import { timeUpstream, type UpstreamTarget } from '../../metrics';

/**
 * When NHL_USE_MOCK=true, serve rich local mock data instead of the live NHL API.
 *
 * ── Bridé en production ─────────────────────────────────────────────────────
 *
 * Cette variable posée par erreur sur Railway sert des matchs, des équipes et
 * des joueurs INVENTÉS à de vrais visiteurs, sans qu'aucune réponse HTTP ne le
 * dise. C'est le même mode d'échec que les cotes fictives de `/api/odds/live`
 * (retirées le 2026-09-08) et que les prédictions mockées avant
 * `PredictionUnavailableError` : sur une app de paris, un chiffre faux qui a
 * l'air juste est pire que pas de chiffre. Ça s'est déjà produit — le relevé du
 * 2026-08-29 a trouvé `NHL_USE_MOCK=true` en production.
 *
 * En production, `NHL_USE_MOCK` seul ne suffit donc PLUS : il faut poser en
 * plus `ALLOW_MOCK_IN_PRODUCTION=true`. Deux variables au lieu d'une, parce que
 * le risque à couvrir est l'erreur, pas l'intention — le tir de charge B3
 * (`AUDIT_SCALABILITE_COUTS.md` §5) a besoin des données mockées et doit rester
 * possible. Poser les deux est un geste qu'on ne fait pas par distraction.
 */
const MOCK_REQUESTED = process.env.NHL_USE_MOCK === 'true';
const MOCK_ALLOWED_HERE =
  process.env.NODE_ENV !== 'production' || process.env.ALLOW_MOCK_IN_PRODUCTION === 'true';
export const USE_MOCK = MOCK_REQUESTED && MOCK_ALLOWED_HERE;

if (MOCK_REQUESTED && !MOCK_ALLOWED_HERE) {
  // `console.error` et non `logger` : ce module est importé AVANT que le
  // logger ne soit configuré, et cette ligne ne doit pas pouvoir disparaître
  // dans un ordre d'import. Elle est de niveau erreur parce qu'elle signale
  // une variable de production posée par erreur — pas un réglage.
  console.error(
    '[nhlApiClient] NHL_USE_MOCK=true IGNORÉ : interdit en production. ' +
    'Poser ALLOW_MOCK_IN_PRODUCTION=true pour un tir de charge, et le RETIRER après.',
  );
}

const BASE = 'https://api-web.nhle.com/';
// The player-search endpoint lives on a separate host from the main stats API.
const SEARCH_BASE = 'https://search.d3.nhle.com/api/';

// --- Cache mémoire TTL, BORNÉ ---------------------------------------------
//
// La `Map` maison qui vivait ici n'évinçait jamais : `getCached` vérifiait
// l'expiration à la lecture, mais rien ne supprimait les entrées mortes. Or les
// clés dérivent de paramètres de requête (`player:<id>`, `boxscore:<gameId>`,
// `schedule:<date>`…) : un visiteur qui fait défiler le
// calendrier créait une clé par plage consultée. À plusieurs milliers de
// visiteurs la Map croissait de façon monotone jusqu'à l'OOM et au redémarrage
// du conteneur — qui vide tous les caches et provoque une tempête de requêtes
// upstream au redémarrage.
//
// `TtlCache` plafonne le nombre de clés (éviction FIFO de la plus ancienne
// insérée) : la mémoire devient fonction du plafond, plus du trafic. Le
// dépassement du plafond n'est pas une erreur, juste un taux de hit plus bas.
//
// Depuis le 2026-08-24, le calendrier n'est plus une source de clés : il est mis
// en cache par SEMAINE et non par plage consultée (cf. `fetchScheduleWeek`).
//
// Le plafond se règle sans redéploiement de code : NHL_CACHE_MAX_ENTRIES. Un
// boxscore complet pèse quelques dizaines de ko, d'où une valeur par défaut
// prudente plutôt que quelques milliers d'entrées.
const NHL_CACHE_MAX_ENTRIES = Number(process.env.NHL_CACHE_MAX_ENTRIES) || 500;

// Le TTL par défaut n'est jamais utilisé tel quel : chaque appelant passe le
// sien (30 s pour un match en direct, 6 h pour un match terminé).
const _cache = new TtlCache<unknown>(5 * 60_000, NHL_CACHE_MAX_ENTRIES, 'nhl');

export function getCached<T>(key: string): T | null {
  return _cache.get(key) as T | null;
}
export function setCached(key: string, data: unknown, ttlMs: number) {
  _cache.set(key, data, ttlMs);
}

// --- HTTP helper (native fetch, Node 18+) ---------------------------------

// `timeUpstream` enveloppe les DEUX points d'étranglement : toute requête vers
// la NHL passe par l'un ou l'autre, donc aucun appel ne peut échapper au
// compteur. C'est ce qui rend vérifiable le critère central des tests de
// charge — le nombre d'appels sortants doit rester constant quand le nombre de
// visiteurs augmente.
// --- Déduplication des requêtes en vol -------------------------------------
//
// LE PROBLÈME MESURÉ (loadtest/stampede.ts)
//
// Les fonctions de ce module suivent le motif `getCached` → travail →
// `setCached`. Entre l'instant où N appels concurrents lisent un cache froid et
// celui où le premier écrit sa réponse, TOUS voient `null` et partent chercher
// la même donnée. Mesuré sur `fetchTeams` : 10 concurrents → 10 appels NHL,
// 100 → 100, 500 → 500. Le cache lui-même fonctionne (cache chaud, 500
// concurrents → 0 appel) ; le trou est strictement la fenêtre froide, qui
// revient à chaque démarrage, chaque redéploiement et chaque expiration de TTL.
//
// POURQUOI ICI ET PAS DANS CHAQUE FONCTION
//
// Dédupliquer au point d'étranglement HTTP couvre les 19 fonctions d'un coup —
// y compris celles qu'on oublierait — et fait mieux : deux fonctions
// différentes qui demandent la même URL NHL partagent aussi la requête. Surtout,
// ça ne touche à AUCUNE sémantique de cache : les cas « ne pas mettre en
// cache » (jour sans match, boxscore absent, échec réseau) restent exactement
// ce qu'ils étaient.
//
// CE QUE ÇA NE FAIT PAS : le post-traitement (formatage, agrégation) tourne
// encore une fois par appelant. C'est du CPU, plus du réseau ni du quota. Si un
// profilage le désigne un jour, la suite est de basculer les fonctions les plus
// chaudes sur `TtlCache.wrap`, qui déduplique le calcul entier.
//
// La map ne peut pas fuir : chaque entrée est retirée dans `finally`, donc elle
// ne contient que les requêtes réellement en vol.
const _inflight = new Map<string, Promise<unknown>>();

/**
 * Exécute `fn` une seule fois par URL simultanée. Les appelants concurrents
 * partagent la même promesse — donc aussi le même objet résolu, comme le font
 * déjà les valeurs servies depuis le cache.
 *
 * Un échec n'est pas mémorisé : l'entrée est retirée quoi qu'il arrive, et
 * l'erreur est propagée à tous ceux qui attendaient.
 */
function dedupe<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const pending = _inflight.get(url);
  if (pending) return pending as Promise<T>;

  const p = fn().finally(() => { _inflight.delete(url); });
  _inflight.set(url, p);
  return p;
}

/**
 * Délai au bout duquel un appel NHL est abandonné.
 *
 * TROUVÉ PAR LE TIR DE CHARGE S1 (2026-08-03), pas par la lecture du code.
 * Ce module n'avait AUCUN timeout, et `fetch` sans `signal` s'en remet au défaut
 * d'undici : 300 secondes. Les compteurs l'ont montré noir sur blanc —
 * `upstream.nhl` : moyenne 9,6 s, **maximum 305 s**, soit exactement ce plafond.
 *
 * POURQUOI C'EST PIRE QU'UNE SIMPLE LENTEUR — la déduplication ci-dessus est la
 * bonne décision pour le coût, mais elle fait que TOUS les appelants d'une URL
 * partagent le sort du premier. Un appel NHL parti pour cinq minutes retient
 * cinq minutes tous ceux qui demandent la même donnée. Pendant le tir, c'est
 * cette chaîne qui a fait expirer `/api/nhl/games?date=` puis `best-bets`, qui
 * appelle `fetchUpcomingGames`. Le rayon de souffle d'un upstream lent est donc
 * l'application entière, pas la seule requête malchanceuse.
 *
 * 8 s : très au-dessus de la latence NHL normale (~100-600 ms), assez bas pour
 * qu'un appelant abandonne avant que l'utilisateur ne parte. Tous les appelants
 * ont déjà un repli (`.catch(() => [])`, cache périmé, prédiction par règles) :
 * l'effet visible d'un dépassement est « une section sans donnée », pas « la
 * page ne répond plus ».
 *
 * Un échec n'est jamais mémorisé (ni par `dedupe`, ni par le cache) : l'appel
 * suivant retente immédiatement.
 */
const NHL_TIMEOUT_MS = Number(process.env.NHL_TIMEOUT_MS) || 8_000;

/** `fetch` + abandon au bout de `NHL_TIMEOUT_MS`. */
async function fetchWithTimeout(
  url: string,
  accept = 'application/json',
  timeoutMs = NHL_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: {
        'User-Agent': 'IceEdge/1.0 (nhle-stats-client)',
        Accept: accept,
      },
      signal: controller.signal,
    });
  } catch (err: any) {
    // `AbortError` ne dit pas d'où il vient. Le reformuler ici évite qu'un
    // dépassement de délai ressemble, dans les logs, à une annulation côté
    // client — deux causes opposées.
    if (err?.name === 'AbortError') {
      throw new Error(`NHL API timeout (${timeoutMs} ms) for ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchNHL<T>(path: string): Promise<T> {
  const url = `${BASE}${path}`;
  return dedupe(url, () => timeUpstream('nhl', async () => {
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      throw Object.assign(
        new Error(`NHL API ${res.status} for ${path}`),
        { status: res.status }
      );
    }
    return res.json() as Promise<T>;
  }));
}

/** Same as fetchNHL, but against the separate player-search host. */
export async function fetchNHLSearch<T>(path: string): Promise<T> {
  const url = `${SEARCH_BASE}${path}`;
  return dedupe(url, () => timeUpstream('nhl', async () => {
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      throw Object.assign(
        new Error(`NHL Search API ${res.status} for ${path}`),
        { status: res.status }
      );
    }
    return res.json() as Promise<T>;
  }));
}

/**
 * Même chose pour l'hôte `api.nhle.com/stats/rest` (`STATS_BASE`), dont les URL
 * sont construites au point d'appel (expressions cayenne, tri sérialisé) — d'où
 * l'URL complète en paramètre plutôt qu'un chemin.
 *
 * Ces quatre appels étaient les derniers `fetch` bruts du module : **sans
 * timeout**, donc sur le défaut d'undici de 300 s que le tir de charge S1 a
 * mesuré (cf. `NHL_TIMEOUT_MS`), sans déduplication et hors compteur
 * `upstream.nhl`. Les faire passer ici corrige les trois d'un coup — et la
 * déduplication vaut particulièrement pour `team/summary?limit=-1`, que trois
 * fonctions différentes demandent avec la même URL.
 */
export async function fetchStats<T>(url: string, what: string): Promise<T> {
  return dedupe(url, () => timeUpstream('nhl', async () => {
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      throw Object.assign(
        new Error(`NHL stats API ${res.status} for ${what}`),
        { status: res.status }
      );
    }
    return res.json() as Promise<T>;
  }));
}

/**
 * Fichier TEXTE d'un autre hôte (les CSV de MoneyPuck) : même déduplication,
 * même délai borné, compté sous son propre nom dans les métriques upstream.
 * Le délai est le double de celui de l'API NHL (16 s par défaut) :
 * `skaters.csv` pèse ~3,5 Mo.
 */
export async function fetchText(
  url: string,
  what: string,
  target: UpstreamTarget,
  timeoutMs = 2 * NHL_TIMEOUT_MS,
): Promise<string> {
  return dedupe(url, () => timeUpstream(target, async () => {
    const res = await fetchWithTimeout(url, 'text/csv,text/plain,*/*', timeoutMs);
    if (!res.ok) {
      throw Object.assign(new Error(`${what} ${res.status}`), { status: res.status });
    }
    return res.text();
  }));
}

// --- Team emoji / colour metadata (not in the NHL API) --------------------

export const TEAM_META: Record<string, { emoji: string; color: string }> = {
  ANA: { emoji: '🦆', color: '#F47A38' },
  BOS: { emoji: '🐻', color: '#FFB81C' },
  BUF: { emoji: '🦬', color: '#003087' },
  CGY: { emoji: '🔥', color: '#C8102E' },
  CAR: { emoji: '🌀', color: '#CC0000' },
  CHI: { emoji: '🦅', color: '#CF0A2C' },
  COL: { emoji: '🏔️', color: '#6F263D' },
  CBJ: { emoji: '🎖️', color: '#002654' },
  DAL: { emoji: '⭐', color: '#006847' },
  DET: { emoji: '🐙', color: '#CE1126' },
  EDM: { emoji: '🛢️', color: '#FF4C00' },
  FLA: { emoji: '🐆', color: '#041E42' },
  LAK: { emoji: '👑', color: '#111111' },
  MIN: { emoji: '🌲', color: '#154734' },
  MTL: { emoji: '🔴', color: '#AF1E2D' },
  NSH: { emoji: '🎸', color: '#FFB81C' },
  NJD: { emoji: '👹', color: '#CE1126' },
  NYI: { emoji: '🏝️', color: '#00539B' },
  NYR: { emoji: '🗽', color: '#0038A8' },
  OTT: { emoji: '🏛️', color: '#C52032' },
  PHI: { emoji: '🔔', color: '#F74902' },
  PIT: { emoji: '🐧', color: '#FCB514' },
  SEA: { emoji: '🐙', color: '#001628' },
  SJS: { emoji: '🦈', color: '#006D75' },
  STL: { emoji: '🎵', color: '#002F87' },
  TBL: { emoji: '⚡', color: '#002868' },
  TOR: { emoji: '🍁', color: '#003E7E' },
  UTA: { emoji: '⚔️', color: '#69B3E7' },
  VAN: { emoji: '🐋', color: '#00205B' },
  VGK: { emoji: '🃏', color: '#B4975A' },
  WPG: { emoji: '✈️', color: '#041E42' },
  WSH: { emoji: '🦅', color: '#CF0A2C' },
};

// --- Current season helper ------------------------------------------------

/**
 * La saison LNH en cours, au format `20262027`.
 *
 * ── La bascule est en SEPTEMBRE, pas en octobre ─────────────────────────────
 *
 * `getMonth() >= 9` (octobre) laissait tout le mois de septembre pointer sur la
 * saison PRÉCÉDENTE. Ce n'était pas visible comme un bogue — les chiffres
 * étaient vrais — mais c'étaient ceux de l'an dernier, présentés sans date sur
 * une page qui parle du match de ce soir : la fiche d'une équipe affichait
 * « 48-22-8 » en préparation d'une saison où elle n'a pas encore joué.
 *
 * Septembre est le mois des camps, des matchs préparatoires et des premiers
 * paris ; c'est là que l'app doit avoir basculé. `getMonth() >= 8` = septembre.
 *
 * ⚠️ Conséquence à assumer, et gérée en aval : de septembre à la première
 * rondelle, la saison en cours n'a AUCUNE donnée. `fetchTeams` met alors la
 * fiche à zéro plutôt que de servir celle de l'an dernier, et les statistiques
 * de joueur retombent sur la dernière saison complète EN LE DISANT
 * (`statsSeason`) — une cadence de buts par match ne s'invente pas, mais elle
 * ne doit pas non plus se faire passer pour celle de la saison en cours.
 */
export function currentSeason(): string {
  const now  = new Date();
  const year = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}${year + 1}`;
}

/** La saison juste avant `currentSeason()` — la dernière complète, en avant-saison. */
export function previousSeason(): string {
  const cur = Number(currentSeason().slice(0, 4)) - 1;
  return `${cur}${cur + 1}`;
}

/** Parses NHL's "MM:SS" time-on-ice string into decimal minutes. */
export function parseToiMinutes(s: unknown): number {
  if (typeof s !== 'string' || !s.includes(':')) return 0;
  const [m, sec] = s.split(':').map((x) => Number(x.trim()));
  if (!Number.isFinite(m) || !Number.isFinite(sec)) return 0;
  return +(m + sec / 60).toFixed(2);
}
