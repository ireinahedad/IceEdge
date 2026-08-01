/**
 * render-slides.ts — étape 5
 * ===========================
 * posts.json + gabarits HTML + CSV de graphiques  →  PNG 1080×1920.
 *
 * Usage :
 *   npm run content:render
 *   npm run content:render -- --date=2026-08-01
 *   npm run content:render -- --date=2026-08-01 --only=suzuki
 *
 * Prérequis, une seule fois :
 *   npm i -D playwright && npx playwright install chromium
 *
 * POURQUOI UN NAVIGATEUR. Canva impose un compte Enterprise pour l'autofill,
 * l'API REST de Figma est en lecture seule pour le contenu. Rendre du HTML dans
 * Chromium est gratuit, illimité, versionné avec le reste du code, et surtout :
 * un gabarit se règle en l'ouvrant dans Chrome, et le PNG sera identique à ce
 * qu'on y voit. C'est la seule option qui préserve cette boucle-là.
 *
 * PAS DE LIBRAIRIE DE GRAPHIQUES. Les cinq formes dont le système a besoin sont
 * générées en SVG ici même. Chart.js exigerait un chargement réseau au rendu et
 * imposerait ses conventions visuelles ; à ce niveau de contrainte — cinq
 * formes, une palette, un format — écrire le SVG coûte moins cher que de
 * discipliner une librairie.
 */

import { promises as fs } from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE_DIR = path.join(REPO_ROOT, 'content', 'templates');
const OUTPUT_ROOT = path.join(REPO_ROOT, 'content', 'output');
/**
 * Version dimensionnée du logo, à fond transparent.
 *
 * L'original fait 1024×1024 pour 1.5 Mo alors qu'il s'affiche à 260 px : inliné
 * en data-URI sur chaque plan CTA, il produisait un aperçu de 16 Mo. La variante
 * 360 px pèse 73 Ko et reste largement au-dessus de la taille d'affichage.
 *
 * Ne pas y substituer arakice-icon-512.png, qui est la version OPAQUE de la
 * marque : son fond clair ferait un carré sur une carte sombre.
 */
const LOGO_PATH = path.join(REPO_ROOT, 'content', 'assets', 'logo-360.png');
const LOGO_FALLBACK = path.join(REPO_ROOT, 'client', 'public', 'arakice-logo.png');

const WIDTH = 1080;
const HEIGHT = 1920;

/**
 * Gabarits animés. Le hook et le CTA restent fixes : ils portent une phrase et
 * un logo, rien qui gagne à bouger. Le mouvement est réservé aux plans où un
 * chiffre ou une forme PORTE le sens — voir grandir une barre, c'est comprendre
 * l'écart avant d'avoir lu l'axe.
 */
const ANIMATED = new Set(['stat_card', 'chart_card', 'compare_card']);

const FPS = 30;

/**
 * Durée de la phase animée, en secondes. Le reste du plan est un arrêt sur la
 * dernière image, que ffmpeg produit sans coût.
 *
 * On ne capture donc que 42 images par plan animé au lieu des ~115 qu'exigerait
 * un plan de 3.8 s intégralement filmé. C'est ce qui garde le rendu autour de
 * 40 secondes par vidéo plutôt que deux minutes, sans rien perdre à l'écran :
 * après 1.4 s l'image ne change plus.
 */
const ANIM_SECONDS = 1.4;

const PALETTE = {
  accent: '#90C9F0',
  accent2: '#86D1EA',
  muted: '#8A9EA6',
  text: '#BFC8CC',
  positive: '#4ADE80',
  negative: '#F87171',
  surface: '#131A12',
};

// ===========================================================================
// Lecture des CSV de graphiques
// ===========================================================================

interface ChartRow { [key: string]: string | number; }

function parseCsv(text: string): ChartRow[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    // Les CSV produits à l'étape 2 ne contiennent des guillemets que sur les
    // libellés à virgule (les buckets du type "(3.0, 340.0]").
    const cells: string[] = [];
    let cur = '';
    let q = false;
    for (const ch of line) {
      if (ch === '"') { q = !q; continue; }
      if (ch === ',' && !q) { cells.push(cur); cur = ''; continue; }
      cur += ch;
    }
    cells.push(cur);
    const row: ChartRow = {};
    header.forEach((h, i) => {
      const v = cells[i] ?? '';
      row[h] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    });
    return row;
  });
}

