/**
 * replay-live-pp.ts — rejeu de l'AVANTAGE NUMÉRIQUE EN COURS sur de vrais matchs
 * (`STATUS.md` §3.5, Live, point 1).
 *
 *   npx ts-node --transpile-only scripts/replay-live-pp.ts run 0 10 40  → parts 0 à 9 sur 40
 *   npx ts-node --transpile-only scripts/replay-live-pp.ts report       → rapport
 *
 * Même banc que `replay-live.ts` (buts horodatés, chiffres d'avant-match hors
 * échantillon, vrai moteur `liveCtxFromDetail` + `computeLiveModelGroups`), mais
 * seulement aux instants où une situation numérique est EN COURS : ailleurs, les
 * deux moteurs comparés sont identiques. La situation (code + temps restant de la
 * pénalité, reconstruit sans regarder l'avenir) vient de `ml/data/live_pp_moments.csv`
 * (`calibrate_live_pp.py --moments`).
 *
 *   phase 2 = effets de score mesurés (servis aujourd'hui), sans la situation
 *   phase 3 = phase 2 + facteurs de situation (`liveEffects.json` → `pp`)
 *
 * Instants : fin de la 1re, fin de la 2e, 5 et 2 min restantes (quand une
 * situation court), et 5 s après le début du premier avantage numérique de chaque
 * match. Découpé en parts (le shell du poste coupe les commandes longues).
 *
 * Rapport : ml/models/live/live_pp_report.md (+ .json). Règle : n'activer que si la
 * log-loss baisse.
 */

import fs from 'fs';
import path from 'path';
import { computeLiveModelGroups, liveCtxFromDetail, MEASURED_LIVE_EFFECTS, LiveGameCtx, MarketGroup } from '../src/services/nhlPredictions';

const ML = process.env.ML_DIR ?? path.resolve(__dirname, '..', '..', 'ml');
const OUT_DIR = path.join(ML, 'models', 'live');
const PART_DIR = path.join(OUT_DIR, 'pp_replay_parts');

function readCsv(file: string): Array<Record<string, string>> {
  const [head, ...lines] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const cols = head.split(',');
  return lines.map(l => { const v = l.split(','); return Object.fromEntries(cols.map((c, i) => [c, v[i]])); });
}

interface Goal { time: number; period: number; home: boolean }
interface Moment { id: string; elapsed: number; code: string; secondsLeft: number }
interface Game {
  id: string; season: number; homeFinal: number; awayFinal: number; homeReg: number; awayReg: number;
  preHome: number; ot: number; lambdaT: number; goals: Goal[]; moments: Moment[];
}

