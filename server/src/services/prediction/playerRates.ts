/**
 * prediction/playerRates.ts — cadences des paris JOUEUR pour le mode ML de la
 * page d'un match (et d'une équipe), calculées ici, sans appel au service
 * Python.
 *
 * ── Pourquoi pas le service Python ──────────────────────────────────────────
 *
 * `/predict/player` (ml_service.py) n'est pas un modèle entraîné : c'est une
 * Poisson sur la moyenne de saison, bornée à [5 %, 95 %]. La page en tirait
 * une requête PAR CASE (≈ 120 par équipe affichée), chacune faisant l'aller-
 * retour client → Node → Python pour un calcul que le client savait déjà faire
 * — et le plancher à 5 % donnait le même chiffre à Demidov et à Danault sur
 * « 2+ buts ». Ici : UNE requête par page, zéro calcul Python.
 *
 * ── Ce que « ML » ajoute aux règles ─────────────────────────────────────────
 *
 * Les règles de la grille sont la moyenne de saison brute en Poisson. Ce
 * module produit une CADENCE par joueur et par statistique qui corrige les
 * trois défauts connus de cette moyenne :
 *
 *   1. Petits échantillons — rétrécissement bayésien vers une moyenne de
 *      position : λ = (total + m·a priori) / (matchs + m). Un joueur à 0 point
 *      en 60 matchs reste très bas ; à 0 en 4 matchs, on ne sait pas encore.
 *   2. Adversaire — buts/passes/points selon les buts qu'il concède, tirs
 *      selon les tirs qu'il concède, arrêts et tirs bloqués selon les tirs
 *      qu'il génère. Bornés à ±15 %.
 *   3. Dispersion — les comptes par match d'un joueur sont plus dispersés
 *      qu'une Poisson (temps de glace variable). Binomiale négative avec un
 *      `k` par statistique, fixé à la main (`DISPERSION`).
 *
 * Les seuils (1+, 2+, 3+, 4+…) se déduisent de la cadence côté client : une
 * cadence sert toutes les colonnes d'une ligne.
 */

import { fetchGameById, fetchTeamByAbbr, fetchTeamRoster, fetchTeamSummaryStats } from '../nhlApiClient';

export type RateStat = 'goals' | 'assists' | 'points' | 'shots' | 'hits' | 'blocks' | 'saves';

const LEAGUE_GPG = 3.05;
const LEAGUE_SOG = 30;

/**
 * Dispersion `k` de la binomiale négative, par statistique (Var = μ + μ²/k).
 * Réglée à la main sur les ordres de grandeur NHL : les mises en échec et les
 * tirs bloqués sont très dispersés (un match à 0, un match à 6), les arrêts
 * presque Poisson autour de ~27. `null` = Poisson.
 */
export const DISPERSION: Record<RateStat, number | null> = {
  goals:   3,
  assists: 3,
  points:  3,
  shots:   6,
  hits:    2.5,
  blocks:  2.5,
  saves:   25,
};

/**
 * A priori par match — un peu SOUS la moyenne d'un régulier (× 0,75 déjà
 * appliqué) : un joueur à petit échantillon est le plus souvent un joueur de
 * profondeur. `m` = nombre de matchs « fictifs » que pèse cet a priori.
 */
const PRIOR: Record<'F' | 'D' | 'G', Partial<Record<RateStat, number>>> = {
  F: { goals: 0.16, assists: 0.22, points: 0.38, shots: 1.5, hits: 1.1, blocks: 0.45 },
  D: { goals: 0.05, assists: 0.20, points: 0.25, shots: 1.2, hits: 1.1, blocks: 1.05 },
  G: { saves: 24 },
};
const PSEUDO_GAMES: Record<RateStat, number> = {
  goals: 12, assists: 12, points: 12, shots: 6, hits: 6, blocks: 6, saves: 4,
};

export interface PlayerRateRow {
  team:     string;
  position: 'F' | 'D' | 'G';
  gp:       number;
  /** Cadence ajustée par match, par statistique pertinente pour le poste. */
  rates:    Partial<Record<RateStat, number>>;
  /** P(ouvre le score), 0–1. */
  firstGoal?: number;
  /** Buts attendus dans le match (les deux équipes) — base du premier buteur. */
  gameGoals?: number;
}

