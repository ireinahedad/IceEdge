/**
 * newsRoster.service.ts — F4 (NEWS_CONSENSUS_PLAN.md, étape 3) : les
 * transactions du jour, déduites des effectifs LNH, rangées dans `news_items`.
 *
 * Appelé par chaque tour de `newsSync.service.ts` (déjà sous le verrou
 * `news-sync`) ; ne travaille qu'au PREMIER tour après midi (ET).
 * La logique pure (lecture, comparaison, extraits) vit dans `newsRoster.ts`.
 *
 * ── Coût (Neon facturé au compute) ──────────────────────────────────────────
 * • Hors échéance : rien en base (le jour fait est gardé en mémoire).
 * • 1er tour après midi, après un redémarrage : 1 SELECT du marqueur.
 * • Le tour du jour : 32 appels LNH, 1 SELECT des 32 veilles, puis UNE
 *   transaction : 1 INSERT des nouvelles (s'il y en a) + 1 upsert des états.
 *
 * ── Si l'écriture échoue ────────────────────────────────────────────────────
 * (ex. migration 048 pas encore appliquée : le CHECK de `source` refuse
 * 'nhl_roster') la transaction est annulée, les veilles NE bougent PAS : le
 * tour du lendemain retrouve les mêmes écarts. Rien n'est perdu, et on ne
 * réessaie pas à chaque tour (32 appels LNH toutes les 15 min) — une fois par
 * jour et par instance.
 */

import { pool } from '../db/connection';
import { logger } from '../logger';
import { mapLimit } from './concurrency';
import { getJobState } from './jobLock';
import { fetchNHL, TEAM_META, USE_MOCK } from './nhl/core';
import {
  parseRoster, diffRosters, encodeRoster, decodeRoster, excerptFor, externalIdFor,
  playerUrl, stateKey, etParts, rosterDue, DAY_KEY, ROSTER_AUTHOR,
  type RosterPlayer, type RosterEvent,
} from './newsRoster';

const CONCURRENCY = 4;

export interface RosterRunResult {
  ran: boolean;
  teamsRead?: number;
  events?: number;
  inserted?: number;
  baseline?: number;
  rebased?: string[];
}

/** Jour (ET) déjà traité par CETTE instance. Évite toute lecture de base hors échéance. */
let doneDay: string | null = null;

/** Pour les tests. */
export function resetRosterMemory(): void { doneDay = null; }

async function readRosters(teams: string[]): Promise<Map<string, RosterPlayer[]>> {
  const out = new Map<string, RosterPlayer[]>();
  const res = await mapLimit(teams, CONCURRENCY, async (abbr) => {
    try {
      return [abbr, parseRoster(await fetchNHL<unknown>(`v1/roster/${abbr}/current`))] as const;
    } catch (err: any) {
      logger.warn({ err: err?.message, team: abbr }, '[NewsRoster] effectif illisible');
      return null;
    }
  });
  // Une équipe illisible ou vide n'est pas comparée : sa veille reste en place.
  for (const r of res) if (r && r[1].length > 0) out.set(r[0], r[1]);
  return out;
}

async function readPrevious(teams: string[]): Promise<Map<string, RosterPlayer[]>> {
  const { rows } = await pool.query(
    'SELECT key, value FROM job_state WHERE key = ANY($1::text[])',
    [teams.map(stateKey)],
  );
  const byKey = new Map<string, string | null>(rows.map((r: any) => [r.key, r.value]));
  const out = new Map<string, RosterPlayer[]>();
  for (const t of teams) {
    const p = decodeRoster(byKey.get(stateKey(t)));
    if (p) out.set(t, p);
  }
  return out;
}

/** Nouvelles + nouvelles veilles + marqueur du jour, tout ou rien. */
async function persist(events: RosterEvent[], cur: Map<string, RosterPlayer[]>, day: string, postedAt: Date): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let inserted = 0;
    if (events.length > 0) {
      const values: string[] = [];
      const params: unknown[] = [];
      events.forEach((e, i) => {
        const b = i * 5;
        values.push(`('nhl_roster', $${b + 1}, $${b + 2}::text[], $${b + 3}, $${b + 4}, $${b + 5}, ARRAY['transaction']::text[], $${events.length * 5 + 1})`);
        params.push(externalIdFor(e, day), e.teams, ROSTER_AUTHOR, playerUrl(e.player.id), excerptFor(e));
      });
      params.push(postedAt.toISOString());
      const r = await client.query(
        `INSERT INTO news_items (source, external_id, team_abbrs, author, url, excerpt, flags, posted_at)
         VALUES ${values.join(', ')}
         ON CONFLICT (source, external_id) DO NOTHING
         RETURNING id`,
        params,
      );
      inserted = r.rowCount ?? r.rows.length;
    }

    const keys: string[] = [DAY_KEY];
    const vals: string[] = [day];
    for (const [team, players] of cur) { keys.push(stateKey(team)); vals.push(encodeRoster(players)); }
    await client.query(
      `INSERT INTO job_state (key, value, updated_at)
       SELECT k, v, NOW() FROM unnest($1::text[], $2::text[]) AS t(k, v)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [keys, vals],
    );
    await client.query('COMMIT');
    return inserted;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Le tour quotidien, s'il est dû. Ne lève jamais vers le fil de nouvelles :
 * un effectif en panne ne doit pas empêcher les publications Bluesky.
 */
export async function runRosterDiffIfDue(now = Date.now()): Promise<RosterRunResult> {
  if (USE_MOCK) return { ran: false };
  if (!rosterDue(now, doneDay)) return { ran: false };
  const { day } = etParts(now);

  try {
    // Après un redémarrage ou sur une autre instance : le tour est peut-être déjà fait.
    if ((await getJobState(DAY_KEY)) === day) { doneDay = day; return { ran: false }; }
    // Marqué AVANT le travail : un échec ne relance pas 32 appels LNH à chaque tour.
    doneDay = day;

    const teams = Object.keys(TEAM_META).sort();
    const cur = await readRosters(teams);
    if (cur.size === 0) {
      logger.warn('[NewsRoster] aucun effectif lisible — tour sauté, veilles conservées');
      return { ran: true, teamsRead: 0, events: 0, inserted: 0 };
    }
    const prev = await readPrevious([...cur.keys()]);
    const diff = diffRosters(prev, cur);
    if (diff.rebased.length > 0) {
      logger.warn({ teams: diff.rebased }, '[NewsRoster] écart trop grand (bascule de saison ?) — rebasé sans nouvelle');
    }
    const inserted = await persist(diff.events, cur, day, new Date(now));
    return {
      ran: true, teamsRead: cur.size, events: diff.events.length, inserted,
      baseline: diff.baseline.length, rebased: diff.rebased,
    };
  } catch (err: any) {
    logger.warn({ err: err?.message }, '[NewsRoster] tour échoué — veilles conservées, reprise demain');
    return { ran: true, inserted: 0 };
  }
}
