/**
 * build-video.ts — étape 6
 * ========================
 * slides/manifest.json + PNG et séquences  →  video.mp4 (H.264, 1080×1920, 30 fps).
 *
 * Usage :
 *   npm run content:video
 *   npm run content:video -- --date=2026-08-01
 *   npm run content:video -- --only=suzuki
 *   npm run content:video -- --music=..\content\assets\music\bed-01.mp3
 *   npm run content:video -- --keep-segments        :: garder les segments intermédiaires
 *   npm run content:video -- --ffmpeg=C:\outils\ffmpeg\bin\ffmpeg.exe
 *
 * Prérequis, une seule fois :
 *   npm i -D ffmpeg-static ffprobe-static
 * ou une installation système de ffmpeg accessible depuis le PATH.
 *
 * MUET PAR DÉFAUT. TikTok et Instagram favorisent les sons natifs choisis dans
 * l'application au moment de l'envoi : une piste incrustée ici coûte de la portée
 * et ne se change plus. `--music` reste disponible pour les cas où la vidéo doit
 * partir sonorisée telle quelle — la décision se prend à l'envoi, pas dans le code.
 *
 * UN SEGMENT PAR PLAN, PUIS CONCATÉNATION SANS RÉENCODAGE. Un filtergraph unique
 * couvrant cinq entrées hétérogènes (images fixes + séquences) est illisible et
 * casse au premier plan ajouté. Ici chaque plan s'encode seul, se contrôle seul,
 * et l'assemblage final ne fait que recopier des flux déjà conformes. Une vidéo
 * qui déraille se diagnostique en ouvrant son segment.
 *
 * PAS DE FONDUS. Coupes franches entre les plans : le rythme sec convient au
 * format court et se cale sur la musique ajoutée à l'envoi.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_ROOT = path.join(REPO_ROOT, 'content', 'output');
const HISTORY_PATH = path.join(REPO_ROOT, 'content', 'data', 'history.json');

const FPS = 30;

/**
 * Qualité d'encodage. Les plateformes réencodent systématiquement à la réception :
 * les artefacts de compression s'empilent, et ce sont les arêtes de la typographie
 * qui partent en premier. On monte donc en amont pour que la seconde passe ait de
 * la marge — un fichier de 4 Mo au lieu de 1.5 ne coûte rien à l'envoi.
 */
const CRF = 18;
const PRESET = 'medium';

/**
 * Cible éditoriale, voir HANDOFF §4. Hors bornes : on avertit, on ne bloque pas.
 *
 * Le plancher est passé de 14 à 12 s quand le hook est devenu fixe à 2 s : un
 * post de quatre plans tombe désormais autour de 12.5 s. Laisser 14 aurait fait
 * clignoter l'avertissement sur chaque vidéo — un avertissement qui se déclenche
 * toujours ne se lit plus. C'est une cible, pas une limite : les bornes dures
 * sont celles de check-posts, plus larges.
 */
const MIN_SECONDS = 8;
const MAX_SECONDS = 15;

interface ManifestSlide {
  n: number;
  template: string;
  animated: boolean;
  file?: string;
  dir?: string;
  frames?: number;
  fps?: number;
  anim_seconds?: number;
  hold_seconds?: number;
  duration: number;
}

interface Manifest {
  candidate_id: string;
  width: number;
  height: number;
  slides: ManifestSlide[];
}

function arg(name: string): string | null {
  const found = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
}

// ===========================================================================
// Localisation des binaires
// ===========================================================================

const INSTALL_HINT =
  '  Le plus simple, depuis server\\ :\n' +
  '  npm i -D ffmpeg-static ffprobe-static\n\n' +
  '  Sinon, une installation système (build statique sur gyan.dev, dossier bin\\\n' +
  '  ajouté au PATH), ou un chemin explicite :\n' +
  '  npm run content:video -- --ffmpeg=C:\\outils\\ffmpeg\\bin\\ffmpeg.exe';

/**
 * ffmpeg vient d'où on le trouve, dans cet ordre : drapeau explicite, variable
 * d'environnement, paquet npm, PATH.
 *
 * POURQUOI PAS SEULEMENT LE PATH. Une installation système suppose winget ou
 * Chocolatey — absents d'un Windows par défaut — puis une modification du PATH
 * et un terminal rouvert. Les paquets `ffmpeg-static` / `ffprobe-static` posent
 * un binaire dans node_modules et se réinstallent avec le reste du projet :
 * même contrat que Playwright à l'étape 5, une dépendance de développement qui
 * ne touche à rien en production.
 *
 * Aucun des deux n'est requis dans package.json : le PATH reste une réponse
 * valable, et personne ne devrait télécharger 80 Mo pour lancer `npm install`
 * sur la partie serveur.
 */
