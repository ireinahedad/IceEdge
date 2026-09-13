/**
 * nhlPredictions.ts
 * Rule-based prediction engine for all NHL bet market types.
 *
 * Game markets  → Log5 + Poisson + Skellam per-period
 * Team markets  → same, vs league-average opponent
 * Player markets → Poisson on per-game rates
 */

import {
  fetchGameById,
  fetchTeams,
  fetchTeamByAbbr,
  fetchPlayerById,
  fetchTeamSummaryStats,
  fetchTeamRestInfo,
  fetchTeamTravel,
  TeamSummaryStats,
  TeamRestInfo,
} from './nhlApiClient';
import { TravelFeatures } from './travel';
import { getArena } from '../data/arenas';
import { getGameRefFactor } from './refereeStore';
import { fetchOddsImplied } from './oddsClient';
import { getManualFactors } from './injuryStore';
import {
  blendHomeProb, formatBreakdown, homeIceFactor, fatigueFactor, ManualFactor, FactorWeights,
} from './predictionFactors';
import { attachGameFactors, attachPlayerFactors, attachGoalieFactors } from './factorModel';

// ─── Shared interfaces ────────────────────────────────────────────────────────

/**
 * Descripteur du marché ML d'une tuile, produit PAR LE SERVEUR.
 *
 * POURQUOI IL EXISTE. La page match affiche les tuiles du serveur mais y
 * rattachait les `mlProps` du client en faisant correspondre les IDENTIFIANTS
 * (`GamePrediction.tsx`). Or les deux vocabulaires n'ont jamais été les mêmes :
 * le client dit `ou-over`, le serveur `o55` ; `wm-h1` contre `wm-1` ;
 * `p1-over` contre `p1-o05`. 17 identifiants côté client ne correspondaient à
 * rien, donc Total Goals, Winning Margin, Goal Scorer et 1er Période Buts
 * n'avaient AUCUNE prédiction du modèle — le sélecteur ML ne faisait rien sur
 * ces tuiles, sans le moindre message.
 *
 * Le serveur sait déjà exactement quel marché il calcule pour chaque tuile :
 * il l'annonce ici, et la correspondance par identifiant disparaît. Une tuile
 * ajoutée côté serveur arrive avec son ML sans rien toucher au client.
 */
export interface BetMlProps {
  type:             'game' | 'player' | 'team';
  subjectId:        string;
  opponentId?:      string;
  propType?:        string;
  line?:            number;
  isHome?:          boolean;
  selection?:       string;
  settleMarket?:    string;
  settleSelection?: string;
}

export interface BetOption {
  id:        string;
  label:     string;
  rulePct:   number;
  ruleNote:  string;
  /** Marché ML de cette tuile. Absent = ce marché n'a pas d'équivalent modèle. */
  ml?:       BetMlProps;
  /** Décomposition des facteurs — sert au pie chart & à l'éditeur de pondération. */
  factors?:  Array<{ id: string; label: string; weight: number; value: number }>;
  /** Famille de facteurs (match | totals | period | margin | ot | player_off | player_phys | goalie). */
  factorGroup?: string;
}

export interface MarketGroup {
  id:    string;
  title: string;
  cols:  2 | 3;
  options: BetOption[];
}

/**
 * Contexte enrichi d'une équipe pour un match donné.
 * Tous les champs sont optionnels : en leur absence on retombe sur des valeurs
 * neutres, ce qui laisse buildTeamMarkets (vs adversaire moyen) fonctionner.
 */
export interface TeamCtx {
  homeWinPct?:     number; // 0–1, record à domicile
  roadWinPct?:     number; // 0–1, record à l'extérieur
  last10?:         number; // 0–1, forme des 10 derniers
  streak?:         number; // série signée (+3 = 3 V, -2 = 2 D)
  ppPct?:          number; // 0–100
  pkPct?:          number; // 0–100
  shotsForPg?:     number;
  shotsAgainstPg?: number;
  restDays?:       number; // 0–7
  b2b?:            0 | 1;   // back-to-back
  travel?:         TravelFeatures | null; // voyage / fuseaux / altitude / road-trip
}

// ─── Math primitives ──────────────────────────────────────────────────────────

/** Bill James Log5: P(A beats B) given their independent win rates */
function log5(wA: number, wB: number): number {
  const d = wA + wB - 2 * wA * wB;
  if (d === 0) return 0.5;
  return Math.max(0.03, Math.min(0.97, (wA - wA * wB) / d));
}

/** Poisson P(X = k) */
function poissonPmf(lambda: number, k: number): number {
  let p = Math.exp(-lambda);
  for (let i = 0; i < k; i++) p *= lambda / (i + 1);
  return p;
}

/** Poisson P(X > line) — supports half-integer lines */
function poissonOver(lambda: number, line: number): number {
  const k = Math.floor(line);
  let cdf = 0, term = Math.exp(-lambda);
  for (let i = 0; i <= k; i++) { cdf += term; term = (term * lambda) / (i + 1); }
  return Math.max(0.02, Math.min(0.98, 1 - cdf));
}

/** Poisson P(X < line) — equivalent to 1 - P(X >= ceil(line)) */
function poissonUnder(lambda: number, line: number): number {
  return Math.max(0.02, Math.min(0.98, 1 - poissonOver(lambda, line - 1)));
}

/**
 * Skellam-based 3-way period result.
 * Returns { home, draw, away } as fractions summing to ~1.
 */
function skellamPeriod(lambdaH: number, lambdaA: number): { home: number; draw: number; away: number } {
  const MAX_K = 12;
  let home = 0, draw = 0, away = 0;
  for (let h = 0; h <= MAX_K; h++) {
    const ph = poissonPmf(lambdaH, h);
    if (ph < 1e-9) continue;
    for (let a = 0; a <= MAX_K; a++) {
      const pa = poissonPmf(lambdaA, a);
      if (pa < 1e-9) continue;
      const joint = ph * pa;
      if      (h > a) home += joint;
      else if (h < a) away += joint;
      else            draw += joint;
    }
  }
  const total = home + draw + away || 1;
  return { home: home / total, draw: draw / total, away: away / total };
}

/**
 * Distribution des marges sur un match complet à partir des λ Poisson.
 * Retourne les probabilités dérivées directement du modèle plutôt que de
 * constantes forfaitaires (utilisé pour la puck line et la marge de victoire).
 */
