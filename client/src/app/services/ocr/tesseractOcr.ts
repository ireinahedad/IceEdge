/**
 * tesseractOcr.ts — SCAN_TICKET_PLAN § 2.2. OCR du web (repli), sur l'appareil.
 *
 * Chargé UNIQUEMENT par `import()` dynamique depuis ocrService.ts au premier
 * scan : tesseract.js (et ses ~4 Mo de wasm + ~3 Mo de données de langue) ne
 * pèse rien sur le bundle principal ni sur le LCP.
 *
 * Tout est auto-hébergé dans /ocr/ (copié par scripts/ocr-assets.mjs) : pas de
 * CDN (CSP + disponibilité). Le worker est un vrai fichier (`workerBlobURL:
 * false`) : la CSP n'autorise pas les workers `blob:`.
 *
 * ⚠️ Le wasm exige `'wasm-unsafe-eval'` dans `script-src` (vercel.json).
 */
import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import type { OcrResult } from '../../../../../server/src/services/ocrTypes';
import { ocrScale, preprocessRgba, tesseractLines } from './ocrCore';

const ASSETS = '/ocr';

/** Libère le worker (~100 Mo de mémoire wasm) après une minute sans scan. */
const IDLE_MS = 60_000;

let workerPromise: Promise<Worker> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function getWorker(): Promise<Worker> {
  clearTimeout(idleTimer);
  workerPromise ??= (async () => {
    const w = await createWorker('eng', OEM.LSTM_ONLY, {
      workerPath: `${ASSETS}/worker.min.js`,
      corePath: ASSETS, // le worker choisit la variante (simd / relaxed-simd / simple)
      langPath: ASSETS, // eng.traineddata.gz
      workerBlobURL: false,
      // IndexedDB : les données de langue ne sont téléchargées qu'une fois.
      cacheMethod: 'write',
    });
    await w.setParameters({
      // SPARSE_TEXT : chaque texte isolé devient sa propre ligne, comme avec
      // Vision (« MTL Canadiens » et « Mer. 14 oct » séparés) — la segmentation
      // par boîtes de slipScan.ts est donc la même sur les deux moteurs. Mesuré
      // sur la 1re fixture : mêmes lignes de jambes qu'AUTO, colonnes mieux
      // séparées. À recontrôler au banc (scripts/ocr-bench) avec plus de captures.
      tessedit_pageseg_mode: PSM.SPARSE_TEXT,
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
    });
    return w;
  })().catch((err) => { workerPromise = null; throw err; });
  return workerPromise;
}

function scheduleIdle(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const p = workerPromise;
    workerPromise = null;
    void p?.then((w) => w.terminate()).catch(() => {});
  }, IDLE_MS);
}

/** Décode, agrandit et prépare l'image sur un canvas. */
async function prepare(image: Blob): Promise<{ canvas: HTMLCanvasElement; width: number; height: number; scale: number }> {
  const bitmap = await createImageBitmap(image);
  try {
    const { width, height } = bitmap;
    const scale = ocrScale(width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('canvas 2d unavailable');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    preprocessRgba(data);
    ctx.putImageData(data, 0, 0);
    return { canvas, width, height, scale };
  } finally {
    bitmap.close();
  }
}

export async function recognizeWithTesseract(image: Blob): Promise<OcrResult> {
  const t0 = performance.now();
  const [{ canvas, width, height, scale }, worker] = await Promise.all([prepare(image), getWorker()]);
  try {
    const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
    return {
      lines: tesseractLines(data, scale),
      width,
      height,
      engine: 'tesseract',
      ms: Math.round(performance.now() - t0),
    };
  } finally {
    scheduleIdle();
  }
}
