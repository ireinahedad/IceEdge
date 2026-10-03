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

import { fetchGameById, fetchPlayerById, fetchTeamByAbbr, fetchTeamRoster, fetchTeamSummaryStats } from '../nhlApiClient';
import { getGameMlBundle, type GameMlBundle } from '../gameMlBundle';

export type RateStat = 'goals' | 'assists' | 'points' | 'shots' | 'hits' | 'blocks' | 'saves' | 'pim' | 'ppPoints';

const LEAGUE_GPG = 3.05;
const LEAGUE_SOG = 30;

/**
 * Dispersion `k` de la binomiale négative de la RÈGLE, par statistique
 * (Var = μ + μ²/k). `null` = Poisson.
 *
 * Ajustée par vraisemblance sur 2022-23 pour cette règle précise
 * (`train_player.py`, `k_rules` dans `player_report.json`). Les premières
 * valeurs, posées à la main (3 pour les buts, 2.5 pour les mises en échec),
 * étaient bien trop dispersées : elles gonflaient « 2+ » et « 3+ ». Les arrêts
 * restent à 25 : le modèle joueur ne couvre pas les gardiens.
 */
export const DISPERSION: Record<RateStat, number | null> = {
  goals:    40,
  assists:  20,
  points:   40,
  shots:    12,
  hits:     6,
  blocks:   8,
  saves:    25,
  pim:      0.3,
  ppPoints: null,
};

/**
 * A priori par match — un peu SOUS la moyenne d'un régulier (× 0,75 déjà
 * appliqué) : un joueur à petit échantillon est le plus souvent un joueur de
 * profondeur. `m` = nombre de matchs « fictifs » que pèse cet a priori.
 */
const PRIOR: Record<'F' | 'D' | 'G', Partial<Record<RateStat, number>>> = {
  F: { goals: 0.16, assists: 0.22, points: 0.38, shots: 1.5, hits: 1.1, blocks: 0.45, pim: 0.40, ppPoints: 0.08 },
  D: { goals: 0.05, assists: 0.20, points: 0.25, shots: 1.2, hits: 1.1, blocks: 1.05, pim: 0.45, ppPoints: 0.06 },
  G: { saves: 24 },
};
const PSEUDO_GAMES: Record<RateStat, number> = {
  goals: 12, assists: 12, points: 12, shots: 6, hits: 6, blocks: 6, saves: 4, pim: 8, ppPoints: 12,
};

