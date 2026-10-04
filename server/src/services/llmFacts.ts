/**
 * llmFacts.ts — le bloc FAITS de l'« Analyse IA » d'un pari, calculé par le CODE.
 *
 * ── Principe (2026-10-04) ───────────────────────────────────────────────────
 *
 * Le LLM n'est pas un analyste : c'est le NARRATEUR d'un modèle. Tout ce qui
 * peut se calculer l'est ici, de façon déterministe et testable :
 *
 *   • la valeur face au marché (écart ML – marché, cote juste, cote du livre) ;
 *   • la solidité du chiffre (σ de l'ensemble bootstrap, accord des deux modèles) ;
 *   • le statut des données (gardiens, alignements, cotes) ;
 *   • le classement MAJEUR / SECONDAIRE des facteurs, tiré des contributions
 *     RÉELLES du modèle de score (`feature_importances` : décomposition de log λ
 *     par match, signée vers le domicile — pas des gains globaux) ;
 *   • la réserve (« gardien non confirmé… »), écrite par gabarit, pas par le LLM.
 *
 * Le LLM choisit 2 à 3 CLÉS parmi les candidats déjà classés et les met en
 * phrase. Il ne peut ni reclasser, ni inventer un facteur, ni écrire un chiffre
 * absent des faits (`validateAnalysis` le vérifie et retombe sur un texte
 * déterministe sinon).
 *
 * Ce module est PUR : aucune entrée-sortie. `llmAnalysis.ts` va chercher les
 * données (paquet ML, features) et l'appelle.
 */

import type { GameFeatures } from './featureEngineering';
import type { MLPredictionResult } from './mlApiClient';

export type FactsLocale = 'fr' | 'en';

/** Ce que le client dit du pari. Tout est facultatif sauf `type` et `label`. */
export interface BetDescriptor {
  type: 'game' | 'team' | 'player';
  label: string;
  gameId?: string;
  /** Identifiant de la TUILE (page match) : retrouve le résultat du paquet ML. */
  optId?: string;
  propType?: string;
  line?: number;
  selection?: string;
  isHome?: boolean;
  subjectId?: string;
  opponentId?: string;
  /** Repli : chiffre ML connu du client quand le paquet n'a rien. */
  mlPct?: number | null;
  /** Cote décimale du livre pour CE pari, si le client en a une. */
  bookOdds?: number | null;
  /** Pari joueur / équipe : lignes de faits préparées par le client. */
  extraFacts?: string[];
}

export type CandidateSide = 'for' | 'against' | 'neutral';
export type CandidateTier = 'major' | 'minor';

export interface Candidate {
  key: string;
  tier: CandidateTier;
  side: CandidateSide;
  /** Part du facteur dans l'écart du modèle (0–1), quand elle existe. */
  share?: number;
  /** Phrase factuelle chiffrée, dans la langue demandée. */
  evidence: string;
}

export type Solidity = 'stable' | 'moderate' | 'uncertain';

export interface FactsSummary {
  modelPct: number | null;
  marketPct: number | null;
  /** `no_vig` = cote de clôture dé-viggée ; `book` = cote du livre (marge incluse). */
  marketKind: 'no_vig' | 'book' | null;
  /** modèle − marché, en points. */
  edgePts: number | null;
  fairOdds: number | null;
  bookOdds: number | null;
  /** Espérance de gain par $1 à la cote du livre, en % (positif = valeur). */
  valuePct: number | null;
  sigmaPts: number | null;
  solidity: Solidity | null;
  expectedTotal: number | null;
  marketLine: number | null;
}

export type StatusState = 'confirmed' | 'pending' | 'missing';
export interface StatusItem { key: 'goalies' | 'lineups' | 'odds'; state: StatusState; text: string }

export type FactTag =
  | 'models_disagree' | 'goalie_dependent' | 'above_market' | 'below_market'
  | 'with_market' | 'long_shot' | 'high_uncertainty' | 'live';

export interface Facts {
  family: 'sided' | 'totals' | 'free';
  summary: FactsSummary;
  candidates: Candidate[];
  status: StatusItem[];
  tags: FactTag[];
  /** Réserve déterministe, ou null. */
  caveat: string | null;
  /** Aucun facteur MAJEUR : le LLM doit le dire au lieu de broder. */
  dominant: boolean;
  /** Le bloc envoyé au LLM (et réutilisé par les questions de suivi). */
  text: string;
}

