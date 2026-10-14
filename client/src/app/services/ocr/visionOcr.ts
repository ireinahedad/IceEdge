/**
 * visionOcr.ts — SCAN_TICKET_PLAN § 2.1. Pont JS du plugin natif `VisionOcr`
 * (ios/App/App/VisionOcrPlugin.swift, enregistré dans MainViewController).
 *
 * Le natif reçoit l'image en base64 (le pont Capacitor ne transporte que du
 * JSON) et renvoie des lignes déjà en pixels, origine en haut à gauche — même
 * format que Tesseract, donc la segmentation (slipScan.ts) est partagée.
 *
 * ⚠️ Ne jamais RENVOYER `VisionOcr` depuis une fonction async — un plugin
 * Capacitor est un Proxy qui répond à `.then` (voir tokenStore.ts).
 */
import { registerPlugin } from '@capacitor/core';
import type { OcrLine, OcrResult } from '../../../../../server/src/services/ocrTypes';
import { sortOcrLines } from './ocrCore';

interface VisionOcrPlugin {
  recognize(opts: { image: string }): Promise<{ lines: OcrLine[]; width: number; height: number; ms: number }>;
}

const VisionOcr = registerPlugin<VisionOcrPlugin>('VisionOcr');

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function recognizeWithVision(image: Blob): Promise<OcrResult> {
  const t0 = performance.now();
  const res = await VisionOcr.recognize({ image: await toBase64(image) });
  return {
    lines: sortOcrLines(res.lines),
    width: res.width,
    height: res.height,
    engine: 'vision',
    ms: Math.round(performance.now() - t0),
  };
}
