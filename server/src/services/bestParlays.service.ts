/**
 * bestParlays.service.ts — « Best Parlay » de l'accueil (2026-10-04).
 * ------------------------------------------------------------------
 * Environ six combinés par jour, construits par le serveur À PARTIR DU MÊME
 * POOL que « Meilleurs paris » : `getBestBets()` avec les réglages de
 * l'accueil, donc la même clé de cache (`2|15|ml`). Aucun nouvel appel à
 * l'API NHL ni au service ML : si l'accueil a déjà affiché ses Meilleurs
 * paris dans la minute, ce calcul ne fait que combiner des chiffres déjà là.
 *
 * LES RÈGLES (demande du user)
 *   • 3 à 5 jambes par combiné ;
 *   • 2 combinés en moneyline seulement, les autres mélangent les marchés ;
 *   • jambes chiffrées par le ML uniquement (`source === 'ml'`), les plus
 *     probables d'abord ;
 *   • combinaisons COHÉRENTES par équipe / par match (voir `pairRelation`)
 *     plutôt qu'un simple empilement des meilleurs paris ;
 *   • probabilité du combiné ≥ 25 %, TOUJOURS — vérifiée sur le chiffre final,
 *     corrélations comprises (`computeParlayProbability`, le calcul du coupon) ;
 *   • pas deux combinés trop semblables (`tooSimilar`) ;
 *   • VARIÉTÉ (2026-10-06) : chaque combiné doit apporter du neuf. Une jambe
 *     ou un match déjà utilisé fait baisser le rang d'un candidat
 *     (`LEG_REUSE_PENALTY`, `GAME_REUSE_PENALTY`), et deux combinés partagent
 *     au plus UNE jambe tant que la soirée le permet (`DIVERSITY_LEVELS`).
 *
 * CE QUI N'EST PAS FAIT, EXPRÈS
 *   • Aucun chiffre inventé : moins de matchs → moins de combinés. Un soir à
 *     deux matchs n'a pas de combiné moneyline à 3 jambes, et la liste le dit
 *     en étant plus courte.
 *   • Aucun match commencé : on ne propose pas un combiné qu'on ne peut plus
 *     jouer (mise au jeu dans moins de `START_MARGIN_MS`, ou inconnue).
 */

import { getBestBets, type BestBet } from './bestBets.service';
import { computeParlayProbability, type WireParlayLeg } from './parlayProbability';
import { TtlCache } from './ttlCache';

// ─── Réglages ────────────────────────────────────────────────────────────────

/** Seuil du combiné, en % — jamais en dessous. */
export const MIN_PARLAY_PCT = 25;
/** Combinés visibles sans abonnement ; les autres sont réservés aux Pro. */
export const FREE_PARLAYS = 2;
/** Une jambe sous ce seuil ne sert qu'à faire baisser le combiné. */
const MIN_LEG_PCT = 55;
/** Au-delà, l'énumération grossit sans rien apporter : les jambes du bas ne passent pas 25 %. */
const MIXED_POOL = 24;
/** Au plus deux jambes par match : un combiné reste un combiné de MATCHS. */
const MAX_LEGS_PER_GAME = 2;
/** Props joueur : leur corrélation n'est pas calculée (produit supposé), on les dose. */
const MAX_PLAYER_LEGS = 2;
/** Bonus de classement par paire cohérente (même équipe, ou over + attaque). */
const COHERENCE_BONUS = 0.08;
/** Un match qui commence dans moins de 5 min n'est plus proposé. */
const START_MARGIN_MS = 5 * 60_000;
/**
 * Variété : rang d'un candidat × LEG_REUSE_PENALTY par jambe déjà vue dans un
 * combiné retenu (× 2 si vue deux fois…), × GAME_REUSE_PENALTY par match déjà
 * vu. Un combiné neuf à 30 % passe donc devant un 40 % qui recycle une jambe.
 * Le seuil de 25 % reste absolu : la pénalité ne fait que réordonner.
 */
const LEG_REUSE_PENALTY = 0.55;
const GAME_REUSE_PENALTY = 0.85;
/**
 * Niveaux d'exigence, du plus varié au plus permissif. On ne descend d'un
 * niveau que si aucun candidat ne passe (soirée à peu de matchs).
 *   maxShared : jambes en commun permises avec CHAQUE combiné déjà retenu
 *               ('half' = au plus la moitié, 'subset' = jamais contenu dedans) ;
 *   maxUses   : une jambe dans au plus N combinés.
 */
