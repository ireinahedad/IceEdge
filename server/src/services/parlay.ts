/**
 * parlay.ts — probabilité combinée d'un coupon.
 *
 * CE QUI EXISTAIT. La route multipliait les jambes et appliquait 0,95 :
 *
 *     const combined = legs.reduce((acc, l) => acc * (l.probability / 100), 1) * 100;
 *     const adjusted = combined * 0.95;
 *
 * Trois problèmes, du plus grave au plus discret.
 *
 *  1. **Des issues incompatibles donnaient un nombre positif.** « Domicile
 *     gagne » et « Extérieur gagne » sur le MÊME match sortaient à 22,8 %. Cet
 *     événement a une probabilité de zéro : les deux ne peuvent pas se
 *     produire. Un coupon impossible se vendait comme un pari à 1 contre 4.
 *  2. **Le schéma acceptait un champ `correlation` que la route ne lisait
 *     jamais**, et la docstring du client affirmait « The server accounts for
 *     correlated legs ». Elle ne l'a jamais fait.
 *  3. **Le 0,95 n'était pas un modèle.** Un abattement forfaitaire, dans le
 *     mauvais sens la moitié du temps : l'indépendance SOUS-estime déjà les
 *     jambes d'un même match (elles vont dans le même sens), et le rabais
 *     n'avait rien à corriger sur des matchs distincts.
 *
 * CE QUE FAIT CE MODULE. Rien qui ne soit démontrable :
 *
 *   - jambes identiques → une seule (P ∩ P = P) ;
 *   - jambes incompatibles → 0, sans discussion ;
 *   - jambe impliquée par une autre → P(A ∩ B) = P(A) quand A ⊆ B ;
 *   - matchs distincts → produit, l'indépendance y est raisonnable ;
 *   - même match, sans relation logique connue → produit ET un drapeau, parce
 *     qu'on sait que c'est faux sans savoir de combien.
 *
 * Ce dernier point est le seul endroit où le chiffre reste approximatif, et
 * c'est assumé : calculer la vraie corrélation de « domicile gagne » et « plus
 * de 5,5 buts » demande la loi jointe des scores, que cette route n'a pas.
 * Elle le DIT au lieu de le taire.
 *
 * CE MODULE NE REMPLACE PAS `predictJointGameLegs`. Les deux se complètent :
 *
 *   - ici, les relations LOGIQUES, qui ne demandent aucune donnée et valent
 *     pour TOUS les marchés — y compris les props de joueur et les périodes,
 *     que la loi jointe des scores ne couvre pas ;
 *   - là-bas, la corrélation NUMÉRIQUE entre jambes lisibles sur le score
 *     final, calculée sur la vraie loi jointe.
 *
 * La route enchaîne les deux : d'abord ce filtre, puis la loi jointe sur ce
 * qu'il en reste. Sans le filtre, « premier buteur = A » et « premier buteur
 * = B » se multiplient encore, et une jambe en double se multiplie par
 * elle-même.
 *
 * ⚠️ PARTAGÉ AVEC LE CLIENT. Le coupon se recalcule hors ligne à chaque geste
 * (cf. le commentaire de `BetContext.tsx`), donc le client importe CE fichier
 * directement (`../../../../server/src/services/parlay`). Il existait avant en
 * double (`client/src/app/services/parlayMath.ts`, gardé identique par un
 * test) ; la copie a été supprimée le 2026-09-15. Conséquences :
 *   - aucun import ici — ni Node, ni `pg`, ni un autre module du serveur :
 *     le bundle navigateur l'embarque tel quel ;
 *   - `client/vite.config.ts` autorise ce fichier dans `server.fs.allow`, sans
 *     quoi `vite dev` refuse de le servir (il est hors de la racine client).
 */