function marginDistribution(lambdaH: number, lambdaA: number): {
  homeBy1: number; homeBy2plus: number;      // maison gagne de 1 / de 2+
  awayBy1: number; awayBy2plus: number;      // visiteur gagne de 1 / de 2+
  winBy1: number;  winBy2: number; winBy3plus: number; // marge, tout vainqueur
} {
  const MAX_K = 15;
  const ph: number[] = [], pa: number[] = [];
  for (let k = 0; k <= MAX_K; k++) { ph[k] = poissonPmf(lambdaH, k); pa[k] = poissonPmf(lambdaA, k); }

  let homeBy1 = 0, homeBy2plus = 0, awayBy1 = 0, awayBy2plus = 0;
  let winBy1 = 0, winBy2 = 0, winBy3plus = 0;
  for (let h = 0; h <= MAX_K; h++) {
    for (let a = 0; a <= MAX_K; a++) {
      const joint = ph[h] * pa[a];
      if (joint < 1e-12) continue;
      const diff = h - a;
      if (diff === 0) continue;                 // égalité → réglée en prolongation
      const m = Math.abs(diff);
      if (diff > 0) { if (m === 1) homeBy1 += joint; else homeBy2plus += joint; }
      else          { if (m === 1) awayBy1 += joint; else awayBy2plus += joint; }
      if      (m === 1) winBy1 += joint;
      else if (m === 2) winBy2 += joint;
      else              winBy3plus += joint;
    }
  }
  return { homeBy1, homeBy2plus, awayBy1, awayBy2plus, winBy1, winBy2, winBy3plus };
}

/** Clamp and round to integer percentage */
function pct(p: number): number {
  return Math.round(Math.max(3, Math.min(97, p * 100)));
}

/** Format a goals-per-game rate for display */
function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

// ─── League constants ─────────────────────────────────────────────────────────

const HOME_ICE_ADJ   = 0.02;   // résidu d'avantage local (splits domicile/route captent le reste)
const LEAGUE_AVG_GPG = 3.05;   // buts/match moyens par équipe (ligue)
const LEAGUE_AVG_SOG = 30;     // tirs/match moyens (ligue)
const OT_BASE        = 0.225;  // ~22.5% des matchs NHL vont en prolongation
const B2B_WIN_PEN    = 0.05;   // pénalité de force pour un back-to-back
const B2B_GOAL_PEN   = 0.04;   // baisse de λ pour un back-to-back
const REST_EDGE      = 0.010;  // avantage par jour de repos supplémentaire (cap)

/** Per-period goal fractions (empirical NHL averages) */
const PERIOD_DIST = [0.305, 0.365, 0.330] as const;

/**
 * Dispersion (paramètre `k` d'une binomiale négative) des buts d'UNE équipe sur
 * UN match. Sert uniquement à estimer P(l'équipe est blanchie).
 *
 * POURQUOI PAS POISSON — les buts par équipe-match sont nettement plus dispersés
 * qu'une Poisson : à λ = 3.0, Poisson prédit e⁻³ = 5.0 % de blanchissages, la
 * NHL en observe ~8.5 %. Un blanchissage sur trois manquait donc à l'appel, et
 * comme « les deux marquent » multiplie les deux compléments, le marché BTTS
 * sortait à ~90 % POUR TOUS LES MATCHS.
 *
 * k = 6.5 est la valeur qui recolle P(0) au taux observé :
 *     (6.5 / (6.5 + 3.0))^6.5 = 8.5 %   →   BTTS ≈ (1 − 0.085)² ≈ 84 %
 * ce qui est le taux réel (~83 %). k → ∞ redonnerait Poisson.
 */
const GOALS_DISPERSION_K = 6.5;

/** P(une équipe de cadence λ marque au moins un but), binomiale négative. */
function pScoresAtLeastOnce(lambda: number): number {
  const lam = Math.max(0.05, lambda);
  const k   = GOALS_DISPERSION_K;
  return 1 - Math.pow(k / (k + lam), k);
}

/** Estimate OT probability based on how evenly matched the teams are */
function otProb(homeWin: number): number {
  const balance = 1 - 2 * Math.abs(homeWin - 0.5); // 0=mismatch, 1=even
  return OT_BASE + 0.06 * balance; // range ~18%–28%
}

/** Borne une valeur dans [lo, hi] */
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Calibration Platt de la probabilité de victoire.
 * Le Log5 brut est sur-confiant : ces coefficients (a<1 = rétrécissement vers
 * le centre) ont été ajustés sur ml/data/nhl_games.csv (6099 matchs, split
 * temporel 70/30) et réduisent le log-loss hors-échantillon de ~0.703 à ~0.683,
 * au niveau du plafond d'une régression logistique sur les mêmes features.
 */
const WIN_CAL_A = 0.45;
const WIN_CAL_B = 0.06;
function calibrateWin(p: number): number {
  const q = clamp(p, 1e-6, 1 - 1e-6);
  const z = Math.log(q / (1 - q));
  return clamp(1 / (1 + Math.exp(-(WIN_CAL_A * z + WIN_CAL_B))), 0.03, 0.97);
}

/**
 * Force d'équipe combinée : mélange win% saison + split (domicile/route) + forme L10,
 * puis pénalité back-to-back. Retourne une valeur 0–1.
 */
function teamStrength(seasonWin: number, splitWin: number, last10: number, b2b: 0 | 1): number {
  const blended = 0.55 * seasonWin + 0.25 * splitWin + 0.20 * last10;
  return clamp(blended * (1 - B2B_WIN_PEN * b2b), 0.05, 0.95);
}

// ─── Game markets ─────────────────────────────────────────────────────────────

