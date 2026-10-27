/**
 * grade-card.ts — carte « Parlay Tax » pour la semaine 1 du plan de croissance
 * ============================================================================
 * Claude Doc « ArakIce Growth Plan — The Parlay Tax Engine » (2026-10-27).
 *
 * Semaine 1 = test À LA MAIN, sans code produit : on note 20-25 combinés NHL
 * publics (X, Bluesky, Reddit) et on répond sous le post avec une carte. Ce
 * script fabrique la carte et la réponse ; le calcul vit dans
 * `src/services/content/parlayTax.ts` (pur, réutilisé plus tard par /grade).
 *
 * D'où vient --prob : refaire le ticket dans le COUPON de l'app ArakIce et lire
 * la probabilité du coupon (corrélations comprises). --weak = la jambe dont la
 * probabilité du modèle est la plus basse (son numéro, à partir de 1).
 *
 * Usage (depuis server/) :
 *   npm run grade:card -- --prob=10.5 --odds=+600 --legs="TOR ML|Over 6.5|Matthews 1+ goal" \
 *       --weak=2 --game="TOR @ EDM" --platform=x --url=https://x.com/...
 *   options : --note="2 player props treated as independent"  --out=nom-du-fichier
 *             --lang=fr  (carte et réponse en français ; anglais par défaut)
 *
 * Sorties : content/output/grade/<date>-<nom>.png (1080×1350, format 4:5 des fils
 * X/Bluesky), la réponse ≤ 280 car. dans la console, une ligne dans
 * content/output/grade/log.csv (journal du test). content/output/ est gitignoré.
 *
 * Règles (MARKETING_PLAN §2) : aucun bookmaker nommé, aucune promesse, mention
 * 18+ sur la carte et dans la réponse, aucun lien dans la réponse.
 */

import { promises as fs } from 'fs';
import path from 'path';
import {
  parlayTax, parseAmerican, formatAmerican, taxHeadline, gradeReply,
  gradeComplianceProblems, disclaimerFor, pctText, type ParlayTax, type GradeLang,
} from '../src/services/content/parlayTax';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'content', 'output', 'grade');
const LOGO = path.join(REPO_ROOT, 'content', 'assets', 'logo-360.png');
const FONT = path.join(REPO_ROOT, 'client', 'public', 'fonts', 'inter-latin-wght-normal.woff2');
const FONT_EXT = path.join(REPO_ROOT, 'client', 'public', 'fonts', 'inter-latin-ext-wght-normal.woff2');

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/s.exec(argv[i]);
    if (!m) continue;
    out[m[1]] = m[2] !== undefined ? m[2] : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
  }
  return out;
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const csv = (s: string | number) => `"${String(s).replace(/"/g, '""')}"`;
const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'slip';

async function dataUri(file: string, mime: string): Promise<string | null> {
  try { return `data:${mime};base64,${(await fs.readFile(file)).toString('base64')}`; } catch { return null; }
}

