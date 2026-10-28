/**
 * scanShareCanvas.ts — la carte « Parlay Tax » d'un ticket scanné (plan de croissance,
 * « The Parlay Tax Engine »). Même mise en page que les cartes de la semaine 1
 * (`server/scripts/grade-card.ts`) : jambes, maillon faible, PAYÉ / JUSTE, la taxe en gros.
 *
 * Dessinée sur un `<canvas>`, comme `slipShareCanvas.ts` et pour les mêmes raisons :
 * aucune feuille de style lue, aucune image distante, aucun logo. 1080×1350 (4:5) :
 * le format qui prend le plus de place dans les fils X / Bluesky / Instagram.
 *
 * Les textes sont FOURNIS par l'appelant (déjà traduits) : ce module reste libre de React.
 * Règles de contenu (MARKETING_PLAN §2) : aucun bookmaker nommé, mention 18+, arakice.com.
 */

const W = 1080;
const H = 1350;

const INK = {
  bg: '#0A0E0C', surface: '#131A12', line: '#22301F', accent: '#90C9F0',
  text: '#BFC8CC', bright: '#E8EEF0', muted: '#8A9EA6', positive: '#4ADE80', negative: '#F87171',
};
const INTER = "'Inter', system-ui, sans-serif";

export interface ScanShareCard {
  /** « TOR @ EDM », ou vide. */
  game: string;
  /** Libellés des jambes, dans l'ordre du ticket (8 au plus affichées). */
  legs: string[];
  /** Index (0-based) du maillon faible, ou null. */
  weakest: number | null;
  paidOdds: string;
  fairOdds: string;
  /** « Taxe de 27 % sur le combiné ». */
  headline: string;
  tone: 'tax' | 'fair' | 'value';
  /** « arakiceML : 10,5 % de chances… ». */
  detail: string;
  labels: { brand: string; weakest: string; paid: string; fair: string; disclaimer: string; more: (n: number) => string };
}

