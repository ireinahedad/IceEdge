/**
 * oddsClient.ts
 * Récupère les cotes NHL depuis The Odds API : moneyline (h2h) dé-viggée, et
 * totals (over/under) pour le calcul de +EV.
 *
 * La cote de clôture du marché est le meilleur prédicteur disponible : les books
 * agrègent l'information de tous les parieurs. On l'utilise comme facteur pondéré.
 *
 * Nécessite la variable d'environnement ODDS_API_KEY (même clé que le proxy
 * odds.routes.ts). Sans clé ou en cas d'échec réseau, retourne null → le moteur
 * retombe proprement sur les autres facteurs.
 */

import { logger } from '../logger';
import { recordUpstream } from '../metrics';
import { TtlCache } from './ttlCache';
import * as oddsQuota from './oddsQuota';
import { toAbbr } from './oddsTeamNames';

const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const ODDS_KEY  = process.env.ODDS_API_KEY;
const SPORT_KEY = 'icehockey_nhl';

/**
 * Durée de vie du cache des cotes, en minutes — `ODDS_CACHE_TTL_MIN`, 30 par
 * défaut. **C'est LE levier du budget d'affichage.**
 *
 * Ce cache est désormais le SEUL chemin vers The Odds API pour l'affichage :
 * le moteur de paris le lit, et le proxy public `/api/odds` aussi (avant le
 * 2026-09-27, le proxy avait son propre appel amont). Un appel = 3 marchés ×
 * 1 région = 3 crédits. Pire cas, trafic continu en saison :
 *
 *   5 min  → 864 crédits/jour → ~26 000/mois (plus que tout le plan 20K)
 *   30 min → 144 crédits/jour →  ~4 500/mois
 *
 * Plan 20K (2026-09-27) : ~4 500 affichage + ~450 collecte + ~15 000 backfill.
 * Les cotes NHL bougent lentement ; la collecte (`oddsLogger`) a ses propres
 * appels, chez un autre livre, et ne passe pas par ce cache.
 *
 * Lecture durcie pour la même raison que `ODDS_USER_RESERVE` : la variable se
 * pose à la main dans Railway, et `Number('')` vaut 0 — un TTL nul viderait le
 * quota en quelques heures.
 */
const TTL = ((): number => {
  const raw = process.env.ODDS_CACHE_TTL_MIN;
  const DEFAULT_MIN = 30;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MIN * 60_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    logger.warn({ raw, fallback: DEFAULT_MIN },
      '[oddsClient] ODDS_CACHE_TTL_MIN illisible ou < 1 — défaut appliqué.');
    return DEFAULT_MIN * 60_000;
  }
  return Math.round(n * 60_000);
})();

/**
 * Livre(s) et région demandés à The Odds API — UNE seule définition pour tout
 * le serveur (proxy, moteur, collecte).
 *
 * ⚠️ The Odds API ne cote NI Bet365 NI Stake sur la NHL (`bet365_au` ne couvre
 * que l'AFL et la NRL, vérifié le 2026-09-27). Le couple `bet365`/`eu` écrit en
 * dur jusque-là ne désignait aucun livre : chaque événement revenait avec
 * `bookmakers: []`, et la collecte prenait « le premier livre venu » — une
 * source qui pouvait changer d'un jour à l'autre, ce que le CLV ne tolère pas.
 *
 * Décision du user (2026-09-27) : l'app affiche un livre CANADIEN, sous son
 * vrai nom. Défaut `betano_ca_on` : seul livre canadien à coter 33 matchs sur
 * 33 en moneyline ET en puck line au sondage du 2026-09-27
 * (`ml/python/probe_odds_books.py`). Le livre est envoyé en paramètre
 * `bookmakers`, jamais `regions` (même coût : jusqu'à 10 livres = 1 région).
 * Une liste est acceptée, dans l'ordre de préférence. `ODDS_REGIONS` n'est
 * plus lu depuis le 2026-09-27.
 */
export const ODDS_BOOKMAKERS = (process.env.ODDS_BOOKMAKERS ?? '').trim() || 'betano_ca_on';
const PREFERRED_BOOKS = ODDS_BOOKMAKERS.split(',').map((b) => b.trim()).filter(Boolean);

