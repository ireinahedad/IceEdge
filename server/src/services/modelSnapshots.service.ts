/**
 * modelSnapshots.service.ts — le bilan public du modèle (X402_PLAN.md, phase 1).
 * Logique pure dans `modelSnapshots.ts`, table dans la migration 053.
 *
 * Trois écritures, aucune nouvelle minuterie :
 *   • `snapshotPregame`  — à chaque tour de NewsSync (15 min dans la fenêtre des
 *     matchs) : TOUS les matchs qui commencent dans l'heure, sans exiger de vote.
 *   • `freezeMorning`    — appelé par GitHub Actions à 15:00 UTC
 *     (`POST /api/content/snapshots/morning`) : tous les matchs du jour pas encore
 *     commencés. Écrit une fois : un second appel rend les mêmes chiffres.
 *   • `settlePendingSnapshots` — dans la passe de rattrapage horaire du règlement.
 *
 * ── Coût (Neon facturé au compute) ──────────────────────────────────────────
 * • Avant-match : 1 calendrier (cache LNH 5 min), puis, seulement s'il y a des
 *   matchs dans l'heure, 1 UPSERT par match. Le paquet ML est en cache 10 min :
 *   aucun calcul Python de plus que ce que le site déclenche déjà. Pendant les
 *   tours de NewsSync, Neon est de toute façon réveillé.
 * • Matin : 1 réveil par jour (15:00 UTC, sur la grille), ~15 INSERT + 1 SELECT.
 * • Règlement : 1 SELECT par passe horaire ; 1 UPDATE par match fini.
 *
 * Ne lève jamais côté jobs (`snapshotPregame`, `settlePendingSnapshots`) : un
 * modèle indisponible = pas de ligne, le bilan compte alors un match manquant.
 */

import { pool } from '../db/connection';
import { logger } from '../logger';
import { mapLimit } from './concurrency';
import { fetchGameById, fetchGamesByDate } from './nhlApiClient';
import {
  snapshotProbs, toScheduleGame, morningExclusion, inPregameWindow, finalOutcome, rowToPublic,
  GAME_ID_RE, COMMIT_RE,
  type ScheduleGame, type SnapshotKind, type PublicSnapshot,
} from './modelSnapshots';

/** Jour NHL (heure de l'Est), AAAA-MM-JJ. */
export function etDate(now = Date.now(), plusDays = 0): string {
  const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + plusDays);
  return d.toISOString().slice(0, 10);
}

async function scheduleFor(date: string): Promise<ScheduleGame[]> {
  const raw = await fetchGamesByDate(date);
  return raw.map(toScheduleGame).filter((g): g is ScheduleGame => g !== null);
}

type MlModule = typeof import('./gameMlBundle');
/**
 * Import paresseux, une fois par tour : le paquet ML tire tout le client NHL et
 * le service Python, inutile pour un tour sans match dans la fenêtre.
 */
const loadMl = (): Promise<MlModule> => import('./gameMlBundle');

/** Les deux gardiens viennent de la saisie du jour (sinon : titulaire habituel supposé). */
async function goaliesConfirmed(ml: MlModule, gameId: string): Promise<boolean> {
  try {
    const f = await ml.getGameFeatures(gameId);
    return Boolean(f.home_goalie && f.away_goalie);
  } catch {
    return false;
  }
}

/**
 * Fige UN match. `morning` : écrit une fois (DO NOTHING). `pregame` : remplace
 * la capture précédente tant que le match n'est ni commencé ni réglé, et
 * seulement si un chiffre a bougé (sinon `recorded_at` garde l'heure où ces
 * chiffres sont apparus). Rend `true` si une ligne existe après l'appel.
 */