export interface ParlayLeg {
  marketType:      string;
  probability:     number;         // 0–100
  /** Match concerné. Sans lui, aucune relation entre jambes n'est décelable. */
  gameId?:         string;
  /** 'over' | 'under' | 'yes' | 'no' | abréviation d'équipe | seau d'écart. */
  selection?: string;
  line?:           number;
  /**
   * Sur QUOI porte la jambe : l'abréviation de l'équipe, l'identifiant du
   * joueur… (le `subjectId` du coupon). Ajouté le 2026-09-28.
   *
   * La sélection seule ne le dit pas toujours. « MTL +1.5 » est déclaré comme
   * « TOR −1.5, non » (voir `nhlPredictions.ts`) : sa sélection vaut `no`, et
   * sans l'équipe, « MTL −1.5 » + « TOR +1.5 » passaient pour deux paris sans
   * rapport (21 % affichés pour une combinaison impossible). Même chose pour
   * le « yes » du sélecteur de marché.
   */
  subject?: string;
  /** Joueur, équipe ou match — sert à ne pas confondre deux joueurs. */
  subjectType?: 'team' | 'player' | 'game';
}

export interface ParlayResult<L extends ParlayLeg = ParlayLeg> {
  /** Les jambes retenues : doublons et jambes impliquées retirés. */
  legs: L[];
  /** Probabilité combinée, 0–100. */
  probability: number;
  /** Vrai si au moins deux jambes s'excluent — la combinaison est impossible. */
  impossible: boolean;
  /** Jambes retirées parce que dupliquées ou impliquées par une autre. */
  redundantLegs: number;
  /**
   * Vrai si des jambes partagent un match sans relation logique connue : le
   * produit suppose alors une indépendance qui n'existe pas. L'interface doit
   * le dire.
   */
  assumesIndependence: boolean;
}

/**
 * Marchés binaires oui/non : les deux côtés s'excluent.
 *
 * `puck_line` y reste pour les jambes SANS équipe connue (anciens coupons,
 * appelants qui n'envoient pas `subject`). Dès que les deux jambes nomment
 * leur équipe, c'est `teamMargin` qui tranche — et lui ne confond pas « MTL
 * −1.5, oui » avec « TOR −1.5, non », qui sont compatibles.
 */
const BINARY_MARKETS = new Set([
  'both_teams_score', 'clean_sheet', 'game_to_ot',
  'puck_line', 'team_pp_goals', 'team_penalty_kill',
]);

/**
 * Marchés où chaque sélection est un seau DISJOINT des autres : deux
 * sélections différentes ne peuvent pas se réaliser ensemble.
 *
 * Les marchés de buteur en font partie et c'est facile à manquer : deux joueurs
 * différents ne peuvent pas tous deux marquer le PREMIER but, ni le dernier.
 * Sans eux, un coupon « premier buteur = A » + « premier buteur = B » sortait à
 * 1,3 % au lieu de 0.
 *
 * `anytime_goal` n'y est PAS : deux joueurs peuvent parfaitement marquer tous
 * les deux dans le match. C'est la différence entre « le premier » et « un ».
 */
const PARTITION_MARKETS = new Set([
  'winning_margin', 'highest_scoring_period', 'correct_score',
  'first_goal_scorer', 'last_goal_scorer',
  'first_team_score', 'last_team_score',
]);

const NEGATIVE = new Set(['no', 'non', 'false', '0']);
const POSITIVE = new Set(['yes', 'oui', 'true', '1']);

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();

/** Deux marchés O/U équivalents (`total_goals_over` ≡ `total_goals` + 'over'). */
function overUnderSide(leg: ParlayLeg): 'over' | 'under' | null {
  const m = leg.marketType;
  if (m.endsWith('_over'))  return 'over';
  if (m.endsWith('_under')) return 'under';
  const sel = norm(leg.selection);
  if (sel === 'over' || sel === 'under') return sel;
  return null;
}