// ─── Utilitaires ──────────────────────────────────────────────────────────────

const L = (fr: boolean, a: string, b: string): string => (fr ? a : b);

function fmt(n: number, digits: number, fr: boolean): string {
  const s = n.toFixed(digits);
  return fr ? s.replace('.', ',') : s;
}
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const pct0 = (x: number, fr: boolean): string => `${fmt(x * 100, 0, fr)} %`;

// ─── Familles de marchés ──────────────────────────────────────────────────────

/** Marchés qui opposent les deux équipes : la décomposition du modèle les décrit. */
const SIDED_MARKETS = new Set([
  'moneyline', 'regulation_result', 'puck_line', 'winning_margin',
  'period1_winner', 'period2_winner', 'period3_winner',
  'first_team_score', 'last_team_score',
]);

export function marketFamily(market: string | undefined): 'sided' | 'totals' {
  return market && SIDED_MARKETS.has(market) ? 'sided' : 'totals';
}

/** Over / Under, déduit du marché ou de la sélection. */
function overUnder(bet: BetDescriptor): 'over' | 'under' | null {
  const hay = `${bet.propType ?? ''} ${bet.selection ?? ''} ${bet.label}`.toLowerCase();
  if (/(^|[^a-z])under|_under|moins de/.test(hay)) return 'under';
  if (/(^|[^a-z])over|_over|plus de/.test(hay)) return 'over';
  return null;
}

// ─── Candidats : marchés « vainqueur » ────────────────────────────────────────

/** Part minimale pour compter, et part au-dessus de laquelle un facteur est MAJEUR. */
const SHARE_MINOR = 0.08;
const SHARE_MAJOR = 0.25;

function sidedEvidence(key: string, f: GameFeatures, fr: boolean): string | null {
  const h = f.home_team ?? 'DOM';
  const a = f.away_team ?? 'EXT';
  switch (key) {
    case 'factor.team_strength': {
      return L(fr,
        `Force d'équipe : % de victoires ${h} ${pct0(f.home_win_pct, fr)} contre ${a} ${pct0(f.away_win_pct, fr)} ; 10 derniers ${h} ${pct0(f.home_last10_win_pct, fr)} contre ${a} ${pct0(f.away_last10_win_pct, fr)}`,
        `Team strength: win% ${h} ${pct0(f.home_win_pct, fr)} vs ${a} ${pct0(f.away_win_pct, fr)}; last 10 ${h} ${pct0(f.home_last10_win_pct, fr)} vs ${a} ${pct0(f.away_last10_win_pct, fr)}`);
    }
    case 'factor.home_ice': {
      return L(fr,
        `Avantage de la glace : ${h} gagne ${pct0(f.home_home_win_pct, fr)} à domicile, ${a} ${pct0(f.away_road_win_pct, fr)} à l'extérieur`,
        `Home ice: ${h} wins ${pct0(f.home_home_win_pct, fr)} at home, ${a} ${pct0(f.away_road_win_pct, fr)} on the road`);
    }
    case 'factor.goalie': {
      const hg = f.home_goalie, ag = f.away_goalie;
      if (hg && ag) return L(fr, `Gardiens partants : ${h} ${hg}, ${a} ${ag}`, `Starting goalies: ${h} ${hg}, ${a} ${ag}`);
      if (hg || ag) {
        const known = hg ? `${h} ${hg}` : `${a} ${ag}`;
        const unk = hg ? a : h;
        return L(fr, `Gardiens : ${known} ; ${unk} non confirmé (gardien moyen supposé)`,
                     `Goalies: ${known}; ${unk} unconfirmed (average goalie assumed)`);
      }
      return L(fr, 'Gardiens : aucun partant confirmé, le modèle suppose un gardien moyen',
                   'Goalies: no confirmed starter, the model assumes an average goalie');
    }
    case 'factor.lineup': {
      const hs = f.home_scratches ?? [], as = f.away_scratches ?? [];
      const part = (abbr: string, list: string[]) =>
        list.length ? `${abbr} ${list.length} (${list.slice(0, 3).join(', ')})` : `${abbr} 0`;
      return L(fr, `Absents officiels : ${part(h, hs)} ; ${part(a, as)}`,
                   `Scratches: ${part(h, hs)}; ${part(a, as)}`);
    }
    case 'factor.schedule': {
      const b2b = (x: 0 | 1) => (x ? (fr ? ', back-to-back' : ', back-to-back') : '');
      return L(fr,
        `Calendrier : repos ${h} ${f.home_rest_days} j${b2b(f.home_b2b)} ; ${a} ${f.away_rest_days} j${b2b(f.away_b2b)}`,
        `Schedule: rest ${h} ${f.home_rest_days} d${b2b(f.home_b2b)}; ${a} ${f.away_rest_days} d${b2b(f.away_b2b)}`);
    }
    case 'factor.attack': {
      return L(fr,
        `Attaque : buts pour/match ${h} ${fmt(f.home_goals_for_pg, 2, fr)}, ${a} ${fmt(f.away_goals_for_pg, 2, fr)} ; tirs pour ${h} ${fmt(f.home_shots_for_pg, 1, fr)}, ${a} ${fmt(f.away_shots_for_pg, 1, fr)}`,
        `Attack: goals for/game ${h} ${fmt(f.home_goals_for_pg, 2, fr)}, ${a} ${fmt(f.away_goals_for_pg, 2, fr)}; shots for ${h} ${fmt(f.home_shots_for_pg, 1, fr)}, ${a} ${fmt(f.away_shots_for_pg, 1, fr)}`);
    }
    case 'factor.opp_defense': {
      return L(fr,
        `Défense : buts contre/match ${h} ${fmt(f.home_goals_against_pg, 2, fr)}, ${a} ${fmt(f.away_goals_against_pg, 2, fr)} ; tirs contre ${h} ${fmt(f.home_shots_against_pg, 1, fr)}, ${a} ${fmt(f.away_shots_against_pg, 1, fr)}`,
        `Defense: goals against/game ${h} ${fmt(f.home_goals_against_pg, 2, fr)}, ${a} ${fmt(f.away_goals_against_pg, 2, fr)}; shots against ${h} ${fmt(f.home_shots_against_pg, 1, fr)}, ${a} ${fmt(f.away_shots_against_pg, 1, fr)}`);
    }
    default:
      return null;
  }
}

