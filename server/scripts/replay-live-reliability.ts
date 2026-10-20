/**
 * replay-live-reliability.ts — fiabilité des probabilités EN DIRECT et gain
 * minute par minute de la 3e période (`ml/EXPLICATION_ML.md` §10.6).
 *
 *   npx ts-node --transpile-only scripts/replay-live-reliability.ts 2023 2024 2025
 *
 * Même protocole que replay-live.ts (matchs de test, avant-match hors
 * échantillon, feuille de match simulée à partir des buts horodatés, VRAI
 * moteur `liveCtxFromDetail` + `computeLiveModelGroups`, mêmes 10 questions),
 * mais :
 *   1. à plus d'instants : mise au jeu, fins de 1re et de 2e, puis CHAQUE
 *      MINUTE de la 3e (19 → 1 min restantes) et 30 s restantes ;
 *   2. avec la table SERVIE (`liveEffects.json`, deux tables de fin de match
 *      depuis le 2026-10-19) contre la cadence fixe (phase 1) ;
 *   3. en plus de la log-loss, les COURBES DE FIABILITÉ : probabilité prédite
 *      contre fréquence observée, par tranche de 10 points, et l'écart moyen
 *      pondéré (ECE). L'erreur type de chaque tranche est groupée PAR MATCH (un
 *      match donne plusieurs prédictions corrélées : 10 questions × plusieurs
 *      instants).
 *
 * Sortie : ml/models/live/live_reliability.md / .json (OUT= pour un autre nom).
 * REPLAY_LIMIT=n pour un essai rapide.
 *
 * Par tranches (machine lente, ou plusieurs cœurs) : chaque tranche écrit les
 * probabilités brutes, puis une fusion fait le rapport.
 *   PART_OFFSET=0 PART_LIMIT=400 PART_OUT=parts/p0.json npx ts-node … 2023 2024 2025
 *   MERGE=parts npx ts-node … 2023 2024 2025
 */

import fs from 'fs';
import path from 'path';
import {
  computeLiveModelGroups, liveCtxFromDetail, MEASURED_LIVE_EFFECTS, LiveGameCtx, MarketGroup,
} from '../src/services/nhlPredictions';

const ML = path.resolve(__dirname, '..', '..', 'ml');
const OUT_DIR = path.join(ML, 'models', 'live');
const OUT_NAME = process.env.OUT ?? 'live_reliability';

function readCsv(file: string): Array<Record<string, string>> {
  const [head, ...lines] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const cols = head.split(',');
  return lines.map(l => {
    const v = l.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, v[i]]));
  });
}

interface Goal { time: number; period: number; home: boolean }
interface Game {
  id: string; season: number;
  homeFinal: number; awayFinal: number; homeReg: number; awayReg: number;
  preHome: number; ot: number; lambdaT: number; goals: Goal[];
}

function loadGames(seasons: Set<number>): Game[] {
  const pre = new Map(readCsv(path.join(ML, 'data', 'live_pregame.csv')).map(r => [r.game_id, r]));
  const goals = new Map<string, Goal[]>();
  for (const r of readCsv(path.join(ML, 'data', 'live_goals.csv'))) {
    const list = goals.get(r.game_id) ?? [];
    list.push({ time: Number(r.time), period: Number(r.period), home: r.home_scored === '1' });
    goals.set(r.game_id, list);
  }
  const out: Game[] = [];
  for (const r of readCsv(path.join(ML, 'data', 'live_games.csv'))) {
    const season = Number(r.season);
    const p = pre.get(r.game_id);
    if (!seasons.has(season) || !p) continue;
    out.push({
      id: r.game_id, season,
      homeFinal: Number(r.home_score), awayFinal: Number(r.away_score),
      homeReg: Number(r.home_reg_score), awayReg: Number(r.away_reg_score),
      preHome: Number(p.p_home_win), ot: Number(p.p_reg_tie),
      lambdaT: Number(p.lam_home) + Number(p.lam_away),
      goals: (goals.get(r.game_id) ?? []).sort((a, b) => a.time - b.time),
    });
  }
  return out;
}

