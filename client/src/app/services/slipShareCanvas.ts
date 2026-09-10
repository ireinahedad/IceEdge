/**
 * slipShareCanvas.ts — dessine l'image de partage d'un coupon sur un `<canvas>`.
 *
 * ── Pourquoi ce fichier existe, et pourquoi il ne capture PAS le DOM ─────────
 *
 * Jusqu'au 2026-09-10, l'image partagée était une capture de la carte à l'écran
 * (`html-to-image`). Deux choses le condamnaient, et aucune n'était réparable
 * en surface :
 *
 *   1. Pour embarquer les polices, la bibliothèque lit `document.styleSheets`.
 *      Oswald et Inter viennent d'un `<link>` Google Fonts sans `crossorigin`,
 *      donc `sheet.cssRules` LÈVE. L'erreur est avalée par un `catch`, mais ce
 *      catch refetch la CSS, base64 les 9 fichiers de police, et les réinjecte
 *      par `insertRule` DANS LA FEUILLE DE STYLE VIVANTE DE L'APP. Lent, et
 *      salissant.
 *   2. Surtout : pour chaque logo d'équipe, la bibliothèque refait son propre
 *      `fetch`. Si le CDN de la LNH ne renvoie pas d'en-tête CORS, ce fetch
 *      échoue, la fonction retourne `""`, et poser `img.src = ""` déclenche
 *      `onerror` — ce qui fait REJETER tout le partage. Un seul logo suffisait
 *      donc à rendre le bouton mort.
 *
 * Ici on dessine nous-mêmes. Aucune feuille de style n'est lue, aucune image
 * distante n'est chargée (l'identité d'équipe est un liseré de couleur, pas un
 * logo — voir `legAccent`), et le résultat ne dépend plus du navigateur ni de
 * ce que l'écran affichait au moment du clic.
 *
 * ── Le dessin ───────────────────────────────────────────────────────────────
 *
 * Direction « Glace », validée sur maquette le 2026-09-10 : glace de nuit,
 * une carte givrée, l'anneau de probabilité du constructeur, les sélections en
 * lignes séparées d'un filet. Carré 1080×1080 — le format qui passe partout.
 *
 * ⚠️ La densité s'ADAPTE au nombre de jambes (`densityFor`). À 3 sélections
 * l'anneau fait 300 px ; à 5 il tombe à 220 et les lignes se resserrent, sinon
 * le pied de carte sort du carré. Au-delà de ce que la place permet, la liste
 * est TRONQUÉE avec une ligne « + N autres » — on ne rapetisse pas indéfiniment.
 */

import { legAccent } from '../data/teamEmoji';
import type { BetSlip } from './slipApiService';

/** Côté de l'image produite, en pixels. Carré, toujours. */
export const SHARE_SIZE = 1080;

/**
 * Les textes de l'image.
 *
 * Ils sont FOURNIS par l'appelant plutôt que traduits ici : `useI18n` est un
 * hook React et `translate` n'est pas exporté. Garder ce module libre de React
 * lui permet d'être appelé de n'importe où (bouton de partage, chat, futur
 * partage automatique) sans traîner un contexte.
 */
export interface SlipShareLabels {
  /** « Verrouillé le 10 septembre » — déjà formaté à la locale de l'appelant. */
  dateLine:   string;
  /** « COMBINÉ », sous le grand nombre. */
  combined:   string;
  /** « 3 sélections · cote implicite +113 ». */
  summary:    string;
  /** « GAGNÉ » / « PERDU », ou `null` tant que le coupon est en attente. */
  outcome:    string | null;
  /** « +140 XP », ou `null`. */
  xp:         string | null;
  /** La ligne de pied, à gauche. */
  disclaimer: string;
  /** « + 2 autres sélections », quand la liste ne tient pas. */
  moreLegs:   (n: number) => string;
}

/** Levée quand le navigateur ne rend pas de contexte 2D ou refuse le blob. */
export class ShareRenderError extends Error {
  constructor(cause: string) { super(`share_render_failed: ${cause}`); this.name = 'ShareRenderError'; }
}

// ─── Palette ──────────────────────────────────────────────────────────────────
// Reprise telle quelle des jetons de l'app (bet-theme.css / rink-theme.css).
// Aucune valeur n'est arrondie : ce sont les mêmes que celles de l'écran.

const INK = {
  iceTop:     '#08131b',
  iceMid:     '#0a1620',
  iceBottom:  '#08121a',
  accent:     '#86d1ea',
  white:      '#ffffff',
  muted:      '#8a9ea6',
  dim:        '#5f7680',
  blueLine:   '#3574d6',
  win:        '#4ade80',
  loss:       '#f87171',
  xp:         '#facc15',
};