async function snapshotGame(ml: MlModule, g: ScheduleGame, kind: SnapshotKind): Promise<boolean> {
  const bundle = await ml.getGameMlBundle(g.id);
  const probs = snapshotProbs(bundle, ml.mlBundleKey);
  if (!probs) return false;
  // Revérifié APRÈS le calcul, qui peut prendre plusieurs secondes à froid.
  if (Date.now() >= g.startMs) return false;
  const confirmed = await goaliesConfirmed(ml, g.id);

  const params = [
    g.id, kind, g.home, g.away, new Date(g.startMs).toISOString(),
    probs.homeWin, probs.homeMinus, probs.awayMinus, confirmed, probs.modelVersion,
  ];
  const insert = `INSERT INTO model_snapshots
      (game_id, kind, home_team, away_team, start_time, home_win, home_minus, away_minus,
       goalies_confirmed, model_version, recorded_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`;
  if (kind === 'morning') {
    await pool.query(`${insert} ON CONFLICT (game_id, kind) DO NOTHING`, params);
  } else {
    await pool.query(
      `${insert}
       ON CONFLICT (game_id, kind) DO UPDATE SET
         home_team = EXCLUDED.home_team, away_team = EXCLUDED.away_team,
         start_time = EXCLUDED.start_time, home_win = EXCLUDED.home_win,
         home_minus = EXCLUDED.home_minus, away_minus = EXCLUDED.away_minus,
         goalies_confirmed = EXCLUDED.goalies_confirmed, model_version = EXCLUDED.model_version,
         recorded_at = NOW()
       WHERE model_snapshots.outcome IS NULL
         AND model_snapshots.start_time > NOW()
         AND EXCLUDED.start_time > NOW()
         AND (model_snapshots.home_win, model_snapshots.home_minus, model_snapshots.away_minus,
              model_snapshots.goalies_confirmed, model_snapshots.start_time, model_snapshots.model_version)
             IS DISTINCT FROM
             (EXCLUDED.home_win, EXCLUDED.home_minus, EXCLUDED.away_minus,
              EXCLUDED.goalies_confirmed, EXCLUDED.start_time, EXCLUDED.model_version)`,
      params,
    );
  }
  return true;
}

// ── Avant-match : à chaque tour de NewsSync ─────────────────────────────────

/**
 * Fige `pregame` pour tous les matchs qui commencent dans l'heure (et quart).
 * Le dernier tour avant la mise au jeu gagne. Rend le nombre de matchs figés.
 * Ne lève jamais.
 */
export async function snapshotPregame(now = Date.now()): Promise<number> {
  try {
    // Jour ET : la dernière mise au jeu NHL tombe avant 23 h ET, donc un match
    // dans l'heure appartient toujours au jour ET courant.
    const games = (await scheduleFor(etDate(now))).filter((g) => inPregameWindow(g, now));
    if (games.length === 0) return 0;
    const ml = await loadMl();
    const done = await mapLimit(games, 2, async (g) => {
      try {
        return await snapshotGame(ml, g, 'pregame');
      } catch (err: any) {
        logger.warn({ err: err?.message, gameId: g.id }, '[Snapshots] avant-match non figé');
        return false;
      }
    });
    return done.filter(Boolean).length;
  } catch (err: any) {
    logger.warn({ err: err?.message }, '[Snapshots] tour d\'avant-match échoué');
    return 0;
  }
}

// ── Matin : appelé par GitHub Actions ───────────────────────────────────────

export interface MorningFreeze {
  date: string;
  /** Heure de la réponse ; chaque ligne porte aussi son propre `recordedAt`. */
  servedAt: string;
  games: PublicSnapshot[];
  /** Matchs du jour absents de `games`, avec la raison. */
  excluded: Array<{ gameId: string; home: string; away: string; reason: string }>;
}

/**
 * Fige `morning` pour tous les matchs du jour `date` pas encore commencés, puis
 * rend TOUTES les lignes `morning` de ce jour (y compris celles d'un passage
 * précédent : mêmes chiffres, même `recordedAt`). Lève si le calendrier est
 * illisible — le workflow réessaiera.
 */
