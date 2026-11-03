#!/usr/bin/env node
// predictions-publish.mjs — gel du matin + preuve publique (X402_PLAN.md, phase 1).
//
// Appelé par `.github/workflows/predictions-morning.yml`, sans dépendance (Node ≥ 20,
// `fetch` natif). Trois étapes, entre lesquelles le workflow fait le commit :
//
//   node predictions-publish.mjs freeze  --repo=<dossier du dépôt public> [--date=AAAA-MM-JJ]
//     • fichier du jour déjà présent → rien (pas de réveil de Neon), `wrote=false` ;
//     • sinon POST /content/snapshots/morning, retire les matchs qui commencent
//       dans moins de 2 min, écrit `data/AAAA/AAAA-MM-JJ.json`, `wrote=true`.
//   (le workflow : git commit + push)
//   node predictions-publish.mjs confirm --repo=<dossier> --date=AAAA-MM-JJ --commit=<sha>
//     • APRÈS le push : seuls les matchs encore à venir à cet instant entrent au
//       bilan (`proof_commit`). GitHub peut retarder un cron d'environ 1 h : un
//       match commencé avant le push reste dans le fichier mais hors bilan.
//
// Environnement : CONTENT_API_URL (ex. https://api.arakice.com/api), CONTENT_CRON_SECRET.
// Sorties pour GitHub Actions : `date`, `wrote`, `games` dans $GITHUB_OUTPUT.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--'))
  .map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || 'true']; }));
const step = process.argv[2];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Marge entre l'écriture du fichier et le push : un match si proche est retiré. */
const COMMIT_MARGIN_MS = 2 * 60_000;

function fail(msg) { console.error(`[predictions] ${msg}`); process.exit(1); }
function output(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(`${key}=${value}`);
}
const etToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const repo = args.repo;
if (!repo || !existsSync(repo)) fail('--repo=<dossier du dépôt public> manquant ou introuvable');
const date = args.date || etToday();
if (!DATE_RE.test(date)) fail(`date invalide : ${date}`);
const file = join(repo, 'data', date.slice(0, 4), `${date}.json`);

async function api(path, body) {
  const base = process.env.CONTENT_API_URL;
  const secret = process.env.CONTENT_CRON_SECRET;
  if (!base || !secret) fail('CONTENT_API_URL et CONTENT_CRON_SECRET sont requis');
  // Le gel peut calculer ~15 paquets ML à froid : 4 min avant d'abandonner.
  const res = await fetch(`${base.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cron-secret': secret },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4 * 60_000),
  });
  const text = await res.text();
  if (!res.ok) fail(`${path} → HTTP ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function freeze() {
  output('date', date);
  if (existsSync(file)) {
    console.log(`[predictions] ${file} existe déjà : rien à faire`);
    output('wrote', 'false');
    return;
  }
  const out = await api('/content/snapshots/morning', { date });
  const now = Date.now();
  const games = [], excluded = [...(out.excluded ?? [])];
  for (const g of out.games ?? []) {
    if (Date.parse(g.startTimeUTC) - now < COMMIT_MARGIN_MS) {
      excluded.push({ gameId: g.gameId, home: g.home, away: g.away, reason: 'started_before_commit' });
    } else {
      games.push(g);
    }
  }
  if (games.length === 0) {
    console.log(`[predictions] ${date} : aucun match à publier (${excluded.length} exclus)`);
    output('wrote', 'false');
    return;
  }
  const doc = {
    date,
    publisher: 'ArakIce',
    source: 'arakiceML, independent of market odds',
    frozenAt: out.servedAt,
    definitions: {
      homeWin: 'P(home team wins), overtime and shootout included',
      homeMinus1_5: 'P(home team wins by 2 or more goals)',
      awayMinus1_5: 'P(away team wins by 2 or more goals)',
      goaliesConfirmed: 'false = usual starter assumed',
      recordedAt: 'when the model produced these numbers; the git push time proves they precede the game',
    },
    games,
    excluded,
    disclaimer: 'Model estimate. Not financial, legal or betting advice.',
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`[predictions] ${file} : ${games.length} matchs, ${excluded.length} exclus`);
  output('wrote', 'true');
  output('games', String(games.length));
}

async function confirm() {
  const commit = args.commit;
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) fail('--commit=<sha de 40 caractères> requis');
  if (!existsSync(file)) fail(`${file} introuvable`);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const now = Date.now();
  const upcoming = doc.games.filter((g) => Date.parse(g.startTimeUTC) > now);
  const late = doc.games.length - upcoming.length;
  if (late > 0) console.warn(`[predictions] ${late} match(s) commencé(s) avant le push : hors bilan`);
  const out = await api('/content/snapshots/morning/published', { gameIds: upcoming.map((g) => g.gameId), commit });
  console.log(`[predictions] ${out.marked} ligne(s) marquée(s) au commit ${commit.slice(0, 7)}`);
}

if (step === 'freeze') await freeze();
else if (step === 'confirm') await confirm();
else fail('usage : predictions-publish.mjs freeze|confirm --repo=<dossier> [--date=] [--commit=]');
