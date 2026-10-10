// ============================================================
//  Value bets — LE critère, partagé par l'accueil et l'alerte push
// ============================================================
//
// ── Pourquoi un seul module (2026-10-02) ────────────────────────────────────
//
// Jusqu'ici trois calculs différents disaient « value » :
//   • l'accueil (client) : `% modèle − round(100 / cote)`, cote NON dé-viggée,
//     seuil 5 points sans plafond, matchs EN DIRECT compris ;
//   • l'alerte push : edge dé-viggé dans [2 %, 6 %], score ≥ 65, totaux inclus ;
//   • le badge des cartes de match : 8 points bruts, côté domicile seulement.
// « 5 points bruts » vaut ~7 points une fois la marge retirée : l'accueil
// montrait précisément ce que l'alerte rejetait comme du bruit. Décision du
// user : l'accueil et l'alerte partagent le même critère — celui-ci.
//
// ── Le critère ──────────────────────────────────────────────────────────────
//
//  1. Match de la journée (heure de l'Est), PAS ENCORE COMMENCÉ. Une proba
//     d'avant-match contre une cote en direct fabrique des écarts énormes, et
//     l'app ne prend pas de paris en direct (décision du 2026-09-28).
//  2. LES DEUX GARDIENS PARTANTS SAISIS dans /dev/saisie pour la journée
//     (`starting_goalies`). Décision du user : pas de gardien confirmé, pas de
//     value bet. Un gros edge est le plus souvent une information que le modèle
//     n'a pas — le gardien d'abord.
//  3. Probabilité du MODÈLE DE SCORE (`probability_score_model` présent), lue
//     dans le paquet ML du match (`getGameMlBundle`), qui traite correctement
//     le côté visiteur (`subject_is_home`). Pas de modèle → pas de value bet ;
//     jamais de repli sur un score de règles, qui n'est pas une probabilité.
//  4. Probabilité du marché DÉ-VIGGÉE chez le livre d'affichage (division
//     proportionnelle, comme le backtest), sur les deux prix du même livre.
//  5. Par marché :
//       vainqueur (moneyline)  edge ∈ [2 %, 6 %]  — bande du backtest
//                                                   walk-forward ; au-delà,
//                                                   info manquée plus que value
//       puck line −1.5         edge ≥ 4 %, jambe qui DONNE les 1,5 buts
//                                                 — règle A2 pré-enregistrée le
//                                                   2026-08-08, figée telle quelle
//     et, pour les deux, EV = p × cote − 1 ≥ VALUE_BET_MIN_EV (0 par défaut) :
//     une sélection à edge positif mais à EV négatif chez ce livre n'est pas
//     une value qu'on peut y prendre.
//  Les totaux sont exclus : clos définitivement par A3 (CLV sous placebo).
//
// ── La cote minimale ────────────────────────────────────────────────────────
//
// `minOdds = 1 / p_modèle` : le seuil de rentabilité selon le modèle. Elle
// permet de vérifier la value chez SON livre (Bet365, Stake), que The Odds API
// ne cote pas. Ce n'est pas une offre : c'est un seuil, affiché comme tel.
//
// ── Coût ────────────────────────────────────────────────────────────────────
//
// Aucun crédit The Odds API : les prix viennent du cache partagé de
// `oddsClient`. Le modèle n'est appelé que pour les matchs qui ont passé les
// filtres gratuits (horaire, gardiens, prix), via le paquet ML déjà en cache
// pour les pages de match. Le résultat est gardé 5 minutes pour tout le monde.

import { pool } from '../db/connection';
import { logger } from '../logger';
import { fetchGamesByDate } from './nhlApiClient';
import { priceForSelection, type BookPrice } from './oddsClient';
import { getGameMlBundle, mlBundleKey } from './gameMlBundle';
import { getStartingGoalies, easternToday } from './startingGoalies';
import type { MLPredictionResult } from './mlApiClient';
import { TtlCache } from './ttlCache';

export type ValueBetMarket = 'moneyline' | 'puck_line';