export async function freezeMorning(date: string, now = Date.now()): Promise<MorningFreeze> {
  const schedule = await scheduleFor(date);
  const excluded: MorningFreeze['excluded'] = [];
  const ids = schedule.map((g) => g.id);

  const existing = ids.length
    ? new Set<string>((await pool.query(
        `SELECT game_id FROM model_snapshots WHERE kind = 'morning' AND game_id = ANY($1::text[])`, [ids],
      )).rows.map((r: any) => String(r.game_id)))
    : new Set<string>();

  const todo = schedule.filter((g) => {
    if (existing.has(g.id)) return false;
    const why = morningExclusion(g, now);
    if (why) excluded.push({ gameId: g.id, home: g.home, away: g.away, reason: why });
    return why === null;
  });

  const ml = todo.length ? await loadMl() : null;
  await mapLimit(todo, 2, async (g) => {
    try {
      if (!(await snapshotGame(ml!, g, 'morning'))) {
        excluded.push({ gameId: g.id, home: g.home, away: g.away, reason: 'model_unavailable' });
      }
    } catch (err: any) {
      logger.warn({ err: err?.message, gameId: g.id }, '[Snapshots] gel du matin raté');
      excluded.push({ gameId: g.id, home: g.home, away: g.away, reason: 'model_unavailable' });
    }
  });

  const { rows } = ids.length
    ? await pool.query(
        `SELECT * FROM model_snapshots WHERE kind = 'morning' AND game_id = ANY($1::text[]) ORDER BY start_time, game_id`,
        [ids],
      )
    : { rows: [] as any[] };
  return { date, servedAt: new Date(now).toISOString(), games: rows.map(rowToPublic), excluded };
}

/**
 * Pose le commit public sur les lignes `morning` qu'il porte. Seulement pour un
 * match pas encore commencé au moment de l'appel (le workflow appelle APRÈS le
 * push) et une ligne sans preuve. Rend le nombre de lignes marquées.
 */
export async function markMorningPublished(gameIds: string[], commit: string): Promise<number> {
  const ids = [...new Set(gameIds)].filter((id) => GAME_ID_RE.test(id));
  if (!COMMIT_RE.test(commit)) throw Object.assign(new Error('commit must be a 40-character SHA'), { status: 400 });
  if (ids.length === 0) return 0;
  const { rowCount } = await pool.query(
    `UPDATE model_snapshots SET proof_commit = $2
      WHERE kind = 'morning' AND game_id = ANY($1::text[])
        AND proof_commit IS NULL AND outcome IS NULL AND start_time > NOW()`,
    [ids, commit],
  );
  return rowCount ?? 0;
}

// ── Règlement : passe de rattrapage horaire ─────────────────────────────────

/** Un match n'est pas réglable avant ~2 h 30 après la mise au jeu prévue. */
const SETTLE_AFTER_MS = 2.5 * 60 * 60_000;
/** Au-delà de 14 jours sans résultat (reporté, annulé), on cesse de le redemander. */
const SETTLE_GIVE_UP_MS = 14 * 24 * 60 * 60_000;
const SETTLE_BATCH = 40;

/**
 * Règle les lignes des matchs finis (les deux gels d'un coup). Idempotent : ne
 * touche que `outcome IS NULL`, et la base refuse toute modification d'une
 * ligne réglée. Ne lève jamais.
 */
export async function settlePendingSnapshots(now = Date.now()): Promise<{ games: number; rows: number }> {
  let games = 0, rows = 0;
  try {
    const { rows: pending } = await pool.query(
      `SELECT game_id, MIN(start_time) AS s FROM model_snapshots
        WHERE outcome IS NULL AND start_time < $1 AND start_time > $2
        GROUP BY game_id ORDER BY s LIMIT ${SETTLE_BATCH}`,
      [new Date(now - SETTLE_AFTER_MS).toISOString(), new Date(now - SETTLE_GIVE_UP_MS).toISOString()],
    );
    for (const r of pending) {
      const gameId = String(r.game_id);
      let g: any;
      try { g = await fetchGameById(gameId); } catch { continue; }
      const out = finalOutcome(g);
      if (!out) continue;
      const res = await pool.query(
        `UPDATE model_snapshots
            SET home_score = $2, away_score = $3, outcome = $4, settled_at = NOW()
          WHERE game_id = $1 AND outcome IS NULL`,
        [gameId, out.homeScore, out.awayScore, out.outcome],
      );
      games++;
      rows += res.rowCount ?? 0;
    }
  } catch (err: any) {
    logger.warn({ err: err?.message }, '[Snapshots] règlement échoué');
  }
  return { games, rows };
}