function sidedCandidates(
  result: MLPredictionResult | null, f: GameFeatures, subjectIsHome: boolean, fr: boolean,
): Candidate[] {
  const fis = result?.feature_importances ?? [];
  const out: Candidate[] = [];
  for (const fi of fis) {
    if (!isNum(fi.importance)) continue;
    const toward: 'home' | 'away' = fi.direction === 'positive' ? 'home' : 'away';
    const side: CandidateSide = (toward === 'home') === subjectIsHome ? 'for' : 'against';
    if (fi.name.startsWith('factor.')) {
      if (fi.importance < SHARE_MINOR) continue;
      const evidence = sidedEvidence(fi.name, f, fr);
      if (!evidence) continue;
      out.push({
        key: fi.name.slice('factor.'.length),
        tier: fi.importance >= SHARE_MAJOR ? 'major' : 'minor',
        side, share: fi.importance, evidence,
      });
    } else if (out.length < 3) {
      // Repli classifieur : le nom est une colonne, la part est globale. On le
      // garde à titre secondaire plutôt que de ne rien dire.
      out.push({
        key: fi.name.replace(/[^a-z0-9_]/gi, '_').toLowerCase(),
        tier: 'minor', side: 'neutral', share: fi.importance,
        evidence: L(fr, `Variable du modèle : ${fi.name}`, `Model variable: ${fi.name}`),
      });
    }
  }
  return out.sort((x, y) => (x.tier === y.tier ? (y.share ?? 0) - (x.share ?? 0) : x.tier === 'major' ? -1 : 1));
}

// ─── Candidats : totaux, périodes, BTTS, prolongation… ────────────────────────

const LEAGUE_GOALS_PER_TEAM = 3.05;

