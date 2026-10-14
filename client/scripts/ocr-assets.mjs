/**
 * ocr-assets.mjs — SCAN_TICKET_PLAN § 2.2. Copie dans public/ocr/ ce dont
 * Tesseract.js a besoin dans le navigateur, depuis node_modules :
 *
 *   worker.min.js                          le Web Worker (tesseract.js)
 *   tesseract-core{,-simd,-relaxedsimd}-lstm.wasm.js   le moteur (wasm embarqué)
 *   eng.traineddata.gz                     anglais, LSTM « best_int » (~3 Mo)
 *
 * Auto-hébergé, pas de CDN : la CSP n'autorise que 'self', et le scan ne doit
 * pas dépendre de jsdelivr. Les fichiers ne sont PAS versionnés (public/ocr/ est
 * dans .gitignore) : ils viennent toujours de la version installée, donc worker,
 * moteur et bibliothèque ne peuvent pas diverger.
 *
 * Lancé avant `dev`, `start` et `build` (package.json). Le build iOS ne les
 * embarque pas : build-ios.mjs ne garde pas /ocr/ (Vision fait l'OCR sur iOS).
 */
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "public", "ocr");

const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));
const tess = pkgDir("tesseract.js");
const core = pkgDir("tesseract.js-core");
const eng = pkgDir("@tesseract.js-data/eng");

const FILES = [
  [join(tess, "dist", "worker.min.js"), "worker.min.js"],
  [join(core, "tesseract-core-lstm.wasm.js"), "tesseract-core-lstm.wasm.js"],
  [join(core, "tesseract-core-simd-lstm.wasm.js"), "tesseract-core-simd-lstm.wasm.js"],
  [join(core, "tesseract-core-relaxedsimd-lstm.wasm.js"), "tesseract-core-relaxedsimd-lstm.wasm.js"],
  [join(eng, "4.0.0_best_int", "eng.traineddata.gz"), "eng.traineddata.gz"],
];

mkdirSync(OUT, { recursive: true });
let copied = 0;
for (const [from, name] of FILES) {
  const to = join(OUT, name);
  let same = false;
  try {
    const a = statSync(from), b = statSync(to);
    same = a.size === b.size && b.mtimeMs >= a.mtimeMs;
  } catch { /* absent */ }
  if (!same) { copyFileSync(from, to); copied++; }
}
console.log(`ocr-assets: public/ocr/ ${copied ? `${copied} fichier(s) copié(s)` : "à jour"}`);