export interface ValueBet {
  /** Stable pour une sélection : `<gameId>-<market>-<team>`. Clé anti-doublon des alertes. */
  id:           string;
  gameId:       string;
  gameDate:     string;
  startTimeUTC: string | null;
  market:       ValueBetMarket;
  /** Abréviation de l'équipe sur laquelle on mise. */
  team:         string;
  opponent:     string;
  isHome:       boolean;
  /** Handicap de la sélection (−1.5) ; `null` pour le vainqueur. */
  line:         number | null;
  /** Probabilité du modèle de score, 0–1. */
  modelProb:    number;
  /** Probabilité du marché dé-viggée chez le livre, 0–1. */
  marketProb:   number;
  /** modelProb − marketProb. Le critère dont le ROI a été mesuré au backtest. */
  edge:         number;
  /** modelProb × price − 1. */
  ev:           number;
  /** Cote décimale offerte par le livre d'affichage. */
  price:        number;
  bookmaker:    string;
  bookTitle:    string;
  /** Seuil de rentabilité selon le modèle, 1 / modelProb (décimal). */
  minOdds:      number;
}

// ─── Les règles ───────────────────────────────────────────────────────────────

/**
 * Lecture durcie d'une fraction en variable d'environnement : vide, illisible
 * ou négative → défaut. Même piège que `ODDS_USER_RESERVE` — ces variables se
 * posent à la main dans Railway, et `Number('')` vaut 0.
 */
function envFraction(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    logger.warn({ name, raw, fallback: dflt }, '[valueBets] variable illisible — défaut appliqué.');
    return dflt;
  }
  return n;
}

/** Règle A2 — pré-enregistrée, NON réglable : la changer invaliderait le test. */
export const PUCK_LINE_MIN_EDGE = 0.04;

export interface MarketRule { minEdge: number; maxEdge: number | null }

export function rules(): Record<ValueBetMarket, MarketRule> & { minEv: number } {
  const maxMl = envFraction('VALUE_BET_MAX_EDGE', 0.06);
  return {
    moneyline: {
      minEdge: envFraction('VALUE_BET_MIN_EDGE', 0.02),
      // 0 = plafond désactivé, comme avant.
      maxEdge: maxMl > 0 ? maxMl : null,
    },
    puck_line: { minEdge: PUCK_LINE_MIN_EDGE, maxEdge: null },
    minEv: envFraction('VALUE_BET_MIN_EV', 0),
  };
}

/**
 * Juge UNE sélection. Pur, sans I/O — c'est lui que les tests verrouillent.
 *
 * `price` est la cote de la sélection, `otherPrice` celle du côté opposé chez
 * le MÊME livre (sans elle, pas de dé-vig possible → pas de jugement).
 */
export function judgeSelection(
  market: ValueBetMarket,
  modelProb: number,
  price: number,
  otherPrice: number,
  r = rules(),
): { marketProb: number; edge: number; ev: number } | null {
  if (!(modelProb > 0 && modelProb < 1) || !(price > 1) || !(otherPrice > 1)) return null;
  const inv = 1 / price;
  const marketProb = inv / (inv + 1 / otherPrice);
  const edge = modelProb - marketProb;
  const ev = modelProb * price - 1;
  const rule = r[market];
  // Tolérance d'arrondi : un edge de 0.04 calculé en flottant vaut parfois
  // 0.039999… et doit passer la règle « ≥ 4 % ».
  const EPS = 1e-9;
  if (edge + EPS < rule.minEdge) return null;
  if (rule.maxEdge != null && edge - EPS > rule.maxEdge) return null;
  if (ev + EPS < r.minEv) return null;
  return { marketProb, edge, ev };
}

// ─── Lecture des entrées ──────────────────────────────────────────────────────

/**
 * Probabilité 0–1 du modèle DE SCORE pour une question du paquet, ou null.
 *
 * `probability_score_model` n'est rempli que si le modèle de score a répondu :
 * sinon le service est retombé sur une heuristique (classifieur, « × 0,60 »
 * de la puck line…), que rien n'a validée pour l'edge. `live` exclut un chiffre
 * recalculé sur l'état d'un match commencé.
 */
