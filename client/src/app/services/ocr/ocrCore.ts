/**
 * ocrCore.ts — SCAN_TICKET_PLAN § 2. Le cœur PUR de la couche OCR.
 *
 * Aucune API du navigateur, aucun import autre que `import type` : ce fichier
 * est utilisé tel quel par le navigateur (tesseractOcr.ts) ET par le banc de
 * mesure Node (`client/scripts/ocr-bench/`, Node ≥ 22.18 lit le TypeScript),
 * pour que le banc mesure exactement le pipeline livré.
 */
import type { OcrLine } from '../../../../../server/src/services/ocrTypes';

// ── Prétraitement (§ 2.2) ───────────────────────────────────────────────────

/** Une image RGBA brute (même forme qu'`ImageData`). */
export interface RgbaImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/**
 * Largeur visée après agrandissement. Tesseract lit le mieux des lettres de
 * ~30-40 px ; une capture d'iPhone (1179-1320 px de large) y est presque déjà.
 * On agrandit donc jusqu'à ×2 (plan § 2.2), mais pas au-delà de cette largeur :
 * ×2 sur une capture 3x donne 12 Mpx et double le temps sans rien gagner.
 */
export const OCR_TARGET_WIDTH = 2200;
export const OCR_MAX_SCALE = 2;

export function ocrScale(width: number): number {
  return Math.max(1, Math.min(OCR_MAX_SCALE, OCR_TARGET_WIDTH / Math.max(1, width)));
}

export interface PreprocessInfo {
  /** Fond sombre détecté → image inversée. */
  inverted: boolean;
  /** Luminance moyenne avant inversion (0..255). */
  meanLuma: number;
}

/**
 * Niveaux de gris, inversion si fond sombre, étirement du contraste.
 * Modifie `img.data` EN PLACE (RGBA, alpha forcé à 255). L'agrandissement est
 * fait avant, par le canvas (navigateur) ou par l'appelant (banc).
 *
 * Pourquoi pas une vraie binarisation : Tesseract fait déjà son propre seuil
 * (Otsu) ; un seuil dur ici casse les cotes en couleur (vert / jaune sur fond
 * sombre) et les lettres fines. On pousse seulement les tons vers les extrêmes
 * (« binarisation légère »).
 */
export function preprocessRgba(img: RgbaImage): PreprocessInfo {
  const { data } = img;
  const n = img.width * img.height;
  const luma = new Uint8Array(n);
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    // Rec. 601 — le vert pèse lourd : une cote verte sur fond sombre reste claire.
    const y = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114 + 500) / 1000 | 0;
    luma[i] = y;
    hist[y]++;
    sum += y;
  }
  const meanLuma = n ? sum / n : 255;
  const inverted = meanLuma < 128;

  // Étirement entre les centiles 1 % et 99 % (après inversion éventuelle).
  const lo = percentile(hist, n, inverted ? 0.99 : 0.01);
  const hi = percentile(hist, n, inverted ? 0.01 : 0.99);
  // Bornes exprimées APRÈS inversion : a = encre (noir visé), b = fond (blanc visé).
  const a = inverted ? 255 - lo : lo;
  const b = inverted ? 255 - hi : hi;
  const span = Math.max(1, b - a);

  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const x = inverted ? 255 - v : v;
    let t = (x - a) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    // Courbe en S douce (smoothstep) : la « binarisation légère ».
    t = t * t * (3 - 2 * t);
    lut[v] = Math.round(t * 255);
  }
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = lut[luma[i]];
    data[p] = v; data[p + 1] = v; data[p + 2] = v; data[p + 3] = 255;
  }
  return { inverted, meanLuma };
}

function percentile(hist: Uint32Array, n: number, q: number): number {
  const target = q * n;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 255;
}

// ── Sortie Tesseract → OcrLine[] ────────────────────────────────────────────

/** Le strict nécessaire de `Tesseract.Page` (évite d'importer tesseract.js ici). */
export interface TesseractPageLike {
  blocks: Array<{
    paragraphs: Array<{
      lines: Array<{
        text: string;
        confidence: number;
        bbox: { x0: number; y0: number; x1: number; y1: number };
      }>;
    }>;
  }> | null;
}

/** Lignes Tesseract (coordonnées de l'image agrandie) → lignes en pixels d'origine. */
export function tesseractLines(page: TesseractPageLike, scale: number, minConfidence = 0.3): OcrLine[] {
  const out: OcrLine[] = [];
  for (const block of page.blocks ?? []) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        const text = line.text.replace(/\s+/g, ' ').trim();
        const confidence = line.confidence / 100;
        // Le bruit (icônes, logos lus comme « Q@ ») sort à faible confiance.
        if (!text || confidence < minConfidence) continue;
        const { x0, y0, x1, y1 } = line.bbox;
        out.push({
          text,
          confidence: round3(confidence),
          box: {
            x: Math.round(x0 / scale),
            y: Math.round(y0 / scale),
            w: Math.round((x1 - x0) / scale),
            h: Math.round((y1 - y0) / scale),
          },
        });
      }
    }
  }
  return sortOcrLines(out);
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

// ── Tri ─────────────────────────────────────────────────────────────────────

/**
 * Tri canonique : par rangées (deux lignes dont les centres verticaux sont à
 * moins d'une demi-hauteur sont sur la même rangée), puis de gauche à droite.
 * Fait en deux temps (regroupement puis tri) pour rester transitif.
 */
export function sortOcrLines(lines: OcrLine[]): OcrLine[] {
  const byY = [...lines].sort((a, b) => (a.box.y + a.box.h / 2) - (b.box.y + b.box.h / 2));
  const rows: OcrLine[][] = [];
  let rowCenter = -Infinity;
  let rowHalf = 0;
  for (const l of byY) {
    const c = l.box.y + l.box.h / 2;
    if (rows.length && c - rowCenter <= Math.min(rowHalf, l.box.h / 2)) {
      rows[rows.length - 1].push(l);
    } else {
      rows.push([l]);
      rowCenter = c;
      rowHalf = l.box.h / 2;
    }
  }
  return rows.flatMap((r) => r.sort((a, b) => a.box.x - b.box.x));
}
