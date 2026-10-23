/**
 * parlays-daily.ts — la chaîne complète d'une vidéo de combinés (MARKETING_PLAN Phase D)
 * =====================================================================================
 * Lancé par `.github/workflows/content-parlays.yml` quand `parlays-due.mjs` a
 * répondu oui ; se lance aussi à la main pour rattraper un jour.
 *
 *   npx ts-node scripts/parlays-daily.ts --mode=pick   [--date=2026-10-23] [--dry-run]
 *   npx ts-node scripts/parlays-daily.ts --mode=result [--date=2026-10-22] [--dry-run]
 *
 *   1. (pick) GEL — POST /api/content/parlays/freeze. Irréversible : c'est ce
 *      qui entre au bilan. Jamais fait en --dry-run.
 *   2. VIDÉO — content:parlays → content:render → content:video, inchangés.
 *   3. YOUTUBE — Short, `PARLAYS_YOUTUBE_PRIVACY` (défaut « unlisted » : mode
 *      essai), puis drapeau `youtube_<mode>` posé AUSSITÔT.
 *   4. TIKTOK — mp4 sur R2 + courriel à NOTIFY_EMAIL, puis drapeau `tiktok_<mode>`.
 *
 * IDEMPOTENT. Chaque envoi est précédé d'une lecture des drapeaux et suivi de
 * leur pose : un run relancé après une panne reprend où le précédent s'est
 * arrêté, sans jamais republier. Si le drapeau ne peut pas être posé après un
 * envoi réussi, le run échoue bruyamment (l'id YouTube est affiché) plutôt que
 * de risquer un doublon au run suivant.
 *
 * Codes de sortie : 0 = fait, ou rien à faire / pas encore prêt ; 1 = erreur.
 */

import { promises as fs, appendFileSync } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type { ParlayPost } from '../src/services/content/parlayPosts';
import { uploadYoutube, uploadR2, sendTiktokMail, type Privacy } from './lib/parlayPublish';

const SERVER_DIR = path.resolve(__dirname, '..');
const OUTPUT_ROOT = path.resolve(SERVER_DIR, '..', 'content', 'output');
const API = (process.env.CONTENT_API_URL ?? 'https://api.arakice.com/api').replace(/\/+$/, '');
const NOT_READY = 3;

function arg(name: string): string | null {
  const found = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
}
const flag = (name: string) => process.argv.slice(2).includes(`--${name}`);