// ─── Vainqueur et handicap : une seule forme, l'écart final ─────────────────
//
// Moneyline et puck line (±1.5, ±2.5…) se règlent sur le score FINAL,
// prolongation comprise (`settlement.service.ts`). Chaque jambe est donc un
// ensemble d'écarts finaux d'UNE équipe pour lesquels elle gagne :
//
//     « T gagne »          → écart de T ≥ 1
//     « T −1.5 »           → écart de T ≥ 2
//     « T −1.5, non »      → écart de T ≤ 1   (= l'adversaire +1.5)
//     « T +1.5 »           → écart de T ≥ −1
//
// Vue depuis l'adversaire, l'écart change de signe. Deux jambes du même match
// se comparent donc exactement : ensembles disjoints → incompatibles, l'un
// inclus dans l'autre → implication, égaux → même pari. Un écart final n'est
// jamais nul en LNH (la fusillade départage), d'où le retrait du 0.
//
// Rien n'est deviné : sans équipe lisible, sans demi-ligne (une ligne entière
// peut faire « push »), ou avec plus de deux équipes sur un même match (donnée
// incohérente), la jambe n'a pas de forme et les règles d'origine s'appliquent.

interface TeamMargin { team: string; lo: number; hi: number }

const NOT_A_TEAM = new Set(['yes', 'no', 'oui', 'non', 'true', 'false', 'over', 'under', 'draw', 'home', 'away']);

/** L'équipe nommée par la jambe : la sélection si c'en est une, sinon le sujet. */
function legTeam(leg: ParlayLeg): string | null {
  const isTeam = (v: string) => /^[a-z]{2,4}$/.test(v) && !NOT_A_TEAM.has(v);
  const sel = norm(leg.selection);
  if (isTeam(sel)) return sel;
  if (sel && !POSITIVE.has(sel) && !NEGATIVE.has(sel)) return null;
  const subj = norm(leg.subject);
  return isTeam(subj) ? subj : null;
}

function teamMargin(leg: ParlayLeg): TeamMargin | null {
  if (leg.marketType !== 'moneyline' && leg.marketType !== 'puck_line') return null;
  const team = legTeam(leg);
  if (!team) return null;
  const negative = NEGATIVE.has(norm(leg.selection));
  if (leg.marketType === 'moneyline') {
    return negative ? null : { team, lo: 1, hi: Infinity };
  }
  const line = leg.line ?? -1.5;               // −1.5 par défaut, comme au règlement
  if (!Number.isFinite(line) || Math.abs(line % 1) !== 0.5) return null;
  const k = Math.floor(-line) + 1;             // couvre ⇔ écart ≥ k
  return negative ? { team, lo: -Infinity, hi: k - 1 } : { team, lo: k, hi: Infinity };
}

/** Écarts entiers [lo, hi], le 0 retiré des bornes. `null` si vide. */
function interval(lo: number, hi: number): { lo: number; hi: number } | null {
  if (lo === 0) lo = 1;
  if (hi === 0) hi = -1;
  return lo <= hi ? { lo, hi } : null;
}

/** `b` exprimé dans l'écart de l'équipe de `a`. */
function alignTo(a: TeamMargin, b: TeamMargin): { lo: number; hi: number } {
  return a.team === b.team ? { lo: b.lo, hi: b.hi } : { lo: -b.hi, hi: -b.lo };
}

function marginsExclusive(a: TeamMargin, b: TeamMargin): boolean {
  const bb = alignTo(a, b);
  return interval(Math.max(a.lo, bb.lo), Math.min(a.hi, bb.hi)) === null;
}

/** a ⊆ b */
function marginImplies(a: TeamMargin, b: TeamMargin): boolean {
  const A = interval(a.lo, a.hi);
  const B = interval(alignTo(a, b).lo, alignTo(a, b).hi);
  return !!A && !!B && A.lo >= B.lo && A.hi <= B.hi;
}

/**
 * Deux joueurs DIFFÉRENTS : leurs props ne se touchent pas. « Suzuki plus de
 * 2,5 tirs » et « Caufield moins de 2,5 tirs » partagent marché, ligne et
 * match — sans le sujet, ils passaient pour contradictoires (coupon à 0 %).
 */
function differentPlayers(a: ParlayLeg, b: ParlayLeg): boolean {
  return a.subjectType === 'player' && b.subjectType === 'player'
      && !!a.subject && !!b.subject && norm(a.subject) !== norm(b.subject);
}