function computeGameMarkets(
  home: any,
  away: any,
  homeName: string,
  awayName: string,
  homeCtx: TeamCtx = {},
  awayCtx: TeamCtx = {},
  oddsImplied: number | null = null,       // prob implicite marché (dé-viggée)
  injuries: ManualFactor | null = null,    // facteur blessures manuel
  lineup: ManualFactor | null = null,      // facteur alignement manuel
  weights?: FactorWeights,                 // poids personnalisés (paramètres user)
  teamExtras = false,                      // marchés propres à la vue équipe
  refPenaltyMult = 1,                      // volume de PP selon l'arbitrage (totaux)
): MarketGroup[] {
  // Abréviations : ce que le service ML attend comme sujet.
  const hAb: string = home.abbreviation ?? homeName;
  const aAb: string = away.abbreviation ?? awayName;
  /** Tuile vue du DOMICILE. */
  const gm = (propType: string, line?: number, selection?: string): BetMlProps =>
    ({ type: 'game', subjectId: hAb, opponentId: aAb, propType, line, isHome: true, selection });
  /** Tuile vue de l'EXTÉRIEUR — `isHome: false`, sinon le service applique
   *  l'avantage de la glace au visiteur (les deux tuiles totalisaient 110 %). */
  const gma = (propType: string, line?: number, selection?: string): BetMlProps =>
    ({ type: 'game', subjectId: aAb, opponentId: hAb, propType, line, isHome: false, selection });

  const wH  = (home.winPct ?? 50) / 100;
  const wA  = (away.winPct ?? 50) / 100;
  const gfH = home.goalsForPerGame     ?? LEAGUE_AVG_GPG;
  const gaH = home.goalsAgainstPerGame ?? LEAGUE_AVG_GPG;
  const gfA = away.goalsForPerGame     ?? LEAGUE_AVG_GPG;
  const gaA = away.goalsAgainstPerGame ?? LEAGUE_AVG_GPG;

  // ── Contexte (repos, forme, splits, unités spéciales, tirs) ────────────────
  const hB2b = homeCtx.b2b ?? 0;
  const aB2b = awayCtx.b2b ?? 0;
  const hRest = homeCtx.restDays ?? 2;
  const aRest = awayCtx.restDays ?? 2;
  const hL10 = homeCtx.last10 ?? wH;
  const aL10 = awayCtx.last10 ?? wA;
  const hSplit = homeCtx.homeWinPct ?? wH;   // record à domicile
  const aSplit = awayCtx.roadWinPct ?? wA;   // record à l'extérieur
  const hPP = homeCtx.ppPct ?? 20, hPK = homeCtx.pkPct ?? 80;
  const aPP = awayCtx.ppPct ?? 20, aPK = awayCtx.pkPct ?? 80;
  const hSF = homeCtx.shotsForPg ?? LEAGUE_AVG_SOG;
  const aSF = awayCtx.shotsForPg ?? LEAGUE_AVG_SOG;

  // ── Facteurs transparents (chacun estime P(victoire domicile), 0–1) ─────────
  // Qualité d'équipe : win% saison + forme L10, neutre côté glace & fatigue
  // (traités comme des facteurs séparés), Log5 puis calibration Platt.
  const sH = clamp(0.70 * wH + 0.30 * hL10, 0.05, 0.95);
  const sA = clamp(0.70 * wA + 0.30 * aL10, 0.05, 0.95);
  const fQuality = calibrateWin(log5(sH, sA));
  const fHomeIce = homeIceFactor(wH, hSplit, wA, aSplit);
  // Voyage / fuseaux / altitude : nourrit le facteur "Épuisement" (borné).
  const hTravel = homeCtx.travel ?? null;
  const aTravel = awayCtx.travel ?? null;
  const venueAlt = getArena((home.abbreviation ?? '').toUpperCase())?.alt;
  const fFatigue = fatigueFactor(hRest, aRest, hB2b, aB2b, {
    awayDistanceKm: aTravel?.distance_km,
    awayTzShift:    aTravel?.tz_shift,
    awayAltGain:    aTravel?.alt_gain,
    awayGetaway:    aTravel?.getaway,
    awayDaysAway:   aTravel?.days_away,
    homeDistanceKm: hTravel?.distance_km,
    homeAltGain:    hTravel?.alt_gain,
  });
  // Moyenne pondérée des facteurs actifs (règles = boîte de verre transparente).
  const blend = blendHomeProb({
    quality: fQuality, homeIce: fHomeIce, fatigue: fFatigue,
    odds: oddsImplied, injuries, lineup,
  }, weights);
  const mlHome = blend.homeProb;
  const mlAway = 1 - mlHome;
  const mlBreakdown = formatBreakdown(blend);
  const ot     = otProb(mlHome);
  const regAdj = 1 - ot;

  // ── Buts attendus (λ) — ratio attaque × défense relatif à la ligue ─────────
  // λH = force offensive maison × faiblesse défensive visiteur, échelle ligue.
  let lambdaH = (gfH / LEAGUE_AVG_GPG) * (gaA / LEAGUE_AVG_GPG) * LEAGUE_AVG_GPG;
  let lambdaA = (gfA / LEAGUE_AVG_GPG) * (gaH / LEAGUE_AVG_GPG) * LEAGUE_AVG_GPG;

  // Volume de tirs : signal secondaire (poids 12%).
  lambdaH *= clamp(1 + 0.12 * (hSF / LEAGUE_AVG_SOG - 1), 0.9, 1.1);
  lambdaA *= clamp(1 + 0.12 * (aSF / LEAGUE_AVG_SOG - 1), 0.9, 1.1);

  // Unités spéciales : PP maison vs PK adverse (et inversement), borné ±8%.
  lambdaH *= clamp(1 + 0.06 * ((hPP - 20) / 20 - (aPK - 80) / 20) / 2, 0.92, 1.08);
  lambdaA *= clamp(1 + 0.06 * ((aPP - 20) / 20 - (hPK - 80) / 20) / 2, 0.92, 1.08);

  // Back-to-back : moins de buts. Glace locale : léger bonus offensif maison.
  lambdaH *= (1 - B2B_GOAL_PEN * hB2b) * 1.02;
  lambdaA *= (1 - B2B_GOAL_PEN * aB2b) * 0.99;

  lambdaH = clamp(lambdaH, 1.5, 5.0);
  lambdaA = clamp(lambdaA, 1.5, 5.0);
  const lambdaT = lambdaH + lambdaA;  // total expected goals

  // Distribution des marges (match complet) — sert puck line & marge de victoire.
  const md = marginDistribution(lambdaH, lambdaA);

  // ── 1. Match Betting ──────────────────────────────────────────────────────
  const matchBetting: MarketGroup = {
    id: 'match', title: 'Match Betting', cols: 3,
    options: [
      {
        id: 'ml-home',
        ml: gm('moneyline'),
        label: `${homeName} to Win`,
        rulePct: pct(mlHome),
        ruleNote: [
          mlBreakdown,
          injuries?.active ? `blessures : ${injuries.note}` : '',
          lineup?.active   ? `alignement : ${lineup.note}` : '',
        ].filter(Boolean).join('  ·  '),
        // Poids sur 100, comme partout ailleurs (`blend.lines` les porte en
        // fractions de 1). attachGameFactors réécrit ces deux options juste
        // après, mais une échelle erronée ici finirait tôt ou tard à l'écran.
        factors: blend.lines.map(l => ({ id: l.id, label: l.label, weight: Math.round(l.weight * 100), value: l.value })),
      },
      {
        id: 'ml-ot',
        ml: gm('game_to_ot', undefined, 'yes'),
        label: 'OT / Shootout',
        rulePct: pct(ot),
        ruleNote: `NHL avg ~22.5% OT rate; closer matchup (+${fmt((ot-OT_BASE)*100,0)}%) based on win% spread`,
      },
      {
        id: 'ml-away',
        ml: gma('moneyline'),
        label: `${awayName} to Win`,
        rulePct: pct(mlAway),
        ruleNote: `Away win probability = 1 − home win = ${fmt(mlAway*100,0)}%`,
        factors: blend.lines.map(l => ({ id: l.id, label: l.label, weight: Math.round(l.weight * 100), value: 1 - l.value })),
      },
    ],
  };

  // ── 2. Puck Line ──────────────────────────────────────────────────────────
  // Home −1.5 : la maison gagne de 2+ (en réglementaire), dérivé du modèle Skellam.
  // Away +1.5 : couvre si la maison ne gagne PAS de 2+ (donc le complément).
  const plHome = md.homeBy2plus * regAdj;
  const plAway = 1 - plHome;
  const puckLine: MarketGroup = {
    id: 'puckline', title: 'Puck Line', cols: 2,
    options: [
      {
        id: 'pl-home',
        ml: gm('puck_line'),
        label: `${homeName} −1.5`,
        rulePct: pct(plHome),
        ruleNote: `Skellam P(maison gagne de 2+) ${fmt(md.homeBy2plus*100,0)}% × régl. ${fmt(regAdj*100,0)}% = ${fmt(plHome*100,0)}%`,
      },
      {
        id: 'pl-away',
        ml: gm('puck_line', undefined, 'no'),
        label: `${awayName} +1.5`,
        rulePct: pct(plAway),
        ruleNote: `Couvre sauf défaite visiteur de 2+ = ${fmt(plAway*100,0)}%`,
      },
    ],
  };

  // ── 3. Totals ─────────────────────────────────────────────────────────────
  const over55  = poissonOver(lambdaT, 5.5);
  const over65  = poissonOver(lambdaT, 6.5);
  const totals: MarketGroup = {
    id: 'totals', title: 'Total Goals', cols: 2,
    options: [
      {
        id: 'o55',
        ml: gm('total_goals_over', 5.5),
        label: 'Over 5.5',
        rulePct: pct(over55),
        ruleNote: `Expected goals λ=${fmt(lambdaT)} (${fmt(lambdaH)}+${fmt(lambdaA)}) → Poisson P(>5.5)=${fmt(over55*100,0)}%`,
      },
      {
        id: 'u55',
        ml: gm('total_goals_under', 5.5),
        label: 'Under 5.5',
        rulePct: pct(1 - over55),
        ruleNote: `P(<5.5) = ${fmt((1-over55)*100,0)}%`,
      },
      {
        id: 'o65',
        ml: gm('total_goals_over', 6.5),
        label: 'Over 6.5',
        rulePct: pct(over65),
        ruleNote: `Poisson P(>6.5) = ${fmt(over65*100,0)}%`,
      },
      {
        id: 'u65',
        ml: gm('total_goals_under', 6.5),
        label: 'Under 6.5',
        rulePct: pct(1 - over65),
        ruleNote: `P(<6.5) = ${fmt((1-over65)*100,0)}%`,
      },
    ],
  };

  // ── 4. Both Teams to Score ────────────────────────────────────────────────
  // Binomiale négative, pas Poisson : cf. GOALS_DISPERSION_K. Avec exp(−λ) les
  // deux tuiles sortaient ~90 % / ~10 % quel que soit le match.
  const bttsH   = pScoresAtLeastOnce(lambdaH);  // P(home scores ≥1)
  const bttsA   = pScoresAtLeastOnce(lambdaA);  // P(away scores ≥1)
  const bttsYes = bttsH * bttsA;
  const btts: MarketGroup = {
    id: 'btts', title: 'Both Teams to Score', cols: 2,
    options: [
      {
        id: 'btts-yes',
        ml: gm('both_teams_score', undefined, 'yes'),
        label: 'Yes',
        rulePct: pct(bttsYes),
        ruleNote: `P(home≥1)=${fmt(bttsH*100,0)}% × P(away≥1)=${fmt(bttsA*100,0)}% = ${fmt(bttsYes*100,0)}% (buts par match : binomiale négative, k=${GOALS_DISPERSION_K})`,
      },
      {
        id: 'btts-no',
        ml: gm('both_teams_score', undefined, 'no'),
        label: 'No',
        rulePct: pct(1 - bttsYes),
        ruleNote: `At least one team is shut out = ${fmt((1-bttsYes)*100,0)}%`,
      },
    ],
  };

  // ── 6–8. Period Results (Skellam) ─────────────────────────────────────────
  const periodGroups: MarketGroup[] = ['1st', '2nd', '3rd'].map((name, i) => {
    const f  = PERIOD_DIST[i];
    const lH = lambdaH * f;
    const lA = lambdaA * f;
    const r  = skellamPeriod(lH, lA);
    return {
      id:    `p${i+1}`,
      title: `${name} Period Result`,
      cols:  3,
      options: [
        {
          id:       `p${i+1}-home`,
          ml:       gm(`period${i+1}_winner`),
          label:    `${homeName}`,
          rulePct:  pct(r.home),
          ruleNote: `λH=${fmt(lH)} vs λA=${fmt(lA)} → Skellam P(home>away)=${fmt(r.home*100,0)}%`,
        },
        {
          id:       `p${i+1}-draw`,
          // Égalité après la 3e période = le match va en prolongation, un marché
          // réel. Après la 1re ou la 2e, il n'y a pas de marché correspondant :
          // pas de `ml`, et la tuile le dira plutôt que d'afficher autre chose.
          ml:       i === 2 ? gm('game_to_ot', undefined, 'yes') : undefined,
          label:    'Draw',
          rulePct:  pct(r.draw),
          ruleNote: `P(equal goals in period) = ${fmt(r.draw*100,0)}%`,
        },
        {
          id:       `p${i+1}-away`,
          ml:       gma(`period${i+1}_winner`),
          label:    `${awayName}`,
          rulePct:  pct(r.away),
          ruleNote: `P(away>home) = ${fmt(r.away*100,0)}%`,
        },
      ],
    };
  });

  // ── 9. 1st Period Goals O/U ───────────────────────────────────────────────
  const lP1 = lambdaT * PERIOD_DIST[0];
  const p1Goals: MarketGroup = {
    id: 'p1goals', title: '1st Period Goals', cols: 3,
    options: [
      {
        id: 'p1-o05',
        ml: gm('period1_total_goals', 0.5),
        label: 'Over 0.5',
        rulePct: pct(poissonOver(lP1, 0.5)),
        ruleNote: `P1 λ=${fmt(lP1)} → P(≥1 goal)=${fmt(poissonOver(lP1,0.5)*100,0)}%`,
      },
      {
        id: 'p1-o15',
        ml: gm('period1_total_goals', 1.5),
        label: 'Over 1.5',
        rulePct: pct(poissonOver(lP1, 1.5)),
        ruleNote: `P(≥2 goals in P1)=${fmt(poissonOver(lP1,1.5)*100,0)}%`,
      },
      {
        id: 'p1-o25',
        ml: gm('period1_total_goals', 2.5),
        label: 'Over 2.5',
        rulePct: pct(poissonOver(lP1, 2.5)),
        ruleNote: `P(≥3 goals in P1)=${fmt(poissonOver(lP1,2.5)*100,0)}%`,
      },
    ],
  };

  // ── 10. Overtime ──────────────────────────────────────────────────────────
  const overtime: MarketGroup = {
    id: 'ot', title: 'Extra Time', cols: 2,
    options: [
      {
        id: 'ot-yes',
        ml: gm('game_to_ot', undefined, 'yes'),
        label: 'Goes to OT',
        rulePct: pct(ot),
        ruleNote: `Balance factor from win% spread → ${fmt(ot*100,0)}% OT probability`,
      },
      {
        id: 'ot-no',
        ml: gm('game_to_ot', undefined, 'no'),
        label: 'Decided in Regulation',
        rulePct: pct(1 - ot),
        ruleNote: `P(regulation finish) = ${fmt((1-ot)*100,0)}%`,
      },
    ],
  };

  // ── 11. Winning Margin ────────────────────────────────────────────────────
  // Marges dérivées de la distribution Skellam complète, renormalisées sur les
  // matchs réglés en réglementaire (une victoire par 1/2/3+ exclut la prolongation).
  const decisive = md.winBy1 + md.winBy2 + md.winBy3plus || 1;
  const wm1  = (md.winBy1     / decisive) * regAdj;
  const wm2  = (md.winBy2     / decisive) * regAdj;
  const wm3p = (md.winBy3plus / decisive) * regAdj;
  const margin: MarketGroup = {
    id: 'margin', title: 'Winning Margin', cols: 3,
    options: [
      {
        id: 'wm-1',
        ml: gm('winning_margin', undefined, '1'),
        label: 'Win by 1',
        rulePct: pct(wm1),
        ruleNote: `Skellam marge 1 but ${fmt(md.winBy1/decisive*100,0)}% × régl. = ${fmt(wm1*100,0)}%`,
      },
      {
        id: 'wm-2',
        ml: gm('winning_margin', undefined, '2'),
        label: 'Win by 2',
        rulePct: pct(wm2),
        ruleNote: `Skellam marge 2 buts ${fmt(md.winBy2/decisive*100,0)}% × régl. = ${fmt(wm2*100,0)}%`,
      },
      {
        id: 'wm-3p',
        ml: gm('winning_margin', undefined, '3+'),
        label: 'Win by 3+',
        rulePct: pct(wm3p),
        ruleNote: `Skellam marge 3+ ${fmt(md.winBy3plus/decisive*100,0)}% × régl., λ=${fmt(lambdaT)}`,
      },
    ],
  };

  const groups = [
    matchBetting,
    puckLine,
    totals,
    btts,
    ...periodGroups,
    p1Goals,
    overtime,
    margin,
  ];

  // ── 12. Extras équipe (vue équipe uniquement) ─────────────────────────────
  // Buts de l'équipe O/U 2.5, blanchissage, but en PP, PK parfait — les valeurs
  // sont recalculées par attachGameFactors (facteurs dédiés).
  if (teamExtras) {
    const PP_OPPS = 3.1;
    const tOver   = poissonOver(lambdaH, 2.5);
    const csFor   = Math.exp(-lambdaA);
    const ppG     = 1 - Math.exp(-PP_OPPS * (hPP / 100));
    const pkAll   = Math.pow(hPK / 100, PP_OPPS);
    groups.push({
      id: 'teamx', title: 'Team Specials', cols: 2,
      options: [
        { id: 'tg-o25', label: `${homeName} Over 2.5`, rulePct: pct(tOver),
          ml: gm('team_total_goals', 2.5, 'over'),
          ruleNote: `λ équipe=${fmt(lambdaH)} → Poisson P(>2.5)=${fmt(tOver*100,0)}%` },
        { id: 'tg-u25', label: `${homeName} Under 2.5`, rulePct: pct(1 - tOver),
          ml: gm('team_total_goals', 2.5, 'under'),
          ruleNote: `P(<2.5) = ${fmt((1-tOver)*100,0)}%` },
        { id: 'cs-for', label: 'Clean Sheet (Shutout)', rulePct: pct(csFor),
          ml: gm('clean_sheet', undefined, 'yes'),
          ruleNote: `P(0 but adverse) = e^(−${fmt(lambdaA)}) = ${fmt(csFor*100,0)}%` },
        { id: 'ppgoal', label: 'Scores a PP Goal', rulePct: pct(ppG),
          ml: gm('team_pp_goals', undefined, 'yes'),
          ruleNote: `PP ${fmt(hPP,1)}% × ~${PP_OPPS} occasions → ${fmt(ppG*100,0)}%` },
        { id: 'pk-perfect', label: 'Kills All Penalties', rulePct: pct(pkAll),
          ml: gm('team_penalty_kill', undefined, 'yes'),
          ruleNote: `PK ${fmt(hPK,1)}% ^ ${PP_OPPS} occasions = ${fmt(pkAll*100,0)}%` },
      ],
    });
  }

  // Décompose chaque marché en facteurs ajustables (met à jour rulePct + factors).
  attachGameFactors(groups, {
    wH, wA, gfH, gaH, gfA, gaA,
    lambdaH, lambdaA, lambdaT,
    hSF, aSF, hPP, aPP, hPK, aPK, hB2b, aB2b,
    venueAlt, hAltGain: hTravel?.alt_gain, aAltGain: aTravel?.alt_gain,
    refPenaltyMult,
    homeIce: fHomeIce, fatigue: fFatigue,
    mlHome, ot,
    matchFactors: blend.lines.map(l => ({ id: l.id, label: l.label, weight: Math.round(l.weight * 100), value: l.value })),
  });

  return groups;
}

