/**
 * modelSnapshots.ts — logique PURE du bilan public (X402_PLAN.md, phase 1).
 * Les accès à la base et au paquet ML sont dans `modelSnapshots.service.ts`.
 */

import type { MLPredictionResult } from './mlApiClient';

export const GAME_ID_RE = /^\d{6,12}$/;
export const COMMIT_RE = /^[0-9a-f]{40}$/;
export type SnapshotKind = 'morning' | 'pregame';

/** Les trois chiffres figés, en fraction 0–1 (`null` = le modèle ne price pas ce marché). */
export interface SnapshotProbs {
  homeWin: number;
  homeMinus: number | null;
  awayMinus: number | null;
  modelVersion: string | null;
}

/**
 * Probabilité d'avant-match NON arrondie (0–1) d'un résultat du paquet ML.
 * `probability_exact` d'abord ; repli sur l'entier d'affichage (en %) pour un
 * service ML qui ne l'envoie pas. Un chiffre recalculé en direct n'est jamais
 * une probabilité d'avant-match : `null`.
 */
export function preMatchProb(r: MLPredictionResult | null | undefined): number | null {
  if (!r || r.live) return null;
  const exact = r.probability_exact;
  if (typeof exact === 'number' && Number.isFinite(exact)) return exact > 0 && exact < 1 ? exact : null;
  const p = r.probability;
  return typeof p === 'number' && Number.isFinite(p) && p > 0 && p < 100 ? p / 100 : null;
}

/** Arrondi à 5 décimales, la précision de la colonne NUMERIC(6,5). */
export const round5 = (p: number): number => Math.round(p * 1e5) / 1e5;

/**
 * Les chiffres à figer, lus dans `byKey` du paquet ML. `null` si le paquet est
 * en direct ou si la victoire manque : sans elle, pas de ligne.
 */
export function snapshotProbs(
  bundle: { live?: unknown; byKey: Record<string, MLPredictionResult | null> },
  key: (market: string, line: number | null, selection: string | null, subjectIsHome: boolean) => string,
): SnapshotProbs | null {
  if (bundle.live) return null;
  const ml = bundle.byKey[key('moneyline', null, null, true)];
  const homeWin = preMatchProb(ml);
  if (homeWin == null) return null;
  const minus = (isHome: boolean) => {
    const p = preMatchProb(bundle.byKey[key('puck_line', -1.5, null, isHome)]);
    return p == null ? null : round5(p);
  };
  return {
    homeWin: round5(homeWin),
    homeMinus: minus(true),
    awayMinus: minus(false),
    modelVersion: ml?.model_version ? String(ml.model_version).slice(0, 64) : null,
  };
}

/** Match du calendrier, réduit à ce qui sert ici. */
export interface ScheduleGame {
  id: string;
  home: string;
  away: string;
  startMs: number;
  status: string;
}

export function toScheduleGame(g: any): ScheduleGame | null {
  const id = String(g?.id ?? '');
  const home = String(g?.homeTeam?.abbreviation ?? '').toUpperCase();
  const away = String(g?.awayTeam?.abbreviation ?? '').toUpperCase();
  const startMs = g?.startTimeUTC ? Date.parse(g.startTimeUTC) : NaN;
  if (!GAME_ID_RE.test(id) || !home || !away || !Number.isFinite(startMs)) return null;
  return { id, home, away, startMs, status: String(g?.status ?? '') };
}

/**
 * Marge du gel du matin : un match qui commence dans moins de 10 min est exclu.
 * Le commit public suit le gel de quelques secondes à quelques minutes ; le
 * workflow revérifie de toute façon après le push (`predictions-publish.mjs`).
 */
export const MORNING_MARGIN_MS = 10 * 60_000;

/** Fenêtre du gel d'avant-match : la dernière heure (et quart) avant la mise au jeu. */
export const PREGAME_WINDOW_MS = 75 * 60_000;

/** Pourquoi un match n'est pas figé ce matin (`null` = à figer). */
export function morningExclusion(g: ScheduleGame, now: number): 'started' | 'starts_too_soon' | 'not_scheduled' | null {
  if (g.status === 'live' || g.status === 'final' || g.startMs <= now) return 'started';
  if (g.status !== 'scheduled') return 'not_scheduled';     // reporté, annulé…
  if (g.startMs - now < MORNING_MARGIN_MS) return 'starts_too_soon';
  return null;
}

/** À figer à ce tour d'avant-match : prévu, pas commencé, dans la fenêtre. */
export function inPregameWindow(g: ScheduleGame, now: number): boolean {
  return g.status === 'scheduled' && g.startMs > now && g.startMs - now <= PREGAME_WINDOW_MS;
}

/** Résultat d'un match fini (`null` = pas encore réglable). Scores finaux, tirs de barrage compris. */
export function finalOutcome(g: any): { homeScore: number; awayScore: number; outcome: 'home' | 'away' } | null {
  const hs = g?.homeTeam?.score, as = g?.awayTeam?.score;
  if (g?.status !== 'final' || typeof hs !== 'number' || typeof as !== 'number' || hs === as) return null;
  return { homeScore: hs, awayScore: as, outcome: hs > as ? 'home' : 'away' };
}

/** Une ligne figée telle que la rendent la route du matin et le fichier public. */
export interface PublicSnapshot {
  gameId: string;
  home: string;
  away: string;
  startTimeUTC: string;
  probabilities: { homeWin: number; homeMinus1_5: number | null; awayMinus1_5: number | null };
  goaliesConfirmed: boolean;
  modelVersion: string | null;
  recordedAt: string;
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));

export function rowToPublic(r: any): PublicSnapshot {
  return {
    gameId: String(r.game_id),
    home: r.home_team,
    away: r.away_team,
    startTimeUTC: new Date(r.start_time).toISOString(),
    probabilities: {
      homeWin: Number(r.home_win),
      homeMinus1_5: num(r.home_minus),
      awayMinus1_5: num(r.away_minus),
    },
    goaliesConfirmed: Boolean(r.goalies_confirmed),
    modelVersion: r.model_version ?? null,
    recordedAt: new Date(r.recorded_at).toISOString(),
  };
}