/** Paramètre de sélection des livres, commun à tous les appels. */
export function bookParams(): Record<string, string> {
  return { bookmakers: ODDS_BOOKMAKERS };
}

/**
 * Délai maximal d'un appel — même valeur et même raison que dans le proxy
 * (`ODDS_FETCH_TIMEOUT_MS`) : un amont qui accepte la connexion puis se tait
 * gèlerait tous les appelants dédoublonnés derrière la même promesse.
 */
const FETCH_TIMEOUT_MS = Number(process.env.ODDS_FETCH_TIMEOUT_MS) || 8_000;

async function fetchOdds(url: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface OddsOutcome { name: string; price: number; point?: number }
interface OddsEvent {
  /** Identifiant The Odds API de l'événement — clé de l'endpoint par match. */
  id?: string;
  home_team: string;
  away_team: string;
  commence_time: string;
  bookmakers: Array<{
    key: string;
    /** Nom lisible du livre (« Betano (Ontario) »), fourni par The Odds API. */
    title?: string;
    markets: Array<{ key: string; outcomes: OddsOutcome[] }>;
  }>;
}

export interface OddsImplied {
  homeProb: number;   // probabilité implicite dé-viggée (0–1)
  homeOdds: number;   // cote décimale maison (affichage)
  awayOdds: number;   // cote décimale visiteur (affichage)
  bookmaker: string;
}

export interface TotalsOdds {
  line: number;       // ligne du book (ex. 6.0) — peut différer de la ligne du modèle
  overOdds: number;   // cote décimale Over
  underOdds: number;  // cote décimale Under
  bookmaker: string;
}

/** Événement brut de The Odds API (exposé pour le logger de cotes et le proxy). */
export type RawOddsEvent = OddsEvent;

/**
 * Livre de la COLLECTE (série de cotes du ML : `odds_log`, `odds_snapshots`,
 * puis CLV et backfill) — distinct du livre d'AFFICHAGE.
 *
 * Pourquoi deux livres (2026-09-27). Le sondage `probe_odds_books.py` a montré
 * que les livres canadiens n'ont quasiment AUCUN historique chez The Odds API
 * (rien en 2023, 5 matchs sur 17 en 2024). Or la collecte live doit prolonger
 * EXACTEMENT la série que le backfill 2023-2026 reconstruit, sinon le CLV
 * compare deux livres différents selon la saison. Le livre d'affichage, lui,
 * doit être un livre où le visiteur canadien peut réellement parier.
 *
 * Défaut `draftkings` : au sondage du 2026-09-27, seul livre complet en
 * moneyline ET puck line sur les trois saisons à backfiller (13/16, 17/17,
 * 18/18 matchs aux dates testées) et 33/33 en direct. Pinnacle plafonnait à
 * 11-13 matchs. **Doit rester identique à `--odds-api-book` du backfill.**
 */
export const ODDS_COLLECT_BOOKMAKERS =
  (process.env.ODDS_COLLECT_BOOKMAKERS ?? '').trim() || 'draftkings';

/**
 * Cotes pour la COLLECTE, chez le livre de collecte, **sans cache**.
 *
 * `markets` : `h2h,spreads,totals` pour une passe complète (3 crédits),
 * `h2h,spreads` pour une passe de clôture (2 crédits) — les totaux sont clos
 * pour de bon (leur CLV est sous leur propre placebo, 2026-08-23), le
 * moneyline a un CLV réel et la puck line porte la règle A2.
 *
 * **NE PASSE VOLONTAIREMENT PAS PAR `oddsCache`.** Ce cache sert l'affichage,
 * chez un autre livre : y déposer la réponse de la collecte afficherait aux
 * visiteurs un livre où ils ne peuvent pas parier. Un seul appelant, une fois
 * par créneau : il n'y a pas de troupeau à dédoublonner.
 *
 * Pas de repli sur des cotes périmées non plus : un collecteur qui rate un
 * cycle perd un point de mesure, ce qui est sans gravité, là où réécrire un
 * snapshot avec un prix ancien fabriquerait un faux mouvement de ligne.
 */
export async function fetchCollectorOdds(markets: string): Promise<RawOddsEvent[]> {
  if (!ODDS_KEY) return [];

  const params = new URLSearchParams({
    apiKey:     ODDS_KEY,
    bookmakers: ODDS_COLLECT_BOOKMAKERS,
    markets,
    oddsFormat: 'decimal',
  });

  const started = Date.now();
  try {
    const res = await fetchOdds(`${ODDS_BASE}/sports/${SPORT_KEY}/odds?${params}`);
    recordUpstream('odds', Date.now() - started, res.ok);
    // Y compris en erreur : un 429 porte le solde, et c'est le moment où il
    // compte le plus.
    oddsQuota.observe(res.headers);
    if (!res.ok) {
      logger.error({ status: res.status, markets }, '[oddsClient] collecte');
      return [];
    }
    return (await res.json()) as OddsEvent[];
  } catch (err: any) {
    recordUpstream('odds', Date.now() - started, false);
    logger.error({ err: err?.message, markets }, '[oddsClient] collecte fetch error');
    return [];
  }
}

/**
 * Cache des cotes NHL — UNE seule entrée, puisqu'un appel ramène toute la ligue.
 *
 * LE BUG QUE `TtlCache` CORRIGE ICI (trouvé par le tir S1 du 2026-08-03)
 *
 * La version précédente tenait un `let cache` maison, sans déduplication en vol :
 *
 *     if (cache && cache.expiresAt > Date.now()) return cache.data;
 *     const res = await fetch(...);          // ← N appelants passent tous par là
 *     cache = { data, expiresAt: ... };
 *
 * Entre l'instant où N appelants concurrents lisent un cache froid et celui où le
 * premier écrit, **tous** voient `null` et partent chercher la même donnée.
 * `getBestBets` price ses candidats en parallèle : mesuré sur un démarrage à
 * froid, **une seule exécution a émis 26 appels** (13 matchs × h2h + totals),
 * dont 4 rejetés par le limiteur d'en face.
 *
 * C'est exactement le troupeau corrigé dans `nhlApiClient` le 2026-07-28 — sur le
 * seul module du repo où il coûte de l'argent. L'API NHL est gratuite ; The Odds
 * API est facturée à l'appel. À 26 appels par fenêtre froide de 5 minutes, la
 * consommation passait de ~8 600 crédits par mois à ~225 000.
 *
 * `wrap` rattache les N−1 autres à la promesse en vol : une fenêtre froide coûte
 * un appel, quel que soit le nombre d'appelants simultanés.
 */
const oddsCache = new TtlCache<OddsEvent[]>(TTL, 1, 'odds-client');
const ODDS_CACHE_KEY = SPORT_KEY;

/**
 * Récupère toutes les cotes NHL (h2h + spreads + totals).
 *
 * `spreads` a été ajouté le 2026-08-04 : c'est la puck line, et sans elle le
 * journal `odds_log` ne peut pas constituer le jeu de données dont le modèle
 * de score a besoin. Le coût passe de 2 à 3 crédits par appel — un tiers de
 * plus pour la seule famille de marchés où un ROI reste à établir.
 *
 * Un unique appel sert les deux consommateurs (moteur de paris et collecteur)
 * via le même cache : demander `spreads` ici ne crée pas d'appel
 * supplémentaire, il enrichit celui qui a lieu de toute façon.
 *
 * TTL adaptatif — voir `oddsQuota.proxyTtlMs`. À 5 minutes fixes, ce module
 * vaut à lui seul ~288 appels/jour, soit ~864 crédits : un dimensionnement de
 * plan payant. Quand les crédits se raréfient, le TTL s'allonge plutôt que le
 * service ne s'arrête.
 */
async function loadAllOdds(): Promise<OddsEvent[]> {
  if (!ODDS_KEY) return [];

  const params = new URLSearchParams({
    apiKey:     ODDS_KEY,
    ...bookParams(),
    markets:    'h2h,spreads,totals',
    oddsFormat: 'decimal',
  });
  // Synchrone : rien ne doit s'intercaler entre l'appelant et `wrap`. Un
  // `await` ici ajoutait un tour de boucle d'événements pendant lequel des
  // appelants concurrents n'étaient plus dédoublonnés — c'est-à-dire le bug
  // même que ce module a été écrit pour corriger.
  const ttl = oddsQuota.proxyTtlMs(TTL);

  // Deuxième consommateur du quota The Odds API, à côté du proxy de
  // `routes/odds.routes.ts`. Il doit être compté lui aussi, sinon le critère
  // « ≤ 2 appels Odds API » du scénario S1 mesure la moitié de la réalité.
  return oddsCache.wrap(ODDS_CACHE_KEY, async () => {
    const started = Date.now();
    try {
      const res = await fetchOdds(`${ODDS_BASE}/sports/${SPORT_KEY}/odds?${params}`);
      recordUpstream('odds', Date.now() - started, res.ok);
      // Y COMPRIS en erreur : un 429 porte le solde, et c'est justement le
      // moment où l'information compte.
      oddsQuota.observe(res.headers);
      if (!res.ok) {
        logger.error({ status: res.status }, '[oddsClient]');
        // LEVER et non renvoyer `[]` : une réponse vide mise en cache
        // priverait le moteur de cotes bien après le rétablissement. Rien n'est
        // mémorisé quand `fn` rejette.
        throw new Error(`odds upstream ${res.status}`);
      }
      return (await res.json()) as OddsEvent[];
    } catch (err: any) {
      recordUpstream('odds', Date.now() - started, false);
      throw err;
    }
  }, ttl);
}

/**
 * Toutes les cotes NHL, en LEVANT sur échec — pour le proxy public.
 *
 * Le proxy a son propre repli (réponse périmée + cache d'échec, testés dans
 * `odds.routes.test.ts`) : il doit donc voir l'échec, pas un `[]` qu'il
 * prendrait pour « aucun match ». Même cache que le moteur, donc un seul appel
 * amont par fenêtre pour les deux.
 */
export function fetchRawOddsStrict(): Promise<RawOddsEvent[]> {
  return loadAllOdds();
}

async function fetchAllOdds(): Promise<OddsEvent[]> {
  try {
    return await loadAllOdds();
  } catch (err: any) {
    // Repli sur les dernières cotes connues, même expirées — comme le fait déjà
    // le proxy. Des cotes un peu anciennes valent mieux qu'aucun facteur
    // marché, et c'est le meilleur prédicteur dont dispose le moteur.
    const stale = oddsCache.getStale(ODDS_CACHE_KEY);
    if (stale) {
      logger.warn({ err: err?.message }, '[oddsClient] upstream KO — cotes périmées servies');
      return stale;
    }
    logger.error({ err: err?.message }, '[oddsClient] fetch error');
    return [];
  }
}

/** Normalise un nom d'équipe pour un matching tolérant ("Toronto Maple Leafs" ⊃ "Maple Leafs"). */
function norm(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z]/g, '');
}

