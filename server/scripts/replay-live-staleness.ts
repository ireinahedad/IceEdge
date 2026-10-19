/**
 * Rejeu de la FRAÎCHEUR du direct (`ml/EXPLICATION_ML.md` §10.2).
 *
 * Question : que coûte un chiffre affiché en retard ? Deux caches de 30 s
 * s'empilent (feuille de match, paquet en direct) : le chiffre vu à l'instant t
 * a été calculé sur l'état du match à t − s, avec s entre 0 et ~60 s.
 *
 * Pour chaque match des saisons de test, à des instants t, on note (log-loss,
 * contre l'issue réelle) la prédiction faite avec l'état à t − s, pour
 * plusieurs retards s, avec le vrai moteur (`computeLiveModelGroups`). Les
 * retards sont en secondes de JEU (l'horloge du match s'arrête souvent ; un
 * retard de 30 s réelles vaut au plus 30 s de jeu).
 *
 * Usage (dans server/) :
 *   npx ts-node --transpile-only scripts/replay-live-staleness.ts 2023 2024 2025
 *   WINDOWS=last2 npx ts-node … (une seule fenêtre ; les autres sont relues du rapport)
 * Sortie : ml/models/live/live_staleness_report.json
 */
import fs from 'fs';
import path from 'path';
import {
  computeLiveModelGroups, liveCtxFromDetail, MEASURED_LIVE_EFFECTS, LiveGameCtx, MarketGroup,
} from '../src/services/nhlPredictions';

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



const STALE = [0, 10, 20, 30, 45, 60];
const WINDOWS: Array<{ id: string; label: string; instants: number[] }> = [
  { id: 'mid',   label: 'Reste du match (10e, 30e, 50e minute)', instants: [600, 1800, 3000] },
  { id: 'last5', label: '58e-55e minute (5 à 2 min restantes)',  instants: [3300, 3360, 3420] },
  { id: 'last2', label: '2 dernières minutes',                   instants: [3480, 3500, 3520, 3540, 3560, 3580] },
];

function main(): void {
  const seasons = process.argv.slice(2).map(Number).filter(Number.isFinite);
  const games = loadGames(new Set(seasons.length ? seasons : [2023, 2024, 2025]));
  console.log(`${games.length} matchs`);
  const out: any = { generatedAt: new Date().toISOString().slice(0, 10), games: games.length, stale: STALE, windows: {} };
  const only = (process.env.WINDOWS ?? '').split(',').filter(Boolean);
  const file = path.join(ML, 'models', 'live', 'live_staleness_report.json');
  if (only.length && fs.existsSync(file)) Object.assign(out.windows, JSON.parse(fs.readFileSync(file, 'utf8')).windows ?? {});
  for (const w of WINDOWS.filter(x => !only.length || only.includes(x.id))) {
    // somme des log-loss par retard, et différences appariées contre s = 0
    const sum = STALE.map(() => 0); const diffs = STALE.map(() => [] as number[]);
    let n = 0;
    for (const g of games) {
      const model = { preHome: g.preHome, ot: g.ot, lambdaT: g.lambdaT };
      for (const t of w.instants) {
        const per: number[] = STALE.map(s => {
          const live = liveCtxFromDetail(detailAt(g, Math.max(0, t - s))) as any;
          const p = pctById(computeLiveModelGroups(model, { ...live, state: { ...live.state, effects: MEASURED_LIVE_EFFECTS } }));
          let ll = 0;
          for (const q of QUESTIONS) ll += logLoss(p.get(q.id) ?? 0.5, q.won(g));
          return ll / QUESTIONS.length;
        });
        per.forEach((v, k) => { sum[k] += v; diffs[k].push(v - per[0]); });
        n++;
      }
    }
    const row = STALE.map((s, k) => {
      const d = diffs[k]; const m = d.reduce((a, b) => a + b, 0) / d.length;
      const sd = Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, d.length - 1));
      return { stale: s, logLoss: +(sum[k] / n).toFixed(5), delta: +m.toFixed(5), se: +(sd / Math.sqrt(d.length)).toFixed(5),
               deltaPct: +(100 * m / (sum[0] / n)).toFixed(2) };
    });
    out.windows[w.id] = { label: w.label, n, rows: row };
    console.log(`\n${w.label} (${n} instants)`);
    for (const r of row) console.log(`  retard ${String(r.stale).padStart(2)} s : log-loss ${r.logLoss.toFixed(4)}  Δ ${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(4)} ± ${(1.96 * r.se).toFixed(4)} (${r.deltaPct >= 0 ? '+' : ''}${r.deltaPct} %)`);
  }
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\n✅ ${file}`);
}

main();