function loadGames(): Game[] {
  const pre = new Map(readCsv(path.join(ML, 'data', 'live_pregame.csv')).map(r => [r.game_id, r]));
  const goals = new Map<string, Goal[]>();
  for (const r of readCsv(path.join(ML, 'data', 'live_goals.csv'))) {
    const list = goals.get(r.game_id) ?? [];
    list.push({ time: Number(r.time), period: Number(r.period), home: r.home_scored === '1' });
    goals.set(r.game_id, list);
  }
  const moments = new Map<string, Moment[]>();
  for (const r of readCsv(path.join(ML, 'data', 'live_pp_moments.csv'))) {
    if (!(Number(r.seconds_left) > 0)) continue;
    const list = moments.get(r.game_id) ?? [];
    list.push({ id: r.moment, elapsed: Number(r.elapsed), code: r.code.padStart(4, '0'), secondsLeft: Number(r.seconds_left) });
    moments.set(r.game_id, list);
  }
  const out: Game[] = [];
  for (const r of readCsv(path.join(ML, 'data', 'live_games.csv'))) {
    const p = pre.get(r.game_id), m = moments.get(r.game_id);
    if (!p || !m) continue;
    out.push({
      id: r.game_id, season: Number(r.season),
      homeFinal: Number(r.home_score), awayFinal: Number(r.away_score),
      homeReg: Number(r.home_reg_score), awayReg: Number(r.away_reg_score),
      preHome: Number(p.p_home_win), ot: Number(p.p_reg_tie), lambdaT: Number(p.lam_home) + Number(p.lam_away),
      goals: (goals.get(r.game_id) ?? []).sort((a, b) => a.time - b.time), moments: m,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Feuille de match à `elapsed` secondes (comme `replay-live.ts`), avec la situation en cours. */
function detailAt(g: Game, mo: Moment): any {
  const elapsed = mo.elapsed;
  const intermission = elapsed > 0 && elapsed % 1200 === 0 && elapsed < 3600;
  const period = elapsed === 0 ? 1 : intermission ? elapsed / 1200 : Math.floor(elapsed / 1200) + 1;
  const left = intermission ? 0 : Math.round(period * 1200 - elapsed);
  const done = g.goals.filter(x => x.time < elapsed || (intermission && x.time === elapsed && x.period <= period));
  const periods = [1, 2, 3].filter(n => n <= period).map(n => ({
    label: String(n),
    home: done.filter(x => x.period === n && x.home).length,
    away: done.filter(x => x.period === n && !x.home).length,
  }));
  const mm = String(Math.floor(left / 60)).padStart(2, '0'), ss = String(left % 60).padStart(2, '0');
  return {
    status: 'live', period, periodType: 'REG', inIntermission: intermission, clock: `${mm}:${ss}`,
    home: { score: done.filter(x => x.home).length }, away: { score: done.filter(x => !x.home).length },
    periods, situation: { code: mo.code, secondsRemaining: mo.secondsLeft },
  };
}

const QUESTIONS: Array<{ id: string; label: string; won: (g: Game) => boolean }> = [
  { id: 'mw-home',     label: 'Moneyline domicile',  won: g => g.homeFinal > g.awayFinal },
  { id: 'ml-home',     label: 'Domicile en 60 min',  won: g => g.homeReg > g.awayReg },
  { id: 'ml-away',     label: 'Visiteur en 60 min',  won: g => g.awayReg > g.homeReg },
  { id: 'ot-yes',      label: 'Va en prolongation',  won: g => g.homeReg === g.awayReg },
  { id: 'o55',         label: 'Total > 5.5',         won: g => g.homeFinal + g.awayFinal > 5.5 },
  { id: 'o65',         label: 'Total > 6.5',         won: g => g.homeFinal + g.awayFinal > 6.5 },
  { id: 'pl-home-m15', label: 'Domicile −1.5',       won: g => g.homeFinal - g.awayFinal >= 2 },
  { id: 'pl-away-m15', label: 'Visiteur −1.5',       won: g => g.awayFinal - g.homeFinal >= 2 },
  { id: 'tt-home-o25', label: 'Buts domicile > 2.5', won: g => g.homeFinal > 2.5 },
  { id: 'tt-away-o25', label: 'Buts visiteur > 2.5', won: g => g.awayFinal > 2.5 },
];
const MOMENT_LABEL: Record<string, string> = {
  m1200: 'fin de la 1re', m2400: 'fin de la 2e', m3300: '5 min restantes', m3480: '2 min restantes',
  ppStart: 'début du 1er avantage (+5 s)',
};

function pctById(groups: MarketGroup[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const gr of groups) for (const o of gr.options) m.set(o.id, o.rulePct / 100);
  return m;
}
const EPS = 1e-4;
const logLoss = (p: number, y: boolean) => -Math.log(y ? Math.max(EPS, p) : Math.max(EPS, 1 - p));

function run(part: number, parts: number): void {
  if (!MEASURED_LIVE_EFFECTS.pp) { console.error('❌ liveEffects.json sans clé pp (calibrate_live_pp.py --write)'); process.exit(1); }
  const train = MEASURED_LIVE_EFFECTS.pp.trainSeasons ?? [];
  const games = loadGames().filter((_, i) => i % parts === part);
  const bad = games.find(g => train.length && g.season <= train[1]);
  if (bad) { console.error(`❌ saison ${bad.season} dans l'entraînement des facteurs`); process.exit(1); }
  const rows: Array<[string, number, string, string, number, number, number]> = [];
  const t0 = Date.now();
  for (const g of games) {
    const model = { preHome: g.preHome, ot: g.ot, lambdaT: g.lambdaT };
    for (const mo of g.moments) {
      const live = liveCtxFromDetail(detailAt(g, mo)) as LiveGameCtx;
      if (!live?.state.pp) continue;
      const p2 = pctById(computeLiveModelGroups(model, { ...live, state: { ...live.state, pp: null } }));
      const p3 = pctById(computeLiveModelGroups(model, live));
      for (const q of QUESTIONS) {
        const a = p2.get(q.id), b = p3.get(q.id);
        if (a == null || b == null) continue;
        rows.push([g.id, g.season, mo.id, q.id, q.won(g) ? 1 : 0, a, b]);
      }
    }
  }
  fs.mkdirSync(PART_DIR, { recursive: true });
  fs.writeFileSync(path.join(PART_DIR, `part${part}of${parts}.json`), JSON.stringify(rows));
  console.log(`✅ part ${part}/${parts} : ${games.length} matchs, ${rows.length} lignes (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}

function meanSe(x: number[]): { mean: number; se: number } {
  const n = x.length, mean = x.reduce((a, b) => a + b, 0) / n;
  const v = x.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
  return { mean, se: Math.sqrt(v / n) };
}

function report(): void {
  const rows: Array<[string, number, string, string, number, number, number]> = [];
  for (const f of fs.readdirSync(PART_DIR).filter(f => f.endsWith('.json'))) rows.push(...JSON.parse(fs.readFileSync(path.join(PART_DIR, f), 'utf8')));
  const parts = new Set(fs.readdirSync(PART_DIR).map(f => f.replace(/part\d+of/, '')));
  if (parts.size !== 1) { console.error('❌ parts de découpages différents dans', PART_DIR); process.exit(1); }
  const seasons = [...new Set(rows.map(r => r[1]))].sort();
  const games = new Set(rows.map(r => r[0])).size;
  // Erreur type appariée PAR MATCH : les questions d'un même instant ne sont pas indépendantes.
  const cell = (sel: (r: typeof rows[number]) => boolean) => {
    const byGame = new Map<string, number>();
    let l2 = 0, l3 = 0, n = 0;
    for (const r of rows) {
      if (!sel(r)) continue;
      const a = logLoss(r[5], r[4] === 1), b = logLoss(r[6], r[4] === 1);
      l2 += a; l3 += b; n++;
      byGame.set(r[0], (byGame.get(r[0]) ?? 0) + (b - a));
    }
    const d = meanSe([...byGame.values()]);
    return { n, games: byGame.size, l2, l3, dSum: d.mean * byGame.size, dSumSe: d.se * byGame.size };
  };
  const fmt = (c: ReturnType<typeof cell>) => {
    const sig = Math.abs(c.dSum) > 1.96 * c.dSumSe ? (c.dSum < 0 ? ' ✅' : ' ❌') : '';
    return `${c.n} | ${(c.l2 / c.n).toFixed(4)} | ${(c.l3 / c.n).toFixed(4)} | ${c.dSum >= 0 ? '+' : ''}${c.dSum.toFixed(1)} ± ${(1.96 * c.dSumSe).toFixed(1)}${sig}`;
  };
  const all = cell(() => true);
  const lines: string[] = [];
  lines.push('# Rejeu — avantage numérique en cours (phase 3) contre phase 2');
  lines.push('');
  lines.push(`Généré le ${new Date().toISOString().slice(0, 10)} par \`server/scripts/replay-live-pp.ts\`. `
    + `${games} matchs, saisons de test ${seasons.map(s => `${s}-${String(s + 1).slice(2)}`).join(', ')} ; `
    + `facteurs entraînés sur ${MEASURED_LIVE_EFFECTS.pp?.trainSeasons?.join('–')} (\`calibrate_live_pp.py\`).`);
  lines.push('');
  lines.push(`**Synthèse** : log-loss cumulée phase 2 ${all.l2.toFixed(1)}, phase 3 ${all.l3.toFixed(1)} `
    + `(${all.l3 < all.l2 ? '−' : '+'}${Math.abs(100 * (all.l3 - all.l2) / all.l2).toFixed(2)} %), `
    + `Δ ${all.dSum.toFixed(1)} ± ${(1.96 * all.dSumSe).toFixed(1)} (1,96 e.t. appariée par match). `
    + `Seuls les instants où une situation court sont rejoués : ailleurs les deux phases sont identiques.`);
  lines.push('');
  lines.push('Phase 2 = effets de score servis, sans la situation ; phase 3 = + facteurs de situation. '
    + 'Δ = somme des écarts de log-loss phase 3 − phase 2 (négatif = phase 3 meilleure).');
  lines.push('');
  const out: any[] = [];
  for (const mo of Object.keys(MOMENT_LABEL)) {
    lines.push(`## ${MOMENT_LABEL[mo]}`);
    lines.push('');
    lines.push('| Question | n | Log-loss P2 | Log-loss P3 | Δ cumulé |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const q of QUESTIONS) {
      const c = cell(r => r[2] === mo && r[3] === q.id);
      if (!c.n) continue;
      lines.push(`| ${q.label} | ${fmt(c)} |`);
      out.push({ moment: mo, question: q.id, ...c });
    }
    const t = cell(r => r[2] === mo);
    if (t.n) lines.push(`| **Toutes** | ${fmt(t)} |`);
    lines.push('');
  }
  lines.push('## Par saison');
  lines.push('');
  lines.push('| Saison | n | Log-loss P2 | Log-loss P3 | Δ cumulé |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const s of seasons) lines.push(`| ${s}-${String(s + 1).slice(2)} | ${fmt(cell(r => r[1] === s))} |`);
  lines.push('');
  fs.writeFileSync(path.join(OUT_DIR, 'live_pp_report.md'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'live_pp_report.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), seasons, games, total: all, rows: out,
  }, null, 2));
  console.log(lines.slice(0, 5).join('\n'));
}

const [cmd, a, b, c] = process.argv.slice(2);
if (cmd === 'run') {
  const parts = Number(c ?? 1);
  for (let i = Number(a ?? 0); i < Math.min(parts, Number(b ?? parts)); i++) {
    if (fs.existsSync(path.join(PART_DIR, `part${i}of${parts}.json`))) continue;   // reprenable
    run(i, parts);
  }
} else if (cmd === 'report') report();
else { console.error('usage : replay-live-pp.ts run <de> <à> <parts> | report'); process.exit(1); }
process.exit(0);
