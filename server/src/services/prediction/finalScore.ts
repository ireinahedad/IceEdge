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
  /** Taille de la grille (MAX_K + 2 : un nul à MAX_K peut finir MAX_K+1). */
  size: number;
}

export function finalScoreGrid(lambdaH: number, lambdaA: number, otShareHome: number): FinalScoreGrid {
  const ph = poissonPmfs(Math.max(0.05, lambdaH));
  const pa = poissonPmfs(Math.max(0.05, lambdaA));
  const size = MAX_K + 2;
  const p: number[][] = Array.from({ length: size }, () => new Array(size).fill(0));
  const share = Math.max(0, Math.min(1, otShareHome));
  for (let h = 0; h <= MAX_K; h++) {
    for (let a = 0; a <= MAX_K; a++) {
      const joint = ph[h] * pa[a];
      if (joint < 1e-14) continue;
      if (h !== a) { p[h][a] += joint; continue; }
      // Nul réglementaire : un but de plus pour le vainqueur de la prolongation.
      p[h + 1][a] += joint * share;
      p[h][a + 1] += joint * (1 - share);
    }
  }
  // Renormalise la troncature : sans cela les partitions somment à 0.99999…
  let total = 0;
  for (const row of p) for (const v of row) total += v;
  if (total > 0) for (const row of p) for (let a = 0; a < size; a++) row[a] /= total;
  return { p, size };
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