/** Retrouve l'événement correspondant aux deux équipes (matching tolérant, ordre indifférent). */
function findEvent(events: OddsEvent[], homeName: string, awayName: string): OddsEvent | null {
  const h = norm(homeName), a = norm(awayName);
  const ev = events.find(e => {
    const eh = norm(e.home_team), ea = norm(e.away_team);
    const match = (x: string, y: string) => x.includes(y) || y.includes(x);
    return (match(eh, h) && match(ea, a)) || (match(eh, a) && match(ea, h));
  });
  return ev && ev.bookmakers?.length ? ev : null;
}

/**
 * Sélectionne le livre qui expose le marché demandé : le premier de
 * `ODDS_BOOKMAKERS` dans l'ordre donné, sinon le premier disponible.
 */
function pickBookmaker(ev: OddsEvent, marketKey: string): OddsEvent['bookmakers'][number] | null {
  const withMarket = ev.bookmakers.filter(b => b.markets.some(m => m.key === marketKey));
  if (!withMarket.length) return null;
  for (const key of PREFERRED_BOOKS) {
    const hit = withMarket.find(b => b.key === key);
    if (hit) return hit;
  }
  return withMarket[0];
}

/**
 * Probabilité implicite dé-viggée pour la victoire de l'équipe à domicile,
 * à partir des noms complets des deux équipes. Retourne null si introuvable.
 */