function resolveBin(name: 'ffmpeg' | 'ffprobe'): string {
  const explicit = arg(name) ?? process.env[`${name.toUpperCase()}_PATH`];
  if (explicit) return explicit;
  try {
    // ffmpeg-static exporte directement le chemin ; ffprobe-static un objet.
    const mod = require(`${name}-static`);
    const p: unknown = typeof mod === 'string' ? mod : mod?.path;
    if (typeof p === 'string' && p) return p;
  } catch { /* paquet absent — on tente le PATH */ }
  return name;
}

const FFMPEG = resolveBin('ffmpeg');
const FFPROBE = resolveBin('ffprobe');

// ===========================================================================
// Appel ffmpeg
// ===========================================================================

/**
 * Les arguments passent en tableau, jamais par un shell : un chemin de piste
 * musicale vient de la ligne de commande et pourrait contenir n'importe quoi.
 */
function run(bin: string, args: string[], label = bin): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') {
        reject(new Error(`${label} introuvable.\n\n${INSTALL_HINT}`));
        return;
      }
      reject(e);
    });
    child.on('close', (code) => {
      if (code === 0) { resolve(stdout.trim()); return; }
      // ffmpeg est bavard : seules les dernières lignes portent la cause.
      const tail = stderr.trim().split(/\r?\n/).slice(-8).join('\n    ');
      reject(new Error(`${label} a échoué (code ${code}) :\n    ${tail}`));
    });
  });
}

/**
 * Durée réelle du fichier produit. Purement informatif : ffprobe peut manquer
 * sans que le montage en souffre, on retombe alors sur la durée attendue.
 */