// ─── Public: game predictions ─────────────────────────────────────────────────

/** Parse une chaîne L10 ("7-2-1") en win% 0–1. */
function parseLastTen(last10: string | null | undefined, fallback: number): number {
  if (!last10) return fallback;
  const [w] = last10.split('-').map(Number);
  return isNaN(w) ? fallback : Math.min(1, w / 10);
}

/** Construit le contexte enrichi d'une équipe (splits, forme, PP/PK, tirs, repos). */
function makeCtx(
  team: any,
  summary: Record<string, TeamSummaryStats>,
  rest: TeamRestInfo,
  travel: TravelFeatures | null = null,
): TeamCtx {
  const abbr = (team.abbreviation ?? '').toUpperCase();
  const s = summary[abbr];
  const seasonWin = (team.winPct ?? 50) / 100;
  return {
    homeWinPct:     team.homeWinPct ?? seasonWin,
    roadWinPct:     team.roadWinPct ?? seasonWin,
    last10:         parseLastTen(team.last10, seasonWin),
    streak:         team.streakSigned ?? 0,
    ppPct:          s?.ppPct ?? team.ppPct ?? 20,
    pkPct:          s?.pkPct ?? team.pkPct ?? 80,
    shotsForPg:     s?.shotsForPg     ?? LEAGUE_AVG_SOG,
    shotsAgainstPg: s?.shotsAgainstPg ?? LEAGUE_AVG_SOG,
    restDays:       rest.restDays,
    b2b:            rest.b2b,
    travel,
  };
}

