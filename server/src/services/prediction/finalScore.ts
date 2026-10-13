/**
 * prediction/finalScore.ts — loi du SCORE FINAL d'un match (prolongation et
 * fusillade comprises), pour les marchés de la page match qui se règlent sur ce
 * score : score exact, puck lines ±1.5/2.5/3.5, total du match, total par
 * équipe.
 *
 * ── Pourquoi le score FINAL et pas le score après 60 minutes ────────────────
 *
 * Le règlement (`settlement.service.ts`) lit `game.homeTeam.score`, qui compte
 * le but de prolongation ET le but « comptable » de la fusillade. Un match nul
 * 2–2 après 60 minutes se règle donc 3–2 : « plus de 4.5 » est GAGNÉ, « score
 * exact 2–2 » n'existe pas, et l'équipe qui l'emporte passe de 2 à 3 buts.
 * Chiffrer ces marchés sur le score réglementaire ferait annoncer une
 * probabilité pour une autre question que celle qui sera réglée.
 *
 * Chaque case nulle (k, k) est donc éclatée en (k+1, k) et (k, k+1), selon la
 * part de prolongation qui revient au domicile — la même `otShareHome` que la
 * tuile Match Betting utilise pour partager ses deux tuiles OT/SO.
 *
 * ── Poisson, comme `marginDistribution` ─────────────────────────────────────
 *
 * Les buts de chaque équipe suivent une Poisson indépendante de cadence λ,
 * comme le reste de la page (puck line, écart de victoire, totaux). La
 * binomiale négative de `pScoresAtLeastOnce` reste réservée à « les deux
 * marquent » : elle corrige le taux de blanchissage, pas la variance du total —
 * appliquée au total du match, elle le rendrait nettement trop dispersé.
 *
 * ── En direct (`live`) ──────────────────────────────────────────────────────
 *
 * Même grille, décalée du score actuel : score final = score actuel + buts
 * restants, chaque équipe à λ × f (f = part du match qui reste). Un nul à 60
 * minutes est toujours tranché par `otShareHome` ; en prolongation, il ne
 * reste que ce partage. Informatif seulement : les coupons sont fermés dès la
 * mise au jeu (`slip.service.ts`), le règlement n'en dépend pas.
 */

const MAX_K = 14;

function poissonPmfs(lambda: number): number[] {
  const out: number[] = [];
  let p = Math.exp(-lambda);
  for (let k = 0; k <= MAX_K; k++) {
    out.push(p);
    p *= lambda / (k + 1);
  }
  return out;
}

export interface FinalScoreGrid {
  /** p[h][a] = P(score final h–a). Somme ≈ 1 (troncature à MAX_K buts). */
  p: number[][];
  /**
   * Taille de la grille (MAX_K + 2 : un nul à MAX_K peut finir MAX_K+1). En
   * direct, décalée du plus gros score actuel.
   */
  size: number;
  /**
   * Issue après 60 minutes, AVANT le partage de la prolongation : le domicile
   * mène, le visiteur mène, égalité. Somme = 1. C'est ce que règlent « in
   * Reg », « qui mène après la 3e » et « va en prolongation ».
   */
  regHome: number;
  regAway: number;
  regTie:  number;
}

/**
 * État d'un match EN COURS, vu par la loi du score final.
 *
 * Score final = score actuel + buts restants ; les buts restants de chaque
 * équipe suivent une Poisson de cadence λ × f, où f est la part du match
 * réglementaire qui reste à jouer. Les λ d'avant-match restent la mesure de la
 * force des équipes : seul le temps disponible change.
 */
