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
 *   2. VIDÉO — content:parlays → content:render (--scale=2, PNG 2160×3840) →
 *      content:video, puis deux versions (2026-10-26) :
 *        • youtube.mp4 — la 4K, avec la musique `content/assets/music/parlays.mp3`
 *          (ou PARLAYS_MUSIC) si le fichier existe, muette sinon ;
 *        • tiktok.mp4  — réduite en 1080×1920 (lanczos), MUETTE : le son tendance
 *          s'ajoute dans l'app TikTok, qui favorise ses sons natifs.
 *   3. YOUTUBE — Short, `PARLAYS_YOUTUBE_PRIVACY` (défaut « unlisted » : mode
 *      essai), puis drapeau `youtube_<mode>` posé AUSSITÔT. En « public », le
 *      Short « pick » est envoyé en privé et PROGRAMMÉ (`publishAt`) pour sortir
 *      2 h avant le 1er match ; le gel ayant lieu à 06:00 UTC (14 h à Bali).
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
import { youtubePublishAt } from '../src/services/content/parlayPosts';
import { uploadYoutube, uploadR2, sendTiktokMail, type Privacy } from './lib/parlayPublish';

const SERVER_DIR = path.resolve(__dirname, '..');
const OUTPUT_ROOT = path.resolve(SERVER_DIR, '..', 'content', 'output');
const API = (process.env.CONTENT_API_URL ?? 'https://api.arakice.com/api').replace(/\/+$/, '');
const NOT_READY = 3;
const MUSIC = process.env.PARLAYS_MUSIC?.trim()
  || path.resolve(SERVER_DIR, '..', 'content', 'assets', 'music', 'parlays.mp3');
/** Rendu des combinés en 2160×3840 : voir `render-slides.ts --scale`. */
const RENDER_SCALE = '2';

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