function totalsCandidates(
  bet: BetDescriptor, f: GameFeatures, lamH: number | null, lamA: number | null, fr: boolean,
): Candidate[] {
  const h = f.home_team ?? 'DOM';
  const a = f.away_team ?? 'EXT';
  const ou = overUnder(bet);
  const out: Candidate[] = [];

  /** Sens d'un facteur qui pousse le total vers le haut (+1) ou le bas (−1). */
  const sideFor = (dir: 1 | -1): CandidateSide =>
    ou === 'over' ? (dir > 0 ? 'for' : 'against')
    : ou === 'under' ? (dir < 0 ? 'for' : 'against')
    : 'neutral';

  if (lamH != null && lamA != null) {
    const total = lamH + lamA;
    const line = isNum(bet.line) ? bet.line : (isNum(f.total_line_market) ? f.total_line_market : null);
    const gap = line != null ? total - line : null;
    const dir: 1 | -1 = (gap ?? 0) >= 0 ? 1 : -1;
    out.push({
      key: 'expected_total',
      tier: gap != null && Math.abs(gap) >= 0.4 ? 'major' : (gap == null ? 'major' : 'minor'),
      side: gap == null ? 'neutral' : sideFor(dir),
      evidence: gap != null
        ? L(fr, `Total attendu ${fmt(total, 2, fr)} buts (${h} ${fmt(lamH, 2, fr)}, ${a} ${fmt(lamA, 2, fr)}) contre une ligne de ${fmt(line!, 1, fr)} : écart ${gap >= 0 ? '+' : ''}${fmt(gap, 2, fr)}`,
                     `Expected total ${fmt(total, 2, fr)} goals (${h} ${fmt(lamH, 2, fr)}, ${a} ${fmt(lamA, 2, fr)}) vs a line of ${fmt(line!, 1, fr)}: gap ${gap >= 0 ? '+' : ''}${fmt(gap, 2, fr)}`)
        : L(fr, `Total attendu ${fmt(total, 2, fr)} buts (${h} ${fmt(lamH, 2, fr)}, ${a} ${fmt(lamA, 2, fr)})`,
                `Expected total ${fmt(total, 2, fr)} goals (${h} ${fmt(lamH, 2, fr)}, ${a} ${fmt(lamA, 2, fr)})`),
    });
  }

  // Rythme : buts pour + contre des deux équipes, contre la moyenne de ligue.
  const tempo = (f.home_goals_for_pg + f.home_goals_against_pg + f.away_goals_for_pg + f.away_goals_against_pg) / 2;
  const tempoGap = tempo - 2 * LEAGUE_GOALS_PER_TEAM;
  if (Math.abs(tempoGap) >= 0.25) {
    out.push({
      key: 'tempo',
      tier: Math.abs(tempoGap) >= 0.6 ? 'major' : 'minor',
      side: sideFor(tempoGap > 0 ? 1 : -1),
      evidence: L(fr,
        `Rythme : ${h} ${fmt(f.home_goals_for_pg, 2, fr)} pour / ${fmt(f.home_goals_against_pg, 2, fr)} contre, ${a} ${fmt(f.away_goals_for_pg, 2, fr)} / ${fmt(f.away_goals_against_pg, 2, fr)} ; ${fmt(tempo, 1, fr)} buts attendus par les moyennes contre ${fmt(2 * LEAGUE_GOALS_PER_TEAM, 1, fr)} pour la ligue`,
        `Pace: ${h} ${fmt(f.home_goals_for_pg, 2, fr)} for / ${fmt(f.home_goals_against_pg, 2, fr)} against, ${a} ${fmt(f.away_goals_for_pg, 2, fr)} / ${fmt(f.away_goals_against_pg, 2, fr)}; ${fmt(tempo, 1, fr)} goals implied by averages vs ${fmt(2 * LEAGUE_GOALS_PER_TEAM, 1, fr)} league`),
    });
  }

  // Unités spéciales : AN moyen et DN moyen contre la ligue (~21 % / ~79,5 %).
  const pp = [f.home_pp_pct, f.away_pp_pct], pk = [f.home_pk_pct, f.away_pk_pct];
  if (pp.every(isNum) && pk.every(isNum)) {
    const ppAvg = ((pp[0] as number) + (pp[1] as number)) / 2;
    const pkAvg = ((pk[0] as number) + (pk[1] as number)) / 2;
    const net = (ppAvg - 21) - (pkAvg - 79.5);
    if (Math.abs(net) >= 1.5) {
      out.push({
        key: 'special_teams',
        tier: 'minor',
        side: sideFor(net > 0 ? 1 : -1),
        evidence: L(fr,
          `Unités spéciales : AN ${h} ${fmt(pp[0] as number, 1, fr)} %, ${a} ${fmt(pp[1] as number, 1, fr)} % ; DN ${h} ${fmt(pk[0] as number, 1, fr)} %, ${a} ${fmt(pk[1] as number, 1, fr)} %`,
          `Special teams: PP ${h} ${fmt(pp[0] as number, 1, fr)}%, ${a} ${fmt(pp[1] as number, 1, fr)}%; PK ${h} ${fmt(pk[0] as number, 1, fr)}%, ${a} ${fmt(pk[1] as number, 1, fr)}%`),
      });
    }
  }

  // Calendrier : seulement s'il y a un back-to-back.
  if (f.home_b2b || f.away_b2b) {
    const who = [f.home_b2b ? h : null, f.away_b2b ? a : null].filter(Boolean).join(' + ');
    out.push({
      key: 'schedule', tier: 'minor', side: 'neutral',
      evidence: L(fr, `Calendrier : ${who} en back-to-back (repos ${h} ${f.home_rest_days} j, ${a} ${f.away_rest_days} j)`,
                      `Schedule: ${who} on a back-to-back (rest ${h} ${f.home_rest_days} d, ${a} ${f.away_rest_days} d)`),
    });
  }

  // Gardiens : seulement s'ils sont connus (sinon c'est un statut, pas un fait).
  if (f.home_goalie || f.away_goalie) {
    out.push({
      key: 'goalies', tier: 'minor', side: 'neutral',
      evidence: L(fr,
        `Gardiens : ${h} ${f.home_goalie ?? 'non confirmé'}, ${a} ${f.away_goalie ?? 'non confirmé'}`,
        `Goalies: ${h} ${f.home_goalie ?? 'unconfirmed'}, ${a} ${f.away_goalie ?? 'unconfirmed'}`),
    });
  }

  return out.sort((x, y) => (x.tier === y.tier ? 0 : x.tier === 'major' ? -1 : 1));
}