// Instants : avant la 3e, puis chaque minute de la 3e, puis 30 s.
const MOMENTS: Array<{ id: string; label: string; elapsed: number; phase: 'early' | 'p3' | 'late' }> = [
  { id: 'puck',  label: 'mise au jeu',   elapsed: 0,    phase: 'early' },
  { id: 'endP1', label: 'fin de la 1re', elapsed: 1200, phase: 'early' },
  { id: 'endP2', label: 'fin de la 2e',  elapsed: 2400, phase: 'early' },
  ...Array.from({ length: 19 }, (_, i) => {
    const left = 19 - i;
    return { id: `left${left}`, label: `${left} min restante${left > 1 ? 's' : ''}`,
      elapsed: 3600 - 60 * left, phase: (left <= 5 ? 'late' : 'p3') as 'p3' | 'late' };
  }),
  { id: 'left30s', label: '30 s restantes', elapsed: 3570, phase: 'late' },
];
const PHASES: Array<{ id: 'early' | 'p3' | 'late'; label: string }> = [
  { id: 'early', label: 'Avant la 3e (mise au jeu, fins de 1re et de 2e)' },
  { id: 'p3',    label: '3e période, 19 à 6 min restantes' },
  { id: 'late',  label: '5 dernières minutes (5 → 1 min, 30 s)' },
];

function detailAt(g: Game, elapsed: number): any {
  const intermission = elapsed > 0 && elapsed % 1200 === 0 && elapsed < 3600;
  const period = elapsed === 0 ? 1 : intermission ? elapsed / 1200 : Math.floor(elapsed / 1200) + 1;
  const left = intermission ? 0 : period * 1200 - elapsed;
  const done = g.goals.filter(x => x.time < elapsed || (intermission && x.time === elapsed && x.period <= period));
  const periods = [1, 2, 3].filter(n => n <= period).map(n => ({
    label: String(n),
    home: done.filter(x => x.period === n && x.home).length,
    away: done.filter(x => x.period === n && !x.home).length,
  }));
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  return {
    status: 'live', period, periodType: 'REG', inIntermission: intermission, clock: `${mm}:${ss}`,
    home: { score: done.filter(x => x.home).length },
    away: { score: done.filter(x => !x.home).length },
    periods,
    scoring: done.map(x => {
      const t = x.time - (x.period - 1) * 1200;
      return { period: String(x.period), time: `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` };
    }),
  };
}

const QUESTIONS: Array<{ id: string; label: string; family: string; won: (g: Game) => boolean }> = [
  { id: 'mw-home',     label: 'Moneyline domicile',  family: 'Vainqueur',        won: g => g.homeFinal > g.awayFinal },
  { id: 'ml-home',     label: 'Domicile en 60 min',  family: 'Vainqueur',        won: g => g.homeReg > g.awayReg },
  { id: 'ml-away',     label: 'Visiteur en 60 min',  family: 'Vainqueur',        won: g => g.awayReg > g.homeReg },
  { id: 'ot-yes',      label: 'Va en prolongation',  family: 'Vainqueur',        won: g => g.homeReg === g.awayReg },
  { id: 'o55',         label: 'Total > 5.5',         family: 'Totaux',           won: g => g.homeFinal + g.awayFinal > 5.5 },
  { id: 'o65',         label: 'Total > 6.5',         family: 'Totaux',           won: g => g.homeFinal + g.awayFinal > 6.5 },
  { id: 'pl-home-m15', label: 'Domicile −1.5',       family: 'Puck line −1,5',   won: g => g.homeFinal - g.awayFinal >= 2 },
  { id: 'pl-away-m15', label: 'Visiteur −1.5',       family: 'Puck line −1,5',   won: g => g.awayFinal - g.homeFinal >= 2 },
  { id: 'tt-home-o25', label: 'Buts domicile > 2.5', family: 'Buts d\'une équipe', won: g => g.homeFinal > 2.5 },
  { id: 'tt-away-o25', label: 'Buts visiteur > 2.5', family: 'Buts d\'une équipe', won: g => g.awayFinal > 2.5 },
];
const FAMILIES = [...new Set(QUESTIONS.map(q => q.family))];

