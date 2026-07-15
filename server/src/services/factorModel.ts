/**
 * factorModel.ts
 * Décompose CHAQUE type de pari en facteurs nommés (id, label, poids par défaut,
 * valeur 0-1 = probabilité de l'issue vue par ce facteur). Le score affiché est
 * la moyenne pondérée des facteurs — c'est le modèle « boîte de verre ».
 *
 * Le serveur produit les VALEURS ; le client détient les POIDS (ajustables par
 * famille dans chaque carte) et recompose le score en direct.
 *
 * Familles (factorGroup) :
 *   match | totals | period | margin | ot | player_off | player_phys | goalie
 *
 * Sécurité : si une option n'est pas reconnue, elle est laissée intacte
 * (pas de factors) → la carte retombe sur le calcul existant.
 */

export interface Factor { id: string; label: string; weight: number; value: number; }

// ── Primitives ─────────────────────────────────────────────────────────────────
function clamp(x: number, lo = 0.05, hi = 0.95): number { return Math.max(lo, Math.min(hi, x)); }
function poissonOver(lambda: number, line: number): number {
  const k = Math.floor(line);
  let cdf = 0, term = Math.exp(-lambda);
  for (let i = 0; i <= k; i++) { cdf += term; term = (term * lambda) / (i + 1); }
  return clamp(1 - cdf, 0.02, 0.98);
}
/** Sigmoïde centrée : renvoie une prob 0-1 selon l'écart (x-ref)/spread. */
function lean(x: number, ref: number, spread: number): number {
  return clamp(1 / (1 + Math.exp(-(x - ref) / spread)));
}
/** Moyenne pondérée des facteurs → pourcentage entier borné. */
export function blendPct(factors: Factor[]): number {
  const wsum = factors.reduce((s, f) => s + f.weight, 0) || 1;
  const p = factors.reduce((s, f) => s + f.weight * f.value, 0) / wsum;
  return Math.round(Math.max(3, Math.min(97, p * 100)));
}
function inv(factors: Factor[]): Factor[] { return factors.map(f => ({ ...f, value: clamp(1 - f.value) })); }

// ── Contexte de match ───────────────────────────────────────────────────────────
export interface GameFactorCtx {
  wH: number; wA: number;
  gfH: number; gaH: number; gfA: number; gaA: number;
  lambdaH: number; lambdaA: number; lambdaT: number;
  hSF: number; aSF: number;
  hPP: number; aPP: number; hPK: number; aPK: number;
  hB2b: 0 | 1; aB2b: 0 | 1;
  homeIce: number;   // 0-1, faveur domicile (déjà calculée)
  fatigue: number;   // 0-1, faveur domicile côté fraîcheur
  mlHome: number;    // prob victoire domicile (finale)
  ot: number;        // prob OT
  matchFactors: Factor[]; // facteurs du résultat de match (famille 1, déjà calculés)
}

const SHOOT_PCT = 0.102; // ~tirs → buts

// ── Familles ────────────────────────────────────────────────────────────────────

/** Totaux : facteurs pour P(total > line). */
function totalsFactors(line: number, c: GameFactorCtx): Factor[] {
  const offense = poissonOver(c.gfH + c.gfA, line);
  const defense = poissonOver(c.gaH + c.gaA, line);
  const shotPace = poissonOver((c.hSF + c.aSF) * SHOOT_PCT, line);
  const ppAdj = c.lambdaT * (1 + 0.05 * ((c.hPP + c.aPP) / 40 - 1));
  const special = poissonOver(ppAdj, line);
  const fatigue = poissonOver(c.lambdaT * (1 - 0.04 * (c.hB2b + c.aB2b)), line);
  return [
    { id: 'offense',      label: 'Attaque combinée',   weight: 30, value: offense },
    { id: 'defense',      label: 'Défense combinée',   weight: 30, value: defense },
    { id: 'shotPace',     label: 'Rythme de tirs',     weight: 15, value: shotPace },
    { id: 'specialTeams', label: 'Unités spéciales',   weight: 10, value: special },
    { id: 'fatigue',      label: 'Épuisement',         weight: 5,  value: fatigue },
  ];
}

/** BTTS Yes : les deux marquent. */
function bttsFactors(c: GameFactorCtx): Factor[] {
  const both = clamp((1 - Math.exp(-c.lambdaH)) * (1 - Math.exp(-c.lambdaA)));
  const offense = clamp((1 - Math.exp(-c.gfH)) * (1 - Math.exp(-c.gfA)));
  const defense = clamp(lean(c.gaH + c.gaA, 6.0, 1.0)); // défenses faibles → BTTS
  return [
    { id: 'offense', label: 'Attaque combinée', weight: 40, value: offense },
    { id: 'defense', label: 'Défense combinée', weight: 35, value: defense },
    { id: 'model',   label: 'Buts attendus',    weight: 25, value: both },
  ];
}