export interface LiveState {
  homeScore:      number;
  awayScore:      number;
  /** Secondes de temps RÉGLEMENTAIRE restantes (0 en prolongation). */
  secondsLeftReg: number;
  /** Prolongation ou fusillade en cours : le vainqueur se tire directement à `otShareHome`. */
  inOvertime:     boolean;
  /**
   * Part des buts du match qui reste à marquer (0–1). L'appelant la pondère
   * par période (`PERIOD_DIST` dans `nhlPredictions.ts`) ; absente, on prend
   * le temps restant / 3600.
   */
  f?:             number;
  /**
   * Multiplie la masse des NULS à 60 minutes (≥ 1, défaut 1). Deux Poisson
   * indépendantes sous-estiment les nuls du hockey : ~16 % à λT ≈ 6, quand la
   * ligue en compte ~23 %. L'appelant le cale pour qu'à 0–0 avec 60 minutes à
   * jouer, P(nul) vaille le P(prolongation) d'avant-match. En fin de match, il
   * gonfle aussi l'égalisation d'une équipe menée d'un but (gardien retiré).
   */
  tieBoost?:      number;
  /**
   * Effets de score MESURÉS (`liveEffects.json`, `ml/python/calibrate_live.py`).
   * Présents : les buts restants ne sont plus deux Poisson à cadence fixe mais
   * suivent `evolveLiveScore`, où la cadence de chaque équipe dépend de son
   * écart au score et du moment du match. Absents : phase 1, inchangée.
   */
  effects?:       LiveEffects | null;
  /**
   * Situation numérique EN COURS (avantage numérique, 4 c. 4) et temps qu'il lui
   * reste. Lue seulement avec `effects.pp` (facteurs mesurés par
   * `ml/python/calibrate_live_pp.py`) ; absente ou nulle : cadence moyenne.
   */
  pp?:            LivePowerPlay | null;
}

/**
 * Situation numérique en cours, telle que la donne la feuille de match
 * (`situation.situationCode` + `secondsRemaining`). Attaquant supplémentaire
 * (gardien retiré) déjà retiré du compte : 6 c. 5 n'est pas un avantage.
 */
export interface LivePowerPlay {
  homeSkaters: number;
  awaySkaters: number;
  /** Secondes de jeu pendant lesquelles la situation tient encore. */
  secondsLeft: number;
  /**
   * Pénalité mineure : un but de l'équipe en avantage y met fin. Le moteur
   * suit alors la situation case par case (l'équipe en avantage n'a pas
   * encore marqué ⇔ la pénalité court toujours).
   */
  endsOnGoal:  boolean;
}

/** Catégorie de situation vue d'une équipe : clés de `LiveEffects.pp.g`. */
export function ppCategory(own: number, opp: number): 'EV' | 'EVS' | 'PP1' | 'PP2' | 'SH1' | 'SH2' {
  const d = own - opp;
  if (d === 0) return own >= 5 ? 'EV' : 'EVS';
  if (d === 1) return 'PP1';
  if (d >= 2) return 'PP2';
  if (d === -1) return 'SH1';
  return 'SH2';
}

/**
 * `situationCode` NHL (« 1451 » = gardien visiteur, 4 patineurs visiteur,
 * 5 patineurs domicile, gardien domicile) + secondes restantes → situation à
 * passer au moteur. `null` à 5 c. 5 (rien de connu au-delà de la moyenne),
 * code illisible, gardien retiré sans pénalité, ou temps inconnu.
 */
export function powerPlayFromSituation(code: unknown, secondsRemaining: unknown): LivePowerPlay | null {
  const c = String(code ?? '').padStart(4, '0');
  const secs = Number(secondsRemaining);
  if (!/^\d{4}$/.test(c) || !Number.isFinite(secs) || secs <= 0) return null;
  const [ag, as, hs, hg] = c.split('').map(Number);
  const homeSkaters = hs - (hg === 0 ? 1 : 0);
  const awaySkaters = as - (ag === 0 ? 1 : 0);
  if (homeSkaters < 3 || awaySkaters < 3 || homeSkaters > 6 || awaySkaters > 6) return null;
  if (homeSkaters === awaySkaters && homeSkaters >= 5) return null;
  return {
    homeSkaters, awaySkaters,
    // Une situation ne dure jamais plus qu'une majeure : borne contre un chiffre aberrant.
    secondsLeft: Math.min(300, secs),
    endsOnGoal: homeSkaters !== awaySkaters && secs <= 120,
  };
}

/**
 * Multiplicateurs de cadence mesurés : `m[tranche][écart + 3]`, l'écart vu de
 * l'équipe qui marque (borné à ±3), la tranche en secondes ÉCOULÉES.
 */
