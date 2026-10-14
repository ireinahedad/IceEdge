/**
 * ocrService.ts — SCAN_TICKET_PLAN § 2. Point d'entrée unique de l'OCR.
 *
 *   recognize(image) → { lines: { text, box, confidence }[], width, height }
 *
 * 100 % sur l'appareil, gratuit, illimité : l'image ne quitte JAMAIS le
 * téléphone (ni le navigateur).
 *   - iOS : Apple Vision via le plugin natif `VisionOcr`
 *     (ios/App/App/VisionOcrPlugin.swift).
 *   - Web : Tesseract.js, chargé à la demande (tesseractOcr.ts).
 *
 * Le choix est fait à la COMPILATION (`isIOS`, platform.ts) : la branche morte
 * disparaît du code. Rollup émet quand même le petit chunk de l'autre moteur
 * (import dynamique), jamais chargé ; le gros de Tesseract (wasm, données de
 * langue, public/ocr/) n'est pas dans le build iOS (build-ios.mjs l'élague).
 */
import { isIOS } from '../../platform';
import type { OcrResult } from '../../../../../server/src/services/ocrTypes';

export type { OcrBox, OcrLine, OcrResult, OcrEngine } from '../../../../../server/src/services/ocrTypes';

/** Au-delà, ce n'est pas une capture d'écran (et Tesseract y passerait trop de temps). */
export const OCR_MAX_BYTES = 15 * 1024 * 1024;

export type OcrErrorCode = 'not_image' | 'too_large' | 'failed';

export class OcrError extends Error {
  constructor(public readonly code: OcrErrorCode, cause?: unknown) {
    super(`ocr: ${code}`);
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export async function recognize(image: Blob): Promise<OcrResult> {
  if (!image.type.startsWith('image/')) throw new OcrError('not_image');
  if (image.size > OCR_MAX_BYTES) throw new OcrError('too_large');
  try {
    if (isIOS) {
      const { recognizeWithVision } = await import('./visionOcr');
      return await recognizeWithVision(image);
    }
    const { recognizeWithTesseract } = await import('./tesseractOcr');
    return await recognizeWithTesseract(image);
  } catch (err) {
    if (err instanceof OcrError) throw err;
    throw new OcrError('failed', err);
  }
}
