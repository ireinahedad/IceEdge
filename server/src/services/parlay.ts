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

/** Marchés binaires oui/non : les deux côtés s'excluent. */
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
  'winning_margin', 'highest_scoring_period',
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

/** Nom du marché sans le suffixe de côté, pour comparer deux jambes O/U. */
function baseMarket(m: string): string {
  return m.replace(/_(over|under)$/, '');
}

/**
 * Les deux jambes portent-elles sur des issues qui ne peuvent pas coexister ?
 * Seules les exclusions DÉMONTRABLES figurent ici — pas d'intuition.
 */
function mutuallyExclusive(a: ParlayLeg, b: ParlayLeg): boolean {
  if (!a.gameId || a.gameId !== b.gameId) return false;

  // Même ligne O/U, côtés opposés : l'un est la négation de l'autre.
  const sa = overUnderSide(a), sb = overUnderSide(b);
  if (sa && sb && baseMarket(a.marketType) === baseMarket(b.marketType)) {
    if (a.line === b.line && sa !== sb) return true;
  }

  if (a.marketType !== b.marketType) return false;
  const va = norm(a.selection), vb = norm(b.selection);
  if (!va || !vb) return false;

  // Oui contre non sur un marché binaire.
  if (BINARY_MARKETS.has(a.marketType)) {
    if ((POSITIVE.has(va) && NEGATIVE.has(vb)) || (NEGATIVE.has(va) && POSITIVE.has(vb))) return true;
  }

  // Deux équipes différentes sur un marché à vainqueur unique.
  if (a.marketType === 'moneyline' || a.marketType === 'regulation_result' ||
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
function sameLeg(a: ParlayLeg, b: ParlayLeg): boolean {
  if (!a.gameId || a.gameId !== b.gameId) return false;
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
function implies(a: ParlayLeg, b: ParlayLeg): boolean {
  if (!a.gameId || a.gameId !== b.gameId) return false;
  const va = norm(a.selection), vb = norm(b.selection);

  if (b.marketType === 'moneyline' && va && va === vb) {
    // Couvrir −1,5 ou gagner en réglementaire, c'est gagner.
    if (a.marketType === 'puck_line' && !NEGATIVE.has(va)) return true;
    if (a.marketType === 'regulation_result') return true;
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

  // 1. Incompatibilité — la seule réponse est zéro.
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      if (mutuallyExclusive(legs[i], legs[j])) {
        return { legs: [], probability: 0, impossible: true, redundantLegs: 0, assumesIndependence: false };
      }
    }
  }

  // 2. Doublons et jambes impliquées : on ne garde que la plus restrictive.
  const kept: L[] = [];
  let redundant = 0;
  for (const leg of legs) {
    const dupe = kept.findIndex(k => sameLeg(k, leg));
    if (dupe >= 0) { redundant++; continue; }
    const implied = kept.findIndex(k => implies(leg, k));
    if (implied >= 0) { kept[implied] = leg; redundant++; continue; }
    if (kept.some(k => implies(k, leg))) { redundant++; continue; }
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