export interface LiveEffects {
  slices:     Array<[number, number] | number[]>;
  diffs:      number[];
  m:          number[][];
  periodDist: number[];
  /** λ moyen d'une équipe sur les saisons d'entraînement (facteur d'équipe des paris joueur). */
  leagueLambda?: number;
  /**
   * Facteur de cadence selon la situation numérique EN COURS (`calibrate_live_pp.py`),
   * vu de l'équipe : EV, EVS (4 c. 4), PP1/PP2, SH1/SH2. Moyenne pondérée par le
   * temps = 1 : sans situation connue, la cadence reste λ × w × m.
   */
  pp?: { g: Record<string, number>; trainSeasons?: number[] };
}

/** Part des buts restants : f explicite, sinon le temps réglementaire restant. */
export function liveFraction(live: LiveState): number {
  if (live.inOvertime) return 0;
  const f = live.f ?? live.secondsLeftReg / 3600;
  return Number.isFinite(f) ? Math.max(0, Math.min(1, f)) : 0;
}

export function finalScoreGrid(
  lambdaH: number, lambdaA: number, otShareHome: number, live?: LiveState,
): FinalScoreGrid {
  const h0 = live ? Math.max(0, Math.floor(live.homeScore)) : 0;
  const a0 = live ? Math.max(0, Math.floor(live.awayScore)) : 0;
  // Effets de score mesurés : buts restants par le moteur pas à pas.
  if (live?.effects && !live.inOvertime && live.secondsLeftReg > 0) {
    return gridFromRemaining(
      evolveLiveScore(lambdaH, lambdaA, h0, a0, 3600 - live.secondsLeftReg, live.effects, live.pp),
      h0, a0, otShareHome, live.tieBoost);
  }
  // Avant-match : plancher 0.05, grille depuis 0–0. En direct : les buts
  // RESTANTS, sans plancher — à f = 0 il n'en reste aucun, et `poissonPmfs(0)`
  // rend exactement [1, 0, 0…].
  const f  = live ? liveFraction(live) : 1;
  const ph = poissonPmfs(live ? Math.max(0, lambdaH) * f : Math.max(0.05, lambdaH));
  const pa = poissonPmfs(live ? Math.max(0, lambdaA) * f : Math.max(0.05, lambdaA));
  const rem = ph.map(x => pa.map(y => x * y));
  return gridFromRemaining(rem, h0, a0, otShareHome, live?.tieBoost);
}

/**
 * Grille du score final à partir de la loi des buts RESTANTS en temps
 * réglementaire (`rem[i][j]` = P(le domicile en marque encore i, le visiteur
 * j)), décalée du score actuel. Un nul à 60 minutes donne un but de plus au
 * vainqueur de la prolongation (`otShareHome`), après gonflement par
 * `tieBoost`.
 */
function gridFromRemaining(
  rem: number[][], h0: number, a0: number, otShareHome: number, tieBoost?: number,
): FinalScoreGrid {
  // Carrée : les lecteurs (`gridSum`…) parcourent `size` dans les deux sens.
  const size = Math.max(h0, a0) + MAX_K + 2;
  const p: number[][] = Array.from({ length: size }, () => new Array(size).fill(0));
  const share = Math.max(0, Math.min(1, otShareHome));
  const boost = tieBoost != null && tieBoost > 0 ? tieBoost : 1;
  let regHome = 0, regAway = 0, regTie = 0;
  for (let i = 0; i <= MAX_K; i++) {
    for (let j = 0; j <= MAX_K; j++) {
      let joint = rem[i][j];
      if (joint < 1e-14) continue;
      const h = h0 + i, a = a0 + j;
      if (h > a) { p[h][a] += joint; regHome += joint; continue; }
      if (h < a) { p[h][a] += joint; regAway += joint; continue; }
      // Nul réglementaire : un but de plus pour le vainqueur de la prolongation.
      joint *= boost;
      regTie += joint;
      p[h + 1][a] += joint * share;
      p[h][a + 1] += joint * (1 - share);
    }
  }
  // Renormalise la troncature : sans cela les partitions somment à 0.99999…
  let total = 0;
  for (const row of p) for (const v of row) total += v;
  if (total > 0) for (const row of p) for (let a = 0; a < size; a++) row[a] /= total;
  const reg = regHome + regAway + regTie || 1;
  return { p, size, regHome: regHome / reg, regAway: regAway / reg, regTie: regTie / reg };
}