/** ffmpeg : celui de `ffmpeg-static` (installé par npm ci), sinon celui du PATH. */
function ffmpegBin(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const p = require('ffmpeg-static');
    if (typeof p === 'string' && p) return p;
  } catch { /* PATH */ }
  return 'ffmpeg';
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(bin)} a échoué (code ${code})`))));
  });
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

/**
 * Les deux versions publiées, à partir de la vidéo 4K muette de content:video.
 * `seconds` = durée du post (somme des plans) : la musique est coupée net à la
 * fin de la vidéo, avec un fondu d'entrée de 0,3 s et de sortie de 1 s.
 */
async function variants(mp4: string, seconds: number): Promise<{ youtube: string; tiktok: string; music: boolean }> {
  const ff = ffmpegBin();
  const dir = path.dirname(mp4);
  const youtube = path.join(dir, 'youtube.mp4');
  const tiktok = path.join(dir, 'tiktok.mp4');
  const music = await exists(MUSIC);
  if (music) {
    const out = Math.max(0, seconds - 1).toFixed(2);
    await run(ff, ['-y', '-loglevel', 'error', '-i', mp4, '-stream_loop', '-1', '-i', MUSIC,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      '-af', `afade=t=in:d=0.3,afade=t=out:st=${out}:d=1`, '-t', seconds.toFixed(2),
      '-movflags', '+faststart', youtube]);
  } else {
    await fs.copyFile(mp4, youtube);
  }
  await run(ff, ['-y', '-loglevel', 'error', '-i', mp4, '-map', '0:v:0', '-an',
    '-vf', 'scale=1080:1920:flags=lanczos,format=yuv420p,setsar=1',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-r', '30', '-movflags', '+faststart', tiktok]);
  return { youtube, tiktok, music };
}

/** « 21:00 » à Bali, pour le courriel. */
const baliTime = (iso: string) => new Date(iso).toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Makassar' });

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
  if (dryRun && mode === 'pick' && !before.length) summary('- Rien de gelé : aperçu des combinés affichés en ce moment sur le site (non gelés, hors bilan).');

  // 2. Vidéo.
  const built = await npm('content:parlays', [`--mode=${mode}`, `--date=${date}`, ...(dryRun ? ['--live-preview'] : [])]);
  if (built === NOT_READY) { summary('- Pas encore prêt (rien de gelé, ou combinés pas encore réglés) : prochain passage.'); return; }
  if (built !== 0) throw new Error(`content:parlays a échoué (code ${built})`);
  const key = `${date}-parlays-${mode}`;
  for (const [script, extra] of [['content:render', [`--scale=${RENDER_SCALE}`]], ['content:video', []]] as const) {
    const code = await npm(script, [`--date=${key}`, ...extra]);
    if (code !== 0) throw new Error(`${script} a échoué (code ${code})`);
  }
  const dir = path.join(OUTPUT_ROOT, key);
  const post: ParlayPost = JSON.parse(await fs.readFile(path.join(dir, 'posts.json'), 'utf8')).posts[0];
  const mp4 = path.join(dir, post.candidate_id, 'video.mp4');
  await fs.access(mp4);
  const seconds = post.slides.reduce((a: number, s: any) => a + Number(s.duration ?? 0), 0);
  const v = await variants(mp4, seconds);
  summary(`- Vidéo : \`${path.relative(path.resolve(SERVER_DIR, '..'), mp4)}\` (2160×3840) · YouTube ${v.music ? 'avec musique' : 'MUETTE (pas de content/assets/music/parlays.mp3)'} · TikTok 1080×1920 muette`);

  if (dryRun) { summary('- Essai à blanc : rien envoyé, aucun drapeau posé.'); return; }

  // 3. YouTube.
  let youtubeId = ytDone;
  // Programmé seulement en public : `publishAt` exige un envoi « private »,
  // et le mode essai doit rester « unlisted » pour être regardable tout de suite.
  const publishAt = mode === 'pick' && privacy === 'public'
    ? youtubePublishAt(before.map((p) => p.firstStartUTC), Date.now())
    : null;
  if (!youtubeId) {
    youtubeId = await uploadYoutube(v.youtube, {
      title: post.youtube_title, description: post.youtube_description, tags: post.hashtags, privacy, publishAt,
    });
    try {
      await api(`/content/parlays/${date}/posted`, {
        method: 'POST', secret: true, body: JSON.stringify({ kind: `youtube_${mode}`, videoId: youtubeId }),
      });
    } catch (e: any) {
      throw new Error(`vidéo YouTube ${youtubeId} envoyée MAIS drapeau non posé (${e.message}). `
        + `Le poser à la main avant de relancer, sinon elle sera envoyée deux fois.`);
    }
    summary(`- YouTube (${publishAt ? `programmé ${publishAt}` : privacy}) : https://youtube.com/shorts/${youtubeId}`);
  } else {
    summary(`- YouTube : déjà envoyé (${youtubeId})`);
  }
  const youtubeUrl = `https://youtube.com/shorts/${youtubeId}`;

  // 4. TikTok : mp4 sur R2 + courriel.
  if (!tkDone) {
    const videoUrl = await uploadR2(v.tiktok, `parlays/${key}.mp4`);
    await sendTiktokMail({
      subject: `${trial ? '[ESSAI] ' : ''}TikTok · ${mode === 'pick' ? "Tonight's parlays" : 'Parlay results'} · ${date}`,
      videoUrl,
      caption: `${post.caption_tiktok}\n\n${post.hashtags.join(' ')}`,
      youtubeUrl,
      trial,
      note: publishAt
        ? `Le Short YouTube sort à ${baliTime(publishAt)} (heure de Bali), 2 h avant le 1er match. Tu peux programmer TikTok à la même heure dans l'app. Vidéo muette : ajoute un son TikTok.`
        : 'Vidéo muette : ajoute un son TikTok.',
    });
    await api(`/content/parlays/${date}/posted`, { method: 'POST', secret: true, body: JSON.stringify({ kind: `tiktok_${mode}` }) });
    summary(`- TikTok : courriel envoyé (vidéo : ${videoUrl})`);
  } else {
    summary('- TikTok : courriel déjà envoyé');
  }
}

main().catch((e) => { console.error(`\n${e.message}\n`); summary(`- ❌ ${e.message}`); process.exit(1); });