/** Forme « écart » de chaque jambe, neutralisée sur un match à plus de deux équipes. */
function marginsOf(legs: ParlayLeg[]): Map<ParlayLeg, TeamMargin> {
  const out = new Map<ParlayLeg, TeamMargin>();
  const teams = new Map<string, Set<string>>();
  for (const l of legs) {
    const m = l.gameId ? teamMargin(l) : null;
    if (!m) continue;
    out.set(l, m);
    const set = teams.get(l.gameId!) ?? new Set<string>();
    set.add(m.team);
    teams.set(l.gameId!, set);
  }
  for (const [l] of out) if ((teams.get(l.gameId!)?.size ?? 0) > 2) out.delete(l);
  return out;
}

/** Nom du marché sans le suffixe de côté, pour comparer deux jambes O/U. */
function baseMarket(m: string): string {
  return m.replace(/_(over|under)$/, '');
}

/**
 * Les deux jambes portent-elles sur des issues qui ne peuvent pas coexister ?
 * Seules les exclusions DÉMONTRABLES figurent ici — pas d'intuition.
 */
function mutuallyExclusive(a: ParlayLeg, b: ParlayLeg, m: Map<ParlayLeg, TeamMargin>): boolean {
  if (!a.gameId || a.gameId !== b.gameId) return false;
  if (differentPlayers(a, b)) return false;

  const ma = m.get(a), mb = m.get(b);
  if (ma && mb) return marginsExclusive(ma, mb);

  // Même ligne O/U, côtés opposés : l'un est la négation de l'autre.
  const sa = overUnderSide(a), sb = overUnderSide(b);
  if (sa && sb && baseMarket(a.marketType) === baseMarket(b.marketType)) {
    if (a.line === b.line && sa !== sb) return true;
  }

  if (a.marketType !== b.marketType) return false;
  const va = norm(a.selection), vb = norm(b.selection);
  if (!va || !vb) return false;

  // Oui contre non sur un marché binaire — À LA MÊME LIGNE. « Les deux
  // marquent 1+ » et « les deux marquent 2+ : non » coexistent très bien ; les
  // puck lines ±1.5 / ±2.5 / ±3.5 partagent aussi leur marché.
  if (BINARY_MARKETS.has(a.marketType) && (a.line ?? null) === (b.line ?? null)) {
    if ((POSITIVE.has(va) && NEGATIVE.has(vb)) || (NEGATIVE.has(va) && POSITIVE.has(vb))) return true;
  }

  // Deux équipes différentes sur un marché à vainqueur unique.
  // `moneyline` n'y est plus : deux équipes lisibles sont tranchées plus haut
  // par `teamMargin`, et sans équipe lisible (« yes » sans sujet) comparer les
  // sélections affichait 0 % pour « yes » contre « tor » — le même pari.
  if (a.marketType === 'regulation_result' ||
      a.marketType === 'ot_winner' || /^period[123]_winner$/.test(a.marketType)) {
    return va !== vb;
  }

  // Deux seaux différents d'une partition.
  if (PARTITION_MARKETS.has(a.marketType)) return va !== vb;

  return false;
}

/**
 * Les deux jambes sont-elles la même question ?
 *
 * Un `gameId` est EXIGÉ. Sans lui, deux paris moneyline sur deux matchs
 * différents ont exactement la même forme — et se feraient dédupliquer l'un
 * l'autre, ce qui transformerait un coupon à deux jambes en pari simple. Deux
 * jambes anonymes sont donc traitées comme distinctes : c'est le comportement
 * prudent, et l'ancien.
 */
function sameLeg(a: ParlayLeg, b: ParlayLeg, m: Map<ParlayLeg, TeamMargin>): boolean {
  if (!a.gameId || a.gameId !== b.gameId) return false;
  if (differentPlayers(a, b)) return false;
  const ma = m.get(a), mb = m.get(b);
  if (ma && mb) return marginImplies(ma, mb) && marginImplies(mb, ma);
  return a.marketType === b.marketType
      && norm(a.selection) === norm(b.selection)
      && a.line === b.line;
}

