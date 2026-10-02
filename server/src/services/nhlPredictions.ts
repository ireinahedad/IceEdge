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
  fetchGameDetail,
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
import { attachGameFactors, attachPlayerFactors, attachGoalieFactors, PuckLineSpec, PeriodSpec } from './factorModel';
import {
  finalScoreGrid, winByAtLeastShare, exactScoreShare, totalOver, teamOver, nbAtLeast,
  nbAtLeastLive, liveFraction, LiveState, LiveEffects, evolveLiveScore,
} from './prediction/finalScore';
import measuredLiveEffects from './prediction/liveEffects.json';
import { TtlCache } from './ttlCache';

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
  /**
   * Fraction appliquée au mélange des facteurs, pour une tuile qui n'est pas
   * exactement la question que ses facteurs décrivent (« gagne en temps
   * réglementaire » contre « gagne »). Voir `setFactors` dans `factorModel.ts`.
   * Absente = 1.
   */
  pctScale?: number;
  /**
   * `true` = chiffre RECALCULÉ sur l'état du match en cours (score, temps
   * restant). Pendant une partie, le client l'affiche en blanc opaque ; une
   * tuile sans ce drapeau a été calculée avant le match et s'affiche plus pâle.
   */
  live?: boolean;
}

/**
 * Mise en TABLEAU d'un groupe de marchés.
 *
 * Les cases référencent des options du groupe PAR IDENTIFIANT : `options` reste
 * la liste plate et complète des paris — c'est elle que lisent les facteurs
 * (`attachGameFactors`), l'appariement ML du client et le coupon. Le tableau
 * ne dit que OÙ poser chaque pari à l'écran : une ligne par seuil, une colonne
 * par côté. Une carte peut porter plusieurs tableaux (une période : qui mène,
 * puis les buts de la période).
 *
 * Absent = la carte garde sa grille de tuiles (`cols`), comme avant.
 */
export interface MarketTable {
  /** Sous-titre du tableau dans la carte. */
  title?:        string;
  /** En-tête de la colonne des lignes. Toutes les étiquettes vides = pas de colonne de lignes. */
  rowHeader?:    string;
  /** Bandeau au-dessus des colonnes (ex. une équipe sur deux colonnes Over | Under). */
  columnGroups?: Array<{ label: string; span: number }>;
  columns:       string[];
  /** `cells[i]` = identifiant d'option de la colonne i, ou `null` pour une case vide. */
  rows:          Array<{ label: string; cells: Array<string | null> }>;
}