const DIVERSITY_LEVELS: { maxShared: 1 | 'half' | 'subset'; maxUses: number }[] = [
  { maxShared: 1,        maxUses: 2 },
  { maxShared: 'half',   maxUses: 2 },
  { maxShared: 'subset', maxUses: Infinity },
];
/** Candidats gardés par taille pour la sélection finale. */
const KEEP_PER_SIZE = 300;

type ParlayKind = 'moneyline' | 'mixed';

/**
 * Les six places, dans l'ordre d'affichage. Les deux premières sont celles
 * que tout le monde voit : un moneyline et un mélangé, pour montrer les deux
 * formes. `sizes` est une préférence : si aucun combiné de la première taille
 * ne passe (25 %, diversité), on essaie la suivante.
 */
const SLOTS: { kind: ParlayKind; sizes: number[] }[] = [
  { kind: 'moneyline', sizes: [3] },
  { kind: 'mixed',     sizes: [3] },
  { kind: 'moneyline', sizes: [4, 3] },
  { kind: 'mixed',     sizes: [4, 3] },
  { kind: 'mixed',     sizes: [4, 5, 3] },
  { kind: 'mixed',     sizes: [5, 4, 3] },
];

// ─── Types publics ───────────────────────────────────────────────────────────

export interface BestParlay {
  id:           string;
  kind:         ParlayKind;
  locked?:      false;
  /** Les jambes, telles que « Meilleurs paris » les sert (même forme, même %). */
  legs:         BestBet[];
  /** Probabilité du combiné, 0–100 au dixième, corrélations comprises. */
  probability:  number;
  /** Vrai si une partie du chiffre suppose l'indépendance (props d'un même match). */
  assumesIndependence: boolean;
  /** Paires de jambes qui vont dans le même sens (même équipe, over + attaque). */
  coherentPairs: number;
  /**
   * Cote du combiné au livre d'affichage : produit des prix, seulement quand
   * TOUTES les jambes sont cotées ET sur des matchs différents (un combiné
   * d'un même match n'a pas ce prix-là chez un livre). Sinon `null`.
   */
  bookPrice:    number | null;
}

/** Ce qu'un non-abonné reçoit pour un combiné Pro : la forme, rien du contenu. */
export interface LockedParlay {
  id:       string;
  kind:     ParlayKind;
  locked:   true;
  legCount: number;
}

export interface BestParlaysResult {
  parlays: BestParlay[];
  meta: {
    generatedAt: string;
    /** Journée NHL des combinés (`YYYY-MM-DD`), `null` sans combiné. */
    day:         string | null;
    mlAvailable: boolean;
  };
}

export interface BestParlaysResponse {
  parlays: (BestParlay | LockedParlay)[];
  meta: BestParlaysResult['meta'] & { freeCount: number; total: number };
}

// ─── Cohérence entre deux jambes ─────────────────────────────────────────────

interface LegInfo {
  bet:    BestBet;
  p:      number;          // 0–1
  gameId: string;
  /** Équipe que la jambe « soutient » (ML, handicap, prop d'un joueur), en majuscules. */
  side:   string | null;
  /** +1 = il faut des buts (over, props offensives), −1 = under, 0 = neutre. */
  goals:  -1 | 0 | 1;
  isPlayer: boolean;
}

function legInfo(b: BestBet): LegInfo {
  const isPlayer = b.subjectType === 'player';
  const team = b.teamAbbr ? b.teamAbbr.toUpperCase() : null;
  let side: string | null = null;
  let goals: -1 | 0 | 1 = 0;
  if (b.marketType === 'moneyline' || b.marketType === 'puck_line') side = team;
  else if (b.marketType === 'total_goals') goals = b.selectionValue === 'under' ? -1 : 1;
  if (isPlayer) { side = team; goals = 1; }   // anytime_goal, shots, points, pp_point : tous offensifs
  return { bet: b, p: (b.mlPct ?? 0) / 100, gameId: b.gameId!, side, goals, isPlayer };
}

/**
 * Deux jambes d'un MÊME match : se renforcent-elles (+1), s'ignorent-elles (0),
 * ou tirent-elles en sens contraire (−1, refusé) ?
 *
 *   TOR gagne + un joueur de TOR marque          → +1 (même équipe)
 *   plus de 5,5 + un joueur marque un point      → +1 (il faut des buts)
 *   TOR gagne + un joueur de MTL marque          → −1
 *   moins de 5,5 + un joueur marque un point     → −1
 *   TOR gagne + TOR −1.5                         → refusé ailleurs (implication)
 *   TOR gagne + plus de 5,5                      →  0
 */
