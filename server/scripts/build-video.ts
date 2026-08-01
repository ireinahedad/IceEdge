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

const FPS = 30;

/**
 * Qualité d'encodage. Les plateformes réencodent systématiquement à la réception :
 * les artefacts de compression s'empilent, et ce sont les arêtes de la typographie
 * qui partent en premier. On monte donc en amont pour que la seconde passe ait de
 * la marge — un fichier de 4 Mo au lieu de 1.5 ne coûte rien à l'envoi.
 */
const CRF = 18;
const PRESET = 'medium';

/** Cible éditoriale, voir HANDOFF §4. Hors bornes : on avertit, on ne bloque pas. */
const MIN_SECONDS = 14;
const MAX_SECONDS = 18;

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
      '-t', slide.duration.toFixed(3),
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

  console.log(`\n  Montage — ${dateKey}${music ? ` · musique ${path.basename(music)}` : ' · muet'}\n`);

  let built = 0;
  for (const name of entries) {
    if (only && !name.includes(only)) continue;
    const result = await buildPost(path.join(dir, name), music, keepSegments);
    if (!result) continue;

    const shown = result.actual ?? result.expected;
    const flag = shown < MIN_SECONDS || shown > MAX_SECONDS
      ? `  ⚠ hors cible ${MIN_SECONDS}-${MAX_SECONDS} s`
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

  console.log(`\n  ${built} vidéo(s) dans content\\output\\${dateKey}\\<post>\\video.mp4\n`);
}

main().catch((e) => { console.error(`\n${e.message}\n`); process.exit(1); });
