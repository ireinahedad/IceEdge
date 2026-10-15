/**
 * playerModelPrediction.ts — le chiffre ML d'UN pari joueur demandé à l'unité
 * (`POST /api/predict/ml`, type `player`), lu sur le MODÈLE JOUEUR entraîné.
 *
 * ── Pourquoi (« Des buts attendus à tous les paris », piste 1) ──────────────
 *
 * Cette route passait par `/predict/player` du service Python : une Poisson
 * sur la moyenne de saison, bornée à [5 %, 95 %], qui n'utilise pas le modèle
 * XGBoost par statistique (`train_player.py`) — alors qu'il bat cette règle
 * sur les 8 stats (EXPLICATION_ML.md §4.4) et qu'il tourne déjà dans le paquet
 * du match. Les grilles et la page joueur lisaient le modèle
 * (`playerRates.ts`), mais la carte ML d'une fiche sans chiffre préchargé et
 * le repli d'« Ask LLM » recevaient la Poisson, sous la même étiquette « ML ».
 *
 * ── Comment ─────────────────────────────────────────────────────────────────
 *
 *   1. Le match : `gameId` s'il est fourni, sinon le prochain match de
 *      l'équipe du joueur (contre `opponentId` s'il est donné), sur 14 jours.
 *   2. La cadence : celle du paquet ML de ce match (`getGameMlBundle`, en
 *      cache 10 min et partagé avec la page du match) — aucun appel Python de
 *      plus quand la page a déjà été ouverte.
 *   3. La probabilité : la même binomiale négative (k du modèle) que les
 *      grilles (`ratePct` côté client, `probAtLeast` ici), même plafond à 97 :
 *      la fiche et la tuile disent le même chiffre.
 *
 * `null` = le modèle n'a pas de chiffre (gardien, recrue absente de l'état,
 * stat non couverte, aucun match à venir, service ML en panne, match en
 * cours) : la route retombe alors sur `/predict/player`, comme avant.
 */

import { fetchGamesRange, fetchPlayerById } from '../nhlApiClient';
import { getGameMlBundle } from '../gameMlBundle';
import type { MLPredictionResult } from '../mlApiClient';
import { probAtLeast } from './playerRates';

/** `propType` du client → statistique du modèle joueur (`player_report.json`). */
export const MODEL_STAT: Record<string, string> = {
  goals: 'goals', assists: 'assists', points: 'points', shots: 'shots',
  hits: 'hits', blocks: 'blocks', pim: 'pim', pp_point: 'ppPoints',
};

/** Fenêtre de recherche du prochain match — celle du sélecteur de la page joueur. */
const LOOKAHEAD_DAYS = 14;
/** Plafond d'affichage des grilles (`ratePct`, client) : même chiffre ici. */
const MAX_P = 0.97;

export interface PlayerModelQuery {
  playerId:    string;
  propType:    string;
  line:        number;
  selection:   string;
  gameId?:     string;
  opponentId?: string;
  isHome?:     boolean;
}

const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

/** Prochain match (non terminé) de `team`, contre `opp` si donné. */
async function nextGameId(team: string, opp?: string, isHome?: boolean): Promise<string | null> {
  // Veille UTC incluse : un match du soir (heure de l'Est) est déjà au
  // lendemain en UTC.
  const today = new Date().toISOString().slice(0, 10);
  const games = await fetchGamesRange(addDays(today, -1), addDays(today, LOOKAHEAD_DAYS));
  for (const g of games) {
    if (g?.status === 'final') continue;
    const h = String(g?.homeTeam?.abbreviation ?? '').toUpperCase();
    const a = String(g?.awayTeam?.abbreviation ?? '').toUpperCase();
    if (h !== team && a !== team) continue;
    const other = h === team ? a : h;
    if (opp && other !== opp) continue;
    if (isHome !== undefined && (h === team) !== isHome) continue;
    return String(g.id);
  }
  return null;
}

const fmt = (x: number, d = 2) => x.toFixed(d);

/** Probabilité du modèle joueur pour ce pari, ou `null` (→ repli Python). */
export async function predictPlayerFromModel(q: PlayerModelQuery): Promise<MLPredictionResult | null> {
  const stat = MODEL_STAT[q.propType];
  if (!stat || !(q.line >= 0)) return null;

  const player = await fetchPlayerById(q.playerId).catch(() => null);
  // Le modèle ne couvre pas les gardiens (arrêts, victoires, blanchissages).
  if (!player || String(player.position ?? '').toUpperCase() === 'G') return null;
  const team = String(player.teamAbbr ?? '').toUpperCase();

  const gameId = q.gameId
    ?? (team ? await nextGameId(team, q.opponentId?.toUpperCase() || undefined, q.isHome).catch(() => null) : null);
  if (!gameId) return null;

  const bundle = await getGameMlBundle(gameId).catch(() => null);
  // Match commencé : la cadence du paquet est d'avant-match ; le chiffre en
  // direct (déjà fait + reste à jouer) est celui des grilles, pas celui-ci.
  if (!bundle || bundle.live) return null;
  const rate = bundle.playerRates?.[String(q.playerId)]?.[stat];
  if (rate == null || !Number.isFinite(rate)) return null;

  const k = bundle.playerDispersion?.[stat] ?? null;
  const over = probAtLeast(rate, Math.floor(q.line) + 1, k);
  const under = q.selection === 'under';
  const p = Math.min(MAX_P, under ? 1 - over : over);
  const pct = Math.round(p * 100);

  // Confiance : même échelle que `/predict/player` (taille de l'échantillon).
  const gp = Math.max(0, Number(player.gamesPlayed) || 0);
  const confidence = Math.round(Math.max(0.42, Math.min(0.88, 0.40 + gp / 82 * 0.50)) * 100);
  const paceVsLine = (rate - q.line) / Math.max(q.line, 0.1);
  const label = q.propType.charAt(0).toUpperCase() + q.propType.slice(1);

  return {
    probability:       pct,
    probability_exact: Math.round(p * 1e6) / 1e6,
    confidence,
    feature_importances: [
      { name: `${label} rate/game (player model)`, importance: Math.round(rate * 1000) / 1000,
        direction: rate > q.line ? 'positive' : 'negative' },
      { name: 'Pace vs line', importance: Math.round(Math.abs(paceVsLine) * 1000) / 1000,
        direction: paceVsLine > 0 ? 'positive' : 'negative' },
      { name: 'Sample size (GP)', importance: Math.round(gp / 82 * 1000) / 1000, direction: 'positive' },
    ],
    model_version: `player-xgb${bundle.playerModelAsOf ? `@${bundle.playerModelAsOf}` : ''}`,
    model_type:    'Modèle joueur (XGBoost)',
    explanation:
      `Modèle joueur XGBoost (temps de glace, avantage numérique, xG des coéquipiers, ` +
      `production par 60 min, adversaire) : ${fmt(rate)} par match pour ce match ; ` +
      `${k == null ? 'loi de Poisson' : `binomiale négative k=${k}`} → ` +
      `${under ? 'moins de' : 'plus de'} ${q.line} à ${pct} %.`,
  };
}