export async function fetchOddsImplied(
  homeName: string,
  awayName: string,
): Promise<OddsImplied | null> {
  const events = await fetchAllOdds();
  if (!events.length) return null;

  const ev = findEvent(events, homeName, awayName);
  if (!ev) return null;

  const bk = pickBookmaker(ev, 'h2h');
  if (!bk) return null;
  const h2h = bk.markets.find(m => m.key === 'h2h');
  if (!h2h) return null;

  const h = norm(homeName);

  // Retrouve la cote de chaque équipe (le nom de l'outcome = nom complet de l'équipe).
  const homeIsEvHome = norm(ev.home_team).includes(h) || h.includes(norm(ev.home_team));
  const evHomeName = ev.home_team, evAwayName = ev.away_team;
  const oHome = h2h.outcomes.find(o => norm(o.name) === norm(homeIsEvHome ? evHomeName : evAwayName));
  const oAway = h2h.outcomes.find(o => norm(o.name) === norm(homeIsEvHome ? evAwayName : evHomeName));
  if (!oHome?.price || !oAway?.price) return null;

  // Dé-vig : prob brute = 1/cote, renormalisée pour retirer la marge du book.
  const rawH = 1 / oHome.price;
  const rawA = 1 / oAway.price;
  const homeProb = rawH / (rawH + rawA);

  return {
    homeProb,
    homeOdds: oHome.price,
    awayOdds: oAway.price,
    bookmaker: bk.key,
  };
}