export async function buildGameMarkets(gameId: string, weights?: FactorWeights): Promise<MarketGroup[]> {
  const game = await fetchGameById(gameId);
  const homeAbbr = game.homeTeam?.abbreviation ?? game.homeTeam?.abbrev ?? '';
  const awayAbbr = game.awayTeam?.abbreviation ?? game.awayTeam?.abbrev ?? '';

  const [homeTeam, awayTeam] = await Promise.all([
    fetchTeamByAbbr(homeAbbr),
    fetchTeamByAbbr(awayAbbr),
  ]);

  const homeName = game.homeTeam?.name ?? homeAbbr;
  const awayName = game.awayTeam?.name ?? awayAbbr;

  // Sources enrichies, tolérantes aux pannes (fallback neutre par source).
  const [summaryRes, homeRestRes, awayRestRes, oddsRes,
         homeTravelRes, awayTravelRes, refFactorRes, manualRes] = await Promise.allSettled([
    fetchTeamSummaryStats(),
    fetchTeamRestInfo(homeAbbr),
    fetchTeamRestInfo(awayAbbr),
    fetchOddsImplied(homeName, awayName),
    fetchTeamTravel(homeAbbr, homeAbbr),   // les deux jouent dans l'aréna maison
    fetchTeamTravel(awayAbbr, homeAbbr),
    getGameRefFactor(homeAbbr, awayAbbr),  // arbitrage → volume de PP (totaux)
    // Blessures / alignement : lecture en base depuis la migration 034 (le
    // fichier n'existait pas dans le conteneur). Placée ICI et non plus après le
    // bloc : elle est asynchrone maintenant, et l'attendre en série aurait
    // ajouté un aller-retour à chaque prédiction pour rien.
    getManualFactors(homeAbbr, awayAbbr),
  ]);
  const summary  = summaryRes.status  === 'fulfilled' ? summaryRes.value  : {};
  const homeRest = homeRestRes.status === 'fulfilled' ? homeRestRes.value : { restDays: 2, b2b: 0 as 0 | 1, dense3in4: 0 };
  const awayRest = awayRestRes.status === 'fulfilled' ? awayRestRes.value : { restDays: 2, b2b: 0 as 0 | 1, dense3in4: 0 };
  const odds     = oddsRes.status     === 'fulfilled' ? oddsRes.value     : null;
  const homeTravel = homeTravelRes.status === 'fulfilled' ? homeTravelRes.value : null;
  const awayTravel = awayTravelRes.status === 'fulfilled' ? awayTravelRes.value : null;
  const refFactor  = refFactorRes.status  === 'fulfilled' ? refFactorRes.value  : null;

  // Facteurs manuels (blessures + alignement). `getManualFactors` ne lève pas,
  // mais `allSettled` garde le repli neutre explicite si cela changeait un jour.
  const manual = manualRes.status === 'fulfilled'
    ? manualRes.value
    : { injuries: { active: false, homeProb: 0.5, note: 'non renseigné' },
        lineup:   { active: false, homeProb: 0.5, note: 'non renseigné' } };

  return computeGameMarkets(
    homeTeam, awayTeam,
    homeName, awayName,
    makeCtx(homeTeam, summary, homeRest, homeTravel),
    makeCtx(awayTeam, summary, awayRest, awayTravel),
    odds?.homeProb ?? null,
    manual.injuries,
    manual.lineup,
    weights,
    false,
    refFactor?.multiplier ?? 1,
  );
}

