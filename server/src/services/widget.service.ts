// ============================================================
//  Widget iOS « paris en cours » — APPLE_PLAN 4.2
// ============================================================
// Ce que le widget d'écran d'accueil affiche : les coupons EN ATTENTE de
// l'utilisateur, avec, pour chacun, la probabilité au moment du pari et la
// probabilité ACTUELLE — celle du modèle ML conditionnée par le score et le
// temps restant quand le match est commencé (`gameMlBundle.applyLive`).
//
// iOS ne réveille un widget que toutes les 15–30 min : ce n'est pas du temps
// réel, c'est « où en sont mes paris » d'un coup d'œil.
//
// Authentification : un jeton propre au widget (migration 044), lecture seule,
// une seule route. Voir l'en-tête de la migration pour le pourquoi.

import { pool } from '../db/connection';
import { logger } from '../logger';
import { TtlCache } from './ttlCache';
import { mapLimit } from './concurrency';
import { fetchGameById } from './nhlApiClient';
import { buildPrematchGameMarkets, type BetOption, type MarketGroup } from './nhlPredictions';
import { getGameMlBundle, type GameMlBundle } from './gameMlBundle';
import { normalizeMarket } from './parlayProbability';

export { issueWidgetToken, revokeWidgetToken, revokeAllWidgetTokens, userForWidgetToken } from './widgetTokens';

// ---- Appariement jambe → tuile du match ------------------------------------

/**
 * Marché + sélection de règlement d'une tuile — le jumeau serveur de
 * `settlementFields` (client, `gameMarkets.tsx`), qui écrit ces deux champs
 * dans la jambe du coupon. Les deux DOIVENT produire la même chose.
 */
