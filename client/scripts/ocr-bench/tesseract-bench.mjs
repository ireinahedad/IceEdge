/**
 * tesseract-bench.mjs — SCAN_TICKET_PLAN § 7 / S1. Banc de l'OCR.
 *
 *   npm run ocr:bench                       Tesseract sur chaque capture de images/,
 *                                           écrit ocr/tesseract/<nom>.json, puis note
 *                                           TOUS les moteurs présents (vision compris)
 *   npm run ocr:bench -- --score-only       note seulement les JSON existants
 *   npm run ocr:bench -- --psm 3            compare un autre mode (défaut : 11, comme le navigateur)
 *   npm run ocr:bench -- --raw              sans prétraitement (mesure ce qu'il apporte)
 *   npm run ocr:bench -- --no-write         ne touche pas aux fixtures
 *   npm run ocr:bench -- bet365-fr-dark-001 une seule fixture
 *
 * Même pipeline que le navigateur : ocrCore.ts (prétraitement, conversion des
 * lignes) est importé tel quel — Node ≥ 22.18 lit le TypeScript. Seul
 * l'agrandissement diffère (bilinéaire ici, canvas « high » dans le navigateur).
 *
 * Note (vérité : expected/<nom>.json) :
 *   lignes  = % des lignes `ticketText` retrouvées (exactes après normalisation,
 *             ou à ≤ 1 faute pour 12 caractères → « ~ »)
 *   cotes   = % des cotes de groupe lues EXACTEMENT (une cote fausse = jambe fausse)
 *   perso   = textes personnels lus (info : S2 devra les jeter)
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { createWorker, OEM, PSM } from "tesseract.js";
import { ocrScale, preprocessRgba, tesseractLines } from "../../src/app/services/ocr/ocrCore.ts";

const require = createRequire(import.meta.url);
const FIX = fileURLToPath(new URL("../../../server/src/services/__fixtures__/slipScan/", import.meta.url));
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const only = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--psm"));
/** Même valeur que tesseractOcr.ts. */
const DEFAULT_PSM = PSM.SPARSE_TEXT;
const psm = opt("--psm") ?? DEFAULT_PSM;
const raw = flag("--raw");
const write = !flag("--no-write") && !raw && psm === DEFAULT_PSM;

// ── images ──────────────────────────────────────────────────────────────────

function decode(file) {
  const buf = readFileSync(file);
  const ext = extname(file).toLowerCase();
  if (ext === ".png") { const p = PNG.sync.read(buf); return { data: p.data, width: p.width, height: p.height }; }
  if (ext === ".jpg" || ext === ".jpeg") return jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
  throw new Error(`format non géré par le banc : ${ext}`);
}

function resizeBilinear(img, scale) {
  if (scale === 1) return { ...img, data: new Uint8ClampedArray(img.data) };
  const W = Math.round(img.width * scale), H = Math.round(img.height * scale);
  const out = new Uint8ClampedArray(W * H * 4);
  const sx = img.width / W, sy = img.height / H;
  for (let y = 0; y < H; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5), y0 = fy | 0, y1 = Math.min(img.height - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5), x0 = fx | 0, x1 = Math.min(img.width - 1, x0 + 1), tx = fx - x0;
      const a = (y0 * img.width + x0) * 4, b = (y0 * img.width + x1) * 4, c = (y1 * img.width + x0) * 4, d = (y1 * img.width + x1) * 4;
      const o = (y * W + x) * 4;
      for (let k = 0; k < 4; k++) {
        out[o + k] = (img.data[a + k] * (1 - tx) + img.data[b + k] * tx) * (1 - ty) + (img.data[c + k] * (1 - tx) + img.data[d + k] * tx) * ty;
      }
    }
  }
  return { data: out, width: W, height: H };
}

function encodePng(img) {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return PNG.sync.write(png);
}

// ── notation ────────────────────────────────────────────────────────────────

const norm = (s) => s.normalize("NFKC").toLowerCase().replace(/[‐-―−]/g, "-").replace(/\s+/g, " ").trim();