// ─── Public: team predictions (vs league-average opponent) ────────────────────

export async function buildTeamMarkets(teamAbbr: string): Promise<MarketGroup[]> {
  const [team, all] = await Promise.all([fetchTeamByAbbr(teamAbbr), fetchTeams()]);

  // Build league-average pseudo-team
  const n   = all.length || 1;
  const avg = {
    winPct:             all.reduce((s: number, t: any) => s + (t.winPct ?? 50), 0) / n,
    goalsForPerGame:    all.reduce((s: number, t: any) => s + (t.goalsForPerGame ?? 3.0), 0) / n,
    goalsAgainstPerGame:all.reduce((s: number, t: any) => s + (t.goalsAgainstPerGame ?? 3.0), 0) / n,
  };

  // Contexte réel pour l'équipe ; adversaire moyen = contexte neutre.
  const [summaryRes, restRes, travelRes] = await Promise.allSettled([
    fetchTeamSummaryStats(),
    fetchTeamRestInfo(teamAbbr),
    fetchTeamTravel(teamAbbr, teamAbbr),   // match à domicile (aréna de l'équipe)
  ]);
  const summary = summaryRes.status === 'fulfilled' ? summaryRes.value : {};
  const rest    = restRes.status    === 'fulfilled' ? restRes.value    : { restDays: 2, b2b: 0 as 0 | 1, dense3in4: 0 };
  const travel  = travelRes.status  === 'fulfilled' ? travelRes.value  : null;

  return computeGameMarkets(
    team, avg, team.name, 'Avg Opponent',
    makeCtx(team, summary, rest, travel),
    {},                      // adversaire moyen : neutre
    null, null, null,
    undefined,
    true,                    // extras équipe (buts 2.5, blanchissage, PP, PK)
  );
}

// ─── Player markets ───────────────────────────────────────────────────────────

/** Position-based per-game defaults for stats not in the landing endpoint */
const POSITION_DEFAULTS: Record<string, Record<string, number>> = {
  F: { hits: 2.1, blocks: 0.4, pim: 0.50, faceoffWins: 6  },
  D: { hits: 2.2, blocks: 1.6, pim: 0.45, faceoffWins: 1  },
  C: { hits: 2.0, blocks: 0.5, pim: 0.50, faceoffWins: 11 },
  G: { saves: 27, goalsAllowed: 3.0 },
};

