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

const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const ODDS_KEY  = process.env.ODDS_API_KEY;
const SPORT_KEY = 'icehockey_nhl';

const TTL = 5 * 60_000; // 5 min

interface OddsOutcome { name: string; price: number; point?: number }
interface OddsEvent {
  home_team: string;
  away_team: string;
  commence_time: string;
  bookmakers: Array<{
    key: string;
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

/** Événement brut de The Odds API (exposé pour le logger de cotes). */
export type RawOddsEvent = OddsEvent;

/** Récupère tous les événements NHL bruts (h2h + totals). Pour oddsLogger. */
export async function fetchRawOdds(): Promise<RawOddsEvent[]> {
  return fetchAllOdds();
}

/**
 * Récupère UNIQUEMENT la puck line — **1 crédit au lieu de 3** (A3).
 *
 * The Odds API facture un crédit par marché et par région. Une passe complète
 * en coûte donc trois, alors que le seul marché encore vivant est la puck line
 * (A2 : le moneyline est clos, les totaux sont condamnés à −2.75 % de ROI).
 * Cette version permet quatre observations rapprochées de la mise au jeu pour
 * un tiers du prix d'une passe complète — c'est ce qui donne au CLV une vraie
 * clôture par créneau de match au lieu d'un prix vieux de plusieurs heures.
 *
 * **NE PASSE VOLONTAIREMENT PAS PAR `oddsCache`.** Le cache est partagé avec le
 * proxy public : y déposer une réponse dépourvue de `h2h` et de `totals`
 * priverait les visiteurs de leurs cotes pendant tout le TTL. Le troupeau que
 * `TtlCache` corrige n'existe pas ici — un seul appelant, une fois par créneau.
 *
 * Pas de repli sur des cotes périmées non plus : un collecteur qui rate un
 * cycle perd un point de mesure, ce qui est sans gravité, là où réécrire un
 * snapshot avec un prix ancien fabriquerait un faux mouvement de ligne.
 */
export async function fetchSpreadsOnly(): Promise<RawOddsEvent[]> {
  if (!ODDS_KEY) return [];

  const params = new URLSearchParams({
    apiKey:     ODDS_KEY,
    regions:    'eu',
    markets:    'spreads',
    oddsFormat: 'decimal',
  });

  const started = Date.now();
  try {
    const res = await fetch(`${ODDS_BASE}/sports/${SPORT_KEY}/odds?${params}`);
    recordUpstream('odds', Date.now() - started, res.ok);
    // Y compris en erreur : un 429 porte le solde, et c'est le moment où il
    // compte le plus.
    oddsQuota.observe(res.headers);
    if (!res.ok) {
      logger.error({ status: res.status }, '[oddsClient] spreads');
      return [];
    }
    return (await res.json()) as OddsEvent[];
  } catch (err: any) {
    recordUpstream('odds', Date.now() - started, false);
    logger.error({ err: err?.message }, '[oddsClient] spreads fetch error');
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
async function fetchAllOdds(): Promise<OddsEvent[]> {
  if (!ODDS_KEY) return [];

  const params = new URLSearchParams({
    apiKey:     ODDS_KEY,
    regions:    'eu',
    markets:    'h2h,spreads,totals',
    oddsFormat: 'decimal',
  });
  // Synchrone : rien ne doit s'intercaler entre l'appelant et `wrap`. Un
  // `await` ici ajoutait un tour de boucle d'événements pendant lequel des
  // appelants concurrents n'étaient plus dédoublonnés — c'est-à-dire le bug
  // même que ce module a été écrit pour corriger.
  const ttl = oddsQuota.proxyTtlMs(TTL);

  try {
    // Deuxième consommateur du quota The Odds API, à côté du proxy de
    // `routes/odds.routes.ts`. Il doit être compté lui aussi, sinon le critère
    // « ≤ 2 appels Odds API » du scénario S1 mesure la moitié de la réalité.
    return await oddsCache.wrap(ODDS_CACHE_KEY, async () => {
      const started = Date.now();
      try {
        const res = await fetch(`${ODDS_BASE}/sports/${SPORT_KEY}/odds?${params}`);
        recordUpstream('odds', Date.now() - started, res.ok);
        // Y COMPRIS en erreur : un 429 porte le solde, et c'est justement le
        // moment où l'information compte.
        oddsQuota.observe(res.headers);
        if (!res.ok) {
          logger.error({ status: res.status }, '[oddsClient]');
          // LEVER et non renvoyer `[]` : une réponse vide mise en cache 5 minutes
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
  } catch (err: any) {
    // Repli sur les dernières cotes connues, même expirées — comme le fait déjà
    // le proxy. Des cotes de dix minutes valent mieux qu'aucun facteur marché,
    // et c'est le meilleur prédicteur dont dispose le moteur.
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

/** Sélectionne le book préféré (Bet365 sinon le premier) qui expose le marché demandé. */
function pickBookmaker(ev: OddsEvent, marketKey: string): OddsEvent['bookmakers'][number] | null {
  const withMarket = ev.bookmakers.filter(b => b.markets.some(m => m.key === marketKey));
  if (!withMarket.length) return null;
  return withMarket.find(b => b.key === 'bet365') ?? withMarket[0];
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