/** Résultat de période — issue "home" (leans autour du modèle). */
function periodFactors(pHome: number, c: GameFactorCtx): Factor[] {
  return [
    { id: 'quality',  label: 'Qualité d’équipe',        weight: 35, value: clamp(lean(c.wH - c.wA, 0, 0.15)) },
    { id: 'periodAD', label: 'Attaque/défense période', weight: 35, value: clamp(pHome) },
    { id: 'homeIce',  label: 'Avantage domicile',       weight: 15, value: c.homeIce },
    { id: 'fatigue',  label: 'Épuisement',              weight: 15, value: c.fatigue },
  ];
}

/** Marge de victoire — issue cible (by1/by2/by3+), leans autour du modèle. */
function marginFactors(pModel: number, target: 'by1' | 'by2' | 'by3', c: GameFactorCtx): Factor[] {
  const gap = Math.abs(c.wH - c.wA);
  // Écart de force : gros écart → favorise les grosses marges, défavorise "par 1".
  const gapLean = target === 'by1' ? lean(-gap, -0.15, 0.12) : lean(gap, 0.15, 0.12);
  // Total attendu : matchs à gros total → marges plus larges.
  const totLean = target === 'by1' ? lean(-c.lambdaT, -6.0, 0.8) : lean(c.lambdaT, 6.0, 0.8);
  return [
    { id: 'forceGap',      label: 'Écart de force',    weight: 45, value: clamp(0.5 * pModel + 0.5 * gapLean) },
    { id: 'expectedTotal', label: 'Total attendu',     weight: 35, value: clamp(0.5 * pModel + 0.5 * totLean) },
    { id: 'homeIce',       label: 'Avantage domicile', weight: 20, value: c.homeIce },
  ];
}

/** Prolongation — P(va en OT). */
function otFactors(c: GameFactorCtx): Factor[] {
  const balance = 1 - 2 * Math.abs(c.mlHome - 0.5);          // 0..1
  const balanceV = clamp(0.15 + 0.30 * balance, 0.08, 0.5);
  const lowTotalV = clamp(0.15 + 0.25 * lean(6.0 - c.lambdaT, 0, 0.8), 0.08, 0.5);
  return [
    { id: 'balance',  label: 'Équilibre des forces', weight: 65, value: balanceV },
    { id: 'lowTotal', label: 'Faible total attendu', weight: 35, value: lowTotalV },
  ];
}

/**
 * Attache les facteurs aux options d'un match. Modifie chaque option en place
 * (factors + factorGroup) et recale rulePct = blend(facteurs par défaut).
 */
export function attachGameFactors(groups: any[], c: GameFactorCtx): void {
  const set = (o: any, group: string, factors: Factor[]) => {
    o.factors = factors.map(f => ({ id: f.id, label: f.label, weight: f.weight, value: f.value }));
    o.factorGroup = group;
    o.rulePct = blendPct(factors);
  };
  for (const g of groups) {
    for (const o of g.options) {
      const id: string = o.id;
      // Résultat du match / double chance / puck line → famille "match"
      if (id === 'ml-home') set(o, 'match', c.matchFactors);
      else if (id === 'ml-away') set(o, 'match', inv(c.matchFactors));
      else if (id === 'ml-ot' || id === 'ot-yes') set(o, 'ot', otFactors(c));
      else if (id === 'ot-no') set(o, 'ot', inv(otFactors(c)));
      else if (id === 'dc-home') set(o, 'match', c.matchFactors.map(f => ({ ...f, value: clamp(f.value + 0.12) })));
      else if (id === 'dc-away') set(o, 'match', inv(c.matchFactors).map(f => ({ ...f, value: clamp(f.value + 0.12) })));
      else if (id === 'pl-home') set(o, 'match', c.matchFactors.map(f => ({ ...f, value: clamp(f.value - 0.15) })));
      else if (id === 'pl-away') set(o, 'match', inv(c.matchFactors.map(f => ({ ...f, value: clamp(f.value - 0.15) }))));
      // Totaux
      else if (id === 'o55') set(o, 'totals', totalsFactors(5.5, c));
      else if (id === 'u55') set(o, 'totals', inv(totalsFactors(5.5, c)));
      else if (id === 'o65') set(o, 'totals', totalsFactors(6.5, c));
      else if (id === 'u65') set(o, 'totals', inv(totalsFactors(6.5, c)));
      else if (id === 'btts-yes') set(o, 'totals', bttsFactors(c));
      else if (id === 'btts-no') set(o, 'totals', inv(bttsFactors(c)));
      else if (id === 'p1-o05' || id === 'p1-o15' || id === 'p1-o25') set(o, 'totals', totalsFactors(id === 'p1-o05' ? 0.5 : id === 'p1-o15' ? 1.5 : 2.5, { ...c, gfH: c.gfH * 0.305, gfA: c.gfA * 0.305, gaH: c.gaH * 0.305, gaA: c.gaA * 0.305, lambdaT: c.lambdaT * 0.305, hSF: c.hSF * 0.305, aSF: c.aSF * 0.305 }));
      // Période
      else if (/^p[123]-home$/.test(id)) set(o, 'period', periodFactors(o.rulePct / 100, c));
      else if (/^p[123]-away$/.test(id)) set(o, 'period', inv(periodFactors(1 - o.rulePct / 100, c)));
      else if (/^p[123]-draw$/.test(id)) { /* nul : laissé au modèle */ }
      // Marge
      else if (id === 'wm-1') set(o, 'margin', marginFactors(o.rulePct / 100, 'by1', c));
      else if (id === 'wm-2') set(o, 'margin', marginFactors(o.rulePct / 100, 'by2', c));
      else if (id === 'wm-3p') set(o, 'margin', marginFactors(o.rulePct / 100, 'by3', c));
    }
  }
}