export interface MarketGroup {
  id:    string;
  title: string;
  cols:  2 | 3;
  options: BetOption[];
  tables?: MarketTable[];
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
  /** Fenwick toutes situations par match (MoneyPuck) — absent = repli sur les tirs. */
  fenwickForPg?:     number;
  fenwickAgainstPg?: number;
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

/** Poisson P(X ≥ need), sans bornes — en direct, 0 et 1 sont de vraies réponses. */
function poissonAtLeast(lambda: number, need: number): number {
  if (need <= 0) return 1;
  if (!(lambda > 0)) return 0;
  let cdf = 0, term = Math.exp(-lambda);
  for (let i = 0; i < need; i++) { cdf += term; term = (term * lambda) / (i + 1); }
  return Math.max(0, Math.min(1, 1 - cdf));
}

/** Poisson P(X < line) — equivalent to 1 - P(X >= ceil(line)) */
function poissonUnder(lambda: number, line: number): number {
  return Math.max(0.02, Math.min(0.98, 1 - poissonOver(lambda, line - 1)));
}

/**
 * Skellam-based 3-way period result.
 * Returns { home, draw, away } as fractions summing to ~1.
 *
 * `diff` (en direct) : avance ACTUELLE du domicile, ajoutée aux buts restants.
 * À λ = 0 (période terminée), la réponse est l'avance elle-même : 1/0/0.
 */
function skellamPeriod(lambdaH: number, lambdaA: number, diff = 0): { home: number; draw: number; away: number } {
  const MAX_K = 12;
  let home = 0, draw = 0, away = 0;
  for (let h = 0; h <= MAX_K; h++) {
    const ph = poissonPmf(lambdaH, h);
    if (ph < 1e-9) continue;
    for (let a = 0; a <= MAX_K; a++) {
      const pa = poissonPmf(lambdaA, a);
      if (pa < 1e-9) continue;
      const joint = ph * pa;
      if      (h + diff > a) home += joint;
      else if (h + diff < a) away += joint;
      else                   draw += joint;
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
/**
 * Loi des écarts RÉGLEMENTAIRES, seau par seau et camp par camp.
 *
 * `tie` — la masse de l'égalité après 60 minutes — est rendue au lieu d'être
 * jetée. C'est elle qui fait toute la forme de la distribution : un match nul
 * en temps réglementaire se termine TOUJOURS par un but d'écart, en
 * prolongation ou en fusillade. L'appelant la reverse donc dans « par 1 », des
 * deux côtés, selon la part de prolongation qui revient à chacun — et c'est ce
 * qui fait de « par 1 » l'écart le plus fréquent du hockey.
 *
 * C'est aussi ce que fait `predictMarginDistribution` dans
 * `prediction/marginPeriods.ts`, qui est le moteur de référence : ses six seaux
 * somment à 1 par construction. Les deux doivent répondre la même chose, sans
 * quoi la tuile et la fiche qu'on ouvre en cliquant dessus se contredisent.
 */
export function marginDistribution(lambdaH: number, lambdaA: number): {
  tie: number;                                            // nul après 60 min
  homeBy1: number; homeBy2: number; homeBy3plus: number;  // maison gagne de 1 / 2 / 3+
  homeBy2plus: number;                                    // maison gagne de 2+ (puck line)
  awayBy1: number; awayBy2: number; awayBy3plus: number;  // visiteur, mêmes seaux
} {
  const MAX_K = 15;
  const ph: number[] = [], pa: number[] = [];
  for (let k = 0; k <= MAX_K; k++) { ph[k] = poissonPmf(lambdaH, k); pa[k] = poissonPmf(lambdaA, k); }

  let tie = 0;
  let homeBy1 = 0, homeBy2 = 0, homeBy3plus = 0;
  let awayBy1 = 0, awayBy2 = 0, awayBy3plus = 0;
  for (let h = 0; h <= MAX_K; h++) {
    for (let a = 0; a <= MAX_K; a++) {
      const joint = ph[h] * pa[a];
      if (joint < 1e-12) continue;
      const diff = h - a;
      if (diff === 0) { tie += joint; continue; }
      const m = Math.abs(diff);
      if (diff > 0) {
        if      (m === 1) homeBy1     += joint;
        else if (m === 2) homeBy2     += joint;
        else              homeBy3plus += joint;
      } else {
        if      (m === 1) awayBy1     += joint;
        else if (m === 2) awayBy2     += joint;
        else              awayBy3plus += joint;
      }
    }
  }
  return {
    tie,
    homeBy1, homeBy2, homeBy3plus, homeBy2plus: homeBy2 + homeBy3plus,
    awayBy1, awayBy2, awayBy3plus,
  };
}

/** Clamp and round to integer percentage */
function pct(p: number): number {
  return Math.round(Math.max(3, Math.min(97, p * 100)));
}

/**
 * Pourcentage EN DIRECT : 0 ou 100 seulement pour une issue déjà acquise ou
 * impossible (période terminée, Over déjà atteint…), sinon borné à [1, 99].
 * Le plancher de 3 % de `pct` dit « le modèle n'est pas sûr » ; en direct, un
 * but de plus que le seuil rend l'issue certaine, et le cacher mentirait.
 */
function pctLive(p: number): number {
  if (p <= 1e-9) return 0;
  if (p >= 1 - 1e-9) return 100;
  return Math.round(Math.max(1, Math.min(99, p * 100)));
}

/** Format a goals-per-game rate for display */
function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

// ─── League constants ─────────────────────────────────────────────────────────

const LEAGUE_AVG_GPG = 3.05;   // buts/match moyens par équipe (ligue)
const LEAGUE_AVG_SOG = 30;     // tirs/match moyens (ligue)
// Volume de tirs en FENWICK (tentatives non bloquées, toutes situations) depuis
// le 2026-10-02. Mesuré sur 14 saisons (régression de Poisson hors
// échantillon, moyennes de saison à date comme ici) : contre les tirs cadrés,
// log-loss de la victoire −0,00096 (z −3,6, 12 saisons sur 14), déviance des
// buts −0,0053 (11/14). Le Corsi fait mieux que les tirs, moins bien que le
// Fenwick ; les versions 5 c. 5 seules ne battent pas les tirs.
// Constantes ligue 2025-26 (MoneyPuck) : 42,7 tentatives non bloquées par
// équipe-match, 7,2 % converties — 42,7 × 0,072 ≈ 3,08 buts, comme
// 30 tirs × 10,2 %.
const LEAGUE_AVG_FF = 42.7;
const FF_GOAL_RATE  = 0.072;
const SOG_GOAL_RATE = 0.102;
const OT_BASE        = 0.225;  // ~22.5% des matchs NHL vont en prolongation
const B2B_GOAL_PEN   = 0.04;   // baisse de λ pour un back-to-back

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

// ─── Match en cours ───────────────────────────────────────────────────────────
//
// Les prédictions en direct sont INFORMATIVES : les coupons sont refusés dès la
// mise au jeu (`gameHasStarted` dans `slip.service.ts`) et le règlement lit le
// score officiel. Rien ici ne touche à l'un ou à l'autre.

/** État d'un match en cours (ou terminé), tel que `computeGameMarkets` le lit. */
export interface LiveGameCtx {
  /** Pour la grille du score final : score actuel, temps restant, f. */
  state:        LiveState;
  /** Période en cours (1–3 ; 4+ = prolongation des séries). */
  period:       number;
  /** Secondes restantes dans la période (0 en entracte). */
  clockSec:     number;
  /** Buts de chaque période réglementaire, P1 → P3. */
  periodGoals:  Array<{ home: number; away: number }>;
  final:        boolean;
  /** Match terminé en prolongation / fusillade : vainqueur connu. */
  otWinnerHome?: boolean;
  /** Pour les notes : « 2–1, 2e, 12:34 restantes ». */
  label:        string;
}

const ORD = ['1re', '2e', '3e'];

/** Les effets de score mesurés par `ml/python/calibrate_live.py` (saisons ≤ 2022-23). */
export const MEASURED_LIVE_EFFECTS: LiveEffects = measuredLiveEffects as LiveEffects;
/**
 * Effets de score servis en direct (`LiveState.effects`) ; `null` = phase 1
 * (cadence fixe). Activés le 2026-10-01 sur le rejeu de 3 903 matchs hors
 * échantillon (`ml/models/live/live_report.md`) : log-loss −2,2 % au total,
 * jusqu'à −27 % sur la puck line à 2 minutes de la fin.
 */
const LIVE_EFFECTS: LiveEffects | null = MEASURED_LIVE_EFFECTS;

/** « MM:SS » → secondes (0 si illisible). */
function parseClock(clock: unknown): number {
  if (typeof clock !== 'string' || !clock.includes(':')) return 0;
  const [m, sec] = clock.split(':').map(Number);
  return Number.isFinite(m) && Number.isFinite(sec) ? Math.max(0, m * 60 + sec) : 0;
}

/**
 * Part des buts du match qui reste à marquer d'ici la fin de la période `n`,
 * pondérée par `PERIOD_DIST` (la 2e période compte plus de buts que la 1re).
 * C'est la même répartition que les cartes de période d'avant-match : à la
 * mise au jeu, la 1re vaut λ × 0.305 dans les deux calculs, sans saut.
 */
function remainingShareUntil(period: number, clockSec: number, n: number): number {
  if (period > n) return 0;
  let f = (Math.min(1200, clockSec) / 1200) * PERIOD_DIST[period - 1];
  for (let k = period; k < n; k++) f += PERIOD_DIST[k];
  return clamp(f, 0, 1);
}

/**
 * Feuille de match (`fetchGameDetail`) → état en direct. `null` = le match n'a
 * pas commencé (ou l'état est illisible) : la page garde l'avant-match.
 *
 * `fetchGameById` ne suffit pas : il n'a ni `periodType`, ni `inIntermission`,
 * ni les buts par période. `gameEvents.ts` non plus : ses buts sont gardés 6 h,
 * écrits pour les matchs terminés.
 */
export function liveCtxFromDetail(d: any): LiveGameCtx | null {
  const status = d?.status;
  if (status !== 'live' && status !== 'final') return null;
  const period = Number(d.period);
  const home = Number(d.home?.score), away = Number(d.away?.score);
  if (!Number.isFinite(period) || period < 1 || !Number.isFinite(home) || !Number.isFinite(away)) return null;

  const periodGoals = [1, 2, 3].map(n => {
    const row = (Array.isArray(d.periods) ? d.periods : []).find((x: any) => x?.label === String(n));
    return { home: Number(row?.home) || 0, away: Number(row?.away) || 0 };
  });
  const periodType = String(d.periodType ?? 'REG').toUpperCase();

  if (status === 'final') {
    // Terminé en prolongation / fusillade : la grille part du nul à 60 minutes
    // et le partage de la prolongation est le vainqueur réel. « Mène après la
    // 3e » vaut alors égalité, comme au règlement. Si les buts par période ne
    // recollent pas au nul (donnée incomplète), on retombe sur le score final.
    const lastType = String(d.lastPeriodType ?? periodType).toUpperCase();
    const regH = periodGoals.reduce((t, x) => t + x.home, 0);
    const regA = periodGoals.reduce((t, x) => t + x.away, 0);
    // Cohérence exigée : nul à 60 minutes ET vainqueur à un seul but de plus
    // (le but de prolongation, ou le but « comptable » de la fusillade).
    const wentOt = (lastType === 'OT' || lastType === 'SO') && regH === regA
      && Math.max(home, away) === regH + 1 && Math.min(home, away) === regH;
    return {
      state: wentOt
        ? { homeScore: regH, awayScore: regA, secondsLeftReg: 0, inOvertime: true, f: 0 }
        : { homeScore: home, awayScore: away, secondsLeftReg: 0, inOvertime: false, f: 0 },
      period: Math.max(3, period), clockSec: 0, periodGoals, final: true,
      otWinnerHome: wentOt ? home > away : undefined,
      label: `score final ${home}–${away}${wentOt ? ` (${lastType})` : ''}`,
    };
  }

  const inOvertime = periodType === 'OT' || periodType === 'SO' || period > 3;
  // En entracte, l'horloge affiche le décompte de la pause : la période est finie.
  const clockSec = d.inIntermission ? 0 : parseClock(d.clock);
  const secondsLeftReg = inOvertime ? 0 : Math.max(0, (3 - period) * 1200 + clockSec);
  const f = inOvertime ? 0 : remainingShareUntil(period, clockSec, 3);
  const when = inOvertime
    ? (periodType === 'SO' ? 'fusillade' : 'prolongation')
    : d.inIntermission
      ? `entracte après la ${ORD[period - 1]}`
      : `${ORD[period - 1]}, ${d.clock ?? '?'} restantes`;
  return {
    state: { homeScore: home, awayScore: away, secondsLeftReg, inOvertime, f, ...(LIVE_EFFECTS ? { effects: LIVE_EFFECTS } : {}) },
    period, clockSec, periodGoals, final: false,
    label: `${home}–${away}, ${when}`,
  };
}

/**
 * Ce qu'il faut aux grilles de paris joueur pendant un match (servi avec la
 * feuille de match, `GET /games/:id/boxscore`).
 *
 *   · `f` — part des buts du match qui reste à marquer (même pondération par
 *     période que les marchés du match). `null` en PROLONGATION : il reste au
 *     plus un but, dont la probabilité n'est pas mesurée ici — la grille montre
 *     alors « — » plutôt qu'un chiffre inventé (les seuils déjà atteints restent
 *     acquis). En fusillade et match terminé : 0, plus aucun but ne compte.
 *   · `firstScorerId` — premier but hors fusillade, ou null s'il n'y en a pas.
 *
 * `null` = état illisible : la grille montre « — », pas la saison.
 */
export function boxscoreLiveInfo(detail: any): {
  f: number | null; fTeam?: Record<string, number>; label: string; firstScorerId: string | null;
} | null {
  const c = liveCtxFromDetail(detail);
  if (!c) return null;
  const periodType = String(detail?.periodType ?? '').toUpperCase();
  const f = c.final || periodType === 'SO' ? 0 : c.state.inOvertime ? null : liveFraction(c.state);
  const first = (Array.isArray(detail?.scoring) ? detail.scoring : []).find((g: any) => g?.period !== 'SO');
  const fTeam = teamGoalsFactor(c, detail);
  return { f, ...(fTeam ? { fTeam } : {}), label: c.label, firstScorerId: first?.playerId ? String(first.playerId) : null };
}

/**
 * Part des buts du match qui reste à marquer, PAR ÉQUIPE, avec les effets de
 * score : buts restants attendus de l'équipe (`evolveLiveScore`) / son λ.
 * Une équipe menée en fin de match en marque plus que f ne le dit, celle qui
 * mène aussi (filet désert) ; à égalité, moins. Les grilles joueur l'appliquent
 * aux buts, passes et points — les statistiques mesurées sur des BUTS — et
 * gardent f pour les tirs, mises en échec, tirs bloqués et arrêts.
 *
 * Le λ du match n'est pas connu ici : on prend le λ moyen mesuré d'une équipe
 * (`leagueLambda`), le rapport n'y est presque pas sensible. Avec m ≡ 1, on
 * retrouve exactement f. `undefined` = pas d'effets, prolongation ou match fini.
 */
function teamGoalsFactor(c: LiveGameCtx, detail: any): Record<string, number> | undefined {
  const fx = c.state.effects;
  const lam = fx?.leagueLambda;
  const homeAbbr = detail?.home?.abbr, awayAbbr = detail?.away?.abbr;
  if (!fx || !(lam && lam > 0) || c.final || c.state.inOvertime || !homeAbbr || !awayAbbr) return undefined;
  if (!(c.state.secondsLeftReg > 0)) return { [homeAbbr]: 0, [awayAbbr]: 0 };
  const rem = evolveLiveScore(lam, lam, c.state.homeScore, c.state.awayScore, 3600 - c.state.secondsLeftReg, fx);
  let eh = 0, ea = 0;
  rem.forEach((row, i) => row.forEach((p, j) => { eh += p * i; ea += p * j; }));
  return { [homeAbbr]: Math.round((eh / lam) * 1e4) / 1e4, [awayAbbr]: Math.round((ea / lam) * 1e4) / 1e4 };
}

/**
 * Calage de la grille en direct sur l'AVANT-MATCH : λ domicile, λ visiteur,
 * gonflement des nuls.
 *
 * La grille Poisson tirée des λ bruts ne donne ni la même victoire que le
 * mélange de facteurs (qui compte la cote, les blessures, la fatigue…), ni le
 * même P(prolongation) qu'`otProb` (~16 % contre ~25 %) : sans calage, les
 * tuiles Moneyline, Match Betting et « Goes to OT » sauteraient à la mise au
 * jeu. On garde donc le total λT et on cherche, par bissection, le partage
 * domicile/visiteur qui rend `targetHome` une fois les nuls ramenés à
 * `targetTie` ; le facteur de nuls (`tieBoost`) s'en déduit. À 0–0 avec 60
 * minutes à jouer, ces tuiles disent exactement ce que disait l'avant-match.
 */
export function liveCalibration(
  lambdaT: number, targetHome: number, targetTie: number, otShareHome: number,
  effects: LiveEffects | null = null,
): { lambdaH: number; lambdaA: number; tieBoost: number } {
  const key = effects ? `${lambdaT}|${targetHome}|${targetTie}|${otShareHome}` : '';
  const hit = effects ? calibrationMemo.get(effects)?.get(key) : undefined;
  if (hit) return hit;
  const tie = clamp(targetTie, 0.01, 0.9);
  // Avec les effets de score, le calage passe par le MÊME moteur que le direct,
  // depuis 0–0 et 60 minutes à jouer : à la mise au jeu, la grille redit
  // l'avant-match.
  const kickoff: LiveState | undefined = effects
    ? { homeScore: 0, awayScore: 0, secondsLeftReg: 3600, inOvertime: false, effects }
    : undefined;
  const grid = (s: number) => finalScoreGrid(lambdaT * s, lambdaT * (1 - s), otShareHome, kickoff);
  const win = (s: number) => {
    const g = grid(s);
    return (g.regHome / Math.max(1e-9, 1 - g.regTie)) * (1 - tie) + tie * otShareHome;
  };
  let lo = 0.05, hi = 0.95;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (win(mid) < targetHome) lo = mid; else hi = mid;
  }
  const s = (lo + hi) / 2;
  const t = grid(s).regTie;
  const tieBoost = t > 0 && t < 1 ? (tie * (1 - t)) / (t * (1 - tie)) : 1;
  const out = { lambdaH: lambdaT * s, lambdaA: lambdaT * (1 - s), tieBoost };
  if (effects) {
    let memo = calibrationMemo.get(effects);
    if (!memo) calibrationMemo.set(effects, memo = new Map());
    if (memo.size >= 2000) memo.clear();
    memo.set(key, out);
  }
  return out;
}

/**
 * Le calage avec effets coûte ~30 passes du moteur ; il ne dépend que de
 * l'avant-match, pas du moment du match : on le garde par match.
 */
const calibrationMemo = new WeakMap<LiveEffects, Map<string, { lambdaH: number; lambdaA: number; tieBoost: number }>>();

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
  live: LiveGameCtx | null = null,         // match en cours : score actuel + temps restant
  model: ModelInputs | null = null,        // en direct : chiffres d'avant-match du MODÈLE ML
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
  // Volume attendu de chaque équipe dans CE match : moyenne de son Fenwick pour
  // et du Fenwick que concède l'adversaire (la mesure a retenu les deux côtés).
  // Les quatre valeurs ou rien : un match ne mélange pas deux mesures.
  const ffVals = [homeCtx.fenwickForPg, homeCtx.fenwickAgainstPg, awayCtx.fenwickForPg, awayCtx.fenwickAgainstPg];
  const useFenwick = ffVals.every((v) => v != null && v > 0);
  const hVol = useFenwick ? (homeCtx.fenwickForPg! + awayCtx.fenwickAgainstPg!) / 2 : hSF;
  const aVol = useFenwick ? (awayCtx.fenwickForPg! + homeCtx.fenwickAgainstPg!) / 2 : aSF;
  const volRef = useFenwick ? LEAGUE_AVG_FF : LEAGUE_AVG_SOG;
  const volRate = useFenwick ? FF_GOAL_RATE : SOG_GOAL_RATE;

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
  // Victoire d'avant-match. En direct, la victoire affichée (`mlHome`) est
  // relue plus bas sur la grille du score final ; celle-ci reste la mesure de
  // la force des équipes (partage de la prolongation, ancrage des λ).
  const preHome = blend.homeProb;
  // En direct, la décomposition d'avant-match ne décrit plus le chiffre.
  const mlBreakdown = live ? '' : formatBreakdown(blend);

  // ── Buts attendus (λ) — ratio attaque × défense relatif à la ligue ─────────
  // λH = force offensive maison × faiblesse défensive visiteur, échelle ligue.
  let lambdaH = (gfH / LEAGUE_AVG_GPG) * (gaA / LEAGUE_AVG_GPG) * LEAGUE_AVG_GPG;
  let lambdaA = (gfA / LEAGUE_AVG_GPG) * (gaH / LEAGUE_AVG_GPG) * LEAGUE_AVG_GPG;

  // Volume de tirs (Fenwick, repli tirs cadrés) : signal secondaire (poids 12%).
  lambdaH *= clamp(1 + 0.12 * (hVol / volRef - 1), 0.9, 1.1);
  lambdaA *= clamp(1 + 0.12 * (aVol / volRef - 1), 0.9, 1.1);

  // Unités spéciales : PP maison vs PK adverse (et inversement), borné ±8%.
  lambdaH *= clamp(1 + 0.06 * ((hPP - 20) / 20 - (aPK - 80) / 20) / 2, 0.92, 1.08);
  lambdaA *= clamp(1 + 0.06 * ((aPP - 20) / 20 - (hPK - 80) / 20) / 2, 0.92, 1.08);

  // Back-to-back : moins de buts. Glace locale : léger bonus offensif maison.
  lambdaH *= (1 - B2B_GOAL_PEN * hB2b) * 1.02;
  lambdaA *= (1 - B2B_GOAL_PEN * aB2b) * 0.99;

  lambdaH = clamp(lambdaH, 1.5, 5.0);
  lambdaA = clamp(lambdaA, 1.5, 5.0);
  const lambdaT = lambdaH + lambdaA;  // total expected goals

  // Part de la prolongation qui revient au domicile — voir « Le partage de la
  // prolongation » dans Match Betting. Calculée ICI parce que la grille en
  // direct en a besoin avant les tuiles. Match terminé en prolongation : le
  // vainqueur est connu, la part vaut 1 ou 0.
  // En direct avec `model` (paquet ML), la grille part des chiffres d'avant-match
  // du modèle ML au lieu de ceux des règles : c'est le modèle ML conditionné par
  // le score et le temps restant. Voir `buildLiveModelMarkets`.
  const anchor = live && model ? model : null;
  const basePre = anchor ? clamp(anchor.preHome, 0.01, 0.99) : preHome;
  const preShare = clamp(0.5 + 0.25 * (basePre - 0.5), 0.40, 0.60);
  const otShareHome = live?.otWinnerHome != null ? (live.otWinnerHome ? 1 : 0) : preShare;

  // ── Loi du score FINAL (prolongation/fusillade comprises) ─────────────────
  //
  // Une seule grille pour tous les marchés qui se règlent sur le score final :
  // puck lines, total du match, total par équipe, score exact. Construite sur
  // les mêmes λ que le reste de la page et sur la même part de prolongation
  // (`otShareHome`) que Match Betting. Voir `prediction/finalScore.ts`.
  //
  // En direct : grille décalée du score actuel, buts restants à λ × f, calée
  // sur la victoire et le P(prolongation) d'avant-match (`liveCalibration`).
  const liveF = live ? liveFraction(live.state) : 1;
  const cal = live
    ? liveCalibration(anchor ? anchor.lambdaT : lambdaT, basePre, anchor ? anchor.ot : otProb(preHome), preShare,
                      live.state.effects ?? null)
    : null;
  const gH = cal ? cal.lambdaH : lambdaH;
  const gA = cal ? cal.lambdaA : lambdaA;
  const grid = finalScoreGrid(gH, gA, otShareHome, live && cal ? { ...live.state, tieBoost: cal.tieBoost } : undefined);
  const h0 = live?.state.homeScore ?? 0;
  const a0 = live?.state.awayScore ?? 0;

  // Victoire (prolongation comprise). En direct, lue sur la grille : P(mène à
  // 60 min) + P(nul) × part OT — sinon une équipe menée 4–0 garderait ~55 %.
  const mlHome = live ? grid.regHome + grid.regTie * otShareHome : preHome;
  const mlAway = 1 - mlHome;
  const ot     = live ? grid.regTie : otProb(preHome);
  // `regAdj = 1 - ot` vivait ici et servait à trois endroits — Match Betting,
  // puck line, écart de victoire. Il n'en reste qu'un : Match Betting, qui
  // soustrait la part de prolongation explicitement (`homeReg`, `awayReg`).
  // Les deux autres l'appliquaient à des seaux qui excluaient DÉJÀ la
  // prolongation, ou qui devaient au contraire l'inclure — voir les blocs
  // « Puck Line » et « Winning Margin ».

  /** Pourcentage affiché : borné [3, 97] avant-match, 0/100 possibles en direct. */
  const pctOf = live ? pctLive : pct;
  /** Buts restants en direct, pour les notes. */
  const lamLeft = (lam: number) => fmt(lam * liveF);

  // ── 0. Moneyline — qui gagne le match, prolongation et fusillade comprises ─
  //
  // Ajouté le 2026-09-27 à la demande de l'utilisatrice : le choix DIRECT entre
  // les deux équipes, sans le découpage réglementaire / prolongation de Match
  // Betting. C'est le marché `h2h` à deux issues des livres, et celui que règle
  // `moneyline` au coupon. Les deux tuiles sont COMPLÉMENTAIRES : leur somme
  // fait 100 % (recalée après `attachGameFactors`, voir plus bas).
  const moneyline: MarketGroup = {
    id: 'moneyline', title: 'Moneyline', cols: 2,
    options: [
      {
        id: 'mw-home',
        ml: gm('moneyline'),
        label: `${homeName} wins`,
        rulePct: pctOf(mlHome),
        ruleNote: [
          `Victoire (prolongation et fusillade comprises) = ${fmt(mlHome*100,0)}%`,
          live ? `P(mène à 60 min) ${fmt(grid.regHome*100,0)}% + P(nul) ${fmt(grid.regTie*100,0)}% × part OT ${fmt(otShareHome*100,0)}%` : '',
          mlBreakdown,
        ].filter(Boolean).join('  ·  '),
      },
      {
        id: 'mw-away',
        ml: gma('moneyline'),
        label: `${awayName} wins`,
        rulePct: 100 - pctOf(mlHome),
        ruleNote: `Victoire (prolongation et fusillade comprises) = 100% − ${homeName} ${fmt(mlHome*100,0)}% = ${fmt(mlAway*100,0)}%`,
      },
    ],
  };

  // ── 1. Match Betting ──────────────────────────────────────────────────────
  //
  // QUATRE tuiles, et non trois : chaque équipe est cotée séparément en temps
  // réglementaire et en prolongation/fusillade.
  //
  // ── Pourquoi ce n'est pas un ajout cosmétique ───────────────────────────
  //
  // Les trois tuiles précédentes — « maison gagne », « OT/SO », « visiteur
  // gagne » — ne partitionnaient rien : « maison gagne » INCLUT les victoires
  // en prolongation, donc la tuile OT recoupait les deux autres et les trois
  // pourcentages totalisaient ~122 %. Le lecteur y voyait un choix exclusif
  // (c'est la forme d'un marché à trois voies) là où il n'y en avait pas.
  //
  // Les quatre tuiles ci-dessous sont EXHAUSTIVES et DISJOINTES : leur somme
  // fait 1 par construction. C'est le marché « 3-way + OT » que cotent les
  // livres.
  //
  // ── Le partage de la prolongation ────────────────────────────────────────
  //
  // P(victoire) contient déjà les prolongations ; il faut donc en retirer la
  // part qui s'y joue. La prolongation est beaucoup plus équilibrée que le
  // match : 3-contre-3 puis fusillade effacent une grande partie de l'écart de
  // talent, et la fusillade est proche du pile ou face. On ne reporte donc
  // qu'un QUART de l'avantage sur le partage de l'OT, borné à ±10 points —
  // au-delà, on prétendrait savoir quelque chose que la fusillade dément.
  // (`otShareHome` est calculée plus haut, avec la grille.)
  const homeOt  = ot * otShareHome;
  const awayOt  = ot * (1 - otShareHome);
  // `Math.max(0, …)` : sur un match très déséquilibré, P(victoire) du faible
  // peut descendre sous sa part de prolongation. Un négatif traverserait `pct`
  // (qui borne à 3 %) sans bruit et ferait mentir la somme.
  // En direct : lu sur la grille — les quatre tuiles somment à 1 par construction.
  const homeReg = live ? grid.regHome : Math.max(0, mlHome - homeOt);
  const awayReg = live ? grid.regAway : Math.max(0, mlAway - awayOt);

  const otNote = live
    ? `Égalité à 60 min ${fmt(ot*100,0)}% (score actuel + buts restants), partagée ${fmt(otShareHome*100,0)}/${fmt((1-otShareHome)*100,0)} en prolongation`
    : `OT/SO ${fmt(ot*100,0)}% du temps (ligue ~22.5%), partagé ${fmt(otShareHome*100,0)}/${fmt((1-otShareHome)*100,0)} — la prolongation efface une partie de l'écart de talent`;

  const matchBetting: MarketGroup = {
    id: 'match', title: 'Match Betting', cols: 2,
    options: [
      {
        id: 'ml-home',
        // Part réglementaire de la victoire. `attachGameFactors` mélange les
        // facteurs « qui gagne ? » puis applique ce facteur — voir `setFactors`.
        pctScale: mlHome > 0 ? homeReg / mlHome : 1,
        // ⚠️ Le marché ML reste `moneyline` : c'est la victoire TOUTES ISSUES
        // CONFONDUES que le modèle sait estimer, et le règlement automatique
        // n'a pas de marché « victoire en 60 minutes ». La tuile porte donc un
        // pourcentage de règles qui, lui, exclut la prolongation. Les deux
        // chiffres diffèrent volontairement et l'étiquette le dit.
        ml: gm('moneyline'),
        label: `${homeName} in Reg`,
        rulePct: pctOf(homeReg),
        ruleNote: [
          `Victoire en temps réglementaire = P(victoire) ${fmt(mlHome*100,0)}% − part OT ${fmt(homeOt*100,0)}% = ${fmt(homeReg*100,0)}%`,
          mlBreakdown,
          !live && injuries?.active ? `blessures : ${injuries.note}` : '',
          !live && lineup?.active   ? `alignement : ${lineup.note}` : '',
        ].filter(Boolean).join('  ·  '),
        // Poids sur 100, comme partout ailleurs (`blend.lines` les porte en
        // fractions de 1). attachGameFactors réécrit ces deux options juste
        // après, mais une échelle erronée ici finirait tôt ou tard à l'écran.
        factors: blend.lines.map(l => ({ id: l.id, label: l.label, weight: Math.round(l.weight * 100), value: l.value })),
      },
      {
        id: 'ml-away',
        pctScale: mlAway > 0 ? awayReg / mlAway : 1,
        ml: gma('moneyline'),
        label: `${awayName} in Reg`,
        rulePct: pctOf(awayReg),
        ruleNote: `Victoire en temps réglementaire = P(victoire) ${fmt(mlAway*100,0)}% − part OT ${fmt(awayOt*100,0)}% = ${fmt(awayReg*100,0)}%`,
        factors: blend.lines.map(l => ({ id: l.id, label: l.label, weight: Math.round(l.weight * 100), value: 1 - l.value })),
      },
      {
        // `ml-home-ot` / `ml-away-ot` sont des identifiants NEUFS. L'ancien
        // `ml-ot` disparaît : il désignait « le match va en prolongation »,
        // sans vainqueur, et le réutiliser pour l'une des deux moitiés
        // rattacherait des paris déjà enregistrés au mauvais marché.
        id: 'ml-home-ot',
        // Les facteurs de cette tuile répondent « va-t-on en prolongation ? ».
        // La part qui revient au domicile est ce facteur d'échelle.
        pctScale: otShareHome,
        /**
         * `ot_so_winner`, et surtout PAS `game_to_ot`.
         *
         * Ces deux tuiles annonçaient `game_to_ot` + sélection `yes` — soit
         * exactement ce qu'annonce la tuile « Goes to OT » du groupe OT. Deux
         * dégâts, et le commentaire de `MLProps.settleMarket` décrit
         * précisément le premier :
         *
         *  1. RÈGLEMENT. Une fois la jambe enregistrée, « le domicile gagne en
         *     prolongation » et « le match va en prolongation » étaient
         *     INDISCERNABLES : même marché, même sélection, même sujet. Le
         *     règlement ne pouvait donc trancher ni l'un ni l'autre sans risquer
         *     de créditer le mauvais pari, et les laissait tous les deux
         *     indécis — ce qui figeait le coupon entier (voir la migration 037).
         *
         *  2. POURCENTAGE. `PredictionSheet` remplace `rulePct` par la réponse
         *     de `/api/predict/single` pour le marché annoncé. La tuile
         *     demandait donc P(prolongation) ≈ 28 % et l'affichait — puis
         *     l'enregistrait dans le coupon — sur une tuile qui vaut
         *     P(prolongation) × part du domicile ≈ 15 %. Le chiffre du marché
         *     voisin, sur une tuile qui dit autre chose.
         *
         * `ot_so_winner` est inconditionnel (« gagne en OT/SO », ≈ 15 %) et se
         * distingue de `ot_winner`, qui est CONDITIONNEL à une prolongation
         * (« gagne SI on y va », ≈ 54 %) et que les books annulent quand le
         * match se règle en 60 minutes.
         *
         * Sans `selection` : `settlementFields` retombe alors sur `subjectId`,
         * donc l'abréviation de l'équipe — la forme que `teamPick` attend.
         */
        ml: gm('ot_so_winner'),
        label: `${homeName} in OT/SO`,
        rulePct: pctOf(homeOt),
        ruleNote: otNote,
      },
      {
        id: 'ml-away-ot',
        pctScale: 1 - otShareHome,
        ml: gma('ot_so_winner'),
        label: `${awayName} in OT/SO`,
        rulePct: pctOf(awayOt),
        ruleNote: otNote,
      },
    ],
  };

  // (La loi du score final, `grid`, est construite plus haut.)

  /** Tuiles posées dans les tableaux, indexées pour leurs facteurs. */
  const puckSpecs: Record<string, PuckLineSpec> = {};

  // ── 2. Puck Line — ±1.5 / ±2.5 / ±3.5, pour les DEUX équipes ──────────────
  //
  // « −x » = le camp gagne par ⌈x⌉ buts ou plus. « +x » = le camp ne perd PAS
  // par ⌈x⌉ ou plus, c'est-à-dire le complément EXACT du « −x » adverse (pas
  // d'égalité possible sur une demi-ligne). D'où, pour chaque ligne :
  //
  //     domicile −x  +  visiteur +x  = 100 %
  //     visiteur −x  +  domicile +x  = 100 %
  //
  // Et c'est ainsi que les tuiles « +x » sont DÉCLARÉES : même marché que le
  // « −x » adverse, côté « non ». Le règlement (`puck_line`, sélection `no`)
  // renverse le verdict, et la ligne voyage dans `line` — c'est elle qui fait
  // la différence entre −1.5 et −2.5, pas le libellé.
  //
  // La probabilité de « −x » est P(victoire) × P(gagne par ⌈x⌉+ | gagne) :
  // le rapport vient de la grille, la victoire du mélange de facteurs, comme
  // la tuile Match Betting. Une puck line ne peut donc jamais dépasser la
  // victoire du même camp, et « −1.5 ≥ −2.5 ≥ −3.5 » tient par construction.
  const PL_LINES = [1.5, 2.5, 3.5];
  const plOptions: BetOption[] = [];
  const plRows: MarketTable['rows'] = [];
  for (const x of PL_LINES) {
    const n   = x + 0.5;
    const tag = String(Math.round(x * 10));
    const rH  = winByAtLeastShare(grid, 'home', n);
    const rA  = winByAtLeastShare(grid, 'away', n);
    const hMinus = mlHome * rH;
    const aMinus = mlAway * rA;
    const ids = { hm: `pl-home-m${tag}`, hp: `pl-home-p${tag}`, am: `pl-away-m${tag}`, ap: `pl-away-p${tag}` };
    puckSpecs[ids.hm] = { side: 'home', minus: true,  rHome: rH, rAway: rA };
    puckSpecs[ids.hp] = { side: 'home', minus: false, rHome: rH, rAway: rA };
    puckSpecs[ids.am] = { side: 'away', minus: true,  rHome: rH, rAway: rA };
    puckSpecs[ids.ap] = { side: 'away', minus: false, rHome: rH, rAway: rA };
    plOptions.push(
      {
        id: ids.hm, ml: gm('puck_line', -x),
        label: `${homeName} −${x}`, rulePct: pctOf(hMinus),
        ruleNote: `P(victoire) ${fmt(mlHome*100,0)}% × P(gagne par ${n}+ | gagne) ${fmt(rH*100,0)}% = ${fmt(hMinus*100,0)}% (score final, prolongation comprise)`,
      },
      {
        id: ids.hp, ml: gma('puck_line', -x, 'no'),
        label: `${homeName} +${x}`, rulePct: pctOf(1 - aMinus),
        ruleNote: `Couvre sauf défaite par ${n}+ : 100% − ${awayName} −${x} (${fmt(aMinus*100,0)}%) = ${fmt((1-aMinus)*100,0)}%`,
      },
    );
    if (!teamExtras) {
      plOptions.push(
        {
          id: ids.am, ml: gma('puck_line', -x),
          label: `${awayName} −${x}`, rulePct: pctOf(aMinus),
          ruleNote: `P(victoire) ${fmt(mlAway*100,0)}% × P(gagne par ${n}+ | gagne) ${fmt(rA*100,0)}% = ${fmt(aMinus*100,0)}% (score final, prolongation comprise)`,
        },
        {
          id: ids.ap, ml: gm('puck_line', -x, 'no'),
          label: `${awayName} +${x}`, rulePct: pctOf(1 - hMinus),
          ruleNote: `Couvre sauf défaite par ${n}+ : 100% − ${homeName} −${x} (${fmt(hMinus*100,0)}%) = ${fmt((1-hMinus)*100,0)}%`,
        },
      );
    }
    plRows.push({ label: `${x}`, cells: teamExtras ? [ids.hm, ids.hp] : [ids.hm, ids.hp, ids.am, ids.ap] });
  }
  const puckLine: MarketGroup = {
    id: 'puckline', title: 'Puck Line', cols: 2,
    options: plOptions,
    tables: [{
      rowHeader: 'Line',
      columnGroups: teamExtras ? undefined : [{ label: hAb, span: 2 }, { label: aAb, span: 2 }],
      columns: teamExtras ? [`${hAb} −`, `${hAb} +`] : ['−', '+', '−', '+'],
      rows: plRows,
    }],
  };

  // ── 3. Total Goals — 2.5 à 7.5, colonnes Over | Under ─────────────────────
  //
  // Score FINAL : un nul 3–3 après 60 minutes se règle 4–3, donc « plus de
  // 6.5 » est gagné. Over et Under d'une même ligne sont des compléments
  // exacts (demi-ligne, pas de push). Les pourcentages affichés sont ceux du
  // mélange de facteurs (`totalsFactors`), qui prend en compte le même but de
  // prolongation.
  const TOTAL_LINES = [2.5, 3.5, 4.5, 5.5, 6.5, 7.5];
  const totOptions: BetOption[] = [];
  const totRows: MarketTable['rows'] = [];
  for (const L of TOTAL_LINES) {
    const tag = String(Math.round(L * 10));
    const over = totalOver(grid, L);
    totOptions.push(
      {
        id: `o${tag}`, ml: gm('total_goals_over', L), label: `Over ${L}`, rulePct: pctOf(over),
        ruleNote: live
          ? `Score actuel ${h0 + a0} but${h0 + a0 > 1 ? 's' : ''} + buts restants λ×f=${lamLeft(gH + gA)} → P(total final > ${L}) = ${fmt(over*100,0)}% (prolongation comprise)`
          : `Buts attendus λ=${fmt(lambdaT)} (${fmt(lambdaH)}+${fmt(lambdaA)}) → P(total final > ${L}) = ${fmt(over*100,0)}% (prolongation comprise)`,
      },
      {
        id: `u${tag}`, ml: gm('total_goals_under', L), label: `Under ${L}`, rulePct: pctOf(1 - over),
        ruleNote: `P(total final < ${L}) = ${fmt((1-over)*100,0)}%`,
      },
    );
    totRows.push({ label: `${L}`, cells: [`o${tag}`, `u${tag}`] });
  }
  const totals: MarketGroup = {
    id: 'totals', title: 'Total Goals', cols: 2,
    options: totOptions,
    tables: [{ rowHeader: 'Line', columns: ['Over', 'Under'], rows: totRows }],
  };

  // ── 3b. Buts par équipe — 0.5 à 4.5, Over | Under pour chaque camp ────────
  //
  // Le vainqueur d'une prolongation prend un but de plus au score final — c'est
  // ce score que règle `team_total_goals`, donc c'est lui qu'on chiffre.
  const TEAM_LINES = [0.5, 1.5, 2.5, 3.5, 4.5];
  const ttOptions: BetOption[] = [];
  const ttRows: MarketTable['rows'] = [];
  for (const L of TEAM_LINES) {
    const tag = String(Math.round(L * 10)).padStart(2, '0');
    const hOver = teamOver(grid, 'home', L);
    const aOver = teamOver(grid, 'away', L);
    ttOptions.push(
      {
        id: `tt-home-o${tag}`, ml: gm('team_total_goals', L, 'over'), label: `${homeName} Over ${L}`, rulePct: pctOf(hOver),
        ruleNote: live
          ? `${hAb} : ${h0} + buts restants λ×f=${lamLeft(gH)} → P(${hAb} > ${L} buts, score final) = ${fmt(hOver*100,0)}%`
          : `λ ${hAb}=${fmt(lambdaH)} → P(${hAb} > ${L} buts, score final) = ${fmt(hOver*100,0)}%`,
      },
      {
        id: `tt-home-u${tag}`, ml: gm('team_total_goals', L, 'under'), label: `${homeName} Under ${L}`, rulePct: pctOf(1 - hOver),
        ruleNote: `P(${hAb} < ${L} buts) = ${fmt((1-hOver)*100,0)}%`,
      },
    );
    if (!teamExtras) {
      ttOptions.push(
        {
          id: `tt-away-o${tag}`, ml: gma('team_total_goals', L, 'over'), label: `${awayName} Over ${L}`, rulePct: pctOf(aOver),
          ruleNote: live
            ? `${aAb} : ${a0} + buts restants λ×f=${lamLeft(gA)} → P(${aAb} > ${L} buts, score final) = ${fmt(aOver*100,0)}%`
            : `λ ${aAb}=${fmt(lambdaA)} → P(${aAb} > ${L} buts, score final) = ${fmt(aOver*100,0)}%`,
        },
        {
          id: `tt-away-u${tag}`, ml: gma('team_total_goals', L, 'under'), label: `${awayName} Under ${L}`, rulePct: pctOf(1 - aOver),
          ruleNote: `P(${aAb} < ${L} buts) = ${fmt((1-aOver)*100,0)}%`,
        },
      );
    }
    ttRows.push({
      label: `${L}`,
      cells: teamExtras
        ? [`tt-home-o${tag}`, `tt-home-u${tag}`]
        : [`tt-home-o${tag}`, `tt-home-u${tag}`, `tt-away-o${tag}`, `tt-away-u${tag}`],
    });
  }
  const teamTotals: MarketGroup = {
    id: 'teamtotals', title: 'Team Total Goals', cols: 2,
    options: ttOptions,
    tables: [{
      rowHeader: 'Line',
      columnGroups: teamExtras ? undefined : [{ label: hAb, span: 2 }, { label: aAb, span: 2 }],
      columns: teamExtras ? [`${hAb} Over`, `${hAb} Under`] : ['Over', 'Under', 'Over', 'Under'],
      rows: ttRows,
    }],
  };

  // ── 4. Both Teams to Score — 1+, 2+, 3+ ; colonnes Yes | No ──────────────
  // Binomiale négative, pas Poisson : cf. GOALS_DISPERSION_K. Avec exp(−λ) les
  // deux tuiles sortaient ~90 % / ~10 % quel que soit le match. « 2+ » et
  // « 3+ » sont la même loi à un seuil plus haut ; « oui » et « non » d'une
  // même ligne sont des compléments exacts.
  const bttsOptions: BetOption[] = [];
  const bttsRows: MarketTable['rows'] = [];
  // En direct : même loi sur le temps restant (`nbAtLeastLive`), en partant des
  // buts déjà marqués — 100 % dès que les deux équipes ont leurs j buts.
  for (const j of [1, 2, 3]) {
    const pH  = live ? nbAtLeastLive(gH, j - h0, GOALS_DISPERSION_K, liveF) : nbAtLeast(lambdaH, j, GOALS_DISPERSION_K);
    const pA  = live ? nbAtLeastLive(gA, j - a0, GOALS_DISPERSION_K, liveF) : nbAtLeast(lambdaA, j, GOALS_DISPERSION_K);
    const yes = pH * pA;
    // `btts-yes` / `btts-no` gardent leur identifiant (et leur marché SANS
    // ligne) : ce sont les tuiles d'avant, et les coupons déjà enregistrés les
    // référencent. Les seuils supérieurs portent la ligne j − 0.5.
    const idY = j === 1 ? 'btts-yes' : `btts${j}-yes`;
    const idN = j === 1 ? 'btts-no'  : `btts${j}-no`;
    const line = j === 1 ? undefined : j - 0.5;
    bttsOptions.push(
      {
        id: idY, ml: gm('both_teams_score', line, 'yes'),
        label: j === 1 ? 'Both Teams Score' : `Both Teams Score ${j}+`, rulePct: pctOf(yes),
        ruleNote: live
          ? `P(${hAb} finit ≥${j}, a ${h0})=${fmt(pH*100,0)}% × P(${aAb} finit ≥${j}, a ${a0})=${fmt(pA*100,0)}% = ${fmt(yes*100,0)}% (buts restants : binomiale négative, k=${GOALS_DISPERSION_K}×f)`
          : `P(${hAb}≥${j})=${fmt(pH*100,0)}% × P(${aAb}≥${j})=${fmt(pA*100,0)}% = ${fmt(yes*100,0)}% (buts par match : binomiale négative, k=${GOALS_DISPERSION_K})`,
      },
      {
        id: idN, ml: gm('both_teams_score', line, 'no'),
        label: j === 1 ? 'Both Teams Score — No' : `Both Teams Score ${j}+ — No`, rulePct: pctOf(1 - yes),
        ruleNote: `Au moins une équipe sous ${j} but${j > 1 ? 's' : ''} = ${fmt((1-yes)*100,0)}%`,
      },
    );
    bttsRows.push({ label: `${j}+`, cells: [idY, idN] });
  }
  const btts: MarketGroup = {
    id: 'btts', title: 'Both Teams to Score', cols: 2,
    options: bttsOptions,
    tables: [{ rowHeader: 'Goals', columns: ['Yes', 'No'], rows: bttsRows }],
  };

  // ── 5. Score exact (score FINAL) ──────────────────────────────────────────
  //
  // Une ligne par score « vainqueur–perdant », une colonne par vainqueur. Le
  // score d'un match allé en prolongation est le score final (3–2 après un
  // 2–2), comme au règlement ; il n'y a donc pas de « 2–2 ».
  //
  // Chaque case vaut P(le camp gagne) × P(ce score | il gagne) : les cases d'un
  // camp, « Other » compris, somment EXACTEMENT à sa probabilité de victoire
  // (tuiles Match Betting), et le tableau entier à 100 %. « Other » = le
  // vainqueur marque 5 buts ou plus.
  //
  // Précision au dixième, et pas de plancher à 3 % : un 4–3 vaut ~1 %, et
  // `pct` l'aurait triplé.
  const SCORES: Array<[number, number]> = [[1,0],[2,0],[2,1],[3,0],[3,1],[3,2],[4,0],[4,1],[4,2],[4,3]];
  // En direct, un score déjà dépassé vaut 0 exactement (et le seul score
  // encore possible, 100).
  const pct1 = (p: number) => live
    ? (p <= 1e-9 ? 0 : p >= 1 - 1e-9 ? 100 : Math.min(99.9, Math.max(0.1, Math.round(p * 1000) / 10)))
    : Math.max(0.1, Math.round(p * 1000) / 10);
  const csOptions: BetOption[] = [];
  const csRows: MarketTable['rows'] = [];
  let homeListed = 0, awayListed = 0;
  for (const [w, l] of SCORES) {
    const sH = exactScoreShare(grid, 'home', w, l);
    const sA = exactScoreShare(grid, 'away', w, l);
    homeListed += sH; awayListed += sA;
    const idH = `sc-home-${w}-${l}`, idA = `sc-away-${w}-${l}`;
    csOptions.push(
      {
        id: idH, ml: gm('correct_score', undefined, `${w}-${l}`),
        label: `${homeName} ${w}-${l}`, rulePct: pct1(mlHome * sH),
        ruleNote: `P(${hAb} gagne) ${fmt(mlHome*100,0)}% × P(${w}-${l} | ${hAb} gagne) ${fmt(sH*100,1)}% = ${fmt(mlHome*sH*100,1)}% (score final)`,
      },
      {
        // Sélection dans l'ordre DOMICILE–VISITEUR, comme le score de l'API :
        // le visiteur qui gagne 3–1 se règle sur « 1-3 ».
        id: idA, ml: gma('correct_score', undefined, `${l}-${w}`),
        label: `${awayName} ${w}-${l}`, rulePct: pct1(mlAway * sA),
        ruleNote: `P(${aAb} gagne) ${fmt(mlAway*100,0)}% × P(${w}-${l} | ${aAb} gagne) ${fmt(sA*100,1)}% = ${fmt(mlAway*sA*100,1)}% (score final)`,
      },
    );
    csRows.push({ label: `${w}-${l}`, cells: [idH, idA] });
  }
  const otherH = mlHome * Math.max(0, 1 - homeListed);
  const otherA = mlAway * Math.max(0, 1 - awayListed);
  csOptions.push(
    {
      id: 'sc-home-other', ml: gm('correct_score', undefined, 'home_other'),
      label: `${homeName} wins, other score`, rulePct: pct1(otherH),
      ruleNote: `${hAb} gagne en marquant 5 buts ou plus = ${fmt(otherH*100,1)}%`,
    },
    {
      id: 'sc-away-other', ml: gma('correct_score', undefined, 'away_other'),
      label: `${awayName} wins, other score`, rulePct: pct1(otherA),
      ruleNote: `${aAb} gagne en marquant 5 buts ou plus = ${fmt(otherA*100,1)}%`,
    },
  );
  csRows.push({ label: 'Winner 5+', cells: ['sc-home-other', 'sc-away-other'] });
  const correctScore: MarketGroup = {
    id: 'correctscore', title: 'Correct Score', cols: 2,
    options: csOptions,
    tables: [{ rowHeader: 'Score', columns: [hAb, aAb], rows: csRows }],
  };

  // ── 6–8. Périodes — UNE carte par période ─────────────────────────────────
  //
  // « Qui MÈNE après la période N », pas « qui gagne la période N » : c'est ce
  // que règle `periodN_winner` (buts CUMULÉS jusqu'à la fin de la période), et
  // ce que les tuiles disaient déjà. Le calcul, lui, prenait les buts de la
  // SEULE période — pour la 2e et la 3e, une autre question.
  //
  //   · P1 / P2 — Skellam sur les cadences cumulées (30.5 % puis 67 % du
  //     match). Les trois tuiles partitionnent : domicile et visiteur se
  //     partagent (1 − nul) selon leurs facteurs, via `pctScale` ; le nul est
  //     ancré sur le modèle. Somme = 100 %.
  //   · P3 — mener après la 3e = gagner en temps réglementaire ; égalité = le
  //     match va en prolongation. Ce sont EXACTEMENT les tuiles « in Reg » et
  //     « Goes to OT » : mêmes chiffres, mêmes facteurs, par construction.
  const periodSpecs: Record<string, PeriodSpec> = {};
  const PERIOD_NAMES = ['1st', '2nd', '3rd'];
  const periodGroups: MarketGroup[] = PERIOD_NAMES.map((name, i) => {
    const n = i + 1;
    let home: BetOption, draw: BetOption, away: BetOption;
    if (n < 3) {
      // En direct : score cumulé ACTUEL + buts restants jusqu'à la fin de la
      // période n. Période terminée → plus aucun but à venir (f = 0) et le
      // score à la fin de la période, lu dans les buts par période : 100/0/0.
      const f  = live
        ? remainingShareUntil(live.period, live.clockSec, n)
        : n === 1 ? PERIOD_DIST[0] : PERIOD_DIST[0] + PERIOD_DIST[1];
      const lH = (live ? gH : lambdaH) * f;
      const lA = (live ? gA : lambdaA) * f;
      const cum = !live ? { home: 0, away: 0 }
        : live.period > n
          ? live.periodGoals.slice(0, n).reduce((t, x) => ({ home: t.home + x.home, away: t.away + x.away }), { home: 0, away: 0 })
          : { home: h0, away: a0 };
      const r  = skellamPeriod(lH, lA, cum.home - cum.away);
      const decisive = Math.max(1e-9, r.home + r.away);
      periodSpecs[String(n)] = { q: r.home / decisive, draw: r.draw, lambdaP: lH + lA };
      const decided = live && f <= 0
        ? `Décidé : ${hAb} ${cum.home}–${cum.away} ${aAb} après la ${ORD[n - 1]} période`
        : '';
      const liveHead = live && !decided
        ? `Score actuel ${hAb} ${cum.home}–${cum.away} ${aAb} + buts restants d'ici la fin de la ${ORD[n - 1]} λH=${fmt(lH)} vs λA=${fmt(lA)}`
        : '';
      home = {
        id: `p${n}-home`, ml: gm(`period${n}_winner`), pctScale: 1 - r.draw,
        label: `${homeName} leads after P${n}`, rulePct: pctOf(r.home),
        ruleNote: decided || (liveHead
          ? `${liveHead} → Skellam P(${hAb} mène)=${fmt(r.home*100,0)}%`
          : `Buts cumulés λH=${fmt(lH)} vs λA=${fmt(lA)} → Skellam P(${hAb} mène)=${fmt(r.home*100,0)}%`),
      };
      draw = {
        id: `p${n}-draw`, ml: gm(`period${n}_winner`, undefined, 'draw'),
        label: `Tied after P${n}`, rulePct: pctOf(r.draw),
        ruleNote: decided || `P(égalité après ${name} période) = ${fmt(r.draw*100,0)}%`,
      };
      away = {
        id: `p${n}-away`, ml: gma(`period${n}_winner`), pctScale: 1 - r.draw,
        label: `${awayName} leads after P${n}`, rulePct: pctOf(r.away),
        ruleNote: decided || `Skellam P(${aAb} mène)=${fmt(r.away*100,0)}%`,
      };
    } else {
      home = {
        id: 'p3-home', ml: gm('period3_winner'), pctScale: mlHome > 0 ? homeReg / mlHome : 1,
        label: `${homeName} leads after P3`, rulePct: pctOf(homeReg),
        ruleNote: `Mène après 60 min = victoire en temps réglementaire : ${fmt(mlHome*100,0)}% − part OT ${fmt(homeOt*100,0)}% = ${fmt(homeReg*100,0)}%`,
      };
      draw = {
        id: 'p3-draw', ml: gm('game_to_ot', undefined, 'yes'),
        label: 'Tied after P3 (OT)', rulePct: pctOf(ot),
        ruleNote: `Égalité après 60 min = prolongation : ${fmt(ot*100,0)}%`,
      };
      away = {
        id: 'p3-away', ml: gma('period3_winner'), pctScale: mlAway > 0 ? awayReg / mlAway : 1,
        label: `${awayName} leads after P3`, rulePct: pctOf(awayReg),
        ruleNote: `Mène après 60 min = victoire en temps réglementaire : ${fmt(mlAway*100,0)}% − part OT ${fmt(awayOt*100,0)}% = ${fmt(awayReg*100,0)}%`,
      };
    }
    const group: MarketGroup = {
      id: `p${n}`, title: `${name} Period`, cols: 3,
      options: [home, draw, away],
      tables: [{
        title: n === 3 ? 'Lead after 3rd (regulation)' : `Lead after ${name}`,
        columns: [hAb, 'Tie', aAb],
        rows: [{ label: '', cells: [home.id, draw.id, away.id] }],
      }],
    };

    // Buts de la 1re période — dans SA carte. Mêmes tuiles qu'avant.
    // En direct : buts déjà marqués en 1re + ceux qui restent à y marquer.
    if (n === 1) {
      const lP1 = live
        ? (gH + gA) * remainingShareUntil(live.period, live.clockSec, 1)
        : lambdaT * PERIOD_DIST[0];
      const g1 = !live ? 0 : live.period > 1 ? live.periodGoals[0].home + live.periodGoals[0].away : h0 + a0;
      const p1Lines = [0.5, 1.5, 2.5];
      const p1Opts: BetOption[] = p1Lines.map(L => {
        const over = live ? poissonAtLeast(lP1, Math.floor(L) + 1 - g1) : poissonOver(lP1, L);
        return {
          id: `p1-o${String(Math.round(L * 10)).padStart(2, '0')}`,
          // `'over'` EXPLICITE : sans lui, `settlementFields` retombe sur le sujet
          // et la jambe part avec l'abréviation de l'équipe comme sélection.
          ml: gm('period1_total_goals', L, 'over'),
          label: `P1 Over ${L}`,
          rulePct: pctOf(over),
          ruleNote: live
            ? `${g1} but${g1 > 1 ? 's' : ''} en 1re + restants λ=${fmt(lP1)} → P(> ${L} buts en 1re)=${fmt(over*100,0)}%`
            : `P1 λ=${fmt(lP1)} → P(> ${L} buts en 1re)=${fmt(over*100,0)}%`,
        };
      });
      group.options.push(...p1Opts);
      group.tables!.push({
        title: '1st Period Goals',
        columns: p1Lines.map(L => `Over ${L}`),
        rows: [{ label: '', cells: p1Opts.map(o => o.id) }],
      });
    }
    return group;
  });

  // ── 10. Overtime ──────────────────────────────────────────────────────────
  const overtime: MarketGroup = {
    id: 'ot', title: 'Extra Time', cols: 2,
    options: [
      {
        id: 'ot-yes',
        ml: gm('game_to_ot', undefined, 'yes'),
        label: 'Goes to OT',
        rulePct: pctOf(ot),
        ruleNote: live
          ? `Égalité après 60 min (score actuel + buts restants) = ${fmt(ot*100,0)}%`
          : `Balance factor from win% spread → ${fmt(ot*100,0)}% OT probability`,
      },
      {
        id: 'ot-no',
        ml: gm('game_to_ot', undefined, 'no'),
        label: 'Decided in Regulation',
        rulePct: pctOf(1 - ot),
        ruleNote: `P(regulation finish) = ${fmt((1-ot)*100,0)}%`,
      },
    ],
  };

  // ── 11. Winning Margin ────────────────────────────────────────────────────
  //
  // Les trois tuiles portent l'écart DU DOMICILE — `gm(...)` met `hAb` en
  // sujet, et c'est ce sujet que `predictWinningMargin` lit pour répondre. Le
  // moteur (`prediction/marginPeriods.ts`) est la référence ; ce bloc doit dire
  // la même chose que lui, sans quoi la tuile et la fiche qu'on ouvre en
  // cliquant dessus se contredisent.
  //
  // ── Ce que ce calcul disait avant ──────────────────────────────────────────
  //
  // Deux écarts avec le moteur, dans la même ligne :
  //
  //  1. **Le camp.** `winBy1` comptait « quelqu'un gagne par 1 », les deux
  //     camps confondus, puis renormalisait sur les matchs décisifs. Le moteur
  //     répond « LE SUJET gagne par 1 ». Sur une affiche déséquilibrée, les deux
  //     nombres n'ont aucun rapport — celui de la tuile vaut presque le double.
  //
  //  2. **La prolongation.** `× regAdj` retirait les matchs qui vont au-delà de
  //     60 minutes. C'est l'inverse de ce qu'il faut faire : un match nul après
  //     60 minutes se termine TOUJOURS par un but d'écart. Cette masse-là
  //     appartient à « par 1 », et l'écarter enlevait précisément ce qui fait de
  //     « par 1 » l'écart le plus fréquent du hockey.
  //
  // Le pourcentage affiché venait du moteur (`PredictionSheet` remplace
  // `rulePct` par la réponse de `/api/predict/single`), donc l'erreur ne se
  // voyait que dans la grille avant ouverture, en repli quand l'appel échoue —
  // et dans `marginFactors`, qui prend ce `rulePct` comme valeur du modèle.
  //
  // `otShareHome` est la part de prolongation revenant au domicile, déjà
  // calculée pour Match Betting ; c'est l'analogue local de `pWinsOvertime`,
  // que le moteur utilise pour la même répartition.
  //
  // ── Sept. 2026 : sur la loi du score FINAL, comme la puck line ─────────────
  //
  // Les trois tuiles sont maintenant P(victoire) × P(cet écart | victoire),
  // rapports lus sur la même grille que la puck line. Deux conséquences
  // voulues : les trois somment EXACTEMENT à la victoire du domicile (tuiles
  // Match Betting), et « par 2 » + « par 3+ » = « −1.5 ». Leurs facteurs sont
  // ceux de Match Betting, transportés (voir `margins` dans `attachGameFactors`)
  // — l'ancien mélange `marginFactors` faisait totaliser ~120 % de la
  // victoire aux trois tuiles.
  const r2 = winByAtLeastShare(grid, 'home', 2);
  const r3 = winByAtLeastShare(grid, 'home', 3);
  const marginShares: Record<string, number> = { 'wm-1': 1 - r2, 'wm-2': r2 - r3, 'wm-3p': r3 };
  const wm1  = mlHome * marginShares['wm-1'];
  const wm2  = mlHome * marginShares['wm-2'];
  const wm3p = mlHome * marginShares['wm-3p'];
  const margin: MarketGroup = {
    id: 'margin', title: 'Winning Margin', cols: 3,
    options: [
      {
        id: 'wm-1',
        ml: gm('winning_margin', undefined, '1'),
        // Le camp est DANS le libellé. « Win by 1 » ne disait pas qui gagne,
        // alors que le pari, lui, porte sur le domicile depuis toujours.
        label: `${hAb} by 1`,
        rulePct: pctOf(wm1),
        ruleNote: `P(victoire) ${fmt(mlHome*100,0)}% × P(par 1 | victoire) ${fmt(marginShares['wm-1']*100,0)}% = ${fmt(wm1*100,0)}% — toutes les victoires en prolongation finissent par 1 but`,
      },
      {
        id: 'wm-2',
        ml: gm('winning_margin', undefined, '2'),
        label: `${hAb} by 2`,
        rulePct: pctOf(wm2),
        ruleNote: `P(victoire) ${fmt(mlHome*100,0)}% × P(par 2 | victoire) ${fmt(marginShares['wm-2']*100,0)}% = ${fmt(wm2*100,0)}%`,
      },
      {
        id: 'wm-3p',
        ml: gm('winning_margin', undefined, '3+'),
        label: `${hAb} by 3+`,
        rulePct: pctOf(wm3p),
        ruleNote: `P(victoire) ${fmt(mlHome*100,0)}% × P(par 3+ | victoire) ${fmt(marginShares['wm-3p']*100,0)}% = ${fmt(wm3p*100,0)}%, λ=${fmt(lambdaT)}`,
      },
    ],
  };

  // Ordre d'affichage. Le score exact n'a pas de sens contre un « adversaire
  // moyen » (vue équipe) : il n'y est pas.
  const groups: MarketGroup[] = [
    moneyline,
    matchBetting,
    puckLine,
    totals,
    teamTotals,
    btts,
    ...(teamExtras ? [] : [correctScore]),
    ...periodGroups,
    overtime,
    margin,
  ];

  // ── 12. Extras équipe (vue équipe uniquement) ─────────────────────────────
  // Blanchissage, but en PP, PK parfait — les valeurs sont recalculées par
  // attachGameFactors (facteurs dédiés). « Buts de l'équipe O/U 2.5 » en est
  // sorti : le tableau « Team Total Goals » (0.5 → 4.5) le couvre, avec le
  // même marché et la même ligne.
  if (teamExtras) {
    const PP_OPPS = 3.1;
    const csFor   = Math.exp(-lambdaA);
    const ppG     = 1 - Math.exp(-PP_OPPS * (hPP / 100));
    const pkAll   = Math.pow(hPK / 100, PP_OPPS);
    groups.push({
      id: 'teamx', title: 'Team Specials', cols: 2,
      options: [
        { id: 'cs-for', label: 'Clean Sheet (Shutout)', rulePct: pctOf(csFor),
          ml: gm('clean_sheet', undefined, 'yes'),
          ruleNote: `P(0 but adverse) = e^(−${fmt(lambdaA)}) = ${fmt(csFor*100,0)}%` },
        { id: 'ppgoal', label: 'Scores a PP Goal', rulePct: pctOf(ppG),
          ml: gm('team_pp_goals', undefined, 'yes'),
          ruleNote: `PP ${fmt(hPP,1)}% × ~${PP_OPPS} occasions → ${fmt(ppG*100,0)}%` },
        { id: 'pk-perfect', label: 'Kills All Penalties', rulePct: pctOf(pkAll),
          ml: gm('team_penalty_kill', undefined, 'yes'),
          ruleNote: `PK ${fmt(hPK,1)}% ^ ${PP_OPPS} occasions = ${fmt(pkAll*100,0)}%` },
      ],
    });
  }

  if (live) {
    // ── En direct : PAS de facteurs ─────────────────────────────────────────
    //
    // `attachGameFactors` écrase `rulePct` par le mélange des facteurs
    // d'avant-match, et le client recompose la tuile à partir de `factors` et
    // des poids de l'utilisateur (`BetOption` dans `PredictionSheet.tsx`). Les
    // deux effaceraient le score du match. Sans `factors` ni `pctScale`, le
    // client affiche `rulePct` tel quel. `ml` et les identifiants restent : le
    // paquet ML, les tableaux et le coupon en dépendent.
    for (const g of groups) {
      for (const o of g.options) {
        delete o.factors;
        delete o.factorGroup;
        delete o.pctScale;
        o.live = true;
        o.ruleNote = o.rulePct === 0 || o.rulePct === 100
          ? `${o.ruleNote}  ·  décidé (${live.label})`
          : `${o.ruleNote}  ·  en direct (${live.label})`;
      }
    }
    const [mwH, mwA] = moneyline.options;
    mwA.rulePct = 100 - mwH.rulePct;
    return groups;
  }

  // Décompose chaque marché en facteurs ajustables (met à jour rulePct + factors).
  attachGameFactors(groups, {
    wH, wA, gfH, gaH, gfA, gaA,
    lambdaH, lambdaA, lambdaT,
    hShotGoals: hVol * volRate, aShotGoals: aVol * volRate,
    shotMetric: useFenwick ? 'fenwick' : 'shots',
    hPP, aPP, hPK, aPK, hB2b, aB2b,
    venueAlt, hAltGain: hTravel?.alt_gain, aAltGain: aTravel?.alt_gain,
    refPenaltyMult,
    homeIce: fHomeIce, fatigue: fFatigue,
    mlHome, ot,
    matchFactors: blend.lines.map(l => ({ id: l.id, label: l.label, weight: Math.round(l.weight * 100), value: l.value })),
    otShareHome,
    bttsK: GOALS_DISPERSION_K,
    puckLines: puckSpecs,
    margins: marginShares,
    periods: periodSpecs,
  });

  // Moneyline : les deux côtés totalisent EXACTEMENT 100 %. Chacun est recalculé
  // depuis ses facteurs (complément exact l'un de l'autre), mais deux arrondis
  // indépendants pourraient encore faire 101 sur un « x,5 ».
  {
    const [mwH, mwA] = moneyline.options;
    mwA.rulePct = 100 - mwH.rulePct;
  }

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
    fenwickForPg:     s?.fenwickForPg,
    fenwickAgainstPg: s?.fenwickAgainstPg,
    restDays:       rest.restDays,
    b2b:            rest.b2b,
    travel,
  };
}

/**
 * Chiffres d'avant-match du MODÈLE ML (paquet `gameMlBundle.ts`) : victoire du
 * domicile, P(prolongation), buts attendus du match. En direct, ils remplacent
 * ceux des règles comme point de départ de la grille du score final.
 */
export interface ModelInputs { preHome: number; ot: number; lambdaT: number }

/** Marchés d'un match + son état, pour que la route règle son cache dessus. */
export interface GameMarketsResult {
  groups: MarketGroup[];
  /**
   * Statut qui règle le cache HTTP : `scheduled` | `live` | `final`. `final`
   * seulement si l'état final a bien été calculé (tout est décidé, plus rien
   * ne bougera).
   */
  status: string;
  /** Match commencé : « 2–1, 2e, 12:34 restantes ». */
  liveLabel?: string;
}

/**
 * 30 s par match (et par jeu de poids) — le rythme de la feuille de match en
 * direct. Surtout un anti-rafale : N visiteurs qui rafraîchissent en même
 * temps ne déclenchent qu'un calcul (`TtlCache.wrap`), comme `gameMlBundle.ts`.
 * ⚠️ Le résultat est PARTAGÉ entre appelants : ne jamais le modifier.
 */
const gameMarketsCache = new TtlCache<GameMarketsResult>(30_000, 500, 'gamePredictions');

export async function buildGameMarketsWithStatus(gameId: string, weights?: FactorWeights): Promise<GameMarketsResult> {
  const key = `${gameId}|${weights ? JSON.stringify(weights) : ''}`;
  return gameMarketsCache.wrap(key, () => computeGameMarketsFor(gameId, weights));
}

export async function buildGameMarkets(gameId: string, weights?: FactorWeights): Promise<MarketGroup[]> {
  return (await buildGameMarketsWithStatus(gameId, weights)).groups;
}

/**
 * Les tuiles d'AVANT-MATCH, sans jamais lire l'état du match. Pour le paquet
 * ML, qui n'en lit que la liste et le marché de chaque tuile : un match en
 * cours dont la feuille est momentanément illisible ne doit pas l'empêcher.
 */
export async function buildPrematchGameMarkets(gameId: string): Promise<MarketGroup[]> {
  return (await computeGameMarketsFor(gameId, undefined, { prematch: true })).groups;
}

/**
 * Marchés EN DIRECT calculés à partir des chiffres du modèle ML (`model`) : même
 * grille que les règles, autre point de départ. `liveLabel` absent = le match
 * n'a pas commencé, ou que son état est illisible : le paquet ML garde alors
 * ses chiffres d'avant-match (affichés plus pâles pendant la partie).
 */
export async function buildLiveModelMarkets(gameId: string, model: ModelInputs): Promise<GameMarketsResult> {
  return computeGameMarketsFor(gameId, undefined, { model });
}

/**
 * Le calcul de `buildLiveModelMarkets` SANS réseau : chiffres d'avant-match du
 * modèle + état du match → tuiles. Pour le rejeu (`scripts/replay-live.ts`),
 * qui note ainsi le vrai moteur. Avec `model`, la grille, la victoire et la
 * prolongation ne lisent que le modèle et l'état du match : les équipes
 * neutres ne changent que les tuiles hors grille, que le rejeu ne note pas.
 */
export function computeLiveModelGroups(model: ModelInputs, live: LiveGameCtx): MarketGroup[] {
  return computeGameMarkets({ abbreviation: 'HOM' }, { abbreviation: 'AWY' }, 'HOM', 'AWY',
    {}, {}, null, null, null, undefined, false, 1, live, model);
}

async function computeGameMarketsFor(
  gameId: string, weights?: FactorWeights,
  opts: { prematch?: boolean; model?: ModelInputs } = {},
): Promise<GameMarketsResult> {
  const game = await fetchGameById(gameId);
  const listed: string = game.status ?? 'scheduled';
  // Commencé : selon le statut, OU l'heure de mise au jeu passée. Un match
  // « à venir » reste en cache 5 min dans `fetchGameById` : sans l'heure, ses
  // premières minutes seraient servies en avant-match.
  const startMs = game.startTimeUTC ? Date.parse(game.startTimeUTC) : NaN;
  const started = listed === 'live' || listed === 'final' || (Number.isFinite(startMs) && startMs <= Date.now());
  const wantDetail = !opts.prematch && started;
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
         homeTravelRes, awayTravelRes, refFactorRes, manualRes, detailRes] = await Promise.allSettled([
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
    // Match commencé : la feuille de match (période, horloge, entracte, buts
    // par période). Cache de 30 s partagé avec la page du match.
    wantDetail ? fetchGameDetail(gameId) : Promise.resolve(null),
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

  // ── État du match ─────────────────────────────────────────────────────────
  //
  // Match commencé et feuille lisible → chiffres recalculés (`live: true` sur
  // chaque tuile). Feuille illisible, ou partie pas encore lancée → chiffres
  // d'AVANT-MATCH, sans le drapeau : le client les affiche plus pâles, sous une
  // note qui dit qu'ils ont été calculés avant le match. Cache court dans les
  // deux cas, pour reprendre le direct dès que la feuille revient.
  let live: LiveGameCtx | null = null;
  let status = listed;
  if (wantDetail) {
    const d = detailRes.status === 'fulfilled' ? detailRes.value : null;
    live = d ? liveCtxFromDetail(d) : null;
    status = live?.final ? 'final' : 'live';
  }

  const groups = computeGameMarkets(
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
    live,
    opts.model ?? null,
  );
  return { groups, status, ...(live ? { liveLabel: live.label } : {}) };
}

// ─── Public: team predictions (vs league-average opponent) ────────────────────

export async function buildTeamMarkets(teamAbbr: string): Promise<MarketGroup[]> {
  const [team, all] = await Promise.all([fetchTeamByAbbr(teamAbbr), fetchTeams()]);

  // Build league-average pseudo-team
  const n   = all.length || 1;
  // `abbreviation: 'OPP'` : c'est le sujet des tuiles qui portent sur
  // l'adversaire (et l'en-tête de leurs colonnes). `TeamPrediction.tsx` le
  // remplace par l'adversaire réel du match choisi avant tout pari.
  const avg = {
    abbreviation:       'OPP',
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
