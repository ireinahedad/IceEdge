/**
 * Banc d'essai du moteur en direct (`ml/EXPLICATION_ML.md` §10.2 et §10.5).
 *
 *   1. Temps d'un recalcul complet (`computeLiveModelGroups`) et du moteur seul
 *      à cinq moments du match, puis du calage (`liveCalibration`).
 *   2. Effet du pas du moteur (5, 10, 30, 60 s contre une référence à 1 s),
 *      avec une copie du moteur à pas réglable vérifiée identique au code servi.
 *   3. Moteur exact contre simulation Monte-Carlo des mêmes fins de match.
 *
 * Aucun réseau, aucune base. Usage (dans server/) :
 *   npx ts-node --transpile-only scripts/bench-live-engine.ts
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const Fs = require('../src/services/prediction/finalScore');
// Copie à UNE table (sans `mAfterGoal`) : la copie du moteur à pas réglable
// ci-dessous ne porte pas la couche « après un but » de la fin de match ; les
// deux moteurs comparés lisent donc la même table.
const FX = { ...require('../src/services/prediction/liveEffects.json'), mAfterGoal: undefined, endgameStart: undefined };
const MAX_K = 14;
// Port of evolveLiveScore (no power play) with a step parameter.
function engine(lh: number, la: number, h0: number, a0: number, elapsed: number, fx: any, STEP: number): number[][] {
  const n = MAX_K + 1;
  let cur = Array.from({ length: n }, () => new Array(n).fill(0)); cur[0][0] = 1;
  const d0 = h0 - a0;
  const sliceAt = (t: number) => { for (let s = 0; s < fx.slices.length; s++) if (t >= fx.slices[s][0] && t < fx.slices[s][1]) return s; return fx.slices.length - 1; };
  const goals3 = (r: number) => { const e = Math.exp(-r); const p = [e, e * r, e * r * r / 2]; const z = p[0] + p[1] + p[2]; return [p[0] / z, p[1] / z, p[2] / z]; };
  let maxI = 0, maxJ = 0, t = elapsed;
  while (t < 3600 - 1e-9) {
    const next = Math.min(3600, (Math.floor(t / STEP) + 1) * STEP);
    const per = Math.min(2, Math.floor(t / 1200));
    const w = fx.periodDist[per] * (next - t) / 1200;
    const s = sliceAt(t);
    const by: any[] = [];
    for (let c = 0; c < 7; c++) by.push({ ph: goals3(lh * w * fx.m[s][c]), pa: goals3(la * w * fx.m[s][6 - c]) });
    const nxt = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i <= maxI; i++) for (let j = 0; j <= maxJ; j++) {
      const q = cur[i][j]; if (q < 1e-15) continue;
      const { ph, pa } = by[Math.max(-3, Math.min(3, d0 + i - j)) + 3];
      for (let k = 0; k < 3; k++) { const row = nxt[Math.min(MAX_K, i + k)]; const qk = q * ph[k];
        row[j] += qk * pa[0]; row[Math.min(MAX_K, j + 1)] += qk * pa[1]; row[Math.min(MAX_K, j + 2)] += qk * pa[2]; }
    }
    maxI = Math.min(MAX_K, maxI + 2); maxJ = Math.min(MAX_K, maxJ + 2); cur = nxt; t = next;
  }
  return cur;
}
// Monte-Carlo with the same 10-s Poisson steps.
function mc(lh: number, la: number, h0: number, a0: number, elapsed: number, fx: any, N: number, seed: number): number[][] {
  let x = seed >>> 0; const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const pois = (r: number) => { const L = Math.exp(-r); let k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; };
  const n = MAX_K + 1; const out = Array.from({ length: n }, () => new Array(n).fill(0));
  const sl: number[] = []; for (let t = 0; t < 3600; t += 10) { let s = 0; for (; s < fx.slices.length; s++) if (t >= fx.slices[s][0] && t < fx.slices[s][1]) break; sl.push(s); }
  for (let r = 0; r < N; r++) {
    let i = 0, j = 0;
    for (let t = elapsed; t < 3600; t += 10) {
      const w = fx.periodDist[Math.floor(t / 1200)] * 10 / 1200; const s = sl[t / 10];
      const c = Math.max(-3, Math.min(3, h0 - a0 + i - j)) + 3;
      i += pois(lh * w * fx.m[s][c]); j += pois(la * w * fx.m[s][6 - c]);
    }
    out[Math.min(MAX_K, i)][Math.min(MAX_K, j)] += 1 / N;
  }
  return out;
}
const q = (rem: number[][], h0: number, a0: number) => {
  let home = 0, tie = 0, o55 = 0, pl = 0;
  rem.forEach((row, i) => row.forEach((p, j) => { const h = h0 + i, a = a0 + j;
    if (h > a) home += p; if (h === a) tie += p; if (h + a >= 6) o55 += p; if (h - a >= 2) pl += p; }));
  return [home, tie, o55, pl];
};
const now = () => Number(process.hrtime.bigint()) / 1e6;

// ── 1. Temps d'un recalcul ──
{
const P = require('../src/services/nhlPredictions');

const { computeLiveModelGroups, liveCtxFromDetail, MEASURED_LIVE_EFFECTS, liveCalibration } = P;
const detail = (period: number, clock: string, h: number, a: number) => ({
  status: 'live', period, clock, home: { score: h }, away: { score: a }, periodType: 'REG', inIntermission: false,
  periods: [{ label: '1', home: 0, away: 0 }, { label: '2', home: 0, away: 0 }, { label: '3', home: 0, away: 0 }],
});
const moments: Array<[string, number, string, number, number]> = [
  ['mise au jeu', 1, '20:00', 0, 0], ['fin 1re', 1, '00:01', 1, 0], ['fin 2e', 2, '00:01', 2, 1],
  ['5 min', 3, '05:00', 3, 2], ['1 min', 3, '01:00', 3, 2],
];
function med(x: number[]) { const s = [...x].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
// cold: new pregame each time (calibration not memoized)
const out: any = {};
for (const [name, per, clk, h, a] of moments) {
  const ctx = liveCtxFromDetail(detail(per, clk, h, a));
  const cold: number[] = [], warm: number[] = [], eng: number[] = [];
  for (let i = 0; i < 40; i++) {
    const model = { preHome: 0.55 + i * 1e-4, ot: 0.23, lambdaT: 6.1 };
    let t = now(); computeLiveModelGroups(model, ctx); cold.push(now() - t);
    t = now(); computeLiveModelGroups(model, ctx); warm.push(now() - t);
    t = now(); Fs.evolveLiveScore(3.2, 2.9, h, a, 3600 - ctx.state.secondsLeftReg, MEASURED_LIVE_EFFECTS); eng.push(now() - t);
  }
  out[name] = { cold: med(cold).toFixed(1), warm: med(warm).toFixed(1), engine: med(eng).toFixed(2) };
}
let t = now(); for (let i = 0; i < 40; i++) liveCalibration(6.1, 0.55 + i * 1e-5 + 0.01, 0.23, 0.5, MEASURED_LIVE_EFFECTS); 
out.calibration = ((now() - t) / 40).toFixed(1);
console.log(JSON.stringify(out));
}

// ── 2 et 3. Pas du moteur, Monte-Carlo ──
const moments: Array<[string, number, number, number]> = [['mise au jeu', 0, 0, 0], ['fin 1re', 1200, 1, 0], ['fin 2e', 2400, 2, 1], ['5 min', 3300, 3, 2], ['1 min', 3540, 3, 2]];
const lh = 3.2, la = 2.9;
// 1) check port vs prod
let maxDiff = 0;
for (const [, el, h, a] of moments) { const A = Fs.evolveLiveScore(lh, la, h, a, el, FX); const B = engine(lh, la, h, a, el, FX, 10);
  A.forEach((r: number[], i: number) => r.forEach((v, j) => { maxDiff = Math.max(maxDiff, Math.abs(v - B[i][j])); })); }
console.log('port vs prod max diff', maxDiff);
// 2) step effect vs 1 s reference
for (const STEP of [5, 10, 30, 60]) {
  let worst = 0, worstWhere = ''; let tt = 0;
  for (const [name, el, h, a] of moments) {
    const ref = q(engine(lh, la, h, a, el, FX, 1), h, a);
    const t0 = now(); const r = engine(lh, la, h, a, el, FX, STEP); tt += now() - t0;
    const v = q(r, h, a);
    v.forEach((x, k) => { const d = Math.abs(x - ref[k]) * 100; if (d > worst) { worst = d; worstWhere = `${name}/${['dom','nul','>5,5','-1,5'][k]}`; } });
  }
  console.log(`step ${STEP}s: max |Δ| vs 1 s = ${worst.toFixed(3)} pt (${worstWhere}), temps total 5 moments ${tt.toFixed(1)} ms`);
}
{ let t0 = now(); for (const [, el, h, a] of moments) engine(lh, la, h, a, el, FX, 1); console.log('step 1s total', (now() - t0).toFixed(1), 'ms'); }
// 3) Monte-Carlo vs exact (10 s), kickoff and 5 min
for (const [name, el, h, a] of [moments[0], moments[3]]) {
  const ex = q(engine(lh, la, h, a, el, FX, 10), h, a);
  let t0 = now(); for (let r = 0; r < 20; r++) engine(lh, la, h, a, el, FX, 10); const te = (now() - t0) / 20;
  for (const N of [1000, 10000, 100000]) {
    const errs: number[] = []; let tm = 0;
    for (let s = 1; s <= 5; s++) { t0 = now(); const v = q(mc(lh, la, h, a, el, FX, N, s * 7919), h, a); tm += now() - t0;
      errs.push(Math.max(...v.map((x, k) => Math.abs(x - ex[k]) * 100))); }
    console.log(`${name} exact ${te.toFixed(2)} ms | MC N=${N}: ${(tm / 5).toFixed(1)} ms, erreur max moyenne ${(errs.reduce((x, y) => x + y) / 5).toFixed(2)} pt`);
  }
}
