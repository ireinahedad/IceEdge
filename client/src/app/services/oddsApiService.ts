// services/oddsApiService.ts
// Fetches live bookmaker odds via the backend proxy (/api/odds/*).
//
// ⚠️ Le livre servi n'est PAS Bet365 : The Odds API ne cote ni Bet365 ni Stake
// sur la NHL. Le serveur relaie un livre canadien (`ODDS_BOOKMAKERS`, défaut
// Betano Ontario) et chaque événement porte son `key`/`title` — c'est ce nom-là
// qu'un écran doit afficher à côté d'un prix. Le chemin `/odds/bet365/` est
// gardé tel quel pour ne pas casser les clients déjà déployés.
// The Odds API key now lives server-side only — it is never shipped to the client.
// Falls back to empty array when the backend/upstream is unavailable.

import { env } from "../env";
import { fetchWithTimeout } from "./http";

// Backend base, e.g. https://<railway>/api — validated in env.ts, no localhost fallback.
const API_BASE = env.apiBase;

// Sport keys used by The Odds API
export const ODDS_SPORT_KEYS = {
  hockey: "icehockey_nhl",
} as const;

export interface OddsOutcome {
  name: string;
  price: number; // decimal odds e.g. 1.85
}

export interface OddsMarket {
  key: string;      // e.g. "h2h", "spreads", "totals"
  lastUpdate: string;
  outcomes: OddsOutcome[];
}

export interface OddsEvent {
  id: string;
  sportKey: string;
  commenceTime: string; // ISO 8601
  homeTeam: string;
  awayTeam: string;
  bookmakers: Array<{
    key: string;
    title: string;
    lastUpdate: string;
    markets: OddsMarket[];
  }>;
}

/**
 * Ramène un événement du fournisseur à la forme déclarée par `OddsEvent`.
 *
 * ⚠️ LE BUG QUE ÇA CORRIGE (2026-09-27). Le proxy relaie le JSON de The Odds
 * API tel quel, c'est-à-dire en snake_case (`home_team`, `commence_time`,
 * `last_update`). Ce module le déclarait en camelCase et le castait sans rien
 * convertir : `event.homeTeam` valait donc toujours `undefined`, et
 * `findOddsEvent` comme `extractH2HOdds` ne trouvaient jamais aucun match.
 * Même avec un livre valide, AUCUNE cote n'aurait pu s'afficher. Les deux
 * écritures sont acceptées, pour qu'un futur proxy qui convertirait côté
 * serveur ne casse rien.
 */
function normalizeEvent(raw: any): OddsEvent {
  return {
    id: String(raw?.id ?? ""),
    sportKey: raw?.sportKey ?? raw?.sport_key ?? "",
    commenceTime: raw?.commenceTime ?? raw?.commence_time ?? "",
    homeTeam: raw?.homeTeam ?? raw?.home_team ?? "",
    awayTeam: raw?.awayTeam ?? raw?.away_team ?? "",
    bookmakers: (raw?.bookmakers ?? []).map((b: any) => ({
      key: String(b?.key ?? ""),
      title: String(b?.title ?? b?.key ?? ""),
      lastUpdate: b?.lastUpdate ?? b?.last_update ?? "",
      markets: (b?.markets ?? []).map((m: any) => ({
        key: String(m?.key ?? ""),
        lastUpdate: m?.lastUpdate ?? m?.last_update ?? "",
        outcomes: m?.outcomes ?? [],
      })),
    })),
  };
}

/**
 * Cotes d'un sport, chez le livre que relaie le serveur.
 * Returns [] if no API key is set or the request fails.
 */
export async function fetchBet365Odds(
  sportKey: string,
  markets: string[] = ["h2h"]
): Promise<OddsEvent[]> {
  try {
    const params = new URLSearchParams({ markets: markets.join(",") });
    const res = await fetchWithTimeout(
      `${API_BASE}/odds/bet365/${encodeURIComponent(sportKey)}?${params}`
    );
    if (!res.ok) {
      console.error("[oddsApi] HTTP", res.status);
      return [];
    }
    const body = await res.json();
    return Array.isArray(body) ? body.map(normalizeEvent) : [];
  } catch (err) {
    console.error("[oddsApi] fetch error", err);
    return [];
  }
}

/**
 * Prix moneyline (vainqueur du match) d'un événement, avec le NOM du livre qui
 * les propose — à afficher à côté du prix. Un prix étiqueté d'un autre livre
 * enverrait l'utilisateur chercher une cote qui n'existe pas chez lui.
 * Returns null if no bookmaker prices the market.
 */
export function extractH2HOdds(
  event: OddsEvent
): { home: number; away: number; bookTitle: string } | null {
  const book = event.bookmakers.find((b) => b.markets.some((m) => m.key === "h2h"));
  if (!book) return null;

  const h2h = book.markets.find((m) => m.key === "h2h");
  if (!h2h || h2h.outcomes.length < 2) return null;

  const home = h2h.outcomes.find((o) => o.name === event.homeTeam);
  const away = h2h.outcomes.find((o) => o.name === event.awayTeam);
  if (!home || !away) return null;

  return { home: home.price, away: away.price, bookTitle: book.title || book.key };
}

// `decimalToWinPct` et `fetchAvailableSports` supprimées le 2026-08-10 (0 appelant).
// La conversion cote → probabilité vit dans `HockeyLanding` (`impliedPct`), qui
// dévigue la paire au lieu d'inverser une seule cote — c'est la bonne version.

// ─── Prix des jambes d'un coupon ────────────────────────────────────────────

/** Ce que le serveur a besoin de savoir d'une jambe pour en trouver le prix. */
export interface LegPriceQuery {
  id: string;
  gameId: string;
  marketType: string;
  selectionValue: string;
  line?: number | null;
}

/** Marchés que le livre cote — les seuls envoyés (le serveur refuserait le reste). */
const PRICED_MARKETS = new Set(["moneyline", "puck_line", "total_goals"]);

/**
 * Vrai prix du livre d'affichage pour chaque jambe cotée, par id de jambe.
 * Une jambe absente de la réponse n'a pas de prix (marché non coté, match
 * commencé, flux en panne) — ce n'est jamais une erreur pour l'appelant.
 */
export async function fetchLegPrices(
  legs: LegPriceQuery[],
): Promise<Record<string, { price: number; bookTitle: string }>> {
  const wanted = legs
    .filter((l) => l.gameId && /^\d{6,12}$/.test(l.gameId) && PRICED_MARKETS.has(l.marketType) && l.selectionValue)
    .slice(0, 20)
    .map((l) => ({ id: l.id, gameId: l.gameId, marketType: l.marketType,
                   selectionValue: l.selectionValue, line: l.line ?? null }));
  if (!wanted.length) return {};
  try {
    const res = await fetchWithTimeout(`${API_BASE}/odds/legs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ legs: wanted }),
    });
    if (!res.ok) return {};
    const body = await res.json();
    return body?.prices ?? {};
  } catch {
    return {};
  }
}

