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

const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const ODDS_KEY  = process.env.ODDS_API_KEY;
const SPORT_KEY = 'icehockey_nhl';

interface CacheEntry { data: OddsEvent[]; expiresAt: number }
let cache: CacheEntry | null = null;
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

/** Récupère toutes les cotes NHL (h2h + totals, mise en cache 5 min). */
async function fetchAllOdds(): Promise<OddsEvent[]> {
  if (!ODDS_KEY) return [];
  if (cache && cache.expiresAt > Date.now()) return cache.data;

  const params = new URLSearchParams({
    apiKey:     ODDS_KEY,
    regions:    'eu',
    markets:    'h2h,totals',
    oddsFormat: 'decimal',
  });
  try {
    const res = await fetch(`${ODDS_BASE}/sports/${SPORT_KEY}/odds?${params}`);
    if (!res.ok) { logger.error({ status: res.status }, '[oddsClient]'); return []; }
    const data = (await res.json()) as OddsEvent[];
    cache = { data, expiresAt: Date.now() + TTL };
    return data;
  } catch (err: any) {
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