export interface PlayerRatesResponse {
  gameId?:    string;
  dispersion: Record<RateStat, number | null>;
  players:    Record<string, PlayerRateRow>;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

function posOf(code: string | undefined): 'F' | 'D' | 'G' {
  const c = (code ?? 'F').toUpperCase();
  return c === 'G' ? 'G' : c === 'D' ? 'D' : 'F';
}

interface TeamCtx { abbr: string; gf: number; ga: number; sf: number; sa: number }

async function teamCtx(abbr: string, summary: Record<string, { shotsForPg: number; shotsAgainstPg: number }>): Promise<TeamCtx> {
  let t: any = null;
  try { t = await fetchTeamByAbbr(abbr); } catch { /* neutre */ }
  const s = summary[abbr.toUpperCase()];
  return {
    abbr: abbr.toUpperCase(),
    gf: t?.goalsForPerGame     ?? LEAGUE_GPG,
    ga: t?.goalsAgainstPerGame ?? LEAGUE_GPG,
    sf: s?.shotsForPg     ?? LEAGUE_SOG,
    sa: s?.shotsAgainstPg ?? LEAGUE_SOG,
  };
}

/** Multiplicateur d'adversaire par statistique. Neutre sans adversaire. */
function oppFactor(stat: RateStat, opp: TeamCtx | null): number {
  if (!opp) return 1;
  switch (stat) {
    case 'goals': case 'assists': case 'points':
      return clamp(opp.ga / LEAGUE_GPG, 0.85, 1.15);
    case 'shots':
      return clamp(opp.sa / LEAGUE_SOG, 0.9, 1.1);
    case 'blocks': case 'saves':
      return clamp(opp.sf / LEAGUE_SOG, 0.85, 1.15);
    default:
      return 1;
  }
}

function seasonTotal(p: any, stat: RateStat): number | null {
  switch (stat) {
    case 'saves': {
      const sa = p.shotsAgainst, ga = p.goalsAgainst;
      return sa == null || ga == null ? null : Math.max(0, sa - ga);
    }
    case 'blocks': return typeof p.blockedShots === 'number' ? p.blockedShots : null;
    case 'hits':   return typeof p.hits === 'number' ? p.hits : null;
    default:       return typeof p[stat] === 'number' ? p[stat] : null;
  }
}

function rowsFor(roster: any[], team: TeamCtx, opp: TeamCtx | null): Record<string, PlayerRateRow> {
  // Cadence de buts de l'ÉQUIPE et de l'adversaire pour CE match — sert au
  // premier buteur. Même forme que `nhlPredictions.ts` (attaque × défense).
  const lamTeam = opp ? clamp(team.gf * opp.ga / LEAGUE_GPG, 1.5, 5) : team.gf;
  const lamOpp  = opp ? clamp(opp.gf * team.ga / LEAGUE_GPG, 1.5, 5) : LEAGUE_GPG;
  const lamGame = lamTeam + lamOpp;
  const anyGoal = 1 - Math.exp(-lamGame);

  const out: Record<string, PlayerRateRow> = {};
  for (const p of roster) {
    const position = posOf(p.position);
    const gp = Math.max(0, Number(p.gamesPlayed) || 0);
    const stats: RateStat[] = position === 'G'
      ? ['saves']
      : ['goals', 'assists', 'points', 'shots', 'hits', 'blocks'];
    const rates: Partial<Record<RateStat, number>> = {};
    for (const stat of stats) {
      const total = seasonTotal(p, stat);
      const prior = PRIOR[position][stat];
      if (prior == null) continue;
      // Statistique absente de l'amont (tirs bloqués non publiés…) : pas de
      // cadence, la case restera « — » plutôt que de montrer l'a priori seul.
      if (total == null) continue;
      const m = PSEUDO_GAMES[stat];
      const shrunk = (total + m * prior) / (gp + m);
      rates[stat] = round4(shrunk * oppFactor(stat, opp));
    }
    const row: PlayerRateRow = { team: team.abbr, position, gp, rates };
    // P(ouvre le score) = part du joueur dans les buts du match × P(il y a un
    // but). Remplace, en mode ML, la case « 1er » qui demandait « 1+ but ».
    if (position !== 'G' && rates.goals != null && lamGame > 0) {
      row.firstGoal = round4((rates.goals / lamGame) * anyGoal);
      row.gameGoals = round4(lamGame);
    }
    out[String(p.id)] = row;
  }
  return out;
}

/** Cadences des deux alignements d'un match, ajustées à l'adversaire. */
export async function playerRatesForGame(gameId: string): Promise<PlayerRatesResponse> {
  const game = await fetchGameById(gameId);
  const home = String(game?.homeTeam?.abbreviation ?? '').toUpperCase();
  const away = String(game?.awayTeam?.abbreviation ?? '').toUpperCase();
  if (!home || !away) throw Object.assign(new Error('Game not found'), { status: 404 });

  const [summary, homeRoster, awayRoster] = await Promise.all([
    fetchTeamSummaryStats().catch(() => ({} as Record<string, any>)),
    fetchTeamRoster(home).catch(() => []),
    fetchTeamRoster(away).catch(() => []),
  ]);
  const [hCtx, aCtx] = await Promise.all([teamCtx(home, summary), teamCtx(away, summary)]);

  return {
    gameId,
    dispersion: DISPERSION,
    players: { ...rowsFor(homeRoster, hCtx, aCtx), ...rowsFor(awayRoster, aCtx, hCtx) },
  };
}

/** Cadences d'un seul club, sans adversaire (page équipe sans match choisi). */
export async function playerRatesForTeam(abbr: string): Promise<PlayerRatesResponse> {
  const upper = abbr.toUpperCase();
  const [summary, roster] = await Promise.all([
    fetchTeamSummaryStats().catch(() => ({} as Record<string, any>)),
    fetchTeamRoster(upper).catch(() => []),
  ]);
  const ctx = await teamCtx(upper, summary);
  return { dispersion: DISPERSION, players: rowsFor(roster, ctx, null) };
}
