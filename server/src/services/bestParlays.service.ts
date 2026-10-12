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

import { getBestBets, normalizeDate, type BestBet } from './bestBets.service';
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

/** Contraintes d'une énumération — l'accueil et « Plus de parlays » n'ont pas les mêmes. */
interface EnumOpts {
  size:       number;
  /** Seuil du produit naïf, en % (élagage). Le chiffre final est revérifié plus tard. */
  minPct:     number;
  /** Nb minimal de matchs différents (1 = un combiné d'un seul match est permis). */
  minGames:   number;
  maxPerGame: number;
  maxPlayers: number;
  /** Dernier filtre sur un combiné complet. */
  accept?:    (legs: LegInfo[]) => boolean;
  /** Plafond de combinés produits / de nœuds visités : borne le temps des grandes tailles. */
  leafCap?:   number;
  visitCap?:  number;
}

/**
 * Tous les combinés de `size` jambes qui passent les contraintes, triés par
 * rang (probabilité × bonus de cohérence). Les jambes sont triées par %
 * décroissant : dès que le produit courant, complété par la meilleure jambe
 * restante à la puissance du nombre manquant, passe sous le seuil, la branche
 * est coupée — rien plus loin ne peut faire mieux.
 */
function enumerate(pool: LegInfo[], o: EnumOpts): Combo[] {
  const { size } = o;
  const out: Combo[] = [];
  const pick: LegInfo[] = [];
  const min = o.minPct / 100;
  const leafCap = o.leafCap ?? Infinity;
  const visitCap = o.visitCap ?? Infinity;
  let visits = 0;

  const visit = (start: number, product: number, coherent: number) => {
    if (out.length >= leafCap || ++visits > visitCap) return;
    if (pick.length === size) {
      const games = new Set(pick.map((l) => l.gameId));
      if (games.size < o.minGames) return;
      if (o.accept && !o.accept(pick)) return;
      out.push({ legs: [...pick], product, coherent, rank: product * (1 + COHERENCE_BONUS * coherent) });
      return;
    }
    for (let i = start; i < pool.length; i++) {
      if (out.length >= leafCap || visits > visitCap) return;
      const leg = pool[i];
      const left = size - pick.length - 1;
      if (product * leg.p * Math.pow(leg.p, left) < min) break;     // trié : la suite est pire
      if (pool.length - i - 1 < left) break;

      let ok = true;
      let add = 0;
      let sameGame = 0;
      let players = leg.isPlayer ? 1 : 0;
      for (const p of pick) {
        if (p.bet.id === leg.bet.id) { ok = false; break; }
        if (p.isPlayer) players++;
        if (p.gameId !== leg.gameId) continue;
        sameGame++;
        // Même sujet deux fois (deux props du même joueur, ML + handicap de la
        // même équipe) : redondant ou presque — une jambe suffit.
        if (p.bet.subjectType === leg.bet.subjectType && p.bet.subjectId === leg.bet.subjectId
            && leg.bet.subjectType === 'player') { ok = false; break; }
        if (p.side && p.side === leg.side && !p.isPlayer && !leg.isPlayer) { ok = false; break; }
        // Deux totaux du même match (over 5.5 + over 6.5) : implication, pas un combiné.
        if (p.bet.marketType === leg.bet.marketType && !p.isPlayer && !leg.isPlayer
            && !p.side && !leg.side) { ok = false; break; }
        const r = pairRelation(p, leg);
        if (r < 0) { ok = false; break; }
        add += r;
      }
      if (!ok || sameGame + 1 > o.maxPerGame || players > o.maxPlayers) continue;

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

export interface BuildOpts {
  /**
   * Accueil (2026-10-11, demande du user) : seulement des jambes COTÉES par le
   * livre, une par match — chaque combiné affiché a donc une vraie cote.
   * `getBestParlays` retombe sur les jambes sans cote quand ce filtre ne laisse
   * aucun combiné (2026-10-12).
   */
  requirePrice?: boolean;
}

export async function buildBestParlays(
  bets: BestBet[], now = Date.now(), onlyDay?: string, opts: BuildOpts = {},
): Promise<{ parlays: BestParlay[]; day: string | null }> {
  // Jour choisi sur l'accueil (2026-10-11) : ce jour-là ou rien.
  const all = playableLegs(bets, now)
    .filter((l) => !onlyDay || l.bet.game?.date === onlyDay)
    .filter((l) => !opts.requirePrice || l.bet.bookPrice != null);
  const day = pickDay(all);
  if (!day) return { parlays: [], day: null };
  const legs = all.filter((l) => l.bet.game?.date === day);

  // Moneyline : une jambe par match au plus — le favori (seul côté ≥ 55 %).
  const mlPool = legs.filter((l) => l.bet.marketType === 'moneyline');
  const mixedPool = legs.slice(0, MIXED_POOL);

  const combos = new Map<string, Combo[]>();
  const combosFor = (kind: ParlayKind, size: number) => {
    const key = `${kind}|${size}`;
    if (!combos.has(key)) combos.set(key, enumerate(kind === 'moneyline' ? mlPool : mixedPool, {
      size, minPct: MIN_PARLAY_PCT, minGames: 2,
      // Avec cote exigée : une jambe par match, sinon le livre n'a pas ce prix-là.
      maxPerGame: opts.requirePrice ? 1 : MAX_LEGS_PER_GAME,
      maxPlayers: MAX_PLAYER_LEGS,
      accept: kind === 'mixed' ? (ls) => !ls.every((l) => l.bet.marketType === 'moneyline') : undefined,
    }));
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

// ─── « Plus de parlays » (2026-10-11) ────────────────────────────────────────
//
// Page ouverte par le bouton « Plus de parlays » de l'accueil. Demande du user :
//   • en tête, les MÊMES combinés que l'accueil (tous cotés) ;
//   • puis d'autres, plus variés, AVEC des jambes sans cote (on n'a pas les
//     prix de tous les marchés, surtout les props joueur) ;
//   • de 2 à 8 jambes ; même type de pari, même match, même équipe, ou mélangés ;
//   • toujours une seule journée.
//
// Mêmes garde-fous que l'accueil : jambes ML seulement (≥ 55 %), matchs pas
// commencés, paires contradictoires refusées (`pairRelation`), chiffre FINAL
// calculé comme le coupon (`computeParlayProbability`). Le seuil, lui, dépend
// de la taille : 25 % est hors d'atteinte à 8 jambes, on affiche donc un
// chiffre honnête et plus bas plutôt que rien (`MORE_MIN_PCT`).

export type MoreKind = 'mixed' | 'same_game' | 'same_team' | 'same_market';

export interface MoreParlay extends Omit<BestParlay, 'kind'> {
  kind:  MoreKind;
  /** Ce que les jambes ont en commun : `TOR`, `MTL@TOR`, `shots_ou`… `null` pour un mélangé. */
  group: string | null;
}

/** Seuil final par nombre de jambes, en %. */
export const MORE_MIN_PCT: Record<number, number> = { 2: 40, 3: 25, 4: 18, 5: 13, 6: 9, 7: 7, 8: 5 };
const MORE_POOL = 30;
/** Au-delà de 5 jambes, on énumère sur un pool plus court : le temps reste borné. */
const MORE_BIG_POOL = 18;
const MORE_LEAF_CAP = 1500;
const MORE_VISIT_CAP = 150_000;
/** Candidats dont on calcule le chiffre final, par place, au plus. */
const MORE_TRIES = 40;
/** Groupes (matchs, équipes, marchés) proposés au plus, par catégorie. */
const MORE_GROUPS = 6;

interface MoreSlot {
  kind:   MoreKind;
  group:  string | null;
  pool:   LegInfo[];
  sizes:  number[];
  opts:   Omit<EnumOpts, 'size' | 'minPct'>;
}

const distinctMarkets = (ls: LegInfo[]) => new Set(ls.map((l) => l.bet.marketType)).size;
const avgP = (ls: LegInfo[]) => ls.reduce((a, l) => a + l.p, 0) / Math.max(1, ls.length);

function groupBy(legs: LegInfo[], key: (l: LegInfo) => string | null): [string, LegInfo[]][] {
  const m = new Map<string, LegInfo[]>();
  for (const l of legs) {
    const k = key(l);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(l);
  }
  // Les groupes les plus solides d'abord (moyenne de leurs 3 meilleures jambes).
  return [...m.entries()]
    .filter(([, ls]) => ls.length >= 2)
    .sort((a, b) => avgP(b[1].slice(0, 3)) - avgP(a[1].slice(0, 3)) || a[0].localeCompare(b[0]));
}

function moreSlots(legs: LegInfo[]): MoreSlot[] {
  const pool = legs.slice(0, MORE_POOL);
  const big = legs.slice(0, MORE_BIG_POOL);
  const slots: MoreSlot[] = [];

  // Mélangés : une place par taille, 2 → 8. Au moins deux marchés, deux matchs.
  const mixedAccept = (ls: LegInfo[]) => distinctMarkets(ls) >= 2;
  for (let n = 2; n <= 8; n++) {
    slots.push({
      kind: 'mixed', group: null, pool: n > 5 ? big : pool, sizes: [n],
      opts: { minGames: 2, maxPerGame: 2, maxPlayers: n >= 6 ? 4 : 3, accept: mixedAccept },
    });
  }

  // Même équipe : tout ce qui demande à une équipe de bien jouer (victoire ou
  // handicap, ses joueurs). Une équipe ne joue qu'une fois par soir. AVANT
  // « même match » : un combiné d'équipe est souvent contenu dans celui du
  // match, et le premier servi garde sa place.
  for (const [team, ls] of groupBy(legs, (l) => l.side).slice(0, MORE_GROUPS)) {
    slots.push({ kind: 'same_team', group: team, pool: ls, sizes: [3, 2, 4],
      opts: { minGames: 1, maxPerGame: 8, maxPlayers: 3 } });
  }

  // Même match : 2 à 5 jambes d'un seul match (corrélation calculée par le coupon).
  const gameLabel = (l: LegInfo) => l.bet.game ? `${l.bet.game.away}@${l.bet.game.home}` : l.gameId;
  for (const [, ls] of groupBy(legs, (l) => l.gameId).slice(0, MORE_GROUPS)) {
    const label = gameLabel(ls[0]);
    slots.push({ kind: 'same_game', group: label, pool: ls, sizes: [3, 2, 4],
      opts: { minGames: 1, maxPerGame: 8, maxPlayers: 3 } });
    if (ls.length >= 5) {
      slots.push({ kind: 'same_game', group: label, pool: ls, sizes: [5, 4],
        opts: { minGames: 1, maxPerGame: 8, maxPlayers: 4 } });
    }
  }

  // Même type de pari : que des victoires, que des tirs, que des totaux…
  for (const [market, ls] of groupBy(legs, (l) => l.bet.marketType).slice(0, MORE_GROUPS)) {
    const p = ls.slice(0, MORE_BIG_POOL);
    slots.push({ kind: 'same_market', group: market, pool: p, sizes: [3, 2],
      opts: { minGames: 1, maxPerGame: 2, maxPlayers: 8 } });
    if (ls.length >= 4) {
      slots.push({ kind: 'same_market', group: market, pool: p, sizes: [5, 4, 6, 7, 8],
        opts: { minGames: 2, maxPerGame: 2, maxPlayers: 8 } });
    }
  }
  return slots;
}

/**
 * Les combinés en plus, pour UNE journée. `taken` : les combinés de l'accueil,
 * déjà affichés en tête — aucun extra ne les répète (ni ne les contient).
 */
export async function buildMoreParlays(
  bets: BestBet[], day: string, taken: BestParlay[] = [], now = Date.now(),
): Promise<MoreParlay[]> {
  const legs = playableLegs(bets, now).filter((l) => l.bet.game?.date === day);
  if (legs.length < 2) return [];

  const chosen: MoreParlay[] = [];
  const takenIds = taken.map((p) => p.legs.map((l) => l.id));
  const uses = new Map<string, number>();
  const finals = new Map<string, Awaited<ReturnType<typeof computeParlayProbability>>>();
  const levels: { maxShared: 'half' | 'subset'; maxUses: number }[] = [
    { maxShared: 'half',   maxUses: 3 },
    { maxShared: 'subset', maxUses: Infinity },
  ];

  const fresh = (c: Combo) => {
    let seen = 0;
    for (const l of c.legs) seen += uses.get(l.bet.id) ?? 0;
    return c.rank * Math.pow(LEG_REUSE_PENALTY, seen);
  };

  for (const slot of moreSlots(legs)) {
    let found: MoreParlay | null = null;
    for (const level of levels) {
      for (const size of slot.sizes) {
        if (slot.pool.length < size) continue;
        const minPct = MORE_MIN_PCT[size] ?? 5;
        // Jambes déjà trop servies retirées AVANT l'énumération : les grandes
        // tailles, plafonnées, ne tournent pas toujours autour des mêmes.
        const pool = slot.pool.filter((l) => (uses.get(l.bet.id) ?? 0) < level.maxUses);
        // Ressemblance jugée contre l'accueil et la MÊME catégorie seulement :
        // un 8 jambes mélangé contient forcément des paires « même équipe ».
        // Entre catégories, c'est la pénalité de réutilisation qui varie.
        const all = [...takenIds, ...chosen.filter((p) => p.kind === slot.kind).map((p) => p.legs.map((l) => l.id))];
        const candidates = enumerate(pool, {
          size, minPct, ...slot.opts, leafCap: MORE_LEAF_CAP, visitCap: MORE_VISIT_CAP,
        })
          .filter((c) => {
            const ids = c.legs.map((l) => l.bet.id);
            const key = [...ids].sort().join('+');
            if (chosen.some((p) => p.legs.map((l) => l.id).sort().join('+') === key)) return false;   // jamais deux fois le même
            return !all.some((o) => tooSimilar(ids, o, level.maxShared));
          })
          .sort((a, b) => fresh(b) - fresh(a) || idOf(a.legs).localeCompare(idOf(b.legs)))
          .slice(0, MORE_TRIES);

        for (const c of candidates) {
          const id = idOf(c.legs);
          let r = finals.get(id);
          if (!r) {
            r = await computeParlayProbability(c.legs.map((l) => toWire(l.bet)));
            finals.set(id, r);
          }
          if (r.impossible || r.redundantLegs > 0 || r.adjustedProbability == null) continue;
          if (r.adjustedProbability < minPct) continue;
          const betsOf = c.legs.map((l) => l.bet);
          found = {
            id: `mp-${day}-${slot.kind}-${id}`,
            kind: slot.kind,
            group: slot.group,
            legs: betsOf,
            probability: r.adjustedProbability,
            assumesIndependence: r.assumesIndependence,
            coherentPairs: c.coherent,
            bookPrice: comboPrice(betsOf),
          };
          break;
        }
        if (found) break;
      }
      if (found) break;
    }
    if (!found) continue;
    chosen.push(found);
    for (const l of found.legs) uses.set(l.id, (uses.get(l.id) ?? 0) + 1);
  }
  return chosen;
}

// ─── Cache + API ─────────────────────────────────────────────────────────────

/**
 * Clé = l'horodatage du pool best-bets. Tant que le pool ne change pas (60 s
 * de cache côté best-bets), les combinés ne sont pas recalculés ; `wrap`
 * dédoublonne les arrivées simultanées.
 */
const parlaysCache = new TtlCache<BestParlaysResult>(5 * 60_000, 24, 'best-parlays');

export async function getBestParlays(date?: string): Promise<BestParlaysResult> {
  // Mêmes réglages que l'accueil (`BestBetsSection` : players par défaut,
  // source ML, jour choisi) → même entrée du cache best-bets. `limit` n'entre
  // pas dans la clé. `normalizeDate` borne la date (clé de cache finie).
  const day0 = normalizeDate(date);
  const pool = await getBestBets({ limit: 50, source: 'ml', date: day0 });
  return parlaysCache.wrap(`${day0 ?? ''}|${pool.meta.generatedAt}`, async () => {
    // Cotes d'abord (règle du 2026-10-11 : chaque combiné de l'accueil a un
    // vrai prix). Mais le livre ne cote souvent qu'une poignée de marchés, et
    // rien du tout pour le lendemain : le 2026-10-12, 3 jambes cotées sur 50
    // (produit 22 %), donc AUCUN combiné, alors que les best picks sans cote en
    // donnaient plusieurs au-dessus de 25 %. Une section vide à côté d'une liste
    // de best picks n'a pas de sens : sans combiné coté, on combine les best
    // picks eux-mêmes — mêmes règles (ML, ≥ 25 %, cohérence), cote affichée
    // seulement si toutes les jambes en ont une (`comboPrice`).
    let built = await buildBestParlays(pool.bets, Date.now(), day0, { requirePrice: true });
    if (built.parlays.length === 0) built = await buildBestParlays(pool.bets, Date.now(), day0);
    const { parlays, day } = built;
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

// ─── « Plus de parlays » : cache + API ───────────────────────────────────────

export interface MoreParlaysResult {
  /** Les combinés de l'accueil pour ce jour, tous cotés — affichés en tête. */
  featured: BestParlay[];
  more:     MoreParlay[];
  meta: { generatedAt: string; day: string | null; mlAvailable: boolean };
}

export interface LockedMoreParlay {
  id:       string;
  kind:     MoreKind;
  locked:   true;
  legCount: number;
}

export interface MoreParlaysResponse {
  featured: (BestParlay | LockedParlay)[];
  more:     (MoreParlay | LockedMoreParlay)[];
  meta: MoreParlaysResult['meta'] & { freeCount: number; total: number };
}

const moreCache = new TtlCache<MoreParlaysResult>(5 * 60_000, 24, 'more-parlays');

/**
 * Même pool, même jour et même combinés de tête que l'accueil (`getBestParlays`,
 * en cache) : la page ne contredit jamais la section. Sans date, le jour est
 * celui des combinés de l'accueil, sinon le premier jour qui a des jambes.
 */
export async function getMoreParlays(date?: string): Promise<MoreParlaysResult> {
  const day0 = normalizeDate(date);
  const [home, pool] = await Promise.all([
    getBestParlays(day0),
    getBestBets({ limit: 50, source: 'ml', date: day0 }),
  ]);
  return moreCache.wrap(`${day0 ?? ''}|${pool.meta.generatedAt}|${home.meta.generatedAt}`, async () => {
    const days = playableLegs(pool.bets, Date.now()).map((l) => l.bet.game?.date ?? '').filter(Boolean).sort();
    const day = day0 ?? home.meta.day ?? days[0] ?? null;
    const featured = home.meta.day === day ? home.parlays : [];
    const more = day ? await buildMoreParlays(pool.bets, day, featured) : [];
    return {
      featured, more,
      meta: { generatedAt: new Date().toISOString(), day, mlAvailable: pool.meta.mlAvailable },
    };
  });
}

/**
 * Même règle que l'accueil : un non-abonné voit les `FREE_PARLAYS` premiers
 * combinés de tête (ceux qu'il voit déjà sur l'accueil), le reste arrive en
 * coquille — type et nombre de jambes, aucun contenu.
 */
export function gateMoreParlays(r: MoreParlaysResult, isPro: boolean): MoreParlaysResponse {
  const featured = r.featured.map((p, i): BestParlay | LockedParlay =>
    isPro || i < FREE_PARLAYS ? p : { id: `locked-f${i}`, kind: p.kind, locked: true, legCount: p.legs.length });
  const more = r.more.map((p, i): MoreParlay | LockedMoreParlay =>
    isPro ? p : { id: `locked-m${i}`, kind: p.kind, locked: true, legCount: p.legs.length });
  return {
    featured, more,
    meta: { ...r.meta, freeCount: FREE_PARLAYS, total: r.featured.length + r.more.length },
  };
}
