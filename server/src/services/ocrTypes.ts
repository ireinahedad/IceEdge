/**
 * ocrTypes.ts — SCAN_TICKET_PLAN § 2. Le format unique d'une lecture OCR.
 *
 * Produit sur l'appareil par `client/src/app/services/ocr/ocrService.ts`
 * (Apple Vision sur iOS, Tesseract.js sur le web), consommé par `slipScan.ts`
 * (S2), et sauvegardé tel quel dans les fixtures
 * (`__fixtures__/slipScan/ocr/<moteur>/<nom>.json`) pour tester le parseur sans OCR.
 *
 * Module de types pur : aucune dépendance, importable par le client (`import type`).
 */

/** Rectangle en PIXELS de l'image d'origine, origine en haut à gauche. */
export interface OcrBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrLine {
  /** Texte de la ligne tel que lu (pas de correction linguistique). */
  text: string;
  box: OcrBox;
  /** 0..1 (Vision : confiance du meilleur candidat ; Tesseract : confiance / 100). */
  confidence: number;
}

export type OcrEngine = 'vision' | 'tesseract';

export interface OcrResult {
  /** Lignes triées de haut en bas, puis de gauche à droite. */
  lines: OcrLine[];
  /** Taille de l'image d'origine, en pixels. */
  width: number;
  height: number;
  engine: OcrEngine;
  /** Durée de la reconnaissance (prétraitement compris), en ms. */
  ms: number;
}