// ─── Statut des données ───────────────────────────────────────────────────────

function statusOf(f: GameFeatures, fr: boolean): StatusItem[] {
  const both = !!(f.home_goalie && f.away_goalie);
  const none = !f.home_goalie && !f.away_goalie;
  const lineups = !!(f.home_dressed_ids?.length && f.away_dressed_ids?.length);
  const hasOdds = isNum(f.home_odds_decimal) && isNum(f.away_odds_decimal);
  return [
    {
      key: 'goalies', state: both ? 'confirmed' : 'pending',
      text: both ? L(fr, 'Gardiens : confirmés', 'Goalies: confirmed')
        : none ? L(fr, 'Gardiens : non confirmés', 'Goalies: unconfirmed')
        : L(fr, 'Gardiens : un seul confirmé', 'Goalies: only one confirmed'),
    },
    {
      key: 'lineups', state: lineups ? 'confirmed' : 'pending',
      text: lineups ? L(fr, 'Alignements : officiels', 'Lineups: official')
                    : L(fr, 'Alignements : pas encore publiés', 'Lineups: not yet published'),
    },
    {
      key: 'odds', state: hasOdds ? 'confirmed' : 'missing',
      text: hasOdds ? L(fr, 'Cotes du marché : disponibles', 'Market odds: available')
                    : L(fr, 'Cotes du marché : indisponibles', 'Market odds: unavailable'),
    },
  ];
}

// ─── Entrée principale ────────────────────────────────────────────────────────

export interface GameFactsInput {
  bet: BetDescriptor;
  result: MLPredictionResult | null;
  features: GameFeatures;
  lambdaHome: number | null;
  lambdaAway: number | null;
  /** Étiquette « live » du paquet, si le match est commencé. */
  liveLabel?: string | null;
  locale: FactsLocale;
}