function scoreModelProb(r: MLPredictionResult | null | undefined): number | null {
  if (!r || r.live || r.probability_score_model == null) return null;
  // La probabilité NON arrondie : l'entier `probability` porte jusqu'à ±0,5
  // point d'erreur, sur une règle large de 2 à 6 points (INCOHERENCES_ML §4).
  // Repli sur l'entier seulement face à un service ML qui ne l'envoie pas.
  const exact = r.probability_exact;
  if (typeof exact === 'number' && Number.isFinite(exact)) {
    return exact > 0 && exact < 1 ? exact : null;
  }
  const p = r.probability;
  return typeof p === 'number' && Number.isFinite(p) && p > 0 && p < 100 ? p / 100 : null;
}

/** Le match n'a pas commencé : statut ET heure de mise au jeu, les deux. */
export function notStarted(game: any, now: number): boolean {
  if (game?.status !== 'scheduled') return false;
  const start = game?.startTimeUTC ? Date.parse(game.startTimeUTC) : NaN;
  return Number.isFinite(start) && start > now;
}

// ─── Calcul ───────────────────────────────────────────────────────────────────

async function priceOf(home: string, away: string, marketType: string,
                       selectionValue: string, line?: number): Promise<BookPrice | null> {
  try {
    return await priceForSelection({ homeAbbr: home, awayAbbr: away, marketType, selectionValue, line });
  } catch {
    return null;
  }
}

async function valueBetsForGame(game: any): Promise<ValueBet[]> {
  const home = String(game.homeTeam?.abbreviation ?? '').toUpperCase();
  const away = String(game.awayTeam?.abbreviation ?? '').toUpperCase();
  if (!home || !away) return [];

  // Prix d'abord : gratuits (cache partagé). Sans prix, inutile de réveiller le modèle.
  const [mlHome, mlAway, plHomeM, plAwayP, plAwayM, plHomeP] = await Promise.all([
    priceOf(home, away, 'moneyline', home),
    priceOf(home, away, 'moneyline', away),
    priceOf(home, away, 'puck_line', home, -1.5),
    priceOf(home, away, 'puck_line', away, 1.5),
    priceOf(home, away, 'puck_line', away, -1.5),
    priceOf(home, away, 'puck_line', home, 1.5),
  ]);
  const hasMl = !!(mlHome && mlAway);
  // La jambe qui DONNE les 1,5 buts, et son vis-à-vis chez le même livre.
  const pl = plHomeM && plAwayP ? { isHome: true, minus: plHomeM, plus: plAwayP }
           : plAwayM && plHomeP ? { isHome: false, minus: plAwayM, plus: plHomeP }
           : null;
  if (!hasMl && !pl) return [];

  let bundle;
  try {
    bundle = await getGameMlBundle(String(game.id));
  } catch (err: any) {
    logger.warn({ err: err?.message, gameId: game.id }, '[valueBets] paquet ML indisponible');
    return [];
  }

  const r = rules();
  const out: ValueBet[] = [];
  const push = (market: ValueBetMarket, isHome: boolean, line: number | null,
                modelProb: number | null, mine: BookPrice, theirs: BookPrice) => {
    if (modelProb == null) return;
    const j = judgeSelection(market, modelProb, mine.price, theirs.price, r);
    if (!j) return;
    const team = isHome ? home : away;
    out.push({
      id: `${game.id}-${market}-${team}`,
      gameId: String(game.id),
      gameDate: String(game.gameDate ?? ''),
      startTimeUTC: game.startTimeUTC ?? null,
      market, team, opponent: isHome ? away : home, isHome, line,
      modelProb, marketProb: j.marketProb, edge: j.edge, ev: j.ev,
      price: mine.price, bookmaker: mine.bookmaker, bookTitle: mine.bookTitle,
      minOdds: 1 / modelProb,
    });
  };

  if (hasMl) {
    push('moneyline', true,  null, scoreModelProb(bundle.byKey[mlBundleKey('moneyline', null, null, true)]),  mlHome!, mlAway!);
    push('moneyline', false, null, scoreModelProb(bundle.byKey[mlBundleKey('moneyline', null, null, false)]), mlAway!, mlHome!);
  }
  if (pl) {
    const p = scoreModelProb(bundle.byKey[mlBundleKey('puck_line', -1.5, null, pl.isHome)]);
    push('puck_line', pl.isHome, -1.5, p, pl.minus, pl.plus);
  }
  return out;
}

