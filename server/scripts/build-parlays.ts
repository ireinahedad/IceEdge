/**
 * build-parlays.ts — les vidéos quotidiennes des combinés (MARKETING_PLAN Phase C)
 * ==============================================================================
 * Combinés GELÉS (`/api/content/parlays`) + bilan  →
 *   content/output/<date>-parlays-<mode>/posts.json (+ candidates.json)
 *
 * Usage :
 *   npm run content:parlays -- --mode=pick                 combinés de ce soir (jour NHL ET)
 *   npm run content:parlays -- --mode=result               résultat de la veille
 *   npm run content:parlays -- --mode=pick --date=2026-10-23
 *   npm run content:parlays -- --mode=result --allow-pending   sortir même si une jambe traîne
 *   npm run content:parlays -- --mode=pick --fixture=..\content\fixtures\parlays-2026-10-22.json
 *                                                          données inventées, aucun appel réseau
 *
 * Puis, sans rien coller nulle part :
 *   npm run content:render -- --date=<date>-parlays-<mode>
 *   npm run content:video  -- --date=<date>-parlays-<mode>
 *
 * Variables : `CONTENT_API_URL` (défaut https://api.arakice.com/api) ;
 * `CONTENT_CRON_SECRET`, facultatif — en mode `result`, demande d'abord au
 * serveur une passe de règlement (sinon on attend la passe horaire).
 *
 * CODES DE SORTIE. 0 = lot écrit ; 3 = PAS ENCORE PRÊT (rien de gelé pour ce
 * jour, ou combiné pas encore réglé) — le workflow réessaie plus tard ;
 * 1 = vraie erreur.
 *
 * AUCUN CHIFFRE CALCULÉ ICI. Les jambes, probabilités et résultats viennent
 * de `parlay_log` tels qu'ils ont été gelés et réglés par le serveur : la vidéo
 * montre exactement ce que l'API publique montre.
 */

import { promises as fs } from 'fs';
import path from 'path';
import {
  buildParlayPost, parlayComplianceProblems, type ParlayMode,
} from '../src/services/content/parlayPosts';
import type { LoggedParlay, ParlayRecord } from '../src/services/parlayLog.service';

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const OUTPUT_ROOT = path.join(REPO_ROOT, 'content', 'output');
const API = (process.env.CONTENT_API_URL ?? 'https://api.arakice.com/api').replace(/\/+$/, '');

const NOT_READY = 3;

function arg(name: string): string | null {
  const found = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
}
const flag = (name: string) => process.argv.slice(2).includes(`--${name}`);

/** Jour NHL (heure de l'Est), décalé de `n` jours. */
function etDay(n = 0): string {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

class NotReady extends Error {}

async function getJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} → HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
  return res.json();
}

interface Fixture { date: string; parlays: LoggedParlay[]; record: ParlayRecord | null }

async function load(mode: ParlayMode, date: string): Promise<{ parlays: LoggedParlay[]; record: ParlayRecord | null; source: string }> {
  const fixtureArg = arg('fixture');
  if (fixtureArg) {
    const fx: Fixture = JSON.parse(await fs.readFile(path.resolve(fixtureArg), 'utf8'));
    return { parlays: fx.parlays, record: fx.record, source: `build-parlays (fixture ${fixtureArg})` };
  }

  const secret = process.env.CONTENT_CRON_SECRET;
  if (mode === 'result' && secret) {
    try {
      const s = await getJson(`${API}/content/parlays/settle`, { method: 'POST', headers: { 'X-Cron-Secret': secret } });
      console.log(`  règlement : ${s.settled} réglé(s) sur ${s.checked}`);
    } catch (e: any) {
      console.log(`  ⚠ règlement non demandé (${e.message}) — on lit l'état actuel`);
    }
  }

  const { parlays } = await getJson(`${API}/content/parlays?date=${date}`);
  const record: ParlayRecord = await getJson(`${API}/content/parlays/record`);
  return { parlays, record, source: 'build-parlays' };
}

async function main() {
  const mode = (arg('mode') ?? '') as ParlayMode;
  if (mode !== 'pick' && mode !== 'result') throw new Error('--mode=pick ou --mode=result');
  const date = arg('date') ?? etDay(mode === 'pick' ? 0 : -1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date invalide : ${date}`);

  const outKey = `${date}-parlays-${mode}`;
  const dir = path.join(OUTPUT_ROOT, outKey);
  console.log(`\nbuild-parlays — ${mode === 'pick' ? 'combinés' : 'résultats'} du ${date}\n`);

  const { parlays, record, source } = await load(mode, date);
  if (source !== 'build-parlays') console.log(`  ⚠ DONNÉES INVENTÉES — ne pas publier ce lot.\n`);

  if (parlays.length === 0) throw new NotReady(`aucun combiné gelé pour ${date} (le gel n'a pas encore eu lieu ?)`);
  if (mode === 'result') {
    const pending = parlays.filter((p) => p.status === 'pending');
    if (pending.length && !flag('allow-pending')) {
      throw new NotReady(`${pending.length} combiné(s) pas encore réglé(s) pour ${date} — réessayer plus tard`);
    }
  }

  const post = buildParlayPost(mode, date, parlays, record);
  const problems = parlayComplianceProblems(post);
  if (problems.length) {
    throw new Error(`post refusé :\n    ${problems.join('\n    ')}\n  Corriger parlayPosts.ts avant de publier.`);
  }

  // `candidates.json` est lu par render-slides (type de graphique, sujet) : un
  // candidat minimal suffit, le sujet est porté par le post lui-même.
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'candidates.json'), JSON.stringify({
    date: outKey, source,
    candidates: [{
      id: post.candidate_id, rule: 'parlays', family: 'parlays', template: `parlays_${mode}`,
      entity: { type: 'games', name: `NHL ${date}`, team: null },
      facts: { date, parlays: parlays.length, record }, chart: { kind: null, file: null },
    }],
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(dir, 'posts.json'), JSON.stringify({
    date: outKey, retrospective: false, generated_by: source, posts: [post],
  }, null, 2), 'utf8');

  const seconds = Math.round(post.slides.reduce((a: number, s: any) => a + s.duration, 0) * 10) / 10;
  console.log(`  ${post.candidate_id} — ${post.slides.length} plans · ${seconds} s`);
  console.log(`  YouTube : ${post.youtube_title}`);
  console.log(`\n  Écrit dans content/output/${outKey}/`);
  console.log(`\n  Suite :`);
  console.log(`    npm run content:render -- --date=${outKey}`);
  console.log(`    npm run content:video  -- --date=${outKey}\n`);
}

main().catch((e) => {
  console.error(`\n${e.message}\n`);
  process.exit(e instanceof NotReady ? NOT_READY : 1);
});