/** Pas du moteur, en secondes. Les bornes des tranches et des périodes en sont des multiples. */
const STEP_SEC = 10;

/**
 * Loi des buts RESTANTS en temps réglementaire, quand la cadence de chaque
 * équipe dépend de l'état du match : `rem[i][j]` = P(le domicile en marque
 * encore i, le visiteur j), i, j ≤ MAX_K.
 *
 * Programmation dynamique sur le score, pas de 10 s, de `elapsedSec` à 3600 :
 * à chaque pas, chaque équipe marque 0, 1 ou 2 buts (Poisson) à la cadence
 *     λ × w(t) × m(écart vu de l'équipe, tranche de t)
 * où w est le profil de temps de `periodDist` (même répartition que les
 * cartes de période) et m le multiplicateur mesuré. L'écart est figé pendant
 * le pas : deux buts en 10 s restent des événements rares, et leur masse est
 * conservée (seuls ≥ 3 buts d'une équipe en un pas sont tronqués, ~10⁻⁶).
 * Avec m ≡ 1, on retrouve les deux Poisson indépendantes de la phase 1.
 *
 * Situation numérique en cours (`pp`, avec `fx.pp`) : pendant ses
 * `secondsLeft` secondes, chaque cadence est aussi multipliée par g(situation
 * vue de l'équipe). Mineure (`endsOnGoal`) : dans les cases où l'équipe en
 * avantage a déjà marqué depuis l'instant présent, la pénalité est finie et
 * g repasse à 1.
 */
export function evolveLiveScore(
  lambdaH: number, lambdaA: number, h0: number, a0: number,
  elapsedSec: number, fx: LiveEffects, pp?: LivePowerPlay | null,
): number[][] {
  const n = MAX_K + 1;
  let cur: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  cur[0][0] = 1;
  const lh = Math.max(0, lambdaH), la = Math.max(0, lambdaA);
  const d0 = h0 - a0;
  const sliceAt = (t: number) => {
    for (let s = 0; s < fx.slices.length; s++) if (t >= fx.slices[s][0] && t < fx.slices[s][1]) return s;
    return fx.slices.length - 1;
  };
  /** P(0, 1, 2 buts) sur le pas, renormalisée (≥ 3 tronqué). */
  const goals3 = (r: number) => {
    const e = Math.exp(-r);
    const p = [e, e * r, e * r * r / 2];
    const z = p[0] + p[1] + p[2];
    return [p[0] / z, p[1] / z, p[2] / z];
  };
  let maxI = 0, maxJ = 0;   // bornes de la masse non nulle : la boucle ne parcourt qu'elles
  let t = Math.max(0, Math.min(3600, elapsedSec));
  // Situation en cours : facteurs mesurés et instant (écoulé) où elle prend fin.
  const g = fx.pp?.g;
  const ppOn = !!(pp && g && pp.secondsLeft > 0);
  const ppEnd = ppOn ? Math.min(3600, t + pp!.secondsLeft) : t;
  const gH = ppOn ? g![ppCategory(pp!.homeSkaters, pp!.awaySkaters)] ?? 1 : 1;
  const gA = ppOn ? g![ppCategory(pp!.awaySkaters, pp!.homeSkaters)] ?? 1 : 1;
  // Mineure : finie dès que l'équipe en avantage marque (i > 0 domicile, j > 0 visiteur).
  const ppHome = ppOn && pp!.endsOnGoal && pp!.homeSkaters > pp!.awaySkaters;
  const ppAway = ppOn && pp!.endsOnGoal && pp!.awaySkaters > pp!.homeSkaters;
  while (t < 3600 - 1e-9) {
    let next = Math.min(3600, (Math.floor(t / STEP_SEC) + 1) * STEP_SEC);
    const inPp = t < ppEnd - 1e-9;
    if (inPp) next = Math.min(next, ppEnd);
    const per = Math.min(2, Math.floor(t / 1200));
    const w = (fx.periodDist[per] ?? 1 / 3) * (next - t) / 1200;
    const s = sliceAt(t);
    // La cadence ne dépend que de l'écart borné à ±3 : 7 cas par pas, ×2 pendant
    // une situation (pénalité en cours / déjà finie par un but).
    const byDiff: Array<{ ph: number[]; pa: number[] }> = [];
    const byDiffOn: Array<{ ph: number[]; pa: number[] }> = [];
    for (let c = 0; c < 7; c++) {
      const mh = fx.m[s][c] ?? 1, ma = fx.m[s][6 - c] ?? 1;
      byDiff.push({ ph: goals3(lh * w * mh), pa: goals3(la * w * ma) });
      if (inPp) byDiffOn.push({ ph: goals3(lh * w * mh * gH), pa: goals3(la * w * ma * gA) });
    }
    const nxt: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i <= maxI; i++) {
      for (let j = 0; j <= maxJ; j++) {
        const q = cur[i][j];
        if (q < 1e-15) continue;
        const on = inPp && !(ppHome && i > 0) && !(ppAway && j > 0);
        const { ph, pa } = (on ? byDiffOn : byDiff)[Math.max(-3, Math.min(3, d0 + i - j)) + 3];
        for (let k = 0; k < 3; k++) {
          const row = nxt[Math.min(MAX_K, i + k)];
          const qk = q * ph[k];
          row[j] += qk * pa[0];
          row[Math.min(MAX_K, j + 1)] += qk * pa[1];
          row[Math.min(MAX_K, j + 2)] += qk * pa[2];
        }
      }
    }
    maxI = Math.min(MAX_K, maxI + 2); maxJ = Math.min(MAX_K, maxJ + 2);
    cur = nxt;
    t = next;
  }
  return cur;
}