/**
 * Cotes over/under (marché "totals") pour un match donné. Retourne la ligne du
 * book et les cotes décimales Over/Under — l'appelant doit vérifier que la ligne
 * correspond à celle du pari avant de calculer un +EV (comparer deux lignes
 * différentes n'aurait pas de sens). Retourne null si introuvable.
 */
export async function fetchTotalsOdds(
  homeName: string,
  awayName: string,
): Promise<TotalsOdds | null> {
  const events = await fetchAllOdds();
  if (!events.length) return null;

  const ev = findEvent(events, homeName, awayName);
  if (!ev) return null;

  const bk = pickBookmaker(ev, 'totals');
  if (!bk) return null;
  const totals = bk.markets.find(m => m.key === 'totals');
  if (!totals) return null;

  const over  = totals.outcomes.find(o => /over/i.test(o.name));
  const under = totals.outcomes.find(o => /under/i.test(o.name));
  if (!over?.price || !under?.price) return null;

  // La ligne est portée par les outcomes (identique pour Over et Under).
  const line = over.point ?? under.point;
  if (typeof line !== 'number') return null;

  return {
    line,
    overOdds: over.price,
    underOdds: under.price,
    bookmaker: bk.key,
  };
}

// ─── Prix d'UNE sélection, pour les Meilleurs paris et les jambes de coupon ───

/** Un prix de livre, avec le nom du livre qui le propose. */
export interface BookPrice {
  price: number;        // cote décimale
  bookmaker: string;    // clé The Odds API (`betano_ca_on`)
  bookTitle: string;    // nom lisible (« Betano (Ontario) »)
}

export interface SelectionQuery {
  homeAbbr: string;
  awayAbbr: string;
  /** `moneyline` | `puck_line` | `total_goals` — les seuls marchés cotés. */
  marketType: string;
  /** Abréviation d'équipe (ML, puck line) ou `over` / `under` (total). */
  selectionValue: string;
  /** Handicap de l'équipe choisie (puck line, −1.5 par défaut) ou ligne du total. */
  line?: number | null;
}

/**
 * Le prix d'une sélection précise chez le livre d'affichage, ou `null`.
 *
 * Aucun crédit de plus : lit le même cache que le proxy et le moteur.
 *
 * ⚠️ Étroit par construction, comme `priceForBet` côté client : un prix n'est
 * rendu que si la correspondance est CERTAINE. Le match s'apparie sur les
 * abréviations des deux équipes (jamais un `includes` de noms), un total exige
 * la même ligne que le pari, une puck line le même handicap. Dans le doute,
 * pas de prix — un prix faux ferait croire à un edge qui n'existe pas.
 */