function pairRelation(a: LegInfo, b: LegInfo): -1 | 0 | 1 {
  if (a.gameId !== b.gameId) return 0;
  if (a.side && b.side && a.side !== b.side) return -1;
  if (a.goals * b.goals < 0) return -1;
  if (a.side && a.side === b.side) return 1;
  if (a.goals > 0 && b.goals > 0) return 1;
  return 0;
}

/** Deux combinés « trop semblables » selon le niveau d'exigence (voir `DIVERSITY_LEVELS`). */
function tooSimilar(a: string[], b: string[], maxShared: 1 | 'half' | 'subset'): boolean {
  const shared = a.filter((id) => b.includes(id)).length;
  const small = Math.min(a.length, b.length);
  if (maxShared === 'subset') return shared >= small;
  if (maxShared === 'half') return shared > Math.floor(small / 2);
  return shared > maxShared;
}

// ─── Énumération ─────────────────────────────────────────────────────────────

interface Combo { legs: LegInfo[]; product: number; coherent: number; rank: number }

/**
 * Tous les combinés de `size` jambes qui passent les contraintes, triés par
 * rang (probabilité × bonus de cohérence). Les jambes sont triées par %
 * décroissant : dès que le produit courant, complété par la meilleure jambe
 * restante à la puissance du nombre manquant, passe sous 25 %, la branche est
 * coupée — rien plus loin ne peut faire mieux.
 */
function enumerate(pool: LegInfo[], size: number, kind: ParlayKind): Combo[] {
  const out: Combo[] = [];
  const pick: LegInfo[] = [];
  const min = MIN_PARLAY_PCT / 100;

  const visit = (start: number, product: number, coherent: number) => {
    if (pick.length === size) {
      const games = new Set(pick.map((l) => l.gameId));
      if (games.size < 2) return;                                    // un combiné de matchs, pas d'un match
      if (kind === 'mixed' && pick.every((l) => l.bet.marketType === 'moneyline')) return;
      out.push({ legs: [...pick], product, coherent, rank: product * (1 + COHERENCE_BONUS * coherent) });
      return;
    }
    for (let i = start; i < pool.length; i++) {
      const leg = pool[i];
      const left = size - pick.length - 1;
      if (product * leg.p * Math.pow(leg.p, left) < min) break;     // trié : la suite est pire
      if (pool.length - i - 1 < left) break;

      let ok = true;
      let add = 0;
      let sameGame = 0;
      let players = leg.isPlayer ? 1 : 0;
      for (const o of pick) {
        if (o.bet.id === leg.bet.id) { ok = false; break; }
        if (o.isPlayer) players++;
        if (o.gameId !== leg.gameId) continue;
        sameGame++;
        // Même sujet deux fois (deux props du même joueur, ML + handicap de la
        // même équipe) : redondant ou presque — une jambe suffit.
        if (o.bet.subjectType === leg.bet.subjectType && o.bet.subjectId === leg.bet.subjectId
            && leg.bet.subjectType === 'player') { ok = false; break; }
        if (o.side && o.side === leg.side && !o.isPlayer && !leg.isPlayer) { ok = false; break; }
        const r = pairRelation(o, leg);
        if (r < 0) { ok = false; break; }
        add += r;
      }
      if (!ok || sameGame + 1 > MAX_LEGS_PER_GAME || players > MAX_PLAYER_LEGS) continue;

      pick.push(leg);
      visit(i + 1, product * leg.p, coherent + add);
      pick.pop();
    }
  };
  visit(0, 1, 0);

  out.sort((a, b) => b.rank - a.rank || idOf(a.legs).localeCompare(idOf(b.legs)));
  return out.slice(0, KEEP_PER_SIZE);
}

const idOf = (legs: LegInfo[]) => legs.map((l) => l.bet.id).sort().join('+');

// ─── Probabilité finale : le calcul du coupon ────────────────────────────────