/** Somme des cases qui vérifient `pred(h, a)`. */
export function gridSum(g: FinalScoreGrid, pred: (h: number, a: number) => boolean): number {
  let s = 0;
  for (let h = 0; h < g.size; h++) for (let a = 0; a < g.size; a++) if (pred(h, a)) s += g.p[h][a];
  return s;
}

/**
 * P(le camp gagne par AU MOINS `n` buts | il gagne) — part des victoires qui
 * couvrent un handicap de −(n − 0.5).
 *
 * C'est un RAPPORT, et c'est voulu : la page affiche la probabilité de
 * victoire du mélange de facteurs (`mlHome`), pas celle de la grille des buts,
 * et les deux ne coïncident pas. Multiplier `mlHome` par ce rapport garde la
 * puck line et le score exact cohérents avec les tuiles Match Betting : les
 * scores exacts d'un camp somment exactement à sa probabilité de victoire, et
 * « −1.5 » ne peut jamais dépasser « gagne ».
 */
export function winByAtLeastShare(g: FinalScoreGrid, side: 'home' | 'away', n: number): number {
  const win = gridSum(g, (h, a) => (side === 'home' ? h > a : a > h));
  if (win <= 0) return 0;
  const cover = gridSum(g, (h, a) => (side === 'home' ? h - a >= n : a - h >= n));
  return cover / win;
}

/** P(score final exact w–l pour `side`) / P(`side` gagne). */
export function exactScoreShare(g: FinalScoreGrid, side: 'home' | 'away', winner: number, loser: number): number {
  const win = gridSum(g, (h, a) => (side === 'home' ? h > a : a > h));
  if (win <= 0) return 0;
  const cell = side === 'home' ? g.p[winner]?.[loser] ?? 0 : g.p[loser]?.[winner] ?? 0;
  return cell / win;
}

/** P(total final > line). */
export function totalOver(g: FinalScoreGrid, line: number): number {
  return gridSum(g, (h, a) => h + a > line);
}

/** P(buts finaux du camp > line). */
export function teamOver(g: FinalScoreGrid, side: 'home' | 'away', line: number): number {
  return gridSum(g, (h, a) => (side === 'home' ? h : a) > line);
}