export function buildGameFacts(input: GameFactsInput): Facts {
  const { bet, result, features: f, locale } = input;
  const fr = locale === 'fr';
  const subjectIsHome = bet.isHome !== false;
  const family = marketFamily(bet.propType);
  const live = !!(input.liveLabel || result?.live);

  const modelPct = isNum(result?.probability) ? Math.round(result!.probability)
    : (isNum(bet.mlPct) ? Math.round(bet.mlPct) : null);

  // ── Marché ──
  let marketPct: number | null = null;
  let marketKind: FactsSummary['marketKind'] = null;
  if (bet.propType === 'moneyline' && isNum(f.home_odds_decimal) && isNum(f.away_odds_decimal)
      && f.home_odds_decimal > 1 && f.away_odds_decimal > 1) {
    const ph = 1 / f.home_odds_decimal, pa = 1 / f.away_odds_decimal;
    const home = (ph / (ph + pa)) * 100;
    marketPct = Math.round(subjectIsHome ? home : 100 - home);
    marketKind = 'no_vig';
  } else if (isNum(bet.bookOdds) && bet.bookOdds > 1) {
    marketPct = Math.round(100 / bet.bookOdds);
    marketKind = 'book';
  }
  const edgePts = modelPct != null && marketPct != null ? modelPct - marketPct : null;
  const fairOdds = modelPct != null && modelPct > 0 && modelPct < 100 ? Math.round((100 / modelPct) * 100) / 100 : null;
  const bookOdds = isNum(bet.bookOdds) && bet.bookOdds > 1 ? bet.bookOdds : null;
  const valuePct = modelPct != null && bookOdds != null
    ? Math.round((bookOdds * modelPct / 100 - 1) * 1000) / 10 : null;

  const sigmaPts = isNum(result?.probability_std) ? Math.round(result!.probability_std! * 10) / 10 : null;
  const unc = result?.uncertainty;
  const solidity: Solidity | null = isNum(unc) ? (unc < 0.34 ? 'stable' : unc < 0.67 ? 'moderate' : 'uncertain') : null;

  const lamH = input.lambdaHome, lamA = input.lambdaAway;
  const summary: FactsSummary = {
    modelPct, marketPct, marketKind, edgePts, fairOdds, bookOdds, valuePct, sigmaPts, solidity,
    expectedTotal: lamH != null && lamA != null ? Math.round((lamH + lamA) * 100) / 100 : null,
    marketLine: isNum(f.total_line_market) ? f.total_line_market : null,
  };

  // ── Candidats ──
  const candidates = family === 'sided'
    ? sidedCandidates(result, f, subjectIsHome, fr)
    : totalsCandidates(bet, f, lamH, lamA, fr);
  const dominant = candidates.some(c => c.tier === 'major');

  // ── Statut + réserve ──
  const status = live ? [] : statusOf(f, fr);
  const goalieShare = candidates.find(c => c.key === 'goalie')?.share ?? 0;
  const lineupShare = candidates.find(c => c.key === 'lineup')?.share ?? 0;
  const goaliesPending = status.find(s => s.key === 'goalies')?.state === 'pending';
  const lineupsPending = status.find(s => s.key === 'lineups')?.state === 'pending';
  const pS = result?.probability_score_model, pC = result?.probability_classifier;
  const disagree = family === 'sided' && isNum(pS) && isNum(pC) && Math.abs(pS - pC) >= 8;

  let caveat: string | null = null;
  if (!live) {
    const h = f.home_team ?? 'DOM', a = f.away_team ?? 'EXT';
    if (goaliesPending && (family === 'totals' || goalieShare >= 0.15)) {
      const who = f.home_goalie ? a : f.away_goalie ? h : null;
      caveat = who
        ? L(fr, `Gardien de ${who} non confirmé : le chiffre suppose un gardien moyen.`, `${who} goalie unconfirmed: the figure assumes an average goalie.`)
        : L(fr, 'Gardiens partants non confirmés : le chiffre suppose des gardiens moyens.', 'Starting goalies unconfirmed: the figure assumes average goalies.');
    } else if (disagree) {
      caveat = L(fr, `Les deux modèles divergent : score ${pS} % contre classifieur ${pC} %.`,
                     `The two models disagree: score model ${pS}% vs classifier ${pC}%.`);
    } else if (lineupsPending && lineupShare >= 0.1) {
      caveat = L(fr, 'Alignements officiels pas encore publiés.', 'Official lineups not yet published.');
    } else if (solidity === 'uncertain' && sigmaPts != null) {
      caveat = L(fr, `Estimation incertaine (± ${fmt(sigmaPts, 1, fr)} pts).`, `Uncertain estimate (± ${fmt(sigmaPts, 1, fr)} pts).`);
    }
  }

  // ── Étiquettes (au plus 3, par priorité) ──
  const tags: FactTag[] = [];
  if (live) tags.push('live');
  if (disagree) tags.push('models_disagree');
  if (!live && goaliesPending && goalieShare >= 0.2) tags.push('goalie_dependent');
  if (edgePts != null) tags.push(edgePts >= 4 ? 'above_market' : edgePts <= -4 ? 'below_market' : 'with_market');
  if (modelPct != null && modelPct < 35) tags.push('long_shot');
  if (solidity === 'uncertain') tags.push('high_uncertainty');

  const facts: Facts = {
    family, summary, candidates, status, tags: tags.slice(0, 3), caveat, dominant, text: '',
  };
  facts.text = renderFactsText(bet, f, facts, input.liveLabel ?? null, fr);
  return facts;
}