function cardHtml(o: {
  tax: ParlayTax; legs: string[]; weak: number | null; game: string; note: string;
  logo: string | null; font: string | null; fontExt: string | null; lang: GradeLang;
}): string {
  const { tax, lang } = o;
  const fr = lang === 'fr';
  const L = fr
    ? { sub: '· NOTE DU COMBINÉ', weak: 'maillon faible', paid: 'PAYÉ', fair: 'JUSTE (ARAKICEML)' }
    : { sub: '· PARLAY GRADE', weak: 'weakest', paid: 'PAID', fair: 'FAIR (ARAKICEML)' };
  const headline = taxHeadline(tax, lang);
  const headSize = headline.length > 34 ? 64 : headline.length > 22 ? 74 : 92;
  const tone = tax.verdict === 'tax' ? 'var(--negative)' : tax.verdict === 'value' ? 'var(--positive)' : 'var(--accent)';
  const per10 = (tax.expectedReturn * 10).toFixed(2);
  const expl = fr
    ? `arakiceML : <b>${pctText(tax.modelPct, lang)}</b> de chances, corrélations comprises. Le prix implique ${pctText(tax.bookImpliedPct, lang)}. Retour espéré : ${per10.replace('.', ',')}\u00a0$ par 10\u00a0$ misés.`
    : `arakiceML: <b>${tax.modelPct}%</b> to hit, correlations included. The price implies ${tax.bookImpliedPct}%. Expected return: $${per10} per $10 staked.`;
  const legs = o.legs.map((l, i) => `
      <li class="${o.weak === i + 1 ? 'weak' : ''}"><span class="n">${i + 1}</span><span class="t">${esc(l)}</span>${o.weak === i + 1 ? `<span class="tag">${L.weak}</span>` : ''}</li>`).join('');
  const face = (uri: string | null, range: string) => uri ? `@font-face{font-family:Inter;src:url(${uri}) format('woff2');font-weight:100 900;unicode-range:${range};}` : '';
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><style>
${face(o.font, 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD')}
${face(o.fontExt, 'U+0100-024F,U+0259,U+1E00-1EFF,U+2020,U+20A0-20AB,U+20AD-20CF,U+2113,U+2C60-2C7F,U+A720-A7FF')}
:root{--bg:#0A0E0C;--surface:#131A12;--line:#22301F;--accent:#90C9F0;--text:#BFC8CC;--bright:#E8EEF0;--muted:#8A9EA6;--positive:#4ADE80;--negative:#F87171;}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1080px;height:1350px;overflow:hidden}
body{background:var(--bg);color:var(--text);font-family:Inter,'Segoe UI',Roboto,system-ui,sans-serif;font-feature-settings:'tnum' 1;padding:72px 80px 56px;display:flex;flex-direction:column;position:relative}
body::before{content:'';position:absolute;top:-30%;left:-25%;width:150%;height:80%;background:radial-gradient(ellipse at center,rgba(144,201,240,.10),transparent 62%);pointer-events:none}
.brand{display:flex;align-items:center;gap:20px;font-size:30px;font-weight:700;letter-spacing:.14em;color:var(--accent)}
.brand img{width:64px;height:64px}
.brand .sub{color:var(--muted);font-weight:500;letter-spacing:.08em}
.game{margin-top:40px;font-size:34px;font-weight:600;color:var(--muted)}
ol{list-style:none;margin-top:20px;display:flex;flex-direction:column;gap:14px}
li{display:flex;align-items:center;gap:22px;background:var(--surface);border:2px solid var(--line);border-radius:18px;padding:20px 26px;font-size:36px;font-weight:600;color:var(--bright)}
li .n{flex:none;width:46px;height:46px;border-radius:50%;background:var(--line);color:var(--muted);font-size:26px;display:flex;align-items:center;justify-content:center}
li .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
li.weak{border-color:var(--negative)}
li .tag{flex:none;font-size:22px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--negative)}
.odds{margin-top:auto;display:flex;gap:24px}
.box{flex:1;border:2px solid var(--line);border-radius:22px;padding:24px 30px}
.box .k{font-size:24px;font-weight:700;letter-spacing:.12em;color:var(--muted)}
.box .v{margin-top:6px;font-size:76px;font-weight:800;color:var(--bright)}
.box.fair .v{color:var(--accent)}
.head{margin-top:30px;font-size:${headSize}px;line-height:1;font-weight:800;color:${tone};letter-spacing:-.01em}
.expl{margin-top:18px;font-size:30px;line-height:1.35;color:var(--text)}
.note{margin-top:10px;font-size:24px;color:var(--muted)}
.foot{margin-top:34px;padding-top:22px;border-top:2px solid var(--line);display:flex;justify-content:space-between;font-size:22px;color:var(--muted)}
.foot b{color:var(--accent);font-weight:700}
</style></head><body>
  <div class="brand">${o.logo ? `<img src="${o.logo}" alt="">` : ''}<span>ARAKICE</span><span class="sub">${L.sub}</span></div>
  ${o.game ? `<div class="game">${esc(o.game)}</div>` : ''}
  <ol>${legs}
  </ol>
  <div class="odds">
    <div class="box"><div class="k">${L.paid}</div><div class="v">${formatAmerican(tax.paidAmerican)}</div></div>
    <div class="box fair"><div class="k">${L.fair}</div><div class="v">${formatAmerican(tax.fairAmerican)}</div></div>
  </div>
  <div class="head">${esc(headline)}</div>
  <div class="expl">${expl}</div>
  ${o.note ? `<div class="note">${esc(o.note)}</div>` : ''}
  <div class="foot"><b>arakice.com</b><span>${esc(disclaimerFor(lang))}</span></div>
</body></html>`;
}

async function main() {
  const a = args();
  if (!a.prob || !a.odds || !a.legs || a.help) {
    console.log('Usage : npm run grade:card -- --prob=10.5 --odds=+600 --legs="A|B|C" [--weak=2] [--game="TOR @ EDM"] [--note=...] [--platform=x] [--url=...] [--out=nom] [--lang=fr]');
    process.exit(a.help ? 0 : 1);
  }
  const legs = a.legs.split('|').map(s => s.trim()).filter(Boolean);
  if (legs.length < 2) throw new Error('--legs : au moins 2 jambes, séparées par « | »');
  if (legs.length > 8) throw new Error('--legs : 8 jambes au plus (la carte ne les afficherait pas toutes)');
  const lang: GradeLang = a.lang === 'fr' ? 'fr' : 'en';
  if (a.lang && a.lang !== 'fr' && a.lang !== 'en') throw new Error('--lang : en ou fr');
  const weak = a.weak ? Number(a.weak) : null;
  if (weak !== null && (!Number.isInteger(weak) || weak < 1 || weak > legs.length)) throw new Error(`--weak : numéro de jambe entre 1 et ${legs.length}`);
  const tax = parlayTax(Number(String(a.prob).replace(',', '.')), parseAmerican(a.odds));
  const game = a.game ?? '';
  const note = a.note ?? '';
  const reply = gradeReply({ tax, weakestLeg: weak ? legs[weak - 1] : undefined, lang });

  const problems = gradeComplianceProblems([reply, game, note, ...legs]);
  if (problems.length) {
    console.error('Carte refusée (règles de contenu) :\n  - ' + problems.join('\n  - '));
    process.exit(2);
  }

  const [logo, font, fontExt] = await Promise.all([
    dataUri(LOGO, 'image/png'), dataUri(FONT, 'font/woff2'), dataUri(FONT_EXT, 'font/woff2'),
  ]);
  const html = cardHtml({ tax, legs, weak, game, note, logo, font, fontExt, lang });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const stem = `${date}-${slug(a.out ?? game ?? legs[0])}${lang === 'fr' ? '-fr' : ''}`;
  let file = path.join(OUT_DIR, `${stem}.png`);
  for (let i = 2; await fs.access(file).then(() => true, () => false); i++) file = path.join(OUT_DIR, `${stem}-${i}.png`);

  let chromium: any;
  try { ({ chromium } = await import('playwright')); } catch {
    throw new Error('Playwright absent : npm i -D playwright && npx playwright install chromium');
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate('document.fonts.ready'); // chaîne : le tsconfig serveur n'a pas la lib DOM
    await page.screenshot({ path: file, type: 'png' });
  } finally { await browser.close(); }

  const log = path.join(OUT_DIR, 'log.csv');
  const exists = await fs.access(log).then(() => true, () => false);
  const row = [new Date().toISOString(), lang, a.platform ?? '', a.url ?? '', game, legs.join(' | '),
    formatAmerican(tax.paidAmerican), tax.modelPct, formatAmerican(tax.fairAmerican), tax.taxPct, path.basename(file)];
  await fs.appendFile(log, (exists ? '' : 'created_at,lang,platform,url,game,legs,paid,model_pct,fair,tax_pct,png\n') + row.map(csv).join(',') + '\n');

  console.log(`\nCarte  : ${path.relative(REPO_ROOT, file)}`);
  console.log(`Taxe   : ${taxHeadline(tax, lang)}  (payé ${formatAmerican(tax.paidAmerican)}, juste ${formatAmerican(tax.fairAmerican)}, modèle ${tax.modelPct} %)`);
  console.log(`Journal: ${path.relative(REPO_ROOT, log)}`);
  console.log(`\nRéponse (${reply.length}/280) :\n${reply}\n`);
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