/**
 * L'échelle de probabilité du produit (identique à `SlipCard` et `LegCard`).
 * ⚠️ Elle s'applique à la PROBABILITÉ, jamais à l'issue : un coupon gagné à
 * 27 % garde son anneau jaune. C'est justement ce qu'on a envie de montrer.
 */
function probabilityColor(pct: number): string {
  if (pct >= 65) return '#86d1ea';
  if (pct >= 45) return '#90C9F0';
  if (pct >= 25) return '#facc15';
  return '#f87171';
}

const OSWALD = "'Oswald', 'Arial Narrow', sans-serif";
const INTER  = "'Inter', system-ui, sans-serif";

// ─── Polices ──────────────────────────────────────────────────────────────────

/**
 * Oswald et Inter sont déjà chargées par la page (`index.html`), mais un
 * `canvas` peint avec la police de repli si la fonte n'est pas encore prête au
 * moment du `fillText` — sans lever, et sans rien dire. On les demande donc
 * explicitement, puis on attend.
 *
 * Aucun embed, aucun base64 : c'est toute la différence avec la capture DOM.
 */
async function ensureFonts(): Promise<void> {
  const fonts = document.fonts;
  if (!fonts?.load) return;   // navigateur sans CSS Font Loading : repli visuel
  try {
    await Promise.all([
      fonts.load(`700 118px ${OSWALD}`),
      fonts.load(`600 36px ${OSWALD}`),
      fonts.load(`400 44px ${OSWALD}`),
      fonts.load(`600 30px ${INTER}`),
      fonts.load(`400 22px ${INTER}`),
    ]);
    await fonts.ready;
  } catch {
    // Une police manquante dégrade le rendu ; elle ne doit pas tuer le partage.
  }
}

// ─── Outils de dessin ─────────────────────────────────────────────────────────

/**
 * `ctx.roundRect` n'existe qu'à partir de Safari 16.4 — trop récent pour le
 * plancher iOS du projet. On trace le chemin à la main.
 */
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
}

/**
 * Écrit un texte lettre par lettre avec un interlettrage.
 *
 * `ctx.letterSpacing` n'arrive qu'à Safari 17.4 : trop récent ici, et le repli
 * habituel (insérer des espaces dans la chaîne) donne un espacement inégal
 * parce qu'une espace n'a pas la largeur voulue. Rend la largeur totale.
 */
function fillTracked(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, tracking: number, align: 'left' | 'right' = 'left'): number {
  const chars = Array.from(text);
  const total = chars.reduce((w, c) => w + ctx.measureText(c).width, 0) + tracking * Math.max(0, chars.length - 1);
  const previous = ctx.textAlign;
  ctx.textAlign = 'left';
  let cursor = align === 'right' ? x - total : x;
  for (const c of chars) {
    ctx.fillText(c, cursor, y);
    cursor += ctx.measureText(c).width + tracking;
  }
  ctx.textAlign = previous;
  return total;
}

/** Coupe le texte à la largeur donnée, avec une ellipse. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut.trimEnd()}…`;
}

/**
 * La couleur d'identité d'une jambe.
 *
 * ⚠️ Une jambe ne porte PAS d'abréviation d'équipe : on la déduit, dans cet
 * ordre, de `selectionValue` (qui vaut 'over' | 'under' | l'abréviation),
 * puis de `subjectId`, puis de l'URL du logo (`…/svg/TOR_light.svg`). Chaque
 * étape est facultative — `teamColors` a déjà un repli ardoise neutre, donc une
 * jambe non reconnue reste dessinée au lieu de faire échouer quoi que ce soit.
 */

// ─── Mise en page ─────────────────────────────────────────────────────────────

const CARD   = { x: 64, y: 64, w: SHARE_SIZE - 128, h: SHARE_SIZE - 128, r: 44 };
const INNER  = { x: CARD.x + 56, y: CARD.y + 56, w: CARD.w - 112, bottom: CARD.y + CARD.h - 48 };
const ROW_MIN = 62;   // sous cette hauteur, une ligne n'est plus lisible : on tronque

interface Density {
  ring: number; ringFont: number; pctFont: number; capFont: number;
  rowH: number; nameFont: number; marketFont: number; legPctFont: number; barH: number;
  summaryFont: number;
}