/**
 * `a` implique-t-il `b` ? (a ⊆ b, donc P(a ∩ b) = P(a))
 *
 * Deux familles, toutes deux vérifiables :
 *  - gagner par 2+ buts implique gagner ; gagner en 60 minutes implique gagner ;
 *  - un total « plus de 6,5 » implique « plus de 5,5 ».
 */
function implies(a: ParlayLeg, b: ParlayLeg, m: Map<ParlayLeg, TeamMargin>): boolean {
  if (!a.gameId || a.gameId !== b.gameId) return false;
  if (differentPlayers(a, b)) return false;
  const va = norm(a.selection), vb = norm(b.selection);

  // Vainqueur / handicap entre eux : l'inclusion des écarts, rien d'autre.
  const ma = m.get(a), mb = m.get(b);
  if (ma && mb) return marginImplies(ma, mb);

  // Gagner en réglementaire, c'est gagner — l'équipe lue par `legTeam`, pour
  // qu'un « yes » du sélecteur de marché se reconnaisse aussi.
  if (b.marketType === 'moneyline' && a.marketType === 'regulation_result') {
    const ta = legTeam(a), tb = legTeam(b);
    if (ta && ta === tb) return true;
  }

  if (b.marketType === 'moneyline' && va && va === vb) {
    // Chemin des jambes sans équipe lisible (anciens coupons).
    if (a.marketType === 'puck_line' && !NEGATIVE.has(va)) return true;
  }

  const sa = overUnderSide(a), sb = overUnderSide(b);
  if (sa && sb && sa === sb &&
      baseMarket(a.marketType) === baseMarket(b.marketType) &&
      a.line != null && b.line != null) {
    // Plus de 6,5 ⊆ plus de 5,5 ; moins de 4,5 ⊆ moins de 5,5.
    return sa === 'over' ? a.line > b.line : a.line < b.line;
  }

  return false;
}

/**
 * Probabilité combinée d'un coupon.
 *
 * `probability` est bornée à [0, 100] ; une jambe hors bornes ou non finie fait
 * renvoyer `NaN`, que l'appelant doit rendre par « — » plutôt que par un
 * pourcentage. C'est le comportement déjà retenu côté client.
 */
export function combineParlayLegs<L extends ParlayLeg>(legs: L[]): ParlayResult<L> {
  const none: ParlayResult<L> = {
    legs: [], probability: 0, impossible: false, redundantLegs: 0, assumesIndependence: false,
  };
  if (legs.length === 0) return none;
  if (legs.some(l => !Number.isFinite(l.probability))) {
    return { ...none, legs, probability: NaN };
  }

  const m = marginsOf(legs);

  // 1. Incompatibilité — la seule réponse est zéro.
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      if (mutuallyExclusive(legs[i], legs[j], m)) {
        return { legs: [], probability: 0, impossible: true, redundantLegs: 0, assumesIndependence: false };
      }
    }
  }

  // 2. Doublons et jambes impliquées : on ne garde que la plus restrictive.
  const kept: L[] = [];
  let redundant = 0;
  for (const leg of legs) {
    const dupe = kept.findIndex(k => sameLeg(k, leg, m));
    if (dupe >= 0) { redundant++; continue; }
    const implied = kept.findIndex(k => implies(leg, k, m));
    if (implied >= 0) { kept[implied] = leg; redundant++; continue; }
    if (kept.some(k => implies(k, leg, m))) { redundant++; continue; }
    kept.push(leg);
  }

  // 3. Produit. Pas d'abattement : il n'y a rien à abattre.
  const probability = kept.reduce((acc, l) => acc * (l.probability / 100), 1) * 100;

  // 4. Reste-t-il des jambes d'un même match sans relation connue ?
  const byGame = new Map<string, number>();
  for (const l of kept) {
    if (!l.gameId) continue;
    byGame.set(l.gameId, (byGame.get(l.gameId) ?? 0) + 1);
  }
  const assumesIndependence = [...byGame.values()].some(n => n > 1);

  return {
    legs: kept,
    probability: Math.max(0, Math.min(100, probability)),
    impossible: false,
    redundantLegs: redundant,
    assumesIndependence,
  };
}