export async function priceForSelection(q: SelectionQuery): Promise<BookPrice | null> {
  const home = q.homeAbbr.toUpperCase();
  const away = q.awayAbbr.toUpperCase();
  const events = await fetchAllOdds();
  const ev = events.find((e) => {
    const eh = toAbbr(e.home_team), ea = toAbbr(e.away_team);
    return (eh === home && ea === away) || (eh === away && ea === home);
  });
  if (!ev) return null;

  const marketKey = q.marketType === 'moneyline' ? 'h2h'
    : q.marketType === 'puck_line' ? 'spreads'
    : q.marketType === 'total_goals' ? 'totals'
    : null;
  if (!marketKey) return null;

  const bk = pickBookmaker(ev, marketKey);
  const market = bk?.markets.find((m) => m.key === marketKey);
  if (!bk || !market) return null;

  const sel = q.selectionValue.toUpperCase();
  let outcome: OddsOutcome | undefined;
  if (marketKey === 'h2h') {
    outcome = market.outcomes.find((o) => toAbbr(o.name) === sel);
  } else if (marketKey === 'spreads') {
    const line = q.line ?? -1.5;
    outcome = market.outcomes.find((o) =>
      toAbbr(o.name) === sel && typeof o.point === 'number' && Math.abs(o.point - line) < 1e-9);
  } else {
    if (q.line == null) return null;
    const side = sel === 'OVER' ? /over/i : sel === 'UNDER' ? /under/i : null;
    if (!side) return null;
    outcome = market.outcomes.find((o) =>
      side.test(o.name) && typeof o.point === 'number' && Math.abs(o.point - Number(q.line)) < 1e-9);
  }
  if (!outcome || !(outcome.price > 1)) return null;
  return { price: outcome.price, bookmaker: bk.key, bookTitle: bk.title ?? bk.key };
}

// ─── Marchés de MATCH supplémentaires (endpoint par événement) ───────────────
//
// Les trois marchés de base (vainqueur, handicap, total) arrivent pour toute la
// ligue en UN appel. Tout le reste — résultat en 60 min, résultat et total par
// période, totaux alternatifs… — n'est servi que match par match, par
// `/events/{id}/odds`, facturé **1 crédit par marché RENVOYÉ** (un marché que le
// livre ne cote pas ne coûte rien).
//
// D'où trois garde-fous, parce que ce coût-là suit le TRAFIC (un appel par
// match ouvert) et non un calendrier :
//   1. un cache PAR MATCH (`ODDS_EXTRAS_TTL_MIN`, 120 min) avec dédoublonnage
//      en vol et repli sur la dernière réponse ;
//   2. un plafond QUOTIDIEN (`ODDS_EXTRAS_DAILY_BUDGET`, 80 crédits ≈ 2 400/mois
//      tant que le backfill tourne ; à relever après) — au-delà, on sert le
//      périmé ou rien, jamais un appel de plus ;
//   3. la réserve visiteurs de `oddsQuota`, comme la collecte : ce n'est pas
//      une page vide qu'on évite ici, c'est un enrichissement.
// Seuls les matchs pas encore commencés et à moins de 48 h sont interrogés.

function readPositive(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    logger.warn({ name, raw, fallback: dflt }, '[oddsClient] variable illisible — défaut appliqué.');
    return dflt;
  }
  return n;
}

/**
 * Marchés demandés par match.
 *
 * Liste LARGE à dessein : l'endpoint facture les marchés RENVOYÉS, pas ceux
 * demandés — un marché que le livre ne cote pas ne coûte rien. Au sondage du
 * 2026-09-27 (pré-saison, CAR–FLA), Betano n'en renvoyait AUCUN et PlayNow le
 * seul `alternate_spreads` : les livres canadiens publient peu de marchés
 * annexes via The Odds API, du moins hors saison. À re-sonder une fois la
 * saison lancée (`probe_odds_books.py --event`), sans rien changer ici.
 */
export const ODDS_EXTRA_MARKETS = (process.env.ODDS_EXTRA_MARKETS ?? '').trim()
  || [
    'h2h_3_way', 'alternate_totals', 'alternate_spreads', 'btts',
    'h2h_3_way_p1', 'h2h_3_way_p2', 'h2h_3_way_p3',
    'totals_p1', 'totals_p2', 'totals_p3',
  ].join(',');