function etDay(n = 0): string {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function summary(line: string): void {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

async function api(pathname: string, init: RequestInit & { secret?: boolean } = {}): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as any) };
  if (init.secret) {
    const s = process.env.CONTENT_CRON_SECRET?.trim();
    if (!s) throw new Error('variable CONTENT_CRON_SECRET absente');
    headers['X-Cron-Secret'] = s;
  }
  const res = await fetch(`${API}${pathname}`, { ...init, headers, signal: AbortSignal.timeout(120_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${pathname} → HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** Lance un script npm du serveur ; renvoie son code de sortie. */
function npm(script: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', '-s', script, '--', ...args], {
      cwd: SERVER_DIR, stdio: 'inherit', shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function main() {
  const mode = arg('mode');
  if (mode !== 'pick' && mode !== 'result') throw new Error('--mode=pick ou --mode=result');
  const date = arg('date') || etDay(mode === 'pick' ? 0 : -1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date invalide : ${date}`);
  const dryRun = flag('dry-run');
  const privacy = (process.env.PARLAYS_YOUTUBE_PRIVACY?.trim() || 'unlisted') as Privacy;
  if (!['public', 'unlisted', 'private'].includes(privacy)) throw new Error(`PARLAYS_YOUTUBE_PRIVACY invalide : ${privacy}`);
  const trial = privacy !== 'public';

  summary(`### Combinés ${mode === 'pick' ? 'du soir' : '— résultat'} · ${date}${dryRun ? ' · ESSAI À BLANC' : ''}${trial && !dryRun ? ` · YouTube ${privacy}` : ''}`);

  // 1. Gel (pick seulement).
  if (mode === 'pick' && !dryRun) {
    const fr = await api('/content/parlays/freeze', { method: 'POST', secret: true, body: JSON.stringify({ date }) });
    if (!fr.parlays.length) {
      // Rien n'est écrit dans ce cas : soit pas de match, soit tous déjà commencés
      // (le serveur ne propose jamais un combiné sur un match commencé).
      summary(`- Aucun combiné pour le ${date} (pas de match, ou tous déjà commencés) : rien gelé, rien publié.`);
      return;
    }
    summary(fr.created ? `- Gel : ${fr.parlays.length} combiné(s) gelé(s)` : `- Gel : déjà fait (${fr.parlays.length} combiné(s))`);
  }

  const before = (await api(`/content/parlays?date=${date}`)).parlays as any[];
  const ytKey = mode === 'pick' ? 'youtubePickId' : 'youtubeResultId';
  const tkKey = mode === 'pick' ? 'tiktokPickSentAt' : 'tiktokResultSentAt';
  const ytDone: string | null = before[0]?.[ytKey] ?? null;
  const tkDone = Boolean(before.length && before.every((p) => p[tkKey]));
  if (!dryRun && ytDone && tkDone) { summary('- Déjà publié : rien à faire.'); return; }

  // 2. Vidéo.
  const built = await npm('content:parlays', [`--mode=${mode}`, `--date=${date}`]);
  if (built === NOT_READY) { summary('- Pas encore prêt (rien de gelé, ou combinés pas encore réglés) : prochain passage.'); return; }
  if (built !== 0) throw new Error(`content:parlays a échoué (code ${built})`);
  const key = `${date}-parlays-${mode}`;
  for (const [script, extra] of [['content:render', []], ['content:video', []]] as const) {
    const code = await npm(script, [`--date=${key}`, ...extra]);
    if (code !== 0) throw new Error(`${script} a échoué (code ${code})`);
  }
  const dir = path.join(OUTPUT_ROOT, key);
  const post: ParlayPost = JSON.parse(await fs.readFile(path.join(dir, 'posts.json'), 'utf8')).posts[0];
  const mp4 = path.join(dir, post.candidate_id, 'video.mp4');
  await fs.access(mp4);
  summary(`- Vidéo : \`${path.relative(path.resolve(SERVER_DIR, '..'), mp4)}\``);

  if (dryRun) { summary('- Essai à blanc : rien envoyé, aucun drapeau posé.'); return; }

  // 3. YouTube.
  let youtubeId = ytDone;
  if (!youtubeId) {
    youtubeId = await uploadYoutube(mp4, {
      title: post.youtube_title, description: post.youtube_description, tags: post.hashtags, privacy,
    });
    try {
      await api(`/content/parlays/${date}/posted`, {
        method: 'POST', secret: true, body: JSON.stringify({ kind: `youtube_${mode}`, videoId: youtubeId }),
      });
    } catch (e: any) {
      throw new Error(`vidéo YouTube ${youtubeId} envoyée MAIS drapeau non posé (${e.message}). `
        + `Le poser à la main avant de relancer, sinon elle sera envoyée deux fois.`);
    }
    summary(`- YouTube (${privacy}) : https://youtube.com/shorts/${youtubeId}`);
  } else {
    summary(`- YouTube : déjà envoyé (${youtubeId})`);
  }
  const youtubeUrl = `https://youtube.com/shorts/${youtubeId}`;

  // 4. TikTok : mp4 sur R2 + courriel.
  if (!tkDone) {
    const videoUrl = await uploadR2(mp4, `parlays/${key}.mp4`);
    await sendTiktokMail({
      subject: `${trial ? '[ESSAI] ' : ''}TikTok · ${mode === 'pick' ? "Tonight's parlays" : 'Parlay results'} · ${date}`,
      videoUrl,
      caption: `${post.caption_tiktok}\n\n${post.hashtags.join(' ')}`,
      youtubeUrl,
      trial,
    });
    await api(`/content/parlays/${date}/posted`, { method: 'POST', secret: true, body: JSON.stringify({ kind: `tiktok_${mode}` }) });
    summary(`- TikTok : courriel envoyé (vidéo : ${videoUrl})`);
  } else {
    summary('- TikTok : courriel déjà envoyé');
  }
}

main().catch((e) => { console.error(`\n${e.message}\n`); summary(`- ❌ ${e.message}`); process.exit(1); });
