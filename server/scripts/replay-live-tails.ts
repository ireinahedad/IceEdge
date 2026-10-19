/**
 * Rejeu des QUEUES en fin de match (`ml/EXPLICATION_ML.md` §10.4).
 *
 * Les buts réels sont sous-dispersés (avantages numériques qui s'arrêtent au
 * premier but, peu de buts répétés dans le filet désert) ; le moteur tire des
 * buts Poisson. Sur-estime-t-il la variance des buts RESTANTS, donc les queues
 * (« plus de 6,5 », « −1,5 ») ?
 *
 * Pour chaque match des saisons de test et chaque moment, on compare au réel :
 *   1. la loi des buts réglementaires restants du moteur (`evolveLiveScore`,
 *      calé comme en production par `liveCalibration`) : moyenne, variance
 *      (rapport Σ(N − E)² / Σ Var), P(0), P(≥ 1), P(≥ 2), P(≥ 3) ;
 *   2. les tuiles servies (`computeLiveModelGroups`) : prédit moyen − observé,
 *      sur les marchés de queue.
 *
 * Usage (dans server/) :
 *   npx ts-node --transpile-only scripts/replay-live-tails.ts 2023 2024 2025
 * Sortie : ml/models/live/live_tails_report.json (OUT=… pour un autre nom)
 */
import fs from 'fs';
import path from 'path';
import {
  computeLiveModelGroups, liveCtxFromDetail, liveCalibration, MEASURED_LIVE_EFFECTS, LiveGameCtx, MarketGroup,
} from '../src/services/nhlPredictions';
import { evolveLiveScore } from '../src/services/prediction/finalScore';

const ML = path.resolve(__dirname, '..', '..', 'ml');
const OUT_DIR = path.join(ML, 'models', 'live');

// ── Données ──────────────────────────────────────────────────────────────────

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
  homeFinal: number; awayFinal: number; homeReg: number; awayReg: number; wentOt: boolean;
  preHome: number; ot: number; lambdaT: number;
  goals: Goal[];
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
      wentOt: r.went_to_ot === '1',
      preHome: Number(p.p_home_win), ot: Number(p.p_reg_tie),
      lambdaT: Number(p.lam_home) + Number(p.lam_away),
      goals: (goals.get(r.game_id) ?? []).sort((a, b) => a.time - b.time),
    });
  }
  return out;
}

/** La feuille de match (`fetchGameDetail`) telle qu'elle serait à `elapsed` secondes. */
function detailAt(g: Game, elapsed: number): any {
  const intermission = elapsed > 0 && elapsed % 1200 === 0 && elapsed < 3600;
  // Fin de période : la période qui vient de finir, horloge à 0 (entracte).
  const period = elapsed === 0 ? 1 : intermission ? elapsed / 1200 : Math.floor(elapsed / 1200) + 1;
  const left = intermission ? 0 : period * 1200 - elapsed;
  // Buts déjà marqués : avant `elapsed`, ou à `elapsed` pile s'ils appartiennent
  // à la période qui vient de finir.
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
    // Résumé des buts (période, temps écoulé dans la période) : le moteur y lit
    // si un but a déjà été marqué depuis le début de la fin de match (`hasGoalSince`, §10.4).
    scoring: done.map(x => {
      const t = x.time - (x.period - 1) * 1200;
      return { period: String(x.period), time: `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` };
    }),
  };
}

// ── Questions notées ─────────────────────────────────────────────────────────

/** Tuile → issue réelle (1/0). La question est celle que le coupon réglerait. */
const QUESTIONS: Array<{ id: string; label: string; won: (g: Game) => boolean }> = [
  { id: 'mw-home',     label: 'Moneyline domicile',       won: g => g.homeFinal > g.awayFinal },
  { id: 'ml-home',     label: 'Domicile en 60 min',       won: g => g.homeReg > g.awayReg },
  { id: 'ml-away',     label: 'Visiteur en 60 min',       won: g => g.awayReg > g.homeReg },
  { id: 'ot-yes',      label: 'Va en prolongation',       won: g => g.homeReg === g.awayReg },
  { id: 'o55',         label: 'Total > 5.5',              won: g => g.homeFinal + g.awayFinal > 5.5 },
  { id: 'o65',         label: 'Total > 6.5',              won: g => g.homeFinal + g.awayFinal > 6.5 },
  { id: 'pl-home-m15', label: 'Domicile −1.5',            won: g => g.homeFinal - g.awayFinal >= 2 },
  { id: 'pl-away-m15', label: 'Visiteur −1.5',            won: g => g.awayFinal - g.homeFinal >= 2 },
  { id: 'tt-home-o25', label: 'Buts domicile > 2.5',      won: g => g.homeFinal > 2.5 },
  { id: 'tt-away-o25', label: 'Buts visiteur > 2.5',      won: g => g.awayFinal > 2.5 },
];