/** Pari joueur / équipe : pas de décomposition du modèle, les lignes du client servent de candidats. */
export function buildFreeFacts(bet: BetDescriptor, locale: FactsLocale): Facts {
  const fr = locale === 'fr';
  const modelPct = isNum(bet.mlPct) ? Math.round(bet.mlPct) : null;
  const bookOdds = isNum(bet.bookOdds) && bet.bookOdds > 1 ? bet.bookOdds : null;
  const marketPct = bookOdds != null ? Math.round(100 / bookOdds) : null;
  const summary: FactsSummary = {
    modelPct, marketPct, marketKind: marketPct != null ? 'book' : null,
    edgePts: modelPct != null && marketPct != null ? modelPct - marketPct : null,
    fairOdds: modelPct != null && modelPct > 0 && modelPct < 100 ? Math.round((100 / modelPct) * 100) / 100 : null,
    bookOdds,
    valuePct: modelPct != null && bookOdds != null ? Math.round((bookOdds * modelPct / 100 - 1) * 1000) / 10 : null,
    sigmaPts: null, solidity: null, expectedTotal: null, marketLine: null,
  };
  const lines = (bet.extraFacts ?? []).slice(0, 8);
  const candidates: Candidate[] = lines.map((evidence, i) => ({
    key: `d${i + 1}`, tier: 'minor', side: 'neutral', evidence,
  }));
  const tags: FactTag[] = [];
  if (summary.edgePts != null) tags.push(summary.edgePts >= 4 ? 'above_market' : summary.edgePts <= -4 ? 'below_market' : 'with_market');
  if (modelPct != null && modelPct < 35) tags.push('long_shot');
  const facts: Facts = {
    family: 'free', summary, candidates, status: [], tags, caveat: null, dominant: false, text: '',
  };
  facts.text = renderFactsText(bet, null, facts, null, fr);
  return facts;
}

// ─── Rendu du bloc FAITS ──────────────────────────────────────────────────────