function toWire(b: BestBet): WireParlayLeg {
  const p = b.mlPct ?? b.score;
  const base: WireParlayLeg = {
    marketType: b.marketType, probability: p, gameId: b.gameId ?? undefined,
    selection: b.selectionValue, line: b.line ?? undefined,
  };
  if (b.subjectType === 'player') {
    return { ...base, subjectType: 'player', teamId: b.subjectId };
  }
  const g = b.game;
  if (!g) return base;
  const home = g.home.toLowerCase(), away = g.away.toLowerCase();
  if (b.teamAbbr) {
    const team = b.teamAbbr.toLowerCase();
    const isHome = team === home;
    return { ...base, subjectType: 'team', teamId: team, opponentId: isHome ? away : home, isHome };
  }
  // Total du match : les équipes servent seulement à construire la loi jointe.
  return { ...base, subjectType: 'game', teamId: home, opponentId: away, isHome: true };
}

function comboPrice(legs: BestBet[]): number | null {
  if (new Set(legs.map((l) => l.gameId)).size !== legs.length) return null;
  if (legs.some((l) => l.bookPrice == null)) return null;
  return Math.round(legs.reduce((acc, l) => acc * (l.bookPrice as number), 1) * 100) / 100;
}

// ─── Construction ────────────────────────────────────────────────────────────

/** Jambes jouables : chiffrées par le ML, match pas commencé, ≥ `MIN_LEG_PCT`. */
function playableLegs(bets: BestBet[], now: number): LegInfo[] {
  return bets
    .filter((b) => b.source === 'ml' && b.mlPct != null && b.mlPct >= MIN_LEG_PCT && b.mlPct < 100)
    .filter((b) => {
      const t = b.game?.startTimeUTC ? Date.parse(b.game.startTimeUTC) : NaN;
      return !!b.gameId && Number.isFinite(t) && t - now > START_MARGIN_MS;
    })
    .map(legInfo)
    .sort((a, b) => b.p - a.p || a.bet.id.localeCompare(b.bet.id));
}

/**
 * La journée des combinés : la PREMIÈRE qui a au moins trois matchs jouables
 * (assez pour un moneyline à 3 jambes) — un combiné se règle le soir même.
 * Sans elle, la première journée qui en a deux ; sinon rien.
 */
function pickDay(legs: LegInfo[]): string | null {
  const games = new Map<string, Set<string>>();
  for (const l of legs) {
    const d = l.bet.game?.date ?? '';
    if (!d) continue;
    if (!games.has(d)) games.set(d, new Set());
    games.get(d)!.add(l.gameId);
  }
  const days = [...games.keys()].sort();
  return days.find((d) => games.get(d)!.size >= 3) ?? days.find((d) => games.get(d)!.size >= 2) ?? null;
}