/** Les trois densités validées sur maquette. */
function densityFor(n: number): Density {
  if (n <= 3) return { ring: 300, ringFont: 118, pctFont: 44, capFont: 19, rowH: 103, nameFont: 30, marketFont: 22, legPctFont: 36, barH: 50, summaryFont: 25 };
  if (n === 4) return { ring: 260, ringFont: 102, pctFont: 38, capFont: 18, rowH:  92, nameFont: 28, marketFont: 21, legPctFont: 33, barH: 46, summaryFont: 24 };
  return          { ring: 220, ringFont:  88, pctFont: 32, capFont: 16, rowH:  81, nameFont: 26, marketFont: 20, legPctFont: 30, barH: 42, summaryFont: 24 };
}

// ─── Les couches ──────────────────────────────────────────────────────────────

function paintIce(ctx: CanvasRenderingContext2D): void {
  const base = ctx.createLinearGradient(0, 0, 0, SHARE_SIZE);
  base.addColorStop(0,    INK.iceTop);
  base.addColorStop(0.45, INK.iceMid);
  base.addColorStop(1,    INK.iceBottom);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, SHARE_SIZE, SHARE_SIZE);

  // Les trois halos de `.rink-ice`, dans le même ordre.
  const halos: Array<[number, number, number, string]> = [
    [SHARE_SIZE * 0.5,  0,                  SHARE_SIZE * 0.72, 'rgba(134,209,234,0.10)'],
    [SHARE_SIZE * 0.12, SHARE_SIZE * 0.38,  SHARE_SIZE * 0.50, 'rgba(120,190,235,0.06)'],
    [SHARE_SIZE * 0.88, SHARE_SIZE * 0.76,  SHARE_SIZE * 0.50, 'rgba(120,190,235,0.05)'],
  ];
  for (const [cx, cy, r, color] of halos) {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SHARE_SIZE, SHARE_SIZE);
  }

  // Marques de patins — deux peignes croisés, très faibles.
  ctx.save();
  ctx.lineWidth = 2;
  // Deux peignes d'espacement DIFFÉRENT (30 et 46 px, comme `.rink-ice`) :
  // au même pas, les deux se croisent en losanges réguliers et l'ensemble se
  // lit comme un grillage au lieu de marques de patins.
  for (const [angle, step, alpha] of [[114, 30, 0.030], [66, 46, 0.022]] as const) {
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
    ctx.save();
    ctx.translate(SHARE_SIZE / 2, SHARE_SIZE / 2);
    ctx.rotate((angle * Math.PI) / 180);
    for (let x = -SHARE_SIZE; x < SHARE_SIZE; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, -SHARE_SIZE);
      ctx.lineTo(x, SHARE_SIZE);
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();

  // La ligne bleue, en filigrane.
  const line = ctx.createLinearGradient(0, 300, 0, 308);
  line.addColorStop(0, 'rgba(53,116,214,0.22)');
  line.addColorStop(1, 'rgba(26,79,168,0.22)');
  ctx.fillStyle = line;
  ctx.fillRect(0, 300, SHARE_SIZE, 8);
}

function paintCard(ctx: CanvasRenderingContext2D, outcome: BetSlip['outcome']): void {
  // Le givre. `backdrop-filter` n'existe pas sur un canvas : on repose le même
  // dégradé translucide que `.icy-card`, ce qui donne le même résultat ici
  // puisque le fond derrière est déjà sombre et lisse.
  const frost = ctx.createLinearGradient(CARD.x, CARD.y, CARD.x + CARD.w, CARD.y + CARD.h);
  frost.addColorStop(0,    'rgba(220,245,255,0.14)');
  frost.addColorStop(0.45, 'rgba(150,205,240,0.06)');
  frost.addColorStop(1,    'rgba(235,250,255,0.12)');

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 60;
  ctx.shadowOffsetY = 20;
  roundRectPath(ctx, CARD.x, CARD.y, CARD.w, CARD.h, CARD.r);
  ctx.fillStyle = frost;
  ctx.fill();
  ctx.restore();

  // Le liseré porte l'ISSUE — pas l'anneau. Vert si gagné, rouge si perdu,
  // blanc translucide tant que le coupon est en attente.
  roundRectPath(ctx, CARD.x, CARD.y, CARD.w, CARD.h, CARD.r);
  ctx.strokeStyle = outcome === 'win'  ? 'rgba(74,222,128,0.45)'
                  : outcome === 'loss' ? 'rgba(248,113,113,0.45)'
                  : 'rgba(255,255,255,0.40)';
  ctx.lineWidth = outcome === 'pending' ? 1 : 2;
  ctx.stroke();
}

function paintRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, pct: number | null, d: Density, caption: string): void {
  const stroke = Math.round(size * 0.06);
  const radius = size / 2 - stroke / 2 - 4;
  const color  = probabilityColor(pct ?? 0);

  ctx.lineWidth = stroke;
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.stroke();

  if (pct != null && pct > 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * pct) / 100);
    ctx.strokeStyle = color;
    ctx.stroke();
  }

  // Le nombre et son « % », composés ensemble pour rester centrés.
  const numText = pct != null ? String(pct) : '—';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `700 ${d.ringFont}px ${OSWALD}`;
  const wNum = ctx.measureText(numText).width;
  ctx.font = `400 ${d.pctFont}px ${OSWALD}`;
  const wPct = pct != null ? ctx.measureText('%').width : 0;

  const startX  = cx - (wNum + wPct) / 2;
  const baseline = cy + d.ringFont * 0.30;

  ctx.textAlign = 'left';
  ctx.font = `700 ${d.ringFont}px ${OSWALD}`;
  ctx.fillStyle = INK.white;
  ctx.fillText(numText, startX, baseline);

  if (pct != null) {
    ctx.font = `400 ${d.pctFont}px ${OSWALD}`;
    ctx.fillStyle = color;
    ctx.fillText('%', startX + wNum, baseline - d.ringFont * 0.42);
  }

  ctx.textAlign = 'center';
  ctx.font = `400 ${d.capFont}px ${INTER}`;
  ctx.fillStyle = INK.muted;
  ctx.fillText(caption, cx, cy + size * 0.30);
}

/** Une pastille arrondie (issue, XP). Rend la largeur occupée. */
function paintPill(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, tint: string, border: string): number {
  ctx.font = `700 21px ${INTER}`;
  const w = ctx.measureText(text).width + 40;
  const h = 42;
  roundRectPath(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = tint;
  ctx.fill();
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 20, y + h / 2 + 1);
  return w;
}

// ─── Le rendu ─────────────────────────────────────────────────────────────────

/**
 * Dessine le coupon et rend un PNG.
 *
 * Ne lit ni le DOM de la page ni le réseau : la même entrée donne toujours la
 * même image, que la carte soit à l'écran ou non.
 */