export interface PlayerRateRow {
  /**
   * `model` = cadences du modèle joueur (`train_player.py`), lues avec
   * `modelDispersion` ; `rules` = la règle ci-dessous, lue avec `dispersion`.
   */
  source?:  'model' | 'rules';
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
  /** k du modèle joueur (lignes `source: 'model'`). */
  modelDispersion?: Record<string, number | null>;
  /** Date des dernières données du modèle joueur. */
  modelAsOf?: string | null;
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
    case 'goals': case 'assists': case 'points': case 'ppPoints':
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
    // Absents de l'effectif d'équipe, présents sur la fiche d'un joueur
    // (`fetchPlayerById`) : seule la page joueur en a une cadence.
    case 'pim':    return typeof p.penaltyMinutes === 'number' ? p.penaltyMinutes : null;
    case 'ppPoints': return typeof p.ppPoints === 'number' ? p.ppPoints : null;
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
      : ['goals', 'assists', 'points', 'shots', 'hits', 'blocks', 'pim', 'ppPoints'];
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

/**
 * Remplace, joueur par joueur, les cadences de la règle par celles du MODÈLE
 * JOUEUR quand le paquet ML du match en porte (`gameMlBundle.ts`).
 *
 * Aucun appel de plus : le paquet est celui que la page match charge déjà, mis
 * en cache 10 min par match. Les arrêts restent à la règle (le modèle ne couvre
 * pas les gardiens), et un joueur inconnu du modèle — une recrue — aussi.
 * Le premier buteur suit la cadence de buts du modèle.
 */
function applyPlayerModel(
  players: Record<string, PlayerRateRow>, bundle: GameMlBundle | null,
): Pick<PlayerRatesResponse, 'modelDispersion' | 'modelAsOf'> {
  const model = bundle?.playerRates ?? {};
  // Buts attendus du match selon le MODÈLE DE SCORE (λ domicile + visiteur,
  // recalés sur la victoire servie). Le premier buteur divisait jusqu'ici la
  // cadence du modèle joueur par les buts de match de la RÈGLE (buts pour ×
  // buts contre des fiches d'équipe) : numérateur et dénominateur venaient de
  // deux modèles (ml/INCOHERENCES_ML.md §13). Quand le paquet les porte, ces
  // λ servent à TOUS les joueurs du match — modèle ou règle — pour que les
  // probabilités de premier buteur soient sur la même échelle.
  const lh = bundle?.lambdaHome, la = bundle?.lambdaAway;
  const modelGameGoals = lh != null && la != null && Number.isFinite(lh + la) && lh + la > 0
    ? lh + la : null;
  for (const [id, row] of Object.entries(players)) {
    const m = model[id];
    if (!m || row.position === 'G') {
      row.source = 'rules';
    } else {
      for (const [stat, v] of Object.entries(m)) {
        if (stat in row.rates || stat in PSEUDO_GAMES) (row.rates as Record<string, number>)[stat] = round4(v);
      }
      row.source = 'model';
    }
    if (modelGameGoals != null && row.gameGoals != null) row.gameGoals = round4(modelGameGoals);
    if (row.gameGoals && row.rates.goals != null) {
      row.firstGoal = round4((row.rates.goals / row.gameGoals) * (1 - Math.exp(-row.gameGoals)));
    }
  }
  return Object.keys(model).length
    ? { modelDispersion: bundle!.playerDispersion, modelAsOf: bundle!.playerModelAsOf }
    : {};
}

/** Paquet ML du match, ou `null` s'il est indisponible (service ML en panne…). */
function bundleOrNull(gameId: string): Promise<GameMlBundle | null> {
  return getGameMlBundle(gameId).catch(() => null);
}

/** Cadences des deux alignements d'un match, ajustées à l'adversaire. */
export async function playerRatesForGame(gameId: string): Promise<PlayerRatesResponse> {
  const game = await fetchGameById(gameId);
  const home = String(game?.homeTeam?.abbreviation ?? '').toUpperCase();
  const away = String(game?.awayTeam?.abbreviation ?? '').toUpperCase();
  if (!home || !away) throw Object.assign(new Error('Game not found'), { status: 404 });

  const [summary, homeRoster, awayRoster, bundle] = await Promise.all([
    fetchTeamSummaryStats().catch(() => ({} as Record<string, any>)),
    fetchTeamRoster(home).catch(() => []),
    fetchTeamRoster(away).catch(() => []),
    bundleOrNull(gameId),
  ]);
  const [hCtx, aCtx] = await Promise.all([teamCtx(home, summary), teamCtx(away, summary)]);

  const players = { ...rowsFor(homeRoster, hCtx, aCtx), ...rowsFor(awayRoster, aCtx, hCtx) };
  return { gameId, dispersion: DISPERSION, ...applyPlayerModel(players, bundle), players };
}

/** Cadences d'un seul club, sans adversaire (page équipe sans match choisi). */
export async function playerRatesForTeam(abbr: string): Promise<PlayerRatesResponse> {
  const upper = abbr.toUpperCase();
  const [summary, roster] = await Promise.all([
    fetchTeamSummaryStats().catch(() => ({} as Record<string, any>)),
    fetchTeamRoster(upper).catch(() => []),
  ]);
  const ctx = await teamCtx(upper, summary);
  const players = rowsFor(roster, ctx, null);
  for (const row of Object.values(players)) row.source = 'rules';
  return { dispersion: DISPERSION, players };
}

/**
 * Cadences d'UN joueur — la page joueur. Sa fiche (`fetchPlayerById`) porte
 * aussi les minutes de pénalité et les points en avantage numérique, absents
 * de l'effectif d'équipe. Avec `gameId`, ajustées à l'adversaire de ce match.
 */
export async function playerRatesForPlayer(playerId: string, gameId?: string): Promise<PlayerRatesResponse> {
  const player = await fetchPlayerById(playerId);
  const team = String(player?.teamAbbr ?? '').toUpperCase();
  const summary = await fetchTeamSummaryStats().catch(() => ({} as Record<string, any>));
  const ctx = await teamCtx(team || 'UNK', summary);

  let opp: TeamCtx | null = null;
  if (gameId) {
    const game = await fetchGameById(gameId).catch(() => null);
    const home = String(game?.homeTeam?.abbreviation ?? '').toUpperCase();
    const away = String(game?.awayTeam?.abbreviation ?? '').toUpperCase();
    // L'adversaire n'est retenu que si le joueur est bien dans ce match : un
    // identifiant de match qui ne le concerne pas ne doit rien ajuster.
    const oppAbbr = team === home ? away : team === away ? home : '';
    if (oppAbbr) opp = await teamCtx(oppAbbr, summary);
  }
  const players = rowsFor([{ ...player, id: String(player?.id ?? playerId) }], ctx, opp);
  // Match connu et joueur dans ce match : le modèle joueur, via le paquet ML
  // du match (déjà en cache si la page du match a été ouverte).
  const bundle = gameId && opp ? await bundleOrNull(gameId) : null;
  return {
    ...(gameId && opp ? { gameId } : {}),
    dispersion: DISPERSION,
    ...applyPlayerModel(players, bundle),
    players,
  };
}