function posDefaults(pos: string): Record<string, number> {
  if (pos === 'G') return POSITION_DEFAULTS.G;
  if (pos === 'D') return POSITION_DEFAULTS.D;
  if (pos === 'C') return POSITION_DEFAULTS.C;
  return POSITION_DEFAULTS.F;
}

export async function buildPlayerMarkets(playerId: string): Promise<MarketGroup[]> {
  const p  = await fetchPlayerById(playerId);
  const gp = Math.max(p.gamesPlayed ?? 1, 1);
  const pos = (p.position ?? 'F').toUpperCase();
  const def = posDefaults(pos);
  const isGoalie = pos === 'G';

  if (isGoalie) return buildGoalieMarkets(p, gp, def);
  return buildSkaterMarkets(p, gp, pos, def);
}

function buildSkaterMarkets(p: any, gp: number, pos: string, def: Record<string, number>): MarketGroup[] {
  const gpg  = p.goals   / gp;
  const apg  = p.assists / gp;
  const ppg  = p.points  / gp;
  const spg  = p.shots   / gp;
  const pppg = (p.ppPoints ?? 0) / gp;
  const hits = def.hits;
  const blks = def.blocks;
  const pim  = def.pim;

  // ── Goal Scoring ──────────────────────────────────────────────────────────
  const goals: MarketGroup = {
    id: 'goals', title: 'Goal Scoring', cols: 3,
    options: [
      {
        id: 'g-anytime',
        label: 'Anytime Goal',
        rulePct: pct(1 - Math.exp(-gpg)),
        ruleNote: `${p.goals}G in ${gp} GP = ${fmt(gpg)} G/game → P(≥1)=${fmt((1-Math.exp(-gpg))*100,0)}%`,
      },
      {
        id: 'g-first',
        label: 'First Goal Scorer',
        rulePct: pct((1 - Math.exp(-gpg)) / 5.2),
        ruleNote: `Anytime% ÷ ~5.2 avg shooters/game = ${fmt(((1-Math.exp(-gpg))/5.2)*100,0)}%`,
      },
      {
        id: 'g-2plus',
        label: '2+ Goals',
        rulePct: pct(poissonOver(gpg, 1.5)),
        ruleNote: `Poisson P(X>1.5 | λ=${fmt(gpg)}) = ${fmt(poissonOver(gpg,1.5)*100,0)}%`,
      },
    ],
  };

  // ── Assists ───────────────────────────────────────────────────────────────
  const assists: MarketGroup = {
    id: 'assists', title: 'Assists', cols: 3,
    options: [
      {
        id: 'a-1plus',
        label: '1+ Assist',
        rulePct: pct(1 - Math.exp(-apg)),
        ruleNote: `${p.assists}A in ${gp} GP = ${fmt(apg)} A/game → P(≥1)=${fmt((1-Math.exp(-apg))*100,0)}%`,
      },
      {
        id: 'a-2plus',
        label: '2+ Assists',
        rulePct: pct(poissonOver(apg, 1.5)),
        ruleNote: `Poisson P(X>1.5 | λ=${fmt(apg)}) = ${fmt(poissonOver(apg,1.5)*100,0)}%`,
      },
      {
        id: 'a-3plus',
        label: '3+ Assists',
        rulePct: pct(poissonOver(apg, 2.5)),
        ruleNote: `Poisson P(X>2.5 | λ=${fmt(apg)}) = ${fmt(poissonOver(apg,2.5)*100,0)}%`,
      },
    ],
  };

  // ── Points ────────────────────────────────────────────────────────────────
  const points: MarketGroup = {
    id: 'points', title: 'Points', cols: 3,
    options: [
      {
        id: 'pts-1plus',
        label: '1+ Point',
        rulePct: pct(1 - Math.exp(-ppg)),
        ruleNote: `${p.points}PTS in ${gp} GP = ${fmt(ppg)} P/game → P(≥1)=${fmt((1-Math.exp(-ppg))*100,0)}%`,
      },
      {
        id: 'pts-2plus',
        label: '2+ Points',
        rulePct: pct(poissonOver(ppg, 1.5)),
        ruleNote: `Poisson P(X>1.5 | λ=${fmt(ppg)}) = ${fmt(poissonOver(ppg,1.5)*100,0)}%`,
      },
      {
        id: 'pts-3plus',
        label: '3+ Points',
        rulePct: pct(poissonOver(ppg, 2.5)),
        ruleNote: `Poisson P(X>2.5 | λ=${fmt(ppg)}) = ${fmt(poissonOver(ppg,2.5)*100,0)}%`,
      },
    ],
  };

  // ── Shots on Goal ─────────────────────────────────────────────────────────
  const shots: MarketGroup = {
    id: 'shots', title: 'Shots on Goal', cols: 3,
    options: [
      {
        id: 'sog-o25',
        label: 'Over 2.5',
        rulePct: pct(poissonOver(spg, 2.5)),
        ruleNote: `${p.shots} shots in ${gp} GP = ${fmt(spg)} SOG/game → P(>2.5)=${fmt(poissonOver(spg,2.5)*100,0)}%`,
      },
      {
        id: 'sog-o35',
        label: 'Over 3.5',
        rulePct: pct(poissonOver(spg, 3.5)),
        ruleNote: `Poisson P(>3.5 | λ=${fmt(spg)}) = ${fmt(poissonOver(spg,3.5)*100,0)}%`,
      },
      {
        id: 'sog-o45',
        label: 'Over 4.5',
        rulePct: pct(poissonOver(spg, 4.5)),
        ruleNote: `Poisson P(>4.5 | λ=${fmt(spg)}) = ${fmt(poissonOver(spg,4.5)*100,0)}%`,
      },
    ],
  };

  // ── Hits ──────────────────────────────────────────────────────────────────
  const hitsGroup: MarketGroup = {
    id: 'hits', title: 'Hits', cols: 3,
    options: [
      {
        id: 'hits-o15',
        label: 'Over 1.5',
        rulePct: pct(poissonOver(hits, 1.5)),
        ruleNote: `Position avg ${fmt(hits)} hits/game → P(>1.5)=${fmt(poissonOver(hits,1.5)*100,0)}%`,
      },
      {
        id: 'hits-o25',
        label: 'Over 2.5',
        rulePct: pct(poissonOver(hits, 2.5)),
        ruleNote: `P(>2.5) = ${fmt(poissonOver(hits,2.5)*100,0)}%`,
      },
      {
        id: 'hits-o35',
        label: 'Over 3.5',
        rulePct: pct(poissonOver(hits, 3.5)),
        ruleNote: `P(>3.5) = ${fmt(poissonOver(hits,3.5)*100,0)}%`,
      },
    ],
  };

  // ── Blocked Shots ─────────────────────────────────────────────────────────
  const blocksGroup: MarketGroup = {
    id: 'blocks', title: 'Blocked Shots', cols: 2,
    options: [
      {
        id: 'blk-o05',
        label: 'Over 0.5',
        rulePct: pct(poissonOver(blks, 0.5)),
        ruleNote: `${pos === 'D' ? 'D-man' : 'Forward'} avg ${fmt(blks)} blocks/game → P(≥1)=${fmt(poissonOver(blks,0.5)*100,0)}%`,
      },
      {
        id: 'blk-o15',
        label: 'Over 1.5',
        rulePct: pct(poissonOver(blks, 1.5)),
        ruleNote: `P(≥2 blocks) = ${fmt(poissonOver(blks,1.5)*100,0)}%`,
      },
    ],
  };

  // ── Power Play ────────────────────────────────────────────────────────────
  const ppGroup: MarketGroup = {
    id: 'pp', title: 'Power Play', cols: 2,
    options: [
      {
        id: 'pp-point',
        label: 'PP Point',
        rulePct: pct(1 - Math.exp(-pppg)),
        ruleNote: `${p.ppPoints ?? 0} PP pts in ${gp} GP = ${fmt(pppg)} PP pts/game → P(≥1)=${fmt((1-Math.exp(-pppg))*100,0)}%`,
      },
      {
        id: 'pp-goal',
        label: 'PP Goal',
        rulePct: pct(1 - Math.exp(-pppg * 0.45)),
        ruleNote: `~45% of PP pts are goals → P(PP goal)=${fmt((1-Math.exp(-pppg*0.45))*100,0)}%`,
      },
    ],
  };

  // ── Penalty Minutes ───────────────────────────────────────────────────────
  const pimGroup: MarketGroup = {
    id: 'pim', title: 'Penalty Minutes', cols: 2,
    options: [
      {
        id: 'pim-o05',
        label: 'Over 0.5',
        rulePct: pct(poissonOver(pim, 0.5)),
        ruleNote: `Position avg ${fmt(pim)} PIM/game → P(≥1 PIM)=${fmt(poissonOver(pim,0.5)*100,0)}%`,
      },
      {
        id: 'pim-o15',
        label: 'Over 1.5',
        rulePct: pct(poissonOver(pim, 1.5)),
        ruleNote: `P(≥2 PIM) = ${fmt(poissonOver(pim,1.5)*100,0)}%`,
      },
    ],
  };

  const groups = [goals, assists, points, shots, hitsGroup, blocksGroup, ppGroup, pimGroup];
  attachPlayerFactors(groups, {
    pos, gpg, apg, ppg, spg, pppg,
    shotPct:  p.shotPct ?? 0,
    hitsPg:   hits,   // moyenne de position (donnée réelle absente du endpoint landing)
    blocksPg: blks,
    pimPg:    pim,
  });
  return groups;
}