export function optionSettleFields(o: BetOption): { market?: string; selection?: string } {
  const ml = o.ml;
  if (!ml) return {};
  if (ml.settleMarket) return { market: ml.settleMarket, selection: ml.settleSelection };
  if (ml.type === 'game' || ml.type === 'team') {
    const n = normalizeMarket(ml.propType ?? 'moneyline', ml.selection ?? ml.subjectId);
    return { market: n.market, selection: n.selection };
  }
  return {};
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

/**
 * La tuile du match qui correspond à une jambe de coupon, ou null.
 * Même marché, même sélection, même ligne ; à égalité (« MTL gagne » et « MTL
 * gagne en temps réglementaire » règlent tous deux `moneyline/MTL`), l'étiquette
 * exacte de la jambe départage.
 */
export function findLegOption(groups: MarketGroup[], leg: any): BetOption | null {
  const market = norm(leg?.marketType);
  if (!market) return null;
  const sel  = norm(leg?.selectionValue);
  const line = leg?.line == null ? null : Number(leg.line);

  const candidates: BetOption[] = [];
  for (const g of groups) for (const o of g.options) {
    const f = optionSettleFields(o);
    if (norm(f.market) !== market) continue;
    if (sel && norm(f.selection) !== sel) continue;
    const oLine = o.ml?.line == null ? null : Number(o.ml.line);
    if (line != null && oLine != null && Math.abs(line - oLine) > 1e-9) continue;
    if ((line == null) !== (oLine == null)) continue;
    candidates.push(o);
  }
  if (candidates.length === 0) return null;
  const label = norm(leg?.marketLabel);
  return candidates.find((o) => norm(o.label) === label) ?? candidates[0];
}

// ---- Construction de la réponse --------------------------------------------

export type WidgetLang = 'fr' | 'en';
export type GameState = 'scheduled' | 'live' | 'final';

export interface WidgetGame {
  state:     GameState;
  home:      string;
  away:      string;
  homeScore: number | null;
  awayScore: number | null;
  period:    number | null;
  clock:     string | null;
  startsAt:  string | null;
}

export interface WidgetLeg {
  placedPct:  number | null;
  currentPct: number | null;
  live:       boolean;
  game:       WidgetGame | null;
}

export interface WidgetBet {
  id:         string;
  title:      string;
  /** Ligne de match : « MTL 2–1 TOR · P2 12:34 », « MTL @ TOR », « 3 matchs ». */
  subtitle:   string;
  state:      GameState;
  legs:       number;
  /** Probabilité du coupon au moment du pari, 0–100. */
  placedPct:  number | null;
  /** Probabilité actuelle, 0–100 (jambes non recalculables : leur chiffre du pari). */
  currentPct: number | null;
  /** Au moins une jambe recalculée sur l'état d'un match en cours. */
  live:       boolean;
  /** Mise au jeu la plus proche encore à venir — le widget l'affiche en heure locale. */
  startsAt:   string | null;
}

export interface WidgetPayload {
  generatedAt:  string;
  pendingCount: number;
  bets:         WidgetBet[];
  /** Conseil au widget : rafraîchir plus souvent quand un match est en cours. */
  refreshAfterSec: number;
}

const clampPct = (p: number) => Math.max(0, Math.min(100, p));
const round1 = (p: number) => Math.round(p * 10) / 10;

function periodLabel(g: WidgetGame, lang: WidgetLang): string {
  if (g.period == null) return '';
  if (g.period > 3) return lang === 'fr' ? 'Prol.' : 'OT';
  return `P${g.period}${g.clock ? ` ${g.clock}` : ''}`;
}

export function gameLine(g: WidgetGame, lang: WidgetLang): string {
  if (g.state === 'scheduled' || g.homeScore == null || g.awayScore == null) return `${g.away} @ ${g.home}`;
  const score = `${g.away} ${g.awayScore}–${g.homeScore} ${g.home}`;
  if (g.state === 'final') return `${score} · ${lang === 'fr' ? 'Final' : 'Final'}`;
  const p = periodLabel(g, lang);
  return p ? `${score} · ${p}` : score;
}

/** Résume un coupon à partir de ses jambes déjà enrichies. Pur — testé. */
export function summarizeSlip(
  slip: { id: string; legs: any[]; combinedProbability: number | null },
  legs: WidgetLeg[],
  lang: WidgetLang,
): WidgetBet {
  const n = slip.legs.length;
  const single = n === 1;
  const title = single
    ? String(slip.legs[0]?.selection ?? slip.legs[0]?.marketLabel ?? '').trim() || (lang === 'fr' ? 'Pari' : 'Bet')
    : (lang === 'fr' ? `Combiné · ${n} paris` : `${n}-leg parlay`);

  // Probabilité actuelle : produit des jambes (chiffre live s'il existe, sinon
  // celui du pari). Le coupon garde sa propre probabilité « au pari », qui tient
  // compte des corrélations ; l'actuelle est le produit naïf — assez pour une
  // tendance d'un coup d'œil, pas pour un calcul.
  let prod = 1;
  let known = true;
  for (const l of legs) {
    const p = l.currentPct ?? l.placedPct;
    if (p == null) { known = false; break; }
    prod *= clampPct(p) / 100;
  }
  const currentPct = known && legs.length ? round1(prod * 100) : null;
  const placedPct = slip.combinedProbability != null
    ? round1(Number(slip.combinedProbability))
    : (single ? legs[0]?.placedPct ?? null : null);

  const games = legs.map((l) => l.game).filter((g): g is WidgetGame => !!g);
  const state: GameState = games.some((g) => g.state === 'live') ? 'live'
    : games.length > 0 && games.every((g) => g.state === 'final') ? 'final' : 'scheduled';

  const distinct = new Map(games.map((g) => [`${g.away}@${g.home}`, g]));
  let subtitle = '';
  if (distinct.size === 1) subtitle = gameLine([...distinct.values()][0], lang);
  else if (distinct.size > 1) {
    const liveG = games.find((g) => g.state === 'live');
    const k = distinct.size;
    subtitle = liveG
      ? `${gameLine(liveG, lang)} · +${k - 1}`
      : (lang === 'fr' ? `${k} matchs` : `${k} games`);
  }

  const upcoming = games
    .filter((g) => g.state === 'scheduled' && g.startsAt)
    .map((g) => g.startsAt!)
    .sort()[0] ?? null;

  return {
    id: slip.id, title, subtitle, state, legs: n,
    placedPct, currentPct,
    live: legs.some((l) => l.live),
    startsAt: upcoming,
  };
}

// ---- Accès aux données (caches) --------------------------------------------

/** Liste des tuiles d'un match : ne bouge pas pendant la partie (seuls les chiffres bougent). */
const groupsCache = new TtlCache<MarketGroup[]>(10 * 60_000, 300, 'widgetGameGroups');

function toWidgetGame(g: any): WidgetGame | null {
  if (!g) return null;
  const st = g.status === 'live' || g.status === 'final' ? g.status : 'scheduled';
  return {
    state:     st,
    home:      String(g.homeTeam?.abbreviation ?? ''),
    away:      String(g.awayTeam?.abbreviation ?? ''),
    homeScore: g.homeTeam?.score ?? null,
    awayScore: g.awayTeam?.score ?? null,
    period:    g.period ?? null,
    clock:     g.clock ?? null,
    startsAt:  g.startTimeUTC ?? null,
  };
}

interface GameData { game: WidgetGame | null; groups: MarketGroup[] | null; bundle: GameMlBundle | null }

async function loadGame(gameId: string): Promise<GameData> {
  const [game, groups, bundle] = await Promise.all([
    fetchGameById(gameId).then(toWidgetGame).catch(() => null),
    groupsCache.wrap(gameId, () => buildPrematchGameMarkets(gameId)).catch(() => null),
    // Service ML en panne : les jambes gardent leur chiffre du pari.
    getGameMlBundle(gameId).catch(() => null),
  ]);
  return { game, groups, bundle };
}

function enrichLeg(leg: any, data: GameData | undefined): WidgetLeg {
  const placed = Number(leg?.probability);
  const placedPct = Number.isFinite(placed) ? clampPct(placed) : null;
  if (!data) return { placedPct, currentPct: null, live: false, game: null };

  let currentPct: number | null = null;
  let live = false;
  if (data.groups && data.bundle) {
    const o = findLegOption(data.groups, leg);
    const r = o ? data.bundle.results[o.id] : null;
    if (r && typeof r.probability === 'number' && Number.isFinite(r.probability)) {
      currentPct = clampPct(r.probability);
      live = r.live === true;
    }
  }
  return { placedPct, currentPct, live, game: data.game };
}

/** Coupons affichés au plus (le grand widget en montre 6). */
const MAX_BETS = 6;

export async function liveBetsFor(userId: string, lang: WidgetLang): Promise<WidgetPayload> {
  const { rows: slips } = await pool.query(
    `SELECT id, legs, combined_probability AS "combinedProbability"
       FROM bet_slips
      WHERE user_id = $1 AND outcome = 'pending'
      ORDER BY placed_at DESC
      LIMIT 50`,
    [userId],
  );

  const shown = slips.slice(0, MAX_BETS).map((s: any) => ({
    id: String(s.id),
    legs: Array.isArray(s.legs) ? s.legs : [],
    combinedProbability: s.combinedProbability == null ? null : Number(s.combinedProbability),
  }));

  const gameIds = [...new Set(shown.flatMap((s) => s.legs.map((l: any) => l?.gameId).filter(Boolean).map(String)))];
  const data = new Map<string, GameData>();
  await mapLimit(gameIds, 4, async (id) => {
    try { data.set(id, await loadGame(id)); }
    catch (err: any) { logger.warn({ err: err?.message, gameId: id }, '[Widget] match illisible'); }
  });

  const bets = shown
    .filter((s) => s.legs.length > 0)
    .map((s) => summarizeSlip(s, s.legs.map((l: any) => enrichLeg(l, l?.gameId ? data.get(String(l.gameId)) : undefined)), lang));

  // Live first, then the next to start, then the rest.
  const rank = (b: WidgetBet) => (b.state === 'live' ? 0 : b.state === 'scheduled' ? 1 : 2);
  bets.sort((a, b) => rank(a) - rank(b) || String(a.startsAt ?? '~').localeCompare(String(b.startsAt ?? '~')));

  return {
    generatedAt: new Date().toISOString(),
    pendingCount: slips.length,
    bets,
    refreshAfterSec: bets.some((b) => b.state === 'live') ? 15 * 60 : 30 * 60,
  };
}
