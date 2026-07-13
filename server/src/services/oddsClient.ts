/**
 * oddsClient.ts
 * Récupère les cotes moneyline (h2h) NHL depuis The Odds API et les convertit
 * en probabilité implicite dé-viggée (marge du book retirée).
 *
 * La cote de clôture du marché est le meilleur prédicteur disponible : les books
 * agrègent l'information de tous les parieurs. On l'utilise comme facteur pondéré.
 *
 * Nécessite la variable d'environnement ODDS_API_KEY (même clé que le proxy
 * odds.routes.ts). Sans clé ou en cas d'échec réseau, retourne null → le moteur
 * retombe proprement sur les autres facteurs.
 */

const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const ODDS_KEY  = process.env.ODDS_API_KEY;
const SPORT_KEY = 'icehockey_nhl';

interface CacheEntry { data: OddsEvent[]; expiresAt: number }
let cache: CacheEntry | null = null;
const TTL = 5 * 60_000; // 5 min

interface OddsOutcome { name: string; price: number }
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

/** Récupère toutes les cotes h2h NHL (mise en cache 5 min). */
async function fetchAllOdds(): Promise<OddsEvent[]> {
  if (!ODDS_KEY) return [];
  if (cache && cache.expiresAt > Date.now()) return cache.data;

  const params = new URLSearchParams({
    apiKey:     ODDS_KEY,
    regions:    'eu',
    markets:    'h2h',
    oddsFormat: 'decimal',
  });
  try {
    const res = await fetch(`${ODDS_BASE}/sports/${SPORT_KEY}/odds?${params}`);
    if (!res.ok) { console.error('[oddsClient]', res.status); return []; }
    const data = (await res.json()) as OddsEvent[];
    cache = { data, expiresAt: Date.now() + TTL };
    return data;
  } catch (err: any) {
    console.error('[oddsClient] fetch error', err?.message);
    return [];
  }
}

/** Normalise un nom d'équipe pour un matching tolérant ("Toronto Maple Leafs" ⊃ "Maple Leafs"). */
function norm(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z]/g, '');
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

  const h = norm(homeName), a = norm(awayName);
  const ev = events.find(e => {
    const eh = norm(e.home_team), ea = norm(e.away_team);
    const match = (x: string, y: string) => x.includes(y) || y.includes(x);
    return (match(eh, h) && match(ea, a)) || (match(eh, a) && match(ea, h));
  });
  if (!ev || !ev.bookmakers?.length) return null;

  // Préfère Bet365, sinon le premier book disponible.
  const bk = ev.bookmakers.find(b => b.key === 'bet365') ?? ev.bookmakers[0];
  const h2h = bk.markets.find(m => m.key === 'h2h');
  if (!h2h) return null;

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