// ===========================================================================
// Génération SVG
// ===========================================================================

const esc = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Abrège un libellé trop long plutôt que de le laisser déborder du cadre. */
function trim(s: unknown, max = 22): string {
  const t = String(s ?? '');
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function fmt(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return Math.abs(n) < 10 ? n.toFixed(2).replace(/0$/, '') : n.toFixed(1);
}

/**
 * Barres horizontales triées. La forme la plus lisible en 9:16 : les libellés
 * se lisent à l'horizontale, et l'œil compare des longueurs alignées à gauche.
 * Des barres verticales obligeraient à incliner les noms de joueurs.
 */
function barRank(rows: ChartRow[], w: number): string {
  const data = rows.slice(0, 10);
  const barH = 74;
  const gap = 18;
  const labelW = 340;
  const h = data.length * (barH + gap);
  const max = Math.max(...data.map((r) => Math.abs(Number(r.value))), 1);

  const bars = data.map((r, i) => {
    const y = i * (barH + gap);
    const v = Number(r.value);
    const len = (Math.abs(v) / max) * (w - labelW - 190);
    const highlighted = Number(r.highlight) === 1;
    const color = highlighted ? PALETTE.accent : 'rgba(144,201,240,0.28)';
    return `
    <text x="0" y="${y + barH * 0.68}" fill="${highlighted ? '#fff' : PALETTE.muted}"
          font-size="34" font-weight="${highlighted ? 700 : 500}">${esc(trim(r.label))}</text>
    <g class="anim-bar-h" style="transform-origin:${labelW}px center">
      <rect x="${labelW}" y="${y + 12}" width="${Math.max(len, 4)}" height="${barH - 24}"
            rx="8" fill="${color}"/>
    </g>
    <text class="anim-fade" x="${labelW + Math.max(len, 4) + 20}" y="${y + barH * 0.68}"
          fill="${highlighted ? '#fff' : PALETTE.muted}" font-size="34"
          font-weight="${highlighted ? 700 : 500}">${esc(fmt(v))}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${bars}</svg>`;
}

/** Deux barres face à face. Sert à bar_compare et split_pair. */
function barCompare(rows: ChartRow[], w: number): string {
  const data = rows.slice(0, 4);
  const h = 460;
  const max = Math.max(...data.map((r) => Math.abs(Number(r.value))), 1);
  const slot = w / data.length;
  const barW = Math.min(slot * 0.52, 210);

  const bars = data.map((r, i) => {
    const v = Number(r.value);
    const bh = (Math.abs(v) / max) * (h - 150);
    const x = i * slot + (slot - barW) / 2;
    const y = h - 100 - bh;
    // La dernière barre est la valeur actuelle : c'est elle qu'on met en avant.
    const color = i === data.length - 1 ? PALETTE.accent : 'rgba(144,201,240,0.26)';
    return `
    <rect class="anim-bar-v" data-base-y="${y}" data-height="${Math.max(bh, 6)}"
          x="${x}" y="${y}" width="${barW}" height="${Math.max(bh, 6)}" rx="12" fill="${color}"/>
    <text class="anim-fade" x="${x + barW / 2}" y="${y - 24}" fill="#fff" font-size="52"
          font-weight="800" text-anchor="middle">${esc(fmt(v))}</text>
    <text x="${x + barW / 2}" y="${h - 44}" fill="${PALETTE.muted}" font-size="34"
          font-weight="500" text-anchor="middle">${esc(trim(r.label, 18))}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${bars}</svg>`;
}

/** Longueur d'une polyligne : sert au tracé progressif via stroke-dashoffset. */
function polyLength(data: ChartRow[], x: (i: number) => number, y: (v: number) => number): number {
  let total = 0;
  for (let i = 1; i < data.length; i++) {
    const dx = x(i) - x(i - 1);
    const dy = y(Number(data[i].value)) - y(Number(data[i - 1].value));
    total += Math.hypot(dx, dy);
  }
  return Math.ceil(total);
}

/** Courbe de carrière : une saison par point. */
function lineCareer(rows: ChartRow[], w: number): string {
  const data = rows.filter((r) => Number.isFinite(Number(r.value)));
  if (data.length < 2) return barCompare(data, w);
  const h = 460;
  const pad = 90;
  const max = Math.max(...data.map((r) => Number(r.value)));
  const min = Math.min(...data.map((r) => Number(r.value)), 0);
  const x = (i: number) => pad + (i / (data.length - 1)) * (w - pad * 2);
  const y = (v: number) => h - 110 - ((v - min) / (max - min || 1)) * (h - 220);

  const pts = data.map((r, i) => `${x(i)},${y(Number(r.value))}`).join(' ');
  const dots = data.map((r, i) => {
    const last = i === data.length - 1;
    const season = String(r.season ?? '').slice(2, 4);
    return `
    <circle class="anim-dot" cx="${x(i)}" cy="${y(Number(r.value))}" r="${last ? 16 : 9}"
            fill="${last ? PALETTE.accent : 'rgba(144,201,240,0.55)'}"/>
    ${last ? `<text x="${x(i)}" y="${y(Number(r.value)) - 34}" fill="#fff" font-size="46"
            font-weight="800" text-anchor="middle">${esc(fmt(Number(r.value)))}</text>` : ''}
    <text x="${x(i)}" y="${h - 44}" fill="${PALETTE.muted}" font-size="30"
          text-anchor="middle">'${esc(season)}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <polyline class="anim-line" data-length="${polyLength(data, x, y)}" points="${pts}"
              fill="none" stroke="${PALETTE.accent}" stroke-width="6"
              stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>${dots}</svg>`;
}

/** Nuage volume / efficacité. Le point mis en avant est celui du candidat. */
function scatter(rows: ChartRow[], w: number): string {
  const data = rows.filter((r) => Number.isFinite(Number(r.x)) && Number.isFinite(Number(r.y)));
  if (data.length === 0) return '';
  const h = 460;
  const pad = 80;
  const xs = data.map((r) => Number(r.x));
  const ys = data.map((r) => Number(r.y));
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const px = (v: number) => pad + ((v - xMin) / (xMax - xMin || 1)) * (w - pad * 2);
  const py = (v: number) => h - pad - ((v - yMin) / (yMax - yMin || 1)) * (h - pad * 2);

  const dots = data.map((r) => {
    const on = Number(r.highlight) === 1;
    return `<circle class="anim-dot" cx="${px(Number(r.x))}" cy="${py(Number(r.y))}" r="${on ? 18 : 7}"
      fill="${on ? PALETTE.accent : 'rgba(138,158,166,0.34)'}"/>` +
      (on ? `<text x="${px(Number(r.x))}" y="${py(Number(r.y)) - 34}" fill="#fff"
        font-size="40" font-weight="700" text-anchor="middle">${esc(trim(r.label, 16))}</text>` : '');
  }).join('');

  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${dots}</svg>`;
}

function buildSvg(kind: string, rows: ChartRow[]): string {
  const w = WIDTH - 192; // moins les marges latérales
  switch (kind) {
    case 'bar_rank': return barRank(rows, w);
    case 'bar_compare':
    case 'split_pair': return barCompare(rows, w);
    case 'line_career': return lineCareer(rows, w);
    case 'scatter': return scatter(rows, w);
    default: return barCompare(rows, w);
  }
}

// ===========================================================================
// Rendu
// ===========================================================================

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key) => vars[key] ?? '');
}

/** Un chiffre qui commence par + ou − est coloré : le sens se lit avant le texte. */
function toneOf(big: string): string {
  if (/^\+/.test(big)) return 'positive';
  if (/^[-−]/.test(big)) return 'negative';
  return '';
}

function arg(name: string): string | null {
  const found = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
}

/**
 * Galerie HTML de tous les plans du jour, sans navigateur ni PNG.
 *
 * Existe pour découpler le réglage du design de l'installation de Playwright :
 * ~150 Mo de Chromium ne devraient pas se mettre entre toi et un ajustement de
 * taille de police. Chaque plan est le VRAI document, dans une iframe réduite —
 * ce n'est pas une maquette approchée, c'est le rendu exact en plus petit.
 */
function buildPreview(cards: Array<{ title: string; html: string }>, dateKey: string): string {
  const scale = 0.19;
  const items = cards.map((c) => `
    <figure>
      <div class="frame">
        <iframe srcdoc="${c.html.replace(/"/g, '&quot;')}" scrolling="no"></iframe>
      </div>
      <figcaption>${esc(c.title)}</figcaption>
    </figure>`).join('');

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>Aperçu des plans — ${esc(dateKey)}</title><style>
body{margin:0;padding:32px;background:#07090b;color:#e6edf3;
  font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
h1{font-size:19px;margin:0 0 4px} p.sub{color:#8b949e;margin:0 0 26px;font-size:13px}
.grid{display:flex;flex-wrap:wrap;gap:26px}
figure{margin:0}
.frame{width:${Math.round(WIDTH * scale)}px;height:${Math.round(HEIGHT * scale)}px;
  overflow:hidden;border-radius:12px;border:1px solid #1f2937}
iframe{width:${WIDTH}px;height:${HEIGHT}px;border:0;transform:scale(${scale});
  transform-origin:top left;pointer-events:none}
figcaption{margin-top:8px;font-size:11px;color:#8b949e;max-width:${Math.round(WIDTH * scale)}px}
</style></head><body>
<h1>Aperçu des plans — ${esc(dateKey)}</h1>
<p class="sub">Rendu réel des gabarits, réduit à ${Math.round(scale * 100)} %.
Modifie <code>content/templates/_shared.css</code> et relance pour voir l'effet.</p>
<div class="grid">${items}</div></body></html>`;
}

async function main() {
  const dateKey = arg('date') ?? new Date().toISOString().slice(0, 10);
  const preview = process.argv.slice(2).includes('--preview');

  let chromium: any = null;
  if (!preview) {
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      throw new Error(
        'Playwright absent.\n' +
        '  npm i -D playwright\n' +
        '  npx playwright install chromium\n\n' +
        '  Pour régler le design sans rien installer :\n' +
        '  npm run content:render -- --preview',
      );
    }
  }
  const only = arg('only');
  const dir = path.join(OUTPUT_ROOT, dateKey);
  const posts = JSON.parse(await fs.readFile(path.join(dir, 'posts.json'), 'utf8'));

  // Le type de graphique vit dans candidates.json, pas dans posts.json : c'est
  // une décision de l'étape 2, pas du rédacteur. On le récupère par candidat
  // plutôt que de demander au prompt de le recopier — un champ recopié est un
  // champ qui finit par diverger.
  const candidates = JSON.parse(await fs.readFile(path.join(dir, 'candidates.json'), 'utf8'));
  const chartKind = new Map<string, string>(
    candidates.candidates.map((c: any) => [c.id, c.chart?.kind ?? 'bar_compare']),
  );

  const css = await fs.readFile(path.join(TEMPLATE_DIR, '_shared.css'), 'utf8');
  const animJs = await fs.readFile(path.join(TEMPLATE_DIR, '_anim.js'), 'utf8');
  const templates: Record<string, string> = {};
  for (const name of ['hook_card', 'stat_card', 'chart_card', 'cta_card', 'compare_card']) {
    const raw = await fs.readFile(path.join(TEMPLATE_DIR, `${name}.html`), 'utf8');
    // La feuille est inlinée plutôt que liée : on rend avec setContent, sans
    // URL de base, donc aucun chemin relatif ne serait résolu.
    templates[name] = raw
      .replace(/<link rel="stylesheet" href="_shared\.css">/, `<style>${css}</style>`)
      .replace(/<script src="_anim\.js"><\/script>/, `<script>${animJs}</script>`);
  }

  let logoUri = '';
  for (const candidate of [LOGO_PATH, LOGO_FALLBACK]) {
    try {
      const buf = await fs.readFile(candidate);
      logoUri = `data:image/png;base64,${buf.toString('base64')}`;
      break;
    } catch { /* essai suivant */ }
  }
  if (!logoUri) console.log('  logo introuvable — plan CTA sans logo');

  const browser = preview ? null : await chromium.launch();
  const page = browser ? await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  }) : null;
  const previewCards: Array<{ title: string; html: string }> = [];
  // Manifeste par post : dit à l'étape 6 quels plans sont des images fixes et
  // lesquels sont des séquences, avec la durée d'arrêt sur la dernière image.
  const manifest: any[] = [];

  let rendered = 0;
  for (const post of posts.posts) {
    if (only && !post.candidate_id.includes(only)) continue;
    const slideDir = path.join(dir, post.candidate_id, 'slides');
    if (!preview) await fs.mkdir(slideDir, { recursive: true });

    for (const slide of post.slides) {
      const template = templates[slide.template];
      if (!template) { console.log(`  gabarit inconnu : ${slide.template}`); continue; }

      let chartSvg = '';
      if (slide.chart) {
        try {
          const csv = await fs.readFile(path.join(dir, slide.chart), 'utf8');
          const kind = chartKind.get(post.candidate_id) ?? 'bar_compare';
          chartSvg = buildSvg(kind, parseCsv(csv));
        } catch {
          console.log(`  CSV illisible : ${slide.chart}`);
        }
      }

      const html = fill(template, {
        season_label: posts.retrospective ? (post.season_label ?? '') : '',
        text: slide.text ?? '',
        big: slide.big ?? '',
        tone: toneOf(slide.big ?? ''),
        label: slide.label ?? '',
        sub: slide.sub ?? '',
        chart_svg: chartSvg,
        logo: logoUri,
        left_value: slide.left_value ?? '',
        left_label: slide.left_label ?? '',
        right_value: slide.right_value ?? '',
        right_label: slide.right_label ?? '',
      });

      if (preview) {
        previewCards.push({
          title: `${post.candidate_id.replace(`${dateKey}-`, '')} · plan ${slide.n} · ${slide.template}`,
          html,
        });
        rendered++;
        continue;
      }

      await page!.setContent(html, { waitUntil: 'load' });
      const stem = String(slide.n).padStart(2, '0');
      const animated = ANIMATED.has(slide.template);

      if (!animated) {
        await page!.screenshot({ path: path.join(slideDir, `${stem}.png`), type: 'png' });
        manifest.push({
          n: slide.n, template: slide.template, animated: false,
          file: `${stem}.png`, duration: slide.duration,
        });
      } else {
        // Séquence pilotée par setProgress : chaque image est une fonction pure
        // de sa position dans l'animation, jamais du moment où la capture est
        // tombée. Deux rendus donnent des fichiers identiques.
        const frameDir = path.join(slideDir, stem);
        await fs.mkdir(frameDir, { recursive: true });
        const frames = Math.max(2, Math.round(FPS * Math.min(ANIM_SECONDS, slide.duration)));
        for (let f = 0; f < frames; f++) {
          // `globalThis` et non `window` : le corps de la fonction s'exécute dans
          // la page, mais il est TYPÉ ici, où tsconfig ne charge que la lib ES2020
          // — pas le DOM. Ajouter "DOM" au tsconfig du serveur pour un seul appel
          // exposerait tout le code de production aux globales du navigateur.
          await page!.evaluate((t: number) => (globalThis as any).setProgress(t), f / (frames - 1));
          await page!.screenshot({
            path: path.join(frameDir, `f${String(f).padStart(4, '0')}.png`),
            type: 'png',
          });
        }
        manifest.push({
          n: slide.n, template: slide.template, animated: true,
          dir: stem, frames, fps: FPS,
          anim_seconds: Math.round((frames / FPS) * 100) / 100,
          hold_seconds: Math.round((slide.duration - frames / FPS) * 100) / 100,
          duration: slide.duration,
        });
      }
      rendered++;
    }

    if (!preview) {
      await fs.writeFile(
        path.join(slideDir, 'manifest.json'),
        JSON.stringify({ candidate_id: post.candidate_id, width: WIDTH, height: HEIGHT, slides: manifest }, null, 2),
        'utf8',
      );
    }
    console.log(`  ${post.candidate_id} — ${post.slides.length} plans` +
      (preview ? '' : ` (${manifest.filter((m) => m.animated).length} animés)`));
    manifest.length = 0;
  }

  if (preview) {
    const file = path.join(dir, 'slides-preview.html');
    await fs.writeFile(file, buildPreview(previewCards, dateKey), 'utf8');
    console.log(`\n  ${rendered} plans dans content\\output\\${dateKey}\\slides-preview.html`);
    console.log(`  Ouvre-le pour régler le design, puis relance sans --preview.\n`);
    return;
  }

  await browser!.close();
  console.log(`\n  ${rendered} PNG écrits dans content\\output\\${dateKey}\\<post>\\slides\\\n`);
}

main().catch((e) => { console.error(`\n${e.message}\n`); process.exit(1); });