function dist(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/** 'exact' | 'near' | null — `want` cherché dans les lignes OCR (ou une sous-chaîne d'une ligne). */
function find(want, lines) {
  const w = norm(want);
  const texts = lines.map((l) => norm(l.text));
  if (texts.some((t) => t === w || t.includes(w))) return "exact";
  const tol = Math.max(1, Math.floor(w.length / 12));
  for (const t of texts) {
    if (dist(t, w) <= tol) return "near";
    // sous-chaîne approximative : fenêtres de la longueur voulue
    for (let i = 0; i + w.length <= t.length; i++) if (dist(t.slice(i, i + w.length), w) <= tol) return "near";
  }
  return null;
}

/** Une cote doit être lue à l'identique, en mot entier. */
function findOdds(odds, lines) {
  const re = new RegExp(`(^|[^\\d.])${odds.replace(/[.+/]/g, "\\$&")}($|[^\\d])`);
  return lines.some((l) => re.test(norm(l.text).replace(/\s/g, "")) || re.test(norm(l.text)));
}

function score(expected, res) {
  const wantLines = expected.groups.flatMap((g) => g.legs.flatMap((l) => l.ticketText));
  const found = wantLines.map((w) => ({ w, r: find(w, res.lines) }));
  const odds = expected.groups.map((g) => g.odds).filter(Boolean);
  const oddsOk = odds.filter((o) => findOdds(o, res.lines));
  const personal = expected.personal.filter((p) => find(p, res.lines));
  return {
    lines: found.filter((f) => f.r).length / Math.max(1, found.length),
    exact: found.filter((f) => f.r === "exact").length / Math.max(1, found.length),
    odds: oddsOk.length / Math.max(1, odds.length),
    missing: [...found.filter((f) => !f.r).map((f) => `ligne « ${f.w} »`), ...odds.filter((o) => !oddsOk.includes(o)).map((o) => `cote ${o}`)],
    personal: personal.length,
    ms: res.ms,
  };
}

/** Une ligne OCR par ligne de fichier : diffs lisibles dans git. */
export function serialize(res) {
  const { lines, ...head } = res;
  return `{\n "engine": ${JSON.stringify(head.engine)}, "width": ${head.width}, "height": ${head.height}, "ms": ${head.ms},\n "lines": [\n`
    + lines.map((l) => `  ${JSON.stringify(l)}`).join(",\n") + "\n ]\n}\n";
}

// ── run ─────────────────────────────────────────────────────────────────────

const pct = (x) => `${Math.round(x * 100)} %`.padStart(6);
const names = readdirSync(join(FIX, "expected")).filter((f) => f.endsWith(".json")).map((f) => basename(f, ".json"))
  .filter((n) => !only.length || only.includes(n)).sort();
if (!names.length) { console.log("Aucune fixture (expected/*.json)."); process.exit(0); }

let worker;
if (!flag("--score-only")) {
  const eng = join(require.resolve("@tesseract.js-data/eng/package.json"), "..", "4.0.0_best_int");
  worker = await createWorker("eng", OEM.LSTM_ONLY, { langPath: eng, cacheMethod: "none", gzip: true });
  await worker.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: "1", user_defined_dpi: "300" });
}

const totals = {};
console.log(`\nBanc OCR — ${names.length} fixture(s)${worker ? ` · Tesseract PSM ${psm}${raw ? " · SANS prétraitement" : ""}` : ""}\n`);
for (const name of names) {
  const expected = JSON.parse(readFileSync(join(FIX, "expected", `${name}.json`), "utf8"));
  const results = {};

  const image = [".png", ".jpg", ".jpeg"].map((e) => join(FIX, "images", name + e)).find(existsSync);
  if (worker && image) {
    const t0 = performance.now();
    const src = decode(image);
    const scale = ocrScale(src.width);
    const img = resizeBilinear(src, scale);
    if (!raw) preprocessRgba(img);
    const { data } = await worker.recognize(encodePng(img), {}, { blocks: true, text: false });
    results.tesseract = { lines: tesseractLines(data, scale), width: src.width, height: src.height, engine: "tesseract", ms: Math.round(performance.now() - t0) };
    if (write) {
      mkdirSync(join(FIX, "ocr", "tesseract"), { recursive: true });
      writeFileSync(join(FIX, "ocr", "tesseract", `${name}.json`), serialize(results.tesseract));
    }
    if (flag("--dump")) for (const l of results.tesseract.lines) console.log(`   ${String(Math.round(l.confidence * 100)).padStart(3)}  ${l.text}`);
  }
  for (const engine of ["tesseract", "vision"]) {
    const p = join(FIX, "ocr", engine, `${name}.json`);
    if (!results[engine] && existsSync(p)) results[engine] = JSON.parse(readFileSync(p, "utf8"));
  }
  if (!Object.keys(results).length) { console.log(`${name}: ni image ni JSON OCR — ignorée`); continue; }

  console.log(name);
  for (const [engine, res] of Object.entries(results)) {
    const s = score(expected, res);
    (totals[engine] ??= []).push(s);
    console.log(`  ${engine.padEnd(9)} lignes${pct(s.lines)} (exactes${pct(s.exact)})  cotes${pct(s.odds)}  perso lus ${s.personal}  ${String(s.ms).padStart(5)} ms`);
    for (const m of s.missing) console.log(`            ✗ ${m}`);
  }
}

console.log("\nMoyennes");
for (const [engine, list] of Object.entries(totals)) {
  const avg = (k) => list.reduce((a, s) => a + s[k], 0) / list.length;
  console.log(`  ${engine.padEnd(9)} lignes${pct(avg("lines"))} (exactes${pct(avg("exact"))})  cotes${pct(avg("odds"))}  ${Math.round(avg("ms"))} ms  (${list.length} capture(s))`);
}
await worker?.terminate();