async function probeDuration(file: string): Promise<number | null> {
  try {
    const out = await run(FFPROBE, [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', file,
    ], 'ffprobe');
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

// ===========================================================================
// Un segment par plan
// ===========================================================================

/**
 * Réglages communs à tous les segments — ils doivent être identiques d'un plan à
 * l'autre, sinon la concaténation sans réencodage refuse les flux.
 *
 * Les filtres ajoutent `setsar=1` : sans ratio d'échantillon explicite, certains
 * lecteurs mobiles déduisent une valeur approximative et déforment le 9:16.
 */
const VIDEO_ARGS = [
  '-c:v', 'libx264', '-preset', PRESET, '-crf', String(CRF),
  '-pix_fmt', 'yuv420p', '-r', String(FPS),
];

async function buildSegment(slideDir: string, slide: ManifestSlide, out: string): Promise<void> {
  if (!slide.animated) {
    const png = path.join(slideDir, slide.file!);
    await fs.access(png);
    await run(FFMPEG, [
      '-y', '-loglevel', 'error',
      '-loop', '1', '-framerate', String(FPS), '-i', png,
      '-t', slide.duration.toFixed(2),
      '-vf', 'format=yuv420p,setsar=1',
      ...VIDEO_ARGS, out,
    ]);
    return;
  }

  const frameDir = path.join(slideDir, slide.dir!);
  await fs.access(path.join(frameDir, 'f0000.png'));
  const srcFps = slide.fps ?? FPS;
  const hold = slide.hold_seconds ?? 0;

  /**
   * L'arrêt sur la dernière image est produit par tpad plutôt que par un second
   * segment : l'étape 5 ne capture que la phase animée (1.4 s), le reste du plan
   * est un gel que ffmpeg clone sans réencoder d'image supplémentaire.
   */
  const filters = hold > 0.02
    ? `tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)},format=yuv420p,setsar=1`
    : 'format=yuv420p,setsar=1';

  await run(FFMPEG, [
    '-y', '-loglevel', 'error',
    '-framerate', String(srcFps), '-start_number', '0',
    '-i', path.join(frameDir, 'f%04d.png'),
    '-vf', filters,
    '-t', slide.duration.toFixed(3),
    ...VIDEO_ARGS, out,
  ]);
}

// ===========================================================================
// Assemblage
// ===========================================================================

async function buildPost(
  postDir: string,
  music: string | null,
  keepSegments: boolean,
): Promise<{ file: string; expected: number; actual: number | null } | null> {
  const slideDir = path.join(postDir, 'slides');
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(slideDir, 'manifest.json'), 'utf8'));
  } catch {
    return null; // post non rendu — l'étape 5 n'est pas passée dessus
  }

  const slides = [...manifest.slides].sort((a, b) => a.n - b.n);
  if (!slides.length) throw new Error(`manifeste vide : ${path.basename(postDir)}`);

  const segDir = path.join(slideDir, '_segments');
  await fs.rm(segDir, { recursive: true, force: true });
  await fs.mkdir(segDir, { recursive: true });

  const segments: string[] = [];
  for (const slide of slides) {
    const seg = path.join(segDir, `${String(slide.n).padStart(2, '0')}.mp4`);
    await buildSegment(slideDir, slide, seg);
    segments.push(seg);
  }

  // Le démultiplexeur concat lit un chemin par ligne. Les antislashes de Windows
  // y sont interprétés comme des échappements : on écrit en séparateurs POSIX,
  // que ffmpeg accepte des deux côtés.
  const listFile = path.join(segDir, 'concat.txt');
  await fs.writeFile(
    listFile,
    segments.map((s) => `file '${s.replace(/\\/g, '/')}'`).join('\n') + '\n',
    'utf8',
  );

  const expected = slides.reduce((sum, s) => sum + s.duration, 0);
  const outFile = path.join(postDir, 'video.mp4');

  const args = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile];
  if (music) {
    // -stream_loop avant son -i : la piste boucle pour couvrir la vidéo quelle
    // que soit sa durée, -shortest coupe sur la fin de l'image.
    args.push('-stream_loop', '-1', '-i', music);
    args.push('-map', '0:v:0', '-map', '1:a:0');
    const fadeOut = Math.max(0, expected - 0.8);
    args.push('-af', `afade=t=in:st=0:d=0.4,afade=t=out:st=${fadeOut.toFixed(2)}:d=0.8`);
    args.push('-c:a', 'aac', '-b:a', '192k');
    // -shortest sur un flux vidéo recopié laisse parfois traîner une queue audio :
    // ces deux drapeaux forcent la coupe nette à la fin de l'image.
    args.push('-shortest', '-fflags', '+shortest', '-max_interleave_delta', '100M');
  } else {
    args.push('-map', '0:v:0', '-an');
  }
  // Les segments sont déjà conformes et commencent chacun sur une image clé :
  // la concaténation recopie les flux au lieu de les réencoder une seconde fois.
  args.push('-c:v', 'copy', '-movflags', '+faststart', outFile);

  await run(FFMPEG, args);
  if (!keepSegments) await fs.rm(segDir, { recursive: true, force: true });

  return { file: outFile, expected, actual: await probeDuration(outFile) };
}

// ===========================================================================
// Page du jour — étape 7
// ===========================================================================

/**
 * POURQUOI LA PAGE EST ÉCRITE ICI. Valider une journée demandait d'ouvrir six
 * mp4, six blocs de légendes dans posts.json et de recopier les hashtags à la
 * main. C'est le moment où l'on publie, donc le moment où l'on est pressé : ce
 * qui est pénible finit par être sauté, à commencer par le journal.
 *
 * Elle n'est pas un script de plus mais la fin du montage, comme `review.html`
 * est la fin du minage. Une étape qu'on peut oublier de lancer est une étape qui
 * n'existe pas.
 *
 * Aucun CDN, aucun serveur : la page s'ouvre par double-clic, les vidéos sont
 * lues depuis le dossier voisin.
 */

interface PagePost {
  /** 1-based : exactement l'index attendu par `content:log -- --posts=`. */
  index: number;
  id: string;
  subject: string;
  template: string;
  video: string | null;
  seconds: number | null;
  megabytes: number | null;
  captionTiktok: string;
  captionInstagram: string;
  hashtags: string;
  published: boolean;
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));
}

/**
 * Bloc de texte sélectionnable + bouton de copie.
 *
 * Le texte vit dans le DOM et non dans un attribut : une légende contient des
 * apostrophes et des guillemets, et un attribut aurait exigé un second niveau
 * d'échappement pour rien.
 */
function copyBlock(id: string, title: string, text: string, mono = false): string {
  return `
      <div class="block">
        <div class="blabel">${esc(title)}
          <button class="copy" data-target="${id}">copier</button>
        </div>
        <div class="text${mono ? ' mono' : ''}" id="${id}" tabindex="0">${esc(text)}</div>
      </div>`;
}