function pctById(groups: MarketGroup[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const gr of groups) for (const o of gr.options) m.set(o.id, o.rulePct / 100);
  return m;
}

const EPS = 1e-4;
const logLoss = (p: number, y: boolean) => -Math.log(y ? Math.max(EPS, p) : Math.max(EPS, 1 - p));




const MOMENTS_T: Array<{ id: string; label: string; elapsed: number }> = [
  { id: 'endP2', label: 'fin de la 2e',     elapsed: 2400 },
  { id: 'left10', label: '10 min restantes', elapsed: 3000 },
  { id: 'left5', label: '5 min restantes',  elapsed: 3300 },
  { id: 'left3', label: '3 min restantes',  elapsed: 3420 },
  { id: 'left2', label: '2 min restantes',  elapsed: 3480 },
  { id: 'left1', label: '1 min restante',   elapsed: 3540 },
];
const TAIL = ['o55', 'o65', 'pl-home-m15', 'pl-away-m15', 'tt-home-o25', 'tt-away-o25', 'ot-yes'];

function main(): void {
  const seasons = process.argv.slice(2).map(Number).filter(Number.isFinite);
  const games = loadGames(new Set(seasons.length ? seasons : [2023, 2024, 2025]));
  console.log(`${games.length} matchs`);
  const fx = MEASURED_LIVE_EFFECTS;
  const out: any = { generatedAt: new Date().toISOString().slice(0, 10), games: games.length, moments: {} };
  for (const mo of MOMENTS_T) {
    const acc = { n: 0, eSum: 0, oSum: 0, sq: 0, varSum: 0, p0: 0, o0: 0, p1: 0, o1: 0, p2: 0, o2: 0, p3: 0, o3: 0, v0: 0, v1: 0, v2: 0, v3: 0,
                  team: { eSum: 0, oSum: 0, sq: 0, varSum: 0, n: 0 } };
    const tiles: Record<string, { p: number; o: number; v: number; n: number }> = {};
    for (const g of games) {
      const live = liveCtxFromDetail(detailAt(g, mo.elapsed)) as LiveGameCtx;
      const st = live.state;
      // Calage comme en production (`computeGameMarkets`, paquet ML).
      const basePre = Math.min(0.99, Math.max(0.01, g.preHome));
      const preShare = Math.min(0.60, Math.max(0.40, 0.5 + 0.25 * (basePre - 0.5)));
      const cal = liveCalibration(g.lambdaT, basePre, g.ot, preShare, fx);
      const rem = evolveLiveScore(cal.lambdaH, cal.lambdaA, st.homeScore, st.awayScore, mo.elapsed, fx);
      // Buts réglementaires restants observés.
      const remH = g.homeReg - st.homeScore, remA = g.awayReg - st.awayScore;
      const N = remH + remA;
      const pN: number[] = new Array(30).fill(0);
      let eH = 0, eA = 0, vH = 0, vA = 0;
      rem.forEach((row, i) => row.forEach((p, j) => { pN[i + j] += p; eH += p * i; eA += p * j; vH += p * i * i; vA += p * j * j; }));
      vH -= eH * eH; vA -= eA * eA;
      const e = pN.reduce((a, p, k) => a + p * k, 0);
      const v = pN.reduce((a, p, k) => a + p * k * k, 0) - e * e;
      const ge = (k: number) => pN.slice(k).reduce((a, b) => a + b, 0);
      acc.n++; acc.eSum += e; acc.oSum += N; acc.sq += (N - e) ** 2; acc.varSum += v;
      acc.v0 += pN[0] * (1 - pN[0]); acc.v1 += ge(1) * (1 - ge(1)); acc.v2 += ge(2) * (1 - ge(2)); acc.v3 += ge(3) * (1 - ge(3));
      acc.p0 += pN[0]; acc.o0 += N === 0 ? 1 : 0;
      acc.p1 += ge(1); acc.o1 += N >= 1 ? 1 : 0;
      acc.p2 += ge(2); acc.o2 += N >= 2 ? 1 : 0;
      acc.p3 += ge(3); acc.o3 += N >= 3 ? 1 : 0;
      for (const [eT, vT, oT] of [[eH, vH, remH], [eA, vA, remA]] as const) {
        acc.team.n++; acc.team.eSum += eT; acc.team.oSum += oT; acc.team.sq += (oT - eT) ** 2; acc.team.varSum += vT;
      }
      const p = pctById(computeLiveModelGroups({ preHome: g.preHome, ot: g.ot, lambdaT: g.lambdaT },
                                               { ...live, state: { ...st, effects: fx } }));
      for (const q of QUESTIONS) {
        if (!TAIL.includes(q.id)) continue;
        const pr = p.get(q.id); if (pr == null) continue;
        const t = tiles[q.id] ?? (tiles[q.id] = { p: 0, o: 0, v: 0, n: 0 });
        t.p += pr; t.o += q.won(g) ? 1 : 0; t.v += pr * (1 - pr); t.n++;
      }
    }
    const pct = (x: number) => +(100 * x / acc.n).toFixed(2);
    // z de l'écart observé − prédit (somme de Bernoulli indépendantes, variance Σ p(1 − p)).
    const z = (pred: number, obs: number, v: number) => +((obs - pred) / Math.sqrt(Math.max(1e-9, v))).toFixed(2);
    const row = {
      label: mo.label, n: acc.n,
      remaining_goals: {
        mean_pred: +(acc.eSum / acc.n).toFixed(4), mean_obs: +(acc.oSum / acc.n).toFixed(4),
        variance_ratio: +(acc.sq / acc.varSum).toFixed(4),
        team_variance_ratio: +(acc.team.sq / acc.team.varSum).toFixed(4),
        p0: { pred: pct(acc.p0), obs: pct(acc.o0), z: z(acc.p0, acc.o0, acc.v0) },
        p_ge1: { pred: pct(acc.p1), obs: pct(acc.o1), z: z(acc.p1, acc.o1, acc.v1) },
        p_ge2: { pred: pct(acc.p2), obs: pct(acc.o2), z: z(acc.p2, acc.o2, acc.v2) },
        p_ge3: { pred: pct(acc.p3), obs: pct(acc.o3), z: z(acc.p3, acc.o3, acc.v3) },
      },
      tiles: Object.fromEntries(Object.entries(tiles).map(([k, t]) => [k, {
        pred: +(100 * t.p / t.n).toFixed(2), obs: +(100 * t.o / t.n).toFixed(2),
        z: +((t.o - t.p) / Math.sqrt(Math.max(1e-9, t.v))).toFixed(2),
      }])),
    };
    out.moments[mo.id] = row;
    const r = row.remaining_goals;
    console.log(`\n${mo.label} : buts restants prédits ${r.mean_pred} / observés ${r.mean_obs} ; variance réelle / prédite ${r.variance_ratio} (par équipe ${r.team_variance_ratio})`);
    console.log(`  P(0) ${r.p0.pred} / ${r.p0.obs} (z ${r.p0.z})  P(≥1) ${r.p_ge1.pred} / ${r.p_ge1.obs}  P(≥2) ${r.p_ge2.pred} / ${r.p_ge2.obs} (z ${r.p_ge2.z})  P(≥3) ${r.p_ge3.pred} / ${r.p_ge3.obs} (z ${r.p_ge3.z})`);
    for (const [k, t] of Object.entries(row.tiles)) console.log(`  ${k.padEnd(12)} prédit ${t.pred} % / observé ${t.obs} % (z ${t.z})`);
  }
  const file = path.join(ML, 'models', 'live', `${process.env.OUT ?? 'live_tails_report'}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\n✅ ${file}`);
}

main();