/**
 * Tous les value bets du moment, du plus gros edge au plus petit.
 * `now` et `date` ne servent qu'aux tests.
 */
export async function computeValueBets(now = Date.now(), date = easternToday()): Promise<ValueBet[]> {
  const [games, goalies] = await Promise.all([fetchGamesByDate(date), getStartingGoalies(date)]);
  const confirmed = (abbr: unknown) => {
    const name = goalies[String(abbr ?? '').toUpperCase()];
    return typeof name === 'string' && name.trim() !== '';
  };
  const eligible = games.filter((g: any) =>
    notStarted(g, now) && confirmed(g.homeTeam?.abbreviation) && confirmed(g.awayTeam?.abbreviation));

  const perGame = await Promise.all(eligible.map((g: any) => valueBetsForGame(g).catch((err: any) => {
    logger.warn({ err: err?.message, gameId: g?.id }, '[valueBets] match ignoré');
    return [] as ValueBet[];
  })));
  const bets = perGame.flat().sort((a, b) => b.edge - a.edge);
  await logValueBets(bets);
  return bets;
}

// ─── Journal (CLV) ────────────────────────────────────────────────────────────

/**
 * Écrit chaque sélection dans `value_bet_log` (migration 040). La première
 * détection fixe le prix jugé par le CLV ; les suivantes ne touchent que `last_*`.
 *
 * Jamais bloquant : un journal en panne (migration pas encore passée, base
 * indisponible) ne doit pas retirer les value bets de l'écran.
 */
export async function logValueBets(bets: ValueBet[]): Promise<void> {
  for (const b of bets) {
    try {
      const [home, away] = b.isHome ? [b.team, b.opponent] : [b.opponent, b.team];
      await pool.query(
        `INSERT INTO value_bet_log
           (game_id, game_date, home_team, away_team, commence_time, market, team, line, bookmaker,
            first_price, first_model_prob, first_market_prob, first_edge, last_price, last_edge)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $10, $13)
         ON CONFLICT (game_id, market, team) DO UPDATE
           SET last_seen_at = NOW(), last_price = EXCLUDED.last_price, last_edge = EXCLUDED.last_edge`,
        [b.gameId, b.gameDate, home, away, b.startTimeUTC, b.market, b.team, b.line, b.bookmaker,
         b.price, b.modelProb, b.marketProb, b.edge],
      );
    } catch (err: any) {
      logger.warn({ err: err?.message, id: b.id }, '[valueBets] journal non écrit');
      return;   // même cause pour les suivantes : inutile d'insister
    }
  }
}

// ─── Cache partagé ────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60_000;
const cache = new TtlCache<ValueBet[]>(CACHE_TTL_MS, 1, 'value-bets');

/** Les value bets du moment — calcul partagé entre visiteurs et alerte, 5 minutes. */
export function getValueBets(): Promise<ValueBet[]> {
  return cache.wrap('today', () => computeValueBets());
}

/**
 * Ce que l'écran reçoit à la lecture : le cache peut avoir jusqu'à 5 minutes,
 * et un match peut avoir commencé entre-temps. On le retire à la sortie.
 */
export async function getCurrentValueBets(now = Date.now()): Promise<ValueBet[]> {
  const bets = await getValueBets();
  return bets.filter((b) => {
    const start = b.startTimeUTC ? Date.parse(b.startTimeUTC) : NaN;
    return Number.isFinite(start) && start > now;
  });
}