export async function renderSlipShareCard(slip: BetSlip, labels: SlipShareLabels): Promise<Blob> {
  await ensureFonts();

  const canvas = document.createElement('canvas');
  canvas.width  = SHARE_SIZE;
  canvas.height = SHARE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ShareRenderError('no_2d_context');

  const legs = Array.isArray(slip.legs) ? slip.legs : [];
  const d = densityFor(legs.length);

  paintIce(ctx);
  paintCard(ctx, slip.outcome);

  // ── En-tête ────────────────────────────────────────────────────────────────
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = `700 32px ${OSWALD}`;
  ctx.fillStyle = INK.accent;
  fillTracked(ctx, 'ARAKICE', INNER.x, INNER.y + 26, 32 * 0.16);

  ctx.textAlign = 'right';
  ctx.font = `400 23px ${INTER}`;
  ctx.fillStyle = INK.dim;
  ctx.fillText(fitText(ctx, labels.dateLine, INNER.w * 0.55), INNER.x + INNER.w, INNER.y + 26);

  // ── L'anneau ───────────────────────────────────────────────────────────────
  const cx = INNER.x + INNER.w / 2;
  const ringTop = INNER.y + 34 + 30;
  paintRing(ctx, cx, ringTop + d.ring / 2, d.ring, slip.combinedProbability, d, labels.combined);

  let y = ringTop + d.ring + 20;

  // ── Le résumé ──────────────────────────────────────────────────────────────
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `400 ${d.summaryFont}px ${INTER}`;
  ctx.fillStyle = INK.muted;
  ctx.fillText(fitText(ctx, labels.summary, INNER.w), cx, y + d.summaryFont);
  y += d.summaryFont + 8;

  // ── Issue + XP ─────────────────────────────────────────────────────────────
  if (labels.outcome || labels.xp) {
    const won = slip.outcome === 'win';
    ctx.font = `700 21px ${INTER}`;
    const wOutcome = labels.outcome ? ctx.measureText(labels.outcome).width + 40 : 0;
    const wXp      = labels.xp      ? ctx.measureText(labels.xp).width      + 40 : 0;
    const gap      = labels.outcome && labels.xp ? 14 : 0;
    let px = cx - (wOutcome + gap + wXp) / 2;
    const py = y + 14;

    if (labels.outcome) {
      px += paintPill(ctx, px, py, labels.outcome,
        won ? INK.win : INK.loss,
        won ? 'rgba(74,222,128,0.12)' : 'rgba(248,113,113,0.12)',
        won ? 'rgba(74,222,128,0.35)' : 'rgba(248,113,113,0.35)') + gap;
    }
    if (labels.xp) {
      paintPill(ctx, px, py, labels.xp, INK.xp, 'rgba(250,204,21,0.10)', 'rgba(250,204,21,0.30)');
    }
    y = py + 42;
  }

  // ── Les sélections ─────────────────────────────────────────────────────────
  //
  // ⚠️ On calcule ce qui TIENT avant de dessiner. Un coupon à sept jambes ne
  // rapetisse pas jusqu'à l'illisible : il montre ce qu'il peut et annonce le
  // reste.
  const footerH = 30;
  const legsTop = y + 34;
  const avail   = INNER.bottom - footerH - 16 - legsTop;

  // On resserre AVANT de tronquer : tant qu'une ligne reste au-dessus du
  // plancher de lisibilité, mieux vaut cinq lignes serrées que trois lignes
  // aérées suivies d'un « + 4 autres » et d'un grand vide.
  let rowH = d.rowH;
  let rows = Math.max(1, Math.floor(avail / rowH));
  if (rows < legs.length) {
    rowH = Math.max(ROW_MIN, avail / legs.length);
    rows = Math.max(1, Math.floor(avail / rowH));
  }
  const truncated = legs.length > rows;
  const shown     = truncated ? legs.slice(0, Math.max(1, rows - 1)) : legs;
  // Étale les lignes retenues jusqu'au pied — sans jamais dépasser la hauteur
  // nominale, sinon un coupon d'une seule jambe se retrouverait avec une ligne
  // haute comme un tiers de la carte.
  const used = shown.length + (truncated ? 1 : 0);
  rowH = Math.min(d.rowH, avail / used);

  // Un coupon d'une ou deux jambes ne remplit pas la carte. Plutôt que de
  // laisser la liste collée sous l'anneau avec un grand vide sous elle, on la
  // CENTRE dans la place disponible : le bas de la carte respire au lieu d'être
  // troué. Sur un coupon plein, la marge est nulle et rien ne bouge.
  let ry = legsTop + Math.max(0, avail - rowH * used) / 2;
  for (const leg of shown) {
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(INNER.x, ry + 0.5);
    ctx.lineTo(INNER.x + INNER.w, ry + 0.5);
    ctx.stroke();

    const midY = ry + rowH / 2;

    // Le liseré d'équipe, à la place du logo.
    roundRectPath(ctx, INNER.x, midY - d.barH / 2, 5, d.barH, 3);
    ctx.fillStyle = legAccent(leg);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.stroke();

    const pctText = `${leg.probability}%`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${d.legPctFont}px ${OSWALD}`;
    ctx.fillStyle = INK.accent;
    ctx.fillText(pctText, INNER.x + INNER.w, midY);
    const pctW = ctx.measureText(pctText).width;

    const textX = INNER.x + 31;
    const textW = INNER.w - 31 - pctW - 26;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `600 ${d.nameFont}px ${INTER}`;
    ctx.fillStyle = INK.white;
    ctx.fillText(fitText(ctx, leg.subjectName ?? '', textW), textX, midY - 4);

    ctx.font = `400 ${d.marketFont}px ${INTER}`;
    ctx.fillStyle = INK.muted;
    ctx.fillText(fitText(ctx, leg.selection ?? leg.marketType ?? '', textW), textX, midY + d.marketFont + 2);

    ry += rowH;
  }

  if (truncated) {
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(INNER.x, ry + 0.5);
    ctx.lineTo(INNER.x + INNER.w, ry + 0.5);
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `400 ${d.marketFont}px ${INTER}`;
    ctx.fillStyle = INK.dim;
    ctx.fillText(labels.moreLegs(legs.length - shown.length), INNER.x + 31, ry + rowH / 2);
    ry += rowH;
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(INNER.x, ry + 0.5);
  ctx.lineTo(INNER.x + INNER.w, ry + 0.5);
  ctx.stroke();

  // ── Pied ───────────────────────────────────────────────────────────────────
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = `400 22px ${INTER}`;
  ctx.fillStyle = INK.dim;
  ctx.fillText(fitText(ctx, labels.disclaimer, INNER.w * 0.62), INNER.x, INNER.bottom);

  ctx.font = `600 25px ${OSWALD}`;
  ctx.fillStyle = INK.accent;
  fillTracked(ctx, 'arakice.com', INNER.x + INNER.w, INNER.bottom, 25 * 0.10, 'right');

  return canvasToBlob(canvas);
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (!canvas.toBlob) { reject(new ShareRenderError('no_to_blob')); return; }
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new ShareRenderError('null_blob'))),
      'image/png',
    );
  });
}