function buildDayHtml(dateKey: string, posts: PagePost[], extras: string[]): string {
  const cards = posts.map((p) => {
    const meta = [
      p.template,
      p.seconds !== null ? `${p.seconds.toFixed(1)} s` : null,
      p.megabytes !== null ? `${p.megabytes.toFixed(1)} Mo` : null,
    ].filter(Boolean).join(' · ');

    const video = p.video
      ? `<video controls preload="metadata" playsinline src="${esc(p.video)}"></video>`
      : `<div class="novideo">pas encore monté<br><code>npm run content:video</code></div>`;

    return `
  <article class="card${p.published ? ' done' : ''}" data-index="${p.index}">
    <div class="left">
      ${video}
      <label class="pick">
        <input type="checkbox" class="sel" value="${p.index}"${p.published ? ' disabled' : ''}>
        ${p.published ? 'déjà journalisé' : 'publié'}
      </label>
    </div>
    <div class="right">
      <header>
        <span class="idx">#${p.index}</span>
        <h2>${esc(p.subject)}</h2>
        <span class="tpl">${esc(meta)}</span>
      </header>
      ${copyBlock(`tt-${p.index}`, 'Légende TikTok', p.captionTiktok)}
      ${copyBlock(`ig-${p.index}`, 'Légende Instagram', p.captionInstagram)}
      ${copyBlock(`ht-${p.index}`, 'Hashtags', p.hashtags)}
      ${copyBlock(`lg-${p.index}`, 'Journaliser ce post',
        `npm run content:log -- --date=${dateKey} --posts=${p.index}`, true)}
    </div>
  </article>`;
  }).join('');

  const links = extras.length
    ? `<p class="sub">Aussi dans ce dossier : ${extras.map((f) => `<a href="${esc(f)}">${esc(f)}</a>`).join(' · ')}</p>`
    : '';

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ICEEDGE — à publier, ${esc(dateKey)}</title>
<style>
*{box-sizing:border-box} body{margin:0;padding:28px;background:#0b0f14;color:#e6edf3;
  font:15px/1.55 -apple-system,Segoe UI,Roboto,sans-serif}
h1{margin:0 0 4px;font-size:22px} .sub{color:#8b949e;margin:0 0 6px;font-size:13px}
a{color:#60a5fa}
.card{display:grid;grid-template-columns:240px 1fr;gap:18px;background:#111823;
  border:1px solid #1f2937;border-radius:10px;padding:16px;margin-bottom:14px}
.card.done{opacity:.55}
.left{display:flex;flex-direction:column;gap:10px}
video{width:100%;border-radius:8px;background:#000;aspect-ratio:9/16}
.novideo{width:100%;aspect-ratio:9/16;border:1px dashed #1f2937;border-radius:8px;
  display:flex;flex-direction:column;justify-content:center;text-align:center;
  color:#6b7280;font-size:12px;gap:6px}
.pick{display:flex;align-items:center;gap:7px;font-size:13px;color:#8b949e;cursor:pointer}
.right header{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.idx{color:#6b7280;font-size:13px} h2{margin:0;font-size:16px}
.tpl{margin-left:auto;background:#1f2937;color:#9ca3af;padding:3px 9px;border-radius:99px;font-size:11px}
.block{margin-bottom:10px}
.blabel{display:flex;align-items:center;gap:8px;font-size:11px;text-transform:uppercase;
  letter-spacing:.7px;color:#6b7280;margin-bottom:4px}
.copy{background:#1f2937;color:#c9d1d9;border:0;border-radius:6px;padding:3px 10px;
  font-size:11px;cursor:pointer;font-family:inherit}
.copy:hover{background:#2b3a4d} .copy.ok{background:#166534;color:#dcfce7}
.text{background:#0e1520;border:1px solid #1f2937;border-radius:8px;padding:9px 11px;
  font-size:13px;color:#c9d1d9;white-space:pre-wrap;cursor:text}
.text:focus{outline:1px solid #2b3a4d}
.mono{font-family:Consolas,Menlo,monospace;font-size:12px;color:#9ca3af}
.bar{position:sticky;bottom:0;background:#0e1520;border:1px solid #1f2937;border-radius:10px;
  padding:12px 16px;margin-top:20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.bar .mono{flex:1;min-width:280px;padding:7px 10px;background:#0b0f14;border-radius:6px;
  border:1px solid #1f2937}
.hint{color:#6b7280;font-size:12px;margin:14px 0 0}
</style></head><body>
<h1>À publier — ${esc(dateKey)}</h1>
<p class="sub">${posts.length} post(s) · les légendes se copient d'un bouton, la vidéo se lit ici.</p>
${links}
${cards}
<div class="bar">
  <strong style="font-size:13px">Après publication</strong>
  <div class="mono" id="cmd">coche les posts sortis</div>
  <button class="copy" data-target="cmd">copier</button>
</div>
<p class="hint">Journaliser n'est pas une formalité : l'anti-répétition de
<code>mine-stories</code> ne lit que <code>history.json</code>. Sans cette ligne, un
cinquième du barème de sélection ne pénalise rien et le compte se répète au bout de
trois semaines.</p>
<script>
// Le presse-papier moderne exige un contexte sécurisé. Chrome considère file://
// comme tel, pas tous les navigateurs : la vieille méthode reste en repli, faute
// de quoi le bouton échouerait en silence — pire qu'un bouton absent.
function copyText(text, btn) {
  var done = function () {
    var old = btn.textContent;
    btn.textContent = 'copié';
    btn.classList.add('ok');
    setTimeout(function () { btn.textContent = old; btn.classList.remove('ok'); }, 1200);
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, function () { fallback(text, done); });
  } else {
    fallback(text, done);
  }
}
function fallback(text, done) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { alert('Copie impossible — sélectionne le texte à la main.'); }
  document.body.removeChild(ta);
}
document.addEventListener('click', function (e) {
  var btn = e.target && e.target.closest ? e.target.closest('.copy') : null;
  if (!btn) return;
  var el = document.getElementById(btn.dataset.target);
  if (el) copyText(el.textContent.trim(), btn);
});
// Un clic dans un bloc de texte le sélectionne en entier : sur téléphone,
// attraper trois lignes au doigt est plus pénible que la copie elle-même.
document.querySelectorAll('.text').forEach(function (el) {
  el.addEventListener('focus', function () {
    var r = document.createRange();
    r.selectNodeContents(el);
    var s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  });
});
var boxes = Array.prototype.slice.call(document.querySelectorAll('.sel'));
function refresh() {
  var picked = boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
  document.getElementById('cmd').textContent = picked.length
    ? 'npm run content:log -- --date=${dateKey} --posts=' + picked.join(',')
    : 'coche les posts sortis';
}
boxes.forEach(function (b) { b.addEventListener('change', refresh); });
</script>
</body></html>`;
}

/**
 * Construit la page à partir de posts.json, pas de ce que cette exécution a
 * monté : lancer `--only=suzuki` ne doit pas produire une page amputée des sept
 * autres posts du jour.
 */
async function writeDayPage(dir: string, dateKey: string): Promise<number> {
  let posts: any;
  try {
    posts = JSON.parse(await fs.readFile(path.join(dir, 'posts.json'), 'utf8'));
  } catch {
    console.log('  (pas de posts.json — page du jour non écrite)');
    return 0;
  }

  let byId = new Map<string, any>();
  try {
    const candidates = JSON.parse(await fs.readFile(path.join(dir, 'candidates.json'), 'utf8'));
    byId = new Map(candidates.candidates.map((c: any) => [c.id, c]));
  } catch { /* la page se contente alors de l'identifiant du candidat */ }

  // Ce qui est déjà journalisé s'affiche estompé et non cochable : la page sert
  // à publier, pas à journaliser deux fois le même post.
  let published = new Set<string>();
  try {
    const history = JSON.parse(await fs.readFile(HISTORY_PATH, 'utf8'));
    published = new Set(history
      .filter((h: any) => h.date === dateKey)
      .map((h: any) => h.candidate_id as string));
  } catch { /* premier passage */ }

  const pagePosts: PagePost[] = [];
  for (let i = 0; i < posts.posts.length; i++) {
    const post = posts.posts[i];
    const c = byId.get(post.candidate_id);
    const rel = `${post.candidate_id}/video.mp4`;
    let seconds: number | null = null;
    let megabytes: number | null = null;
    let video: string | null = null;
    try {
      const stat = await fs.stat(path.join(dir, post.candidate_id, 'video.mp4'));
      video = rel.replace(/\\/g, '/');
      megabytes = stat.size / 1024 / 1024;
      seconds = await probeDuration(path.join(dir, post.candidate_id, 'video.mp4'));
    } catch { /* post non monté */ }

    pagePosts.push({
      index: i + 1,
      id: post.candidate_id,
      subject: c ? `${c.entity.name}${c.entity.team ? ` · ${c.entity.team}` : ''}` : post.candidate_id,
      template: c?.template ?? '',
      video, seconds, megabytes,
      captionTiktok: post.caption_tiktok ?? '',
      captionInstagram: post.caption_instagram ?? '',
      hashtags: (post.hashtags ?? []).join(' '),
      published: published.has(post.candidate_id),
    });
  }

  const extras: string[] = [];
  for (const f of ['review.html', 'slides-preview.html']) {
    try { await fs.access(path.join(dir, f)); extras.push(f); } catch { /* absent */ }
  }

  await fs.writeFile(path.join(dir, 'index.html'), buildDayHtml(dateKey, pagePosts, extras), 'utf8');
  return pagePosts.length;
}

// ===========================================================================

async function main() {
  const dateKey = arg('date') ?? new Date().toISOString().slice(0, 10);
  const only = arg('only');
  const keepSegments = process.argv.slice(2).includes('--keep-segments');

  let music: string | null = null;
  const musicArg = arg('music');
  if (musicArg) {
    music = path.resolve(musicArg);
    try {
      await fs.access(music);
    } catch {
      throw new Error(`piste musicale introuvable : ${music}`);
    }
  }

  const dir = path.join(OUTPUT_ROOT, dateKey);
  let entries: string[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    throw new Error(
      `aucune sortie pour ${dateKey}.\n` +
      '  Lancer d\'abord : npm run content:mine puis npm run content:render',
    );
  }

  // Cible éditoriale déclarée post par post, quand posts.json en porte une.
  //
  // Les récaps d'après-match (build-recap.ts) durent de 15 à 50 secondes selon
  // le nombre de matchs de la nuit : les mesurer contre les 8-15 s du format
  // quotidien ferait clignoter l'avertissement sur chacun d'eux, et un
  // avertissement qui se déclenche toujours ne se lit plus. Le défaut ne bouge
  // pas — un post sans `duration_target` reste jugé sur la cible du pipeline.
  const targets = new Map<string, [number, number]>();
  try {
    const posts = JSON.parse(await fs.readFile(path.join(dir, 'posts.json'), 'utf8'));
    for (const post of posts.posts ?? []) {
      const t = post.duration_target;
      if (Array.isArray(t) && t.length === 2) targets.set(post.candidate_id, [Number(t[0]), Number(t[1])]);
    }
  } catch { /* pas de posts.json : cible par défaut pour tout le monde */ }
  console.log(`\n  Montage — ${dateKey}${music ? ` · musique ${path.basename(music)}` : ' · muet'}\n`);

  let built = 0;
  for (const name of entries) {
    if (only && !name.includes(only)) continue;
    const result = await buildPost(path.join(dir, name), music, keepSegments);
    if (!result) continue;

    const shown = result.actual ?? result.expected;
    const [minTarget, maxTarget] = targets.get(name) ?? [MIN_SECONDS, MAX_SECONDS];
    const flag = shown < minTarget || shown > maxTarget
      ? `  ⚠ hors cible ${minTarget}-${maxTarget} s`
      : '';
    const size = (await fs.stat(result.file)).size / 1024 / 1024;
    console.log(`  ${name} — ${shown.toFixed(1)} s · ${size.toFixed(1)} Mo${flag}`);
    built++;
  }

  if (!built) {
    throw new Error(
      only
        ? `aucun post ne correspond à --only=${only}`
        : `aucun manifeste dans content\\output\\${dateKey}\\ — lancer npm run content:render`,
    );
  }

  const listed = await writeDayPage(dir, dateKey);

  console.log(`\n  ${built} vidéo(s) dans content\\output\\${dateKey}\\<post>\\video.mp4`);
  if (listed > 0) {
    console.log(`\n  Ouvre content\\output\\${dateKey}\\index.html — ${listed} post(s),`);
    console.log(`  vidéos lisibles, légendes et hashtags copiables, commande de journal.\n`);
  } else {
    console.log('');
  }
}

main().catch((e) => { console.error(`\n${e.message}\n`); process.exit(1); });