/**
 * Coût supposé d'un premier appel sur un match, avant d'avoir vu le vrai
 * (`x-requests-last`). Prendre la longueur de la liste serait très pessimiste
 * puisque le livre en renvoie peu : le plafond bloquerait après deux matchs.
 */
const FIRST_CALL_ESTIMATE = 5;
const EXTRAS_TTL_MS = readPositive('ODDS_EXTRAS_TTL_MIN', 120) * 60_000;
const EXTRAS_DAILY_BUDGET = readPositive('ODDS_EXTRAS_DAILY_BUDGET', 80);
const EXTRAS_HORIZON_MS = 48 * 60 * 60_000;

const extrasCache = new TtlCache<OddsEvent['bookmakers']>(EXTRAS_TTL_MS, 64, 'odds-extras');
let extrasDay = '';
let extrasSpent = 0;
/** Dernier coût observé par match : l'estimation du prochain appel. */
const lastCost = new Map<string, number>();

function spendToday(): number {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== extrasDay) { extrasDay = day; extrasSpent = 0; }
  return extrasSpent;
}

/**
 * Livres (avec leurs marchés supplémentaires) d'UN match, chez le livre
 * d'affichage. `[]` quand rien n'est disponible — jamais une erreur.
 */
export async function fetchGameExtras(homeAbbr: string, awayAbbr: string): Promise<OddsEvent['bookmakers']> {
  if (!ODDS_KEY || !ODDS_EXTRA_MARKETS) return [];
  const home = homeAbbr.toUpperCase(), away = awayAbbr.toUpperCase();
  const events = await fetchAllOdds();
  const ev = events.find((e) => {
    const eh = toAbbr(e.home_team), ea = toAbbr(e.away_team);
    return (eh === home && ea === away) || (eh === away && ea === home);
  });
  if (!ev?.id) return [];
  const start = Date.parse(ev.commence_time);
  const now = Date.now();
  if (!Number.isFinite(start) || start <= now || start - now > EXTRAS_HORIZON_MS) {
    return extrasCache.getStale(ev.id) ?? [];
  }

  const key = ev.id;
  const fresh = extrasCache.peekFresh(key);
  if (fresh) return fresh;

  const estimate = lastCost.get(key) ?? FIRST_CALL_ESTIMATE;
  if (spendToday() + estimate > EXTRAS_DAILY_BUDGET
      || !(await oddsQuota.collectorMaySpend(estimate))) {
    return extrasCache.getStale(key) ?? [];
  }

  try {
    return await extrasCache.wrap(key, async () => {
      const params = new URLSearchParams({
        apiKey: ODDS_KEY, ...bookParams(), markets: ODDS_EXTRA_MARKETS, oddsFormat: 'decimal',
      });
      const started = Date.now();
      const res = await fetchOdds(`${ODDS_BASE}/sports/${SPORT_KEY}/events/${encodeURIComponent(key)}/odds?${params}`);
      recordUpstream('odds', Date.now() - started, res.ok);
      oddsQuota.observe(res.headers);
      // Coût RÉEL de l'appel, renvoyé par le fournisseur ; à défaut, l'estimation.
      const last = Number(res.headers?.get?.('x-requests-last'));
      const cost = Number.isFinite(last) && last >= 0 ? last : estimate;
      spendToday();
      extrasSpent += cost;
      lastCost.set(key, Math.max(1, cost));
      if (!res.ok) {
        logger.warn({ status: res.status }, '[oddsClient] extras');
        throw new Error(`odds extras ${res.status}`);
      }
      const body = (await res.json()) as { bookmakers?: OddsEvent['bookmakers'] };
      return body?.bookmakers ?? [];
    });
  } catch {
    return extrasCache.getStale(key) ?? [];
  }
}

/** État du budget des marchés supplémentaires — pour `/api/dev/data-health`. */
export function extrasBudgetState() {
  return { day: extrasDay || null, spent: spendToday(), budget: EXTRAS_DAILY_BUDGET,
           markets: ODDS_EXTRA_MARKETS, ttlMin: EXTRAS_TTL_MS / 60_000 };
}