function buildGoalieMarkets(p: any, gp: number, def: Record<string, number>): MarketGroup[] {
  // Stats réelles du gardien (endpoint landing) si disponibles, sinon défauts de position.
  const savePct     = p.savePct ?? 0;
  const gaLambda    = p.goalsAgainstAvg ?? (p.goalsAgainst != null ? p.goalsAgainst / gp : null) ?? def.goalsAllowed ?? 3.0;
  const savesLambda = p.shotsAgainst != null && savePct > 0
    ? (p.shotsAgainst / gp) * savePct
    : def.saves ?? 27;
  const winEstimate = p.wins != null ? clamp(p.wins / gp, 0.15, 0.85) : 0.52;
  const shutoutRate = p.shutouts != null ? clamp(p.shutouts / gp, 0, 0.4) : 0.08;

  const saves: MarketGroup = {
    id: 'saves', title: 'Saves', cols: 3,
    options: [
      {
        id: 'sv-o245',
        label: 'Over 24.5',
        rulePct: pct(poissonOver(savesLambda, 24.5)),
        ruleNote: `League avg ${savesLambda} saves/game → P(>24.5)=${fmt(poissonOver(savesLambda,24.5)*100,0)}%`,
      },
      {
        id: 'sv-o275',
        label: 'Over 27.5',
        rulePct: pct(poissonOver(savesLambda, 27.5)),
        ruleNote: `P(>27.5) = ${fmt(poissonOver(savesLambda,27.5)*100,0)}%`,
      },
      {
        id: 'sv-o295',
        label: 'Over 29.5',
        rulePct: pct(poissonOver(savesLambda, 29.5)),
        ruleNote: `P(>29.5) = ${fmt(poissonOver(savesLambda,29.5)*100,0)}%`,
      },
    ],
  };

  const goalsAllowed: MarketGroup = {
    id: 'ga', title: 'Goals Against', cols: 3,
    options: [
      {
        id: 'ga-o15',
        label: 'Over 1.5 GA',
        rulePct: pct(poissonOver(gaLambda, 1.5)),
        ruleNote: `League avg ${fmt(gaLambda)} GA/game → P(>1.5)=${fmt(poissonOver(gaLambda,1.5)*100,0)}%`,
      },
      {
        id: 'ga-o25',
        label: 'Over 2.5 GA',
        rulePct: pct(poissonOver(gaLambda, 2.5)),
        ruleNote: `P(>2.5) = ${fmt(poissonOver(gaLambda,2.5)*100,0)}%`,
      },
      {
        id: 'ga-u25',
        label: 'Under 2.5 GA',
        rulePct: pct(poissonUnder(gaLambda, 2.5)),
        ruleNote: `P(<2.5) = ${fmt(poissonUnder(gaLambda,2.5)*100,0)}%`,
      },
    ],
  };

  const result: MarketGroup = {
    id: 'gresult', title: 'Game Result', cols: 2,
    options: [
      {
        id: 'gr-win',
        label: 'Team Win',
        rulePct: pct(winEstimate),
        ruleNote: `Goalie team win probability (team-based, ~52% adjusted)`,
      },
      {
        id: 'gr-shutout',
        label: 'Shutout',
        rulePct: pct(Math.exp(-gaLambda)),
        ruleNote: `P(0 GA) = e^(−${fmt(gaLambda)}) = ${fmt(Math.exp(-gaLambda)*100,0)}%`,
      },
    ],
  };

  const groups = [saves, goalsAllowed, result];
  attachGoalieFactors(groups, {
    savesPg: savesLambda,
    gaPg: gaLambda,
    savePct,
    winPct: winEstimate,
    shutoutRate,
  });
  return groups;
}