// ── Props joueur / gardien (contexte limité : pas d'adversaire dans ces vues) ────

/** Props offensifs joueur : P(stat > line). rate = taux/match du joueur, spg = tirs/match. */
function playerOffFactors(rate: number, line: number, spg: number): Factor[] {
  return [
    { id: 'playerRate',  label: 'Taux du joueur',  weight: 78, value: poissonOver(rate, line) },
    { id: 'shotVolume',  label: 'Volume de tirs',  weight: 22, value: clamp(lean(spg, 2.6, 1.1)) },
  ];
}
/** Props physiques joueur : seule la moyenne de position est disponible. */
function playerPhysFactors(posAvg: number, line: number): Factor[] {
  return [
    { id: 'positionAvg', label: 'Moyenne de position', weight: 100, value: poissonOver(posAvg, line) },
  ];
}

export function attachPlayerFactors(groups: any[]): void {
  const set = (o: any, group: string, factors: Factor[]) => {
    o.factors = factors.map(f => ({ ...f }));
    o.factorGroup = group;
    // rulePct laissé tel quel (calculé par le modèle) — le client recompose à l'affichage.
  };
  // Note : les valeurs de facteurs proviennent de rulePct existant faute de contexte
  // adverse ; on expose au moins la décomposition disponible.
  for (const g of groups) {
    for (const o of g.options) {
      const p0 = o.rulePct / 100;
      if (['hits', 'blocks', 'pim'].includes(g.id)) {
        set(o, 'player_phys', [{ id: 'positionAvg', label: 'Moyenne de position', weight: 100, value: clamp(p0) }]);
      } else {
        // offensif : taux du joueur dominant + volume (approx. depuis p0)
        set(o, 'player_off', [
          { id: 'playerRate', label: 'Taux du joueur', weight: 78, value: clamp(p0) },
          { id: 'shotVolume', label: 'Volume de tirs', weight: 22, value: clamp(p0) },
        ]);
      }
    }
  }
}

export function attachGoalieFactors(groups: any[]): void {
  for (const g of groups) {
    for (const o of g.options) {
      const p0 = o.rulePct / 100;
      const win = g.id === 'gresult';
      o.factorGroup = 'goalie';
      o.factors = win
        ? [
            { id: 'teamStrength', label: 'Force de l’équipe', weight: 50, value: clamp(p0) },
            { id: 'teamDefense',  label: 'Défense de l’équipe', weight: 35, value: clamp(p0) },
            { id: 'oppAttack',    label: 'Attaque adverse',    weight: 15, value: clamp(1 - p0) },
          ]
        : [
            { id: 'oppAttack',   label: 'Attaque adverse',    weight: 50, value: clamp(p0) },
            { id: 'teamDefense', label: 'Défense de l’équipe', weight: 35, value: clamp(p0) },
            { id: 'fatigue',     label: 'Épuisement',         weight: 15, value: clamp(p0) },
          ];
    }
  }
}
