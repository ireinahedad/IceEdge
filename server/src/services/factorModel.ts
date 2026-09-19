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
/**
 * Ramène les poids d'une famille à une somme de EXACTEMENT 100, en entiers.
 *
 * Pourquoi : le calcul est une moyenne pondérée, donc invariant d'échelle — la
 * somme des poids n'a jamais compté ici. Mais la carte de règles du client
 * présente ces poids comme un budget « X / 100 » que l'utilisateur répartit,
 * et deux familles ne tenaient pas ce contrat : `totals` vaut 90 de base et
 * grimpe à 106 avec les facteurs conditionnels (altitude, arbitrage), et
 * `match` vaut de 50 à 100 selon les facteurs actifs (cote, blessures,
 * alignement). L'écran affichait donc « Total : 106 / 100 » en rouge.
 *
 * Répartition au plus fort reste : les poids entiers somment à 100 pile, sans
 * qu'un facteur non nul tombe à 0.
 */
function normalizeWeights(factors: Factor[]): Factor[] {
  const sum = factors.reduce((s, f) => s + f.weight, 0);
  if (sum <= 0) return factors.map(f => ({ ...f }));

  const scaled = factors.map(f => (f.weight / sum) * 100);
  const out = factors.map((f, i) => ({ ...f, weight: Math.floor(scaled[i]) }));
  let rest = 100 - out.reduce((s, f) => s + f.weight, 0);
  const byFrac = scaled
    .map((w, i) => ({ i, frac: w - Math.floor(w) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; rest > 0 && k < byFrac.length; k++, rest--) out[byFrac[k].i].weight += 1;
  return out;
}

/** Moyenne pondérée des facteurs → pourcentage entier borné. */
function blendPct(factors: Factor[]): number {
  const wsum = factors.reduce((s, f) => s + f.weight, 0) || 1;
  const p = factors.reduce((s, f) => s + f.weight * f.value, 0) / wsum;
  return Math.round(Math.max(3, Math.min(97, p * 100)));
}
/**
 * Pose les facteurs sur une option (factors + factorGroup) et recale rulePct.
 * Poids normalisés AVANT le blend : le client recalcule le score à partir des
 * poids qu'il reçoit, donc les deux chiffres doivent partir des mêmes.
 */
/**
 * Pose les facteurs d'une tuile ET recale son pourcentage sur leur mélange.
 *
 * ── `pctScale` : une tuile qui n'est pas exactement la question des facteurs ──
 *
 * Ce recalage écrase `rulePct`. C'est voulu — la fiche ouverte recalcule le
 * score depuis les facteurs, donc un `rulePct` posé en amont ferait dire deux
 * chiffres différents au même pari. Mais certaines tuiles sont une FRACTION
 * connue de la question que décrivent leurs facteurs, pas cette question même :
 * « gagne en temps réglementaire » se mesure avec les facteurs de « gagne »,
 * amputés de la part qui se joue en prolongation.
 *
 * `o.pctScale` porte cette fraction. Elle est appliquée APRÈS le mélange, donc
 * elle survit à une repondération par l'utilisateur : alourdir la forme récente
 * déplace la probabilité de victoire, et la part réglementaire suit.
 *
 * Absente, rien ne change — c'est le cas de l'écrasante majorité des tuiles.
 */
function setFactors(o: any, group: string, factors: Factor[]): void {
  const norm = normalizeWeights(factors);
  o.factors = norm.map(f => ({ id: f.id, label: f.label, weight: f.weight, value: f.value }));
  o.factorGroup = group;
  const scale = typeof o.pctScale === 'number' && o.pctScale > 0 ? o.pctScale : 1;
  o.rulePct = scale === 1
    ? blendPct(norm)
    : Math.round(Math.max(3, Math.min(97, blendPct(norm) * scale)));
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
  venueAlt?: number; // altitude du terrain (m) — air raréfié → plus de buts
  hAltGain?: number; aAltGain?: number; // dénivelé subi (m) par chaque équipe
  refPenaltyMult?: number; // volume de PP relatif à l'arbitrage (1.0 neutre)
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
  const factors: Factor[] = [
    { id: 'offense',      label: 'Attaque combinée',   weight: 30, value: offense },
    { id: 'defense',      label: 'Défense combinée',   weight: 30, value: defense },
    { id: 'shotPace',     label: 'Rythme de tirs',     weight: 15, value: shotPace },
    { id: 'specialTeams', label: 'Unités spéciales',   weight: 10, value: special },
    { id: 'fatigue',      label: 'Épuisement',         weight: 5,  value: fatigue },
  ];
  // Altitude : air raréfié (Denver ~1600 m, Salt Lake ~1290 m) → plus de buts.
  // Neutre (0.5) au niveau de la mer ; n'ajoute le facteur qu'en altitude notable.
  if (c.venueAlt != null && c.venueAlt >= 800) {
    const altValue = clamp(0.5 + 0.12 * Math.min(1, (c.venueAlt - 500) / 1100));
    factors.push({ id: 'altitude', label: 'Altitude', weight: 8, value: altValue });
  }
  // Arbitrage : arbitre siffleur → plus de power-plays → total plus élevé.
  // Volume PP ligue ≈ 6.2/match, conversion ≈ 20 % → ~1.24 but par 100 % d'écart.
  if (c.refPenaltyMult != null && Math.abs(c.refPenaltyMult - 1) > 0.01) {
    const goalsShift = (c.refPenaltyMult - 1) * 1.24;
    factors.push({
      id: 'referee', label: 'Arbitrage (PP)', weight: 8,
      value: poissonOver(c.lambdaT + goalsShift, line),
    });
  }
  return factors;
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

/** Nul de période — P(égalité dans la période). */
function periodDrawFactors(pModel: number, c: GameFactorCtx): Factor[] {
  const balance = clamp(1 - 2 * Math.abs(c.mlHome - 0.5), 0, 1);
  const lambdaP = c.lambdaT / 3; // buts attendus dans la période
  // Moins de buts attendus → plus de chances d'égalité (0-0, 1-1…).
  const lowScoring = clamp(0.26 + 0.20 * lean(2.0 - lambdaP, 0, 0.35), 0.12, 0.55);
  const balanceV   = clamp(0.22 + 0.22 * balance, 0.10, 0.55);
  return [
    { id: 'drawModel',  label: 'Modèle Skellam (nul)',   weight: 50, value: clamp(pModel, 0.02, 0.98) },
    { id: 'lowScoring', label: 'Faible rythme de buts',  weight: 30, value: lowScoring },
    { id: 'balance',    label: 'Équilibre des forces',   weight: 20, value: balanceV },
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

// ── Extras équipe (vue équipe uniquement) ──────────────────────────────────────
// Ces marchés n'existent que dans la vue équipe : buts de l'équipe O/U 2.5,
// blanchissage, but en avantage numérique, PK parfait.

const PP_OPPS = 3.1; // occasions d'avantage numérique / match (moyenne NHL)

/** Buts de l'équipe (domicile/sujet) > 2.5. */
function teamTotalFactors(c: GameFactorCtx): Factor[] {
  return [
    { id: 'teamOffense', label: 'Attaque de l’équipe',   weight: 40, value: poissonOver(c.gfH, 2.5) },
    { id: 'oppDefense',  label: 'Défense adverse',       weight: 30, value: poissonOver(c.gaA, 2.5) },
    { id: 'shotVolume',  label: 'Volume de tirs',        weight: 15, value: poissonOver(c.hSF * SHOOT_PCT, 2.5) },
    { id: 'ppStrength',  label: 'Avantage numérique',    weight: 15, value: clamp(lean(c.hPP, 20, 4)) },
  ];
}

/** Blanchissage (l'équipe ne concède aucun but). */
function shutoutFactors(c: GameFactorCtx): Factor[] {
  const base = clamp(Math.exp(-c.lambdaA), 0.02, 0.6);           // P(0 but adverse) selon le modèle
  const oppWeak = clamp(Math.exp(-c.gfA), 0.02, 0.6);            // attaque adverse faible
  const defense = clamp(Math.exp(-c.gaH), 0.02, 0.6);            // défense de l'équipe
  const pk = clamp(0.04 + 0.14 * lean(c.hPK, 80, 4), 0.02, 0.5); // PK solide → moins de buts PP concédés
  return [
    { id: 'model',      label: 'Buts adverses attendus', weight: 40, value: base },
    { id: 'oppAttack',  label: 'Attaque adverse',        weight: 25, value: oppWeak },
    { id: 'teamDefense',label: 'Défense de l’équipe',    weight: 20, value: defense },
    { id: 'pkStrength', label: 'Infériorité numérique',  weight: 15, value: pk },
  ];
}

/** Marque au moins un but en avantage numérique. */
function ppGoalFactors(c: GameFactorCtx): Factor[] {
  const ppEff  = clamp(1 - Math.exp(-PP_OPPS * (c.hPP / 100)));        // efficacité PP × occasions
  const oppPk  = clamp(1 - Math.exp(-PP_OPPS * ((100 - c.aPK) / 100)));// faiblesse du PK adverse
  const offense = clamp(lean(c.gfH, 3.05, 0.5));
  return [
    { id: 'ppEfficiency', label: 'Efficacité du PP',   weight: 55, value: ppEff },
    { id: 'oppPkWeak',    label: 'PK adverse',         weight: 30, value: oppPk },
    { id: 'offense',      label: 'Attaque de l’équipe', weight: 15, value: offense },
  ];
}

/** Tue toutes ses pénalités (PK parfait). */
function pkPerfectFactors(c: GameFactorCtx): Factor[] {
  const pkPerf  = clamp(Math.pow(c.hPK / 100, PP_OPPS), 0.05, 0.9);        // PK% ^ occasions
  const oppWeak = clamp(Math.pow(1 - c.aPP / 100, PP_OPPS), 0.05, 0.9);    // PP adverse inefficace
  const defense = clamp(lean(3.05 - c.gaH, 0, 0.5));                       // défense générale
  return [
    { id: 'pkStrength', label: 'Infériorité numérique', weight: 55, value: pkPerf },
    { id: 'oppPpWeak',  label: 'PP adverse',            weight: 30, value: oppWeak },
    { id: 'teamDefense',label: 'Défense de l’équipe',   weight: 15, value: defense },
  ];
}

/**
 * Attache les facteurs aux options d'un match. Modifie chaque option en place
 * (factors + factorGroup) et recale rulePct = blend(facteurs par défaut).
 */
export function attachGameFactors(groups: any[], c: GameFactorCtx): void {
  for (const g of groups) {
    for (const o of g.options) {
      const id: string = o.id;
      // Résultat du match / puck line → famille "match"
      if (id === 'ml-home') setFactors(o, 'match', c.matchFactors);
      else if (id === 'ml-away') setFactors(o, 'match', inv(c.matchFactors));
      // `ml-ot` a disparu avec le passage du marché Match Betting à quatre
      // tuiles : il valait « le match va en prolongation », sans vainqueur. Les
      // deux moitiés qui l'ont remplacé portent les MÊMES facteurs (la question
      // « va-t-on en prolongation ? » est commune) et se distinguent par leur
      // `pctScale`, qui est la part de prolongation revenant à chaque équipe.
      else if (id === 'ml-home-ot' || id === 'ml-away-ot' || id === 'ot-yes') setFactors(o, 'ot', otFactors(c));
      else if (id === 'ot-no') setFactors(o, 'ot', inv(otFactors(c)));
      else if (id === 'pl-home') setFactors(o, 'match', c.matchFactors.map(f => ({ ...f, value: clamp(f.value - 0.15) })));
      else if (id === 'pl-away') setFactors(o, 'match', inv(c.matchFactors.map(f => ({ ...f, value: clamp(f.value - 0.15) }))));
      // Totaux
      else if (id === 'o55') setFactors(o, 'totals', totalsFactors(5.5, c));
      else if (id === 'u55') setFactors(o, 'totals', inv(totalsFactors(5.5, c)));
      else if (id === 'o65') setFactors(o, 'totals', totalsFactors(6.5, c));
      else if (id === 'u65') setFactors(o, 'totals', inv(totalsFactors(6.5, c)));
      else if (id === 'btts-yes') setFactors(o, 'totals', bttsFactors(c));
      else if (id === 'btts-no') setFactors(o, 'totals', inv(bttsFactors(c)));
      else if (id === 'p1-o05' || id === 'p1-o15' || id === 'p1-o25') setFactors(o, 'totals', totalsFactors(id === 'p1-o05' ? 0.5 : id === 'p1-o15' ? 1.5 : 2.5, { ...c, gfH: c.gfH * 0.305, gfA: c.gfA * 0.305, gaH: c.gaH * 0.305, gaA: c.gaA * 0.305, lambdaT: c.lambdaT * 0.305, hSF: c.hSF * 0.305, aSF: c.aSF * 0.305 }));
      // Période
      else if (/^p[123]-home$/.test(id)) setFactors(o, 'period', periodFactors(o.rulePct / 100, c));
      else if (/^p[123]-away$/.test(id)) setFactors(o, 'period', inv(periodFactors(1 - o.rulePct / 100, c)));
      else if (/^p[123]-draw$/.test(id)) setFactors(o, 'period_draw', periodDrawFactors(o.rulePct / 100, c));
      // Marge
      else if (id === 'wm-1') setFactors(o, 'margin', marginFactors(o.rulePct / 100, 'by1', c));
      else if (id === 'wm-2') setFactors(o, 'margin', marginFactors(o.rulePct / 100, 'by2', c));
      else if (id === 'wm-3p') setFactors(o, 'margin', marginFactors(o.rulePct / 100, 'by3', c));
      // Extras équipe (vue équipe uniquement)
      else if (id === 'tg-o25') setFactors(o, 'team_totals', teamTotalFactors(c));
      else if (id === 'tg-u25') setFactors(o, 'team_totals', inv(teamTotalFactors(c)));
      else if (id === 'cs-for') setFactors(o, 'team_shutout', shutoutFactors(c));
      else if (id === 'ppgoal') setFactors(o, 'team_special', ppGoalFactors(c));
      else if (id === 'pk-perfect') setFactors(o, 'team_special', pkPerfectFactors(c));
    }
  }
}

// ── Props joueur (contexte limité : pas d'adversaire dans ces vues) ─────────────

/** Contexte réel du joueur (taux par match, calculés dans nhlPredictions). */
export interface PlayerFactorCtx {
  pos: string;      // F | C | D
  gpg: number;      // buts / match
  apg: number;      // assists / match
  ppg: number;      // points / match
  spg: number;      // tirs / match
  pppg: number;     // points en avantage numérique / match
  shotPct: number;  // % de tirs convertis (ex. 13.5), 0 si inconnu
  hitsPg: number;   // mises en échec / match (moyenne de position à défaut)
  blocksPg: number; // tirs bloqués / match (moyenne de position à défaut)
  pimPg: number;    // minutes de pénalité / match (moyenne de position à défaut)
}

const LEAGUE_SHOT_PCT = 10.2; // % de conversion moyen NHL
const LEAGUE_SPG      = 2.2;  // tirs / match moyen (patineurs réguliers)

/** Ligne du pari depuis son id (…-o25 → 2.5, …-o05 → 0.5). */
function lineFromId(id: string): number | null {
  const m = id.match(/-o(\d)(\d)$/);
  return m ? Number(m[1]) + Number(m[2]) / 10 : null;
}

/** Buts : taux de marquage + volume de tirs + finition + production PP. */
function goalFactors(line: number, c: PlayerFactorCtx): Factor[] {
  const finishing = c.shotPct > 0 ? lean(c.shotPct, LEAGUE_SHOT_PCT, 3.5) : 0.5;
  return [
    { id: 'scoringRate', label: 'Taux de buts',        weight: 45, value: poissonOver(c.gpg, line) },
    { id: 'shotVolume',  label: 'Volume de tirs',      weight: 25, value: clamp(lean(c.spg, 2.6, 1.0)) },
    { id: 'finishing',   label: 'Finition (tir %)',    weight: 15, value: clamp(finishing) },
    { id: 'ppUsage',     label: 'Production en PP',    weight: 15, value: clamp(lean(c.pppg, 0.35, 0.25)) },
  ];
}

/** Premier buteur : part du menace-anytime + part des tirs d'équipe + PP. */
function firstGoalFactors(c: PlayerFactorCtx): Factor[] {
  const anytime = 1 - Math.exp(-c.gpg);
  return [
    { id: 'anytimeShare', label: 'Menace de but (÷ buteurs)', weight: 55, value: clamp(anytime / 5.2, 0.01, 0.35) },
    { id: 'shotShare',    label: 'Part des tirs d’équipe',    weight: 30, value: clamp(c.spg / 30, 0.01, 0.3) },
    { id: 'ppUsage',      label: 'Déploiement en PP',         weight: 15, value: clamp(0.03 + 0.25 * lean(c.pppg, 0.35, 0.25) * 0.4, 0.01, 0.3) },
  ];
}

/** Assists : taux + part de passes + environnement offensif + PP. */
function assistFactors(line: number, c: PlayerFactorCtx): Factor[] {
  const playShare = c.ppg > 0 ? c.apg / c.ppg : 0.5; // part des points qui sont des passes
  return [
    { id: 'assistRate', label: 'Taux d’assists',        weight: 50, value: poissonOver(c.apg, line) },
    { id: 'playmaking', label: 'Profil de passeur',     weight: 20, value: clamp(lean(playShare, 0.55, 0.15)) },
    { id: 'offenseEnv', label: 'Production offensive',  weight: 15, value: clamp(lean(c.ppg, 0.8, 0.4)) },
    { id: 'ppUsage',    label: 'Production en PP',      weight: 15, value: clamp(lean(c.pppg, 0.35, 0.25)) },
  ];
}

/** Points : taux + volume de tirs + PP + équilibre buts/passes. */
function pointFactors(line: number, c: PlayerFactorCtx): Factor[] {
  const balance = Math.max(c.gpg, c.apg) > 0 ? Math.min(c.gpg, c.apg) / Math.max(c.gpg, c.apg) : 0.5;
  return [
    { id: 'pointsRate', label: 'Taux de points',        weight: 55, value: poissonOver(c.ppg, line) },
    { id: 'shotVolume', label: 'Volume de tirs',        weight: 20, value: clamp(lean(c.spg, 2.6, 1.0)) },
    { id: 'ppUsage',    label: 'Production en PP',      weight: 15, value: clamp(lean(c.pppg, 0.35, 0.25)) },
    { id: 'balance',    label: 'Équilibre buts/passes', weight: 10, value: clamp(lean(balance, 0.5, 0.25)) },
  ];
}

/** Tirs au but : taux + rôle de tireur + menace offensive. */
function shotFactors(line: number, c: PlayerFactorCtx): Factor[] {
  return [
    { id: 'shotRate',   label: 'Taux de tirs',      weight: 60, value: poissonOver(c.spg, line) },
    { id: 'shooterRole',label: 'Rôle de tireur',    weight: 25, value: clamp(lean(c.spg, LEAGUE_SPG, 1.0)) },
    { id: 'goalThreat', label: 'Menace de but',     weight: 15, value: clamp(lean(c.gpg, 0.30, 0.20)) },
  ];
}

/** Mises en échec : taux (moyenne de position à défaut) + rôle physique. */
function hitFactors(line: number, c: PlayerFactorCtx): Factor[] {
  const physRole = c.pos === 'D' ? 0.58 : clamp(lean(c.hitsPg, 2.1, 0.8));
  return [
    { id: 'hitRate',      label: 'Taux de mises en échec', weight: 70, value: poissonOver(c.hitsPg, line) },
    { id: 'physicalRole', label: 'Rôle physique',          weight: 30, value: clamp(physRole) },
  ];
}

/** Tirs bloqués : taux + rôle défensif (les D bloquent bien plus). */
function blockFactors(line: number, c: PlayerFactorCtx): Factor[] {
  return [
    { id: 'blockRate',     label: 'Taux de blocs',   weight: 70, value: poissonOver(c.blocksPg, line) },
    { id: 'defensiveRole', label: 'Rôle défensif',   weight: 30, value: c.pos === 'D' ? 0.7 : 0.35 },
  ];
}

/** Point / but en avantage numérique. */
function ppPointFactors(c: PlayerFactorCtx): Factor[] {
  return [
    { id: 'ppRate',     label: 'Taux de points en PP', weight: 65, value: clamp(1 - Math.exp(-c.pppg)) },
    { id: 'offenseEnv', label: 'Production offensive', weight: 35, value: clamp(lean(c.ppg, 0.8, 0.4)) },
  ];
}
function ppGoalPlayerFactors(c: PlayerFactorCtx): Factor[] {
  const finishing = c.shotPct > 0 ? lean(c.shotPct, LEAGUE_SHOT_PCT, 3.5) : 0.5;
  return [
    { id: 'ppRate',    label: 'Taux de buts en PP', weight: 65, value: clamp(1 - Math.exp(-c.pppg * 0.45)) },
    { id: 'finishing', label: 'Finition (tir %)',   weight: 35, value: clamp(finishing) },
  ];
}

/** Minutes de pénalité : taux + style de jeu physique. */
function pimFactors(line: number, c: PlayerFactorCtx): Factor[] {
  return [
    { id: 'pimRate',     label: 'Taux de pénalités', weight: 70, value: poissonOver(c.pimPg, line) },
    { id: 'physicality', label: 'Jeu physique',      weight: 30, value: clamp(lean(c.hitsPg, 2.1, 0.8)) },
  ];
}

export function attachPlayerFactors(groups: any[], c: PlayerFactorCtx): void {
  for (const g of groups) {
    for (const o of g.options) {
      const id: string = o.id;
      const line = lineFromId(id);
      if (g.id === 'goals') {
        if (id === 'g-first') setFactors(o, 'player_first_goal', firstGoalFactors(c));
        else setFactors(o, 'player_goals', goalFactors(id === 'g-2plus' ? 1.5 : 0.5, c));
      }
      else if (g.id === 'assists') setFactors(o, 'player_assists', assistFactors(id === 'a-2plus' ? 1.5 : id === 'a-3plus' ? 2.5 : 0.5, c));
      else if (g.id === 'points')  setFactors(o, 'player_points', pointFactors(id === 'pts-2plus' ? 1.5 : id === 'pts-3plus' ? 2.5 : 0.5, c));
      else if (g.id === 'shots'  && line != null) setFactors(o, 'player_shots',  shotFactors(line, c));
      else if (g.id === 'hits'   && line != null) setFactors(o, 'player_hits',   hitFactors(line, c));
      else if (g.id === 'blocks' && line != null) setFactors(o, 'player_blocks', blockFactors(line, c));
      else if (id === 'pp-point') setFactors(o, 'player_pp', ppPointFactors(c));
      else if (id === 'pp-goal')  setFactors(o, 'player_pp', ppGoalPlayerFactors(c));
      else if (g.id === 'pim'    && line != null) setFactors(o, 'player_pim',    pimFactors(line, c));
    }
  }
}

// ── Gardien ─────────────────────────────────────────────────────────────────────

/** Contexte réel du gardien (stats saison si dispo, sinon moyennes de ligue). */
export interface GoalieFactorCtx {
  savesPg: number;  // arrêts / match
  gaPg: number;     // buts alloués / match (GAA)
  savePct: number;  // ex. 0.905 — 0 si inconnu
  winPct: number;   // % de victoires du gardien (0-1)
  shutoutRate: number; // blanchissages / départs (0-1)
}

const LEAGUE_SAVE_PCT = 0.902;

/** Save % situé autour de la moyenne de ligue (0-1) ; 0,5 si inconnu. */
function saveEfficiency(c: GoalieFactorCtx): number {
  return c.savePct > 0 ? lean(c.savePct, LEAGUE_SAVE_PCT, 0.012) : 0.5;
}

/** Arrêts O/U : charge de tirs + efficacité + tenue défensive de l'équipe. */
function savesFactors(line: number, c: GoalieFactorCtx): Factor[] {
  const shotsFaced = c.savesPg + c.gaPg; // tirs cadrés subis / match
  const eff = saveEfficiency(c);
  return [
    { id: 'workload',   label: 'Charge de tirs subie', weight: 60, value: poissonOver(shotsFaced * (c.savePct > 0 ? c.savePct : LEAGUE_SAVE_PCT), line) },
    { id: 'efficiency', label: 'Efficacité (save %)',  weight: 25, value: clamp(eff) },
    { id: 'gameScript', label: 'Style de match',       weight: 15, value: clamp(lean(shotsFaced, 30, 3.0)) },
  ];
}

/** Buts alloués O/U (côté over). */
function gaFactors(line: number, c: GoalieFactorCtx): Factor[] {
  const eff = saveEfficiency(c);
  return [
    { id: 'gaRate',     label: 'Buts alloués / match', weight: 55, value: poissonOver(c.gaPg, line) },
    { id: 'efficiency', label: 'Efficacité (save %)',  weight: 30, value: clamp(1 - eff) },
    { id: 'workload',   label: 'Charge de tirs subie', weight: 15, value: clamp(lean(c.savesPg + c.gaPg, 30, 3.0)) },
  ];
}

/** Victoire du gardien. */
function goalieWinFactors(c: GoalieFactorCtx): Factor[] {
  const eff = saveEfficiency(c);
  return [
    { id: 'teamStrength',  label: 'Force de l’équipe',   weight: 50, value: clamp(c.winPct) },
    { id: 'goalieQuality', label: 'Qualité du gardien',  weight: 30, value: clamp(eff) },
    { id: 'gaControl',     label: 'Contrôle des buts',   weight: 20, value: poissonUnderF(c.gaPg, 2.5) },
  ];
}

/** Blanchissage. */
function goalieShutoutFactors(c: GoalieFactorCtx): Factor[] {
  const eff = saveEfficiency(c);
  const history = clamp(c.shutoutRate, 0.02, 0.4);
  return [
    { id: 'model',         label: 'Buts alloués attendus', weight: 45, value: clamp(Math.exp(-c.gaPg), 0.02, 0.6) },
    { id: 'goalieQuality', label: 'Qualité du gardien',    weight: 30, value: clamp(0.04 + 0.18 * eff, 0.02, 0.5) },
    { id: 'history',       label: 'Historique (SO/départ)', weight: 25, value: history },
  ];
}

function poissonUnderF(lambda: number, line: number): number {
  return clamp(1 - poissonOver(lambda, line - 1), 0.02, 0.98);
}

export function attachGoalieFactors(groups: any[], c: GoalieFactorCtx): void {
  for (const g of groups) {
    for (const o of g.options) {
      const id: string = o.id;
      if (g.id === 'saves') {
        const line = id === 'sv-o245' ? 24.5 : id === 'sv-o275' ? 27.5 : 29.5;
        setFactors(o, 'goalie_saves', savesFactors(line, c));
      } else if (g.id === 'ga') {
        if (id === 'ga-u25') setFactors(o, 'goalie_ga', inv(gaFactors(2.5, c)));
        else setFactors(o, 'goalie_ga', gaFactors(id === 'ga-o15' ? 1.5 : 2.5, c));
      } else if (id === 'gr-win') {
        setFactors(o, 'goalie_win', goalieWinFactors(c));
      } else if (id === 'gr-shutout') {
        setFactors(o, 'goalie_shutout', goalieShutoutFactors(c));
      }
    }
  }
}