export async function buildBestParlays(
  bets: BestBet[], now = Date.now(),
): Promise<{ parlays: BestParlay[]; day: string | null }> {
  const all = playableLegs(bets, now);
  const day = pickDay(all);
  if (!day) return { parlays: [], day: null };
  const legs = all.filter((l) => l.bet.game?.date === day);

  // Moneyline : une jambe par match au plus — le favori (seul côté ≥ 55 %).
  const mlPool = legs.filter((l) => l.bet.marketType === 'moneyline');
  const mixedPool = legs.slice(0, MIXED_POOL);

  const combos = new Map<string, Combo[]>();
  const combosFor = (kind: ParlayKind, size: number) => {
    const key = `${kind}|${size}`;
    if (!combos.has(key)) combos.set(key, enumerate(kind === 'moneyline' ? mlPool : mixedPool, size, kind));
    return combos.get(key)!;
  };

  const chosen: BestParlay[] = [];
  const uses = new Map<string, number>();       // jambe → nb de combinés retenus
  const gameUses = new Map<string, number>();   // match → nb de combinés retenus
  // Probabilité finale en cache local : un même combiné peut être essayé à
  // plusieurs places.
  const finals = new Map<string, Awaited<ReturnType<typeof computeParlayProbability>>>();

  /** Rang × pénalité de réutilisation : ce qui a déjà servi recule. */
  const freshRank = (c: Combo) => {
    let legSeen = 0;
    for (const l of c.legs) legSeen += uses.get(l.bet.id) ?? 0;
    let gameSeen = 0;
    for (const g of new Set(c.legs.map((l) => l.gameId))) gameSeen += gameUses.get(g) ?? 0;
    return c.rank * Math.pow(LEG_REUSE_PENALTY, legSeen) * Math.pow(GAME_REUSE_PENALTY, gameSeen);
  };

  const tryFill = async (
    kind: ParlayKind, sizes: number[], level: (typeof DIVERSITY_LEVELS)[number],
  ): Promise<BestParlay | null> => {
    for (const size of sizes) {
      // Filtres rapides d'abord, puis tri par rang « frais » : le premier qui
      // passe le chiffre final est le meilleur combiné qui apporte du neuf.
      const candidates = combosFor(kind, size)
        .filter((c) => {
          const ids = c.legs.map((l) => l.bet.id);
          if (chosen.some((p) => tooSimilar(ids, p.legs.map((l) => l.id), level.maxShared))) return false;
          return !ids.some((x) => (uses.get(x) ?? 0) >= level.maxUses);
        })
        .map((c) => ({ c, fresh: freshRank(c) }))
        .sort((a, b) => b.fresh - a.fresh || idOf(a.c.legs).localeCompare(idOf(b.c.legs)));

      for (const { c } of candidates) {
        const id = idOf(c.legs);
        let r = finals.get(id);
        if (!r) {
          r = await computeParlayProbability(c.legs.map((l) => toWire(l.bet)));
          finals.set(id, r);
        }
        // Le chiffre FINAL décide : une corrélation négative peut faire passer
        // un produit de 26 % sous les 25 %.
        if (r.impossible || r.redundantLegs > 0 || r.adjustedProbability == null) continue;
        if (r.adjustedProbability < MIN_PARLAY_PCT) continue;

        const betsOf = c.legs.map((l) => l.bet);
        return {
          id: `bp-${day}-${id}`,
          kind,
          legs: betsOf,
          probability: r.adjustedProbability,
          assumesIndependence: r.assumesIndependence,
          coherentPairs: c.coherent,
          bookPrice: comboPrice(betsOf),
        };
      }
    }
    return null;
  };

  for (const slot of SLOTS) {
    // Du plus varié au plus permissif : on ne relâche que si rien ne passe.
    let p: BestParlay | null = null;
    for (const level of DIVERSITY_LEVELS) {
      p = await tryFill(slot.kind, slot.sizes, level);
      if (p) break;
    }
    if (!p) continue;
    chosen.push(p);
    for (const l of p.legs) uses.set(l.id, (uses.get(l.id) ?? 0) + 1);
    for (const g of new Set(p.legs.map((l) => l.gameId!))) gameUses.set(g, (gameUses.get(g) ?? 0) + 1);
  }

  // Ordre des places conservé : le 1er moneyline et le 1er mélangé restent en
  // tête (ce sont les deux gratuits), même si une place a sauté.
  return { parlays: chosen, day };
}

// ─── Cache + API ─────────────────────────────────────────────────────────────

/**
 * Clé = l'horodatage du pool best-bets. Tant que le pool ne change pas (60 s
 * de cache côté best-bets), les combinés ne sont pas recalculés ; `wrap`
 * dédoublonne les arrivées simultanées.
 */
const parlaysCache = new TtlCache<BestParlaysResult>(5 * 60_000, 4, 'best-parlays');

export async function getBestParlays(): Promise<BestParlaysResult> {
  // Mêmes réglages que l'accueil (`BestBetsSection` : days/players par défaut,
  // source ML) → même entrée du cache best-bets. `limit` n'entre pas dans la clé.
  const pool = await getBestBets({ limit: 50, source: 'ml' });
  return parlaysCache.wrap(pool.meta.generatedAt, async () => {
    const { parlays, day } = await buildBestParlays(pool.bets);
    return {
      parlays,
      meta: { generatedAt: new Date().toISOString(), day, mlAvailable: pool.meta.mlAvailable },
    };
  });
}

/**
 * Ce que l'appelant a le droit de voir. Un non-abonné reçoit les
 * `FREE_PARLAYS` premiers en entier, et pour les autres une coquille
 * (`LockedParlay`) : AUCUNE jambe ni probabilité d'un combiné Pro ne quitte
 * le serveur — le flou de l'écran n'est pas une protection.
 */
export function gateBestParlays(r: BestParlaysResult, isPro: boolean): BestParlaysResponse {
  const parlays = r.parlays.map((p, i): BestParlay | LockedParlay =>
    isPro || i < FREE_PARLAYS
      ? p
      : { id: `locked-${i}`, kind: p.kind, locked: true, legCount: p.legs.length });
  return { parlays, meta: { ...r.meta, freeCount: FREE_PARLAYS, total: r.parlays.length } };
}