function pctById(groups: MarketGroup[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const gr of groups) for (const o of gr.options) m.set(o.id, o.rulePct / 100);
  return m;
}
const EPS = 1e-4;
const logLoss = (p: number, y: boolean) => -Math.log(y ? Math.max(EPS, p) : Math.max(EPS, 1 - p));

// ── Accumulateurs ────────────────────────────────────────────────────────────
// Fiabilité : tranche = floor(10 p), p = 1 rangé dans la dernière.
const NB = 10;
const binOf = (p: number) => Math.min(NB - 1, Math.floor(p * NB));
interface Bin { n: number; sp: number; sy: number; games: Map<string, number> }
const newBins = (): Bin[] => Array.from({ length: NB }, () => ({ n: 0, sp: 0, sy: 0, games: new Map() }));
// Log-loss par instant : somme sur les 10 questions, écart apparié par match.
interface MomAcc { n: number; l1: number; l2: number; d: number[] }

function main(): void {
  const seasons = process.argv.slice(2).map(Number).filter(Number.isFinite);
  const testSeasons = new Set(seasons.length ? seasons : [2023, 2024, 2025]);
  const train = MEASURED_LIVE_EFFECTS as any;
  for (const s of testSeasons) {
    if (Array.isArray(train.trainSeasons) && s <= train.trainSeasons[1]) {
      console.error(`❌ saison ${s} incluse dans l'entraînement des effets`); process.exit(1);
    }
  }
  type Rec = { id: string; y: boolean[]; p1: number[][]; p2: number[][] };
  let records: Rec[];
  if (process.env.MERGE) {
    const dir = process.env.MERGE;
    records = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()
      .flatMap(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Rec[]);
    const seen = new Set(records.map(r => r.id));
    if (seen.size !== records.length) { console.error('❌ matchs en double entre les tranches'); process.exit(1); }
    const expected = loadGames(testSeasons).length;
    if (records.length !== expected) console.warn(`⚠ ${records.length} matchs fusionnés sur ${expected}`);
  } else {
    let all = loadGames(testSeasons);
    const off = Number(process.env.PART_OFFSET) || 0;
    const lim = Number(process.env.PART_LIMIT) || Number(process.env.REPLAY_LIMIT) || Infinity;
    all = all.slice(off, off + lim);
    console.log(`${all.length} matchs, saisons ${[...testSeasons].join(', ')}, ${MOMENTS.length} instants`);
    const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
    records = all.map(g => {
      const model = { preHome: g.preHome, ot: g.ot, lambdaT: g.lambdaT };
      const p1: number[][] = [], p2: number[][] = [];
      for (const mo of MOMENTS) {
        const live = liveCtxFromDetail(detailAt(g, mo.elapsed)) as LiveGameCtx;
        const a = pctById(computeLiveModelGroups(model, { ...live, state: { ...live.state, effects: null } }));
        const b = pctById(computeLiveModelGroups(model, { ...live, state: { ...live.state, effects: MEASURED_LIVE_EFFECTS } }));
        p1.push(QUESTIONS.map(q => r6(a.get(q.id) ?? NaN)));
        p2.push(QUESTIONS.map(q => r6(b.get(q.id) ?? NaN)));
      }
      return { id: g.id, y: QUESTIONS.map(q => q.won(g)), p1, p2 };
    });
    if (process.env.PART_OUT) {
      fs.mkdirSync(path.dirname(process.env.PART_OUT), { recursive: true });
      fs.writeFileSync(process.env.PART_OUT, JSON.stringify(records));
      console.log(`✅ tranche ${off}-${off + records.length} → ${process.env.PART_OUT}`);
      process.exit(0);
    }
  }
  const games = records;

  // rel[engine|phase|family] ; family 'all' = toutes les questions.
  const rel = new Map<string, Bin[]>();
  const relKey = (e: string, ph: string, f: string) => `${e}|${ph}|${f}`;
  const mom = new Map<string, MomAcc>();           // moment → somme sur questions
  const momQ = new Map<string, MomAcc>();          // moment|question
  const t0 = Date.now();
  for (const g of games) {
    for (const [mi, mo] of MOMENTS.entries()) {
      let s1 = 0, s2 = 0, k = 0;
      for (const [qi, q] of QUESTIONS.entries()) {
        const a = g.p1[mi][qi], b = g.p2[mi][qi];
        if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) continue;
        const y = g.y[qi];
        const la = logLoss(a, y), lb = logLoss(b, y);
        s1 += la; s2 += lb; k++;
        const mq = momQ.get(`${mo.id}|${q.id}`) ?? { n: 0, l1: 0, l2: 0, d: [] };
        mq.n++; mq.l1 += la; mq.l2 += lb; mq.d.push(lb - la);
        momQ.set(`${mo.id}|${q.id}`, mq);
        for (const [eng, p] of [['p1', a], ['p2', b]] as Array<[string, number]>) {
          for (const f of ['all', q.family]) {
            const key = relKey(eng, mo.phase, f);
            const bins = rel.get(key) ?? newBins();
            const bn = bins[binOf(p)];
            bn.n++; bn.sp += p; bn.sy += y ? 1 : 0;
            bn.games.set(g.id, (bn.games.get(g.id) ?? 0) + ((y ? 1 : 0) - p));
            rel.set(key, bins);
          }
        }
      }
      const m = mom.get(mo.id) ?? { n: 0, l1: 0, l2: 0, d: [] };
      m.n += k; m.l1 += s1; m.l2 += s2; m.d.push(s2 - s1);
      mom.set(mo.id, m);
    }
  }

  // ── Synthèses ──────────────────────────────────────────────────────────────
  const summarizeBins = (bins: Bin[]) => {
    const total = bins.reduce((a, b) => a + b.n, 0);
    let ece = 0;
    const rows = bins.map((b, i) => {
      if (!b.n) return { bin: i, n: 0 };
      const pred = b.sp / b.n, obs = b.sy / b.n;
      // Erreur type groupée par match : Var(Σ(y−p)) ≈ Σ_matchs (Σ(y−p))².
      let v = 0; for (const d of b.games.values()) v += d * d;
      const z = v > 0 ? (b.sy - b.sp) / Math.sqrt(v) : 0;
      ece += (b.n / total) * Math.abs(obs - pred);
      return { bin: i, n: b.n, pred, obs, diff: obs - pred, se: Math.sqrt(v) / b.n, z };
    });
    return { total, ece, rows };
  };
  const meanSe = (x: number[]) => {
    const n = x.length, mean = x.reduce((a, b) => a + b, 0) / n;
    const v = x.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
    return { mean, se: Math.sqrt(v / n) };
  };

  const relOut: any[] = [];
  for (const eng of ['p1', 'p2']) for (const ph of PHASES) for (const f of ['all', ...FAMILIES]) {
    const bins = rel.get(relKey(eng, ph.id, f));
    if (bins) relOut.push({ engine: eng, phase: ph.id, family: f, ...summarizeBins(bins) });
  }
  const momOut = MOMENTS.map(mo => {
    const m = mom.get(mo.id)!;
    const d = meanSe(m.d);
    const qs = QUESTIONS.map(q => {
      const a = momQ.get(`${mo.id}|${q.id}`);
      if (!a) return null;
      const dq = meanSe(a.d);
      return { question: q.id, n: a.n, logloss1: a.l1 / a.n, logloss2: a.l2 / a.n, d: dq.mean, se: dq.se };
    }).filter(Boolean);
    return { moment: mo.id, label: mo.label, elapsed: mo.elapsed, games: m.d.length,
      logloss1: m.l1, logloss2: m.l2, dPerGame: d.mean, sePerGame: d.se, questions: qs };
  });

  // ── Rapport ────────────────────────────────────────────────────────────────
  const f = (x: number, d = 3) => x.toFixed(d).replace('.', ',');
  const pc = (x: number, d = 1) => `${(100 * x).toFixed(d).replace('.', ',')} %`;
  const L: string[] = [];
  L.push('# Fiabilité des probabilités en direct et gain minute par minute');
  L.push('');
  L.push(`Généré le ${new Date().toISOString().slice(0, 10)} par \`server/scripts/replay-live-reliability.ts\`. `
    + `${games.length} matchs, saisons de test ${[...testSeasons].join(', ')}. Table servie : \`liveEffects.json\` `
    + `(entraînée ${train.trainSeasons?.join('–')}${train.mAfterGoal ? ', deux tables de fin de match' : ''}). `
    + 'P1 = cadence fixe, P2 = table servie.');
  L.push('');
  L.push('## Log-loss par instant (somme des 10 questions)');
  L.push('');
  L.push('| Instant | Log-loss P1 / match | Log-loss P2 / match | Variation | Δ par match ± 1,96 e.t. |');
  L.push('|---|---:|---:|---:|---:|');
  for (const m of momOut) {
    const sig = Math.abs(m.dPerGame) > 1.96 * m.sePerGame ? (m.dPerGame < 0 ? ' ✅' : ' ❌') : '';
    L.push(`| ${m.label} | ${f(m.logloss1 / m.games, 4)} | ${f(m.logloss2 / m.games, 4)} | `
      + `${m.logloss2 < m.logloss1 ? '−' : '+'}${f(Math.abs(100 * (m.logloss2 - m.logloss1) / m.logloss1), 1)} % | `
      + `${m.dPerGame >= 0 ? '+' : ''}${f(m.dPerGame, 4)} ± ${f(1.96 * m.sePerGame, 4)}${sig} |`);
  }
  L.push('');
  for (const ph of PHASES) for (const fam of ['all', ...FAMILIES]) {
    const r1 = relOut.find(r => r.engine === 'p1' && r.phase === ph.id && r.family === fam);
    const r2 = relOut.find(r => r.engine === 'p2' && r.phase === ph.id && r.family === fam);
    if (!r1 || !r2) continue;
    L.push(`## Fiabilité — ${ph.label} — ${fam === 'all' ? 'toutes questions' : fam}`);
    L.push('');
    L.push(`ECE : P1 ${pc(r1.ece, 2)}, P2 ${pc(r2.ece, 2)} (${r2.total} prédictions).`);
    L.push('');
    L.push('| Tranche | n | P1 prédit | P1 observé | z | P2 prédit | P2 observé | z |');
    L.push('|---|---:|---:|---:|---:|---:|---:|---:|');
    for (let i = 0; i < NB; i++) {
      const a = r1.rows[i], b = r2.rows[i];
      const cell = (x: any) => x.n ? `${pc(x.pred)} | ${pc(x.obs)} | ${f(x.z, 1)}${Math.abs(x.z) > 2 ? ' ⚠' : ''}` : '— | — | —';
      L.push(`| ${i * 10}-${(i + 1) * 10} % | ${b.n || 0} | ${cell(a)} | ${cell(b)} |`);
    }
    L.push('');
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `${OUT_NAME}.md`), L.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT_DIR, `${OUT_NAME}.json`), JSON.stringify({
    generatedAt: new Date().toISOString(), seasons: [...testSeasons], games: games.length,
    moments: momOut, reliability: relOut,
  }, null, 2));
  console.log(`✅ ${OUT_NAME}.md (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  process.exit(0);
}

main();