/**
 * Version « facteur » : P(total final > line) à partir d'une cadence TOTALE et
 * du partage domicile/extérieur, sans construire la grille.
 *
 * Un total réglementaire pair 2k nul (k–k) gagne un but en prolongation ; c'est
 * la seule différence avec la Poisson du total réglementaire, et elle ne compte
 * que quand ⌊line⌋ est pair (2.5, 4.5, 6.5…).
 */
export function finalTotalOverFromRate(lambdaT: number, homeShare: number, line: number): number {
  const lam = Math.max(0.05, lambdaT);
  const k = Math.floor(line);
  let cdf = 0, term = Math.exp(-lam);
  for (let i = 0; i <= k; i++) { cdf += term; term = (term * lam) / (i + 1); }
  let over = 1 - cdf;
  if (k % 2 === 0) {
    const half = k / 2;
    const lh = lam * homeShare, la = lam * (1 - homeShare);
    over += pmf(lh, half) * pmf(la, half);
  }
  return over;
}

/**
 * P(buts finaux d'une équipe > line) à partir de SA cadence et de celle de
 * l'adversaire : Poisson réglementaire, plus le but de prolongation quand le
 * match est nul à ⌊line⌋ partout et que l'équipe gagne la prolongation.
 */
export function finalTeamOverFromRate(lambdaTeam: number, lambdaOpp: number, otShareTeam: number, line: number): number {
  const lt = Math.max(0.05, lambdaTeam);
  const k = Math.floor(line);
  let cdf = 0, term = Math.exp(-lt);
  for (let i = 0; i <= k; i++) { cdf += term; term = (term * lt) / (i + 1); }
  return (1 - cdf) + pmf(lt, k) * pmf(Math.max(0.05, lambdaOpp), k) * otShareTeam;
}

function pmf(lambda: number, k: number): number {
  let p = Math.exp(-lambda);
  for (let i = 0; i < k; i++) p *= lambda / (i + 1);
  return p;
}

/**
 * P(X ≥ j) pour une binomiale négative de moyenne λ et de dispersion k.
 *
 * Sert à « les deux marquent 1+ / 2+ / 3+ » : c'est la loi que la page utilise
 * déjà pour BTTS (voir `GOALS_DISPERSION_K` dans `nhlPredictions.ts`), étendue
 * aux seuils supérieurs. Le but de prolongation ne change jamais ce marché — il
 * ne fait passer que le VAINQUEUR de k à k+1, alors que « les deux ≥ j » exige
 * déjà du perdant qu'il ait j buts (voir le règlement de `both_teams_score`).
 */
export function nbAtLeast(lambda: number, j: number, k: number): number {
  if (j <= 0) return 1;
  const lam = Math.max(0.05, lambda);
  const q = lam / (k + lam);
  let p = Math.pow(k / (k + lam), k);   // P(0)
  let cdf = p;
  for (let n = 0; n < j - 1; n++) {
    p *= ((n + k) / (n + 1)) * q;       // P(n+1)
    cdf += p;
  }
  return Math.max(0, 1 - cdf);
}

/**
 * « L'équipe finit avec au moins `need` buts DE PLUS » en direct — même
 * binomiale négative que `nbAtLeast`, sur le temps restant.
 *
 * Une somme de binomiales négatives de même q est une binomiale négative dont
 * les dispersions s'additionnent : sur une part f du match, moyenne λ·f et
 * dispersion k·f. À f = 1 on retrouve exactement la loi d'avant-match.
 */
export function nbAtLeastLive(lambda: number, need: number, k: number, f: number): number {
  if (need <= 0) return 1;
  if (!(f > 0) || !(lambda > 0)) return 0;
  const lam = lambda * f, kk = k * f;
  const q = lam / (kk + lam);
  let p = Math.pow(kk / (kk + lam), kk);
  let cdf = p;
  for (let n = 0; n < need - 1; n++) {
    p *= ((n + kk) / (n + 1)) * q;
    cdf += p;
  }
  return Math.max(0, Math.min(1, 1 - cdf));
}