function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Coupe le texte à la largeur donnée, avec « … ». */
function fit(ctx: CanvasRenderingContext2D, s: string, max: number): string {
  if (ctx.measureText(s).width <= max) return s;
  let t = s;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

/** Lignes d'un paragraphe à la largeur donnée (au plus `maxLines`). */
function wrap(ctx: CanvasRenderingContext2D, s: string, max: number, maxLines: number): string[] {
  const words = s.split(/\s+/);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width <= max) cur = next;
    else { if (cur) out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  if (out.length > maxLines) {
    const kept = out.slice(0, maxLines);
    kept[maxLines - 1] = fit(ctx, `${kept[maxLines - 1]} ${out.slice(maxLines).join(' ')}`, max);
    return kept;
  }
  return out;
}

async function ensureFonts(): Promise<void> {
  const fonts = document.fonts;
  if (!fonts?.load) return;
  try {
    await Promise.all([fonts.load(`800 92px ${INTER}`), fonts.load(`600 36px ${INTER}`), fonts.load(`400 30px ${INTER}`)]);
    await fonts.ready;
  } catch { /* repli visuel, jamais un échec */ }
}

export async function renderScanShareCard(c: ScanShareCard): Promise<Blob> {
  await ensureFonts();
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('share_render_failed: no 2d context');

  const L = 80;
  const R = W - 80;

  ctx.fillStyle = INK.bg;
  ctx.fillRect(0, 0, W, H);
  const halo = ctx.createRadialGradient(W / 2, 120, 40, W / 2, 120, 760);
  halo.addColorStop(0, 'rgba(144, 201, 240, 0.10)');
  halo.addColorStop(1, 'rgba(144, 201, 240, 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';

  // Marque
  ctx.font = `700 30px ${INTER}`;
  ctx.fillStyle = INK.accent;
  ctx.fillText('ARAKICE', L, 120);
  const bw = ctx.measureText('ARAKICE  ').width;
  ctx.fillStyle = INK.muted;
  ctx.font = `500 30px ${INTER}`;
  ctx.fillText(`· ${c.labels.brand}`, L + bw, 120);

  let y = 196;
  if (c.game) {
    ctx.font = `600 34px ${INTER}`;
    ctx.fillStyle = INK.muted;
    ctx.fillText(fit(ctx, c.game, R - L), L, y);
    y += 30;
  }

  // Jambes
  const shown = c.legs.slice(0, c.legs.length > 8 ? 7 : 8);
  const rowH = shown.length > 5 ? 72 : 88;
  shown.forEach((leg, i) => {
    const top = y + i * (rowH + 12);
    const weak = c.weakest === i;
    rounded(ctx, L, top, R - L, rowH, 18);
    ctx.fillStyle = INK.surface;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = weak ? INK.negative : INK.line;
    ctx.stroke();
    ctx.fillStyle = INK.line;
    ctx.beginPath();
    ctx.arc(L + 48, top + rowH / 2, 23, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = INK.muted;
    ctx.font = `600 24px ${INTER}`;
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), L + 48, top + rowH / 2 + 9);
    ctx.textAlign = 'left';
    let tagW = 0;
    if (weak) {
      ctx.font = `700 22px ${INTER}`;
      const tag = c.labels.weakest.toUpperCase();
      tagW = ctx.measureText(tag).width + 24;
      ctx.fillStyle = INK.negative;
      ctx.fillText(tag, R - 24 - ctx.measureText(tag).width, top + rowH / 2 + 8);
    }
    ctx.font = `600 ${rowH > 80 ? 34 : 30}px ${INTER}`;
    ctx.fillStyle = INK.bright;
    ctx.fillText(fit(ctx, leg, R - L - 110 - tagW), L + 96, top + rowH / 2 + 12);
  });
  y += shown.length * (rowH + 12);
  if (c.legs.length > shown.length) {
    ctx.font = `500 26px ${INTER}`;
    ctx.fillStyle = INK.muted;
    ctx.fillText(c.labels.more(c.legs.length - shown.length), L, y + 30);
  }

  // PAYÉ / JUSTE
  const boxTop = 790;
  const boxW = (R - L - 24) / 2;
  const box = (x: number, k: string, v: string, color: string) => {
    rounded(ctx, x, boxTop, boxW, 170, 22);
    ctx.lineWidth = 2;
    ctx.strokeStyle = INK.line;
    ctx.stroke();
    ctx.font = `700 24px ${INTER}`;
    ctx.fillStyle = INK.muted;
    ctx.fillText(k.toUpperCase(), x + 30, boxTop + 48);
    ctx.font = `800 76px ${INTER}`;
    ctx.fillStyle = color;
    ctx.fillText(fit(ctx, v, boxW - 60), x + 30, boxTop + 136);
  };
  box(L, c.labels.paid, c.paidOdds, INK.bright);
  box(L + boxW + 24, c.labels.fair, c.fairOdds, INK.accent);

  // La taxe en gros
  const tone = c.tone === 'tax' ? INK.negative : c.tone === 'value' ? INK.positive : INK.accent;
  // Une ligne si elle tient à 72 px ou plus ; sinon DEUX lignes à 64 px — jamais tronqué.
  let size = 92;
  ctx.font = `800 ${size}px ${INTER}`;
  while (size > 72 && ctx.measureText(c.headline).width > R - L) { size -= 4; ctx.font = `800 ${size}px ${INTER}`; }
  ctx.fillStyle = tone;
  let detailTop = 1118;
  if (ctx.measureText(c.headline).width <= R - L) {
    ctx.fillText(c.headline, L, 1062);
  } else {
    ctx.font = `800 64px ${INTER}`;
    const lines = wrap(ctx, c.headline, R - L, 2);
    if (lines.length === 1) ctx.fillText(lines[0], L, 1062);
    else { lines.forEach((line, i) => ctx.fillText(line, L, 1034 + i * 68)); detailTop = 1156; }
  }

  ctx.font = `400 ${detailTop > 1118 ? 28 : 30}px ${INTER}`;
  ctx.fillStyle = INK.text;
  wrap(ctx, c.detail, R - L, 2).forEach((line, i) => ctx.fillText(line, L, detailTop + i * 36));

  // Pied
  ctx.strokeStyle = INK.line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(L, 1232);
  ctx.lineTo(R, 1232);
  ctx.stroke();
  ctx.font = `700 22px ${INTER}`;
  ctx.fillStyle = INK.accent;
  ctx.fillText('arakice.com', L, 1280);
  ctx.font = `400 22px ${INTER}`;
  ctx.fillStyle = INK.muted;
  ctx.textAlign = 'right';
  ctx.fillText(fit(ctx, c.labels.disclaimer, R - L - 200), R, 1280);
  ctx.textAlign = 'left';

  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('share_render_failed: toBlob'))), 'image/png'));
}