function renderFactsText(
  bet: BetDescriptor, f: GameFeatures | null, facts: Facts, liveLabel: string | null, fr: boolean,
): string {
  const s = facts.summary;
  const lines: string[] = [];
  const match = f ? `${f.home_team ?? '?'} (dom.) – ${f.away_team ?? '?'} (ext.)` : '';
  lines.push(L(fr, `PARI : ${bet.label}${match ? ` · Match : ${match}` : ''}`, `BET: ${bet.label}${match ? ` · Game: ${match}` : ''}`));
  if (liveLabel) lines.push(L(fr, `MATCH EN COURS : ${liveLabel} (chiffre conditionné par le score)`, `LIVE GAME: ${liveLabel} (figure conditioned on score)`));

  const model = s.modelPct != null
    ? L(fr, `Modèle ML : ${s.modelPct} %${s.sigmaPts != null ? ` (± ${fmt(s.sigmaPts, 1, fr)} pts)` : ''}`,
            `ML model: ${s.modelPct}%${s.sigmaPts != null ? ` (± ${fmt(s.sigmaPts, 1, fr)} pts)` : ''}`)
    : L(fr, 'Modèle ML : indisponible', 'ML model: unavailable');
  lines.push(model);
  if (s.marketPct != null) {
    lines.push(L(fr,
      `Marché : ${s.marketPct} % (${s.marketKind === 'no_vig' ? 'cote de clôture sans marge' : 'cote du livre, marge incluse'}) · écart modèle − marché : ${s.edgePts! >= 0 ? '+' : ''}${s.edgePts} pts`,
      `Market: ${s.marketPct}% (${s.marketKind === 'no_vig' ? 'closing odds, no vig' : 'book odds, vig included'}) · model − market gap: ${s.edgePts! >= 0 ? '+' : ''}${s.edgePts} pts`));
  }
  if (s.fairOdds != null) {
    lines.push(L(fr, `Cote juste du modèle : ${fmt(s.fairOdds, 2, fr)}${s.bookOdds != null ? ` · cote du livre : ${fmt(s.bookOdds, 2, fr)}` : ''}`,
                     `Model fair odds: ${fmt(s.fairOdds, 2, fr)}${s.bookOdds != null ? ` · book odds: ${fmt(s.bookOdds, 2, fr)}` : ''}`));
  }
  if (s.marketLine != null && facts.family === 'totals') {
    lines.push(L(fr, `Ligne de total du marché : ${fmt(s.marketLine, 1, fr)}`, `Market total line: ${fmt(s.marketLine, 1, fr)}`));
  }
  if (facts.status.length) lines.push((fr ? 'STATUT : ' : 'STATUS: ') + facts.status.map(x => x.text).join(' · '));
  if (facts.caveat) lines.push((fr ? 'RÉSERVE (déjà affichée, ne la réécris pas) : ' : 'CAVEAT (already shown, do not rewrite): ') + facts.caveat);

  lines.push('');
  if (!facts.candidates.length) {
    lines.push(L(fr, 'CANDIDATS : aucun', 'CANDIDATES: none'));
  } else {
    lines.push(L(fr, 'CANDIDATS (déjà classés, du plus au moins important) :', 'CANDIDATES (already ranked, most to least important):'));
    for (const c of facts.candidates) {
      const tier = c.tier === 'major' ? L(fr, 'MAJEUR', 'MAJOR') : L(fr, 'SECONDAIRE', 'MINOR');
      const side = c.side === 'for' ? L(fr, 'POUR le pari', 'FOR the bet')
        : c.side === 'against' ? L(fr, 'CONTRE le pari', 'AGAINST the bet') : L(fr, 'sens non tranché', 'direction unclear');
      const share = c.share != null ? ` · ${Math.round(c.share * 100)} %` : '';
      lines.push(`[${c.key}] ${tier} · ${side}${share} — ${c.evidence}`);
    }
    if (!facts.dominant) {
      lines.push(L(fr, 'Aucun facteur MAJEUR : dis-le dans headline.', 'No MAJOR factor: say so in headline.'));
    }
  }
  return lines.join('\n');
}

// ─── Lecture du descripteur envoyé par le client ──────────────────────────────

const MAX_LABEL = 160;
const MAX_FACT_LINES = 8;
const MAX_FACT_LINE_CHARS = 240;

const cleanText = (s: unknown, max: number): string =>
  typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const num = (x: unknown): number | undefined =>
  typeof x === 'number' && Number.isFinite(x) ? x : undefined;

/**
 * Lit `req.body.bet`. Tout est borné et nettoyé : ce texte finit dans l'invite
 * d'un fournisseur facturé à l'opérateur. `null` = descripteur inutilisable.
 */
export function parseBetDescriptor(raw: unknown): BetDescriptor | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const type = b.type === 'game' || b.type === 'team' || b.type === 'player' ? b.type : null;
  const label = cleanText(b.label, MAX_LABEL);
  if (!type || !label) return null;
  const id = (v: unknown, max = 40) => cleanText(v, max) || undefined;
  const odds = num(b.bookOdds);
  const ml = num(b.mlPct);
  return {
    type, label,
    gameId: id(b.gameId), optId: id(b.optId, 60), propType: id(b.propType, 60),
    line: num(b.line), selection: id(b.selection, 40),
    isHome: typeof b.isHome === 'boolean' ? b.isHome : undefined,
    subjectId: id(b.subjectId), opponentId: id(b.opponentId),
    mlPct: ml != null && ml >= 0 && ml <= 100 ? ml : null,
    bookOdds: odds != null && odds > 1 && odds < 1000 ? odds : null,
    extraFacts: Array.isArray(b.extraFacts)
      ? b.extraFacts.map(l => cleanText(l, MAX_FACT_LINE_CHARS)).filter(Boolean).slice(0, MAX_FACT_LINES)
      : undefined,
  };
}
