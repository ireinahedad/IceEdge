/**
 * replay-live.ts — rejeu des prédictions EN DIRECT sur de vrais matchs
 * (`LIVE_PREDICTIONS_PLAN.md`, étape 7).
 *
 *   npx ts-node --transpile-only scripts/replay-live.ts                  → saisons 2023-24, 2024-25
 *   npx ts-node --transpile-only scripts/replay-live.ts 2023 2024 2025   → saisons au choix
 *
 * Pour chaque match des saisons de test et chaque moment (mise au jeu, fin de
 * la 1re, fin de la 2e, 5 min et 2 min restantes), l'état du match est
 * reconstruit à partir des buts horodatés (`ml/data/live_goals.csv`, tirés de
 * MoneyPuck par `fetch_live_goals.py`) et passé au VRAI moteur :
 * `liveCtxFromDetail` (la feuille de match est simulée), puis
 * `computeLiveModelGroups`, le calcul du paquet ML en direct. Point de départ :
 * les chiffres d'avant-match HORS ÉCHANTILLON du modèle de score
 * (`ml/data/live_pregame.csv`, `live_pregame.py`).
 *
 * Deux moteurs, mêmes entrées : phase 1 (cadence fixe) et phase 2 (effets de
 * score mesurés, `liveEffects.json`, entraînés sur les saisons ≤ 2022-23).
 * Notés sur l'issue réelle (Brier, log-loss) avec l'écart apparié et son
 * erreur type. Le chemin des RÈGLES n'est pas rejoué (il lui faudrait les
 * statistiques d'équipe de chaque date) ; il partage la grille et le calage,
 * qui sont ce qui change ici.
 *
 * Rapport : ml/models/live/live_report.md (+ .json).
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

// ── Moments et feuille de match simulée ──────────────────────────────────────

const MOMENTS: Array<{ id: string; label: string; elapsed: number }> = [
  { id: 'puck',  label: 'mise au jeu',      elapsed: 0 },
  { id: 'endP1', label: 'fin de la 1re',    elapsed: 1200 },
  { id: 'endP2', label: 'fin de la 2e',     elapsed: 2400 },
  { id: 'left5', label: '5 min restantes',  elapsed: 3300 },
  { id: 'left2', label: '2 min restantes',  elapsed: 3480 },
];

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
const brier = (p: number, y: boolean) => (p - (y ? 1 : 0)) ** 2;

interface Acc { n: number; b1: number; b2: number; l1: number; l2: number; dl: number[]; db: number[] }
const acc = (): Acc => ({ n: 0, b1: 0, b2: 0, l1: 0, l2: 0, dl: [], db: [] });

function meanSe(x: number[]): { mean: number; se: number } {
  const n = x.length;
  const mean = x.reduce((a, b) => a + b, 0) / n;
  const v = x.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
  return { mean, se: Math.sqrt(v / n) };
}

// ── Rejeu ────────────────────────────────────────────────────────────────────

function main(): void {
  const seasons = process.argv.slice(2).map(Number).filter(Number.isFinite);
  const testSeasons = new Set(seasons.length ? seasons : [2023, 2024]);
  const train = MEASURED_LIVE_EFFECTS as any;
  for (const s of testSeasons) {
    if (Array.isArray(train.trainSeasons) && s <= train.trainSeasons[1]) {
      console.error(`❌ saison ${s} incluse dans l'entraînement des effets (${train.trainSeasons.join('–')})`);
      process.exit(1);
    }
  }
  const limit = Number(process.env.REPLAY_LIMIT) || Infinity;
  const games = loadGames(testSeasons).slice(0, limit);
  console.log(`${games.length} matchs, saisons ${[...testSeasons].join(', ')}`);

  // stats[saison|moment|question]
  const stats = new Map<string, Acc>();
  const keyOf = (s: number | 'all', m: string, q: string) => `${s}|${m}|${q}`;
  const t0 = Date.now();
  let done = 0;
  for (const g of games) {
    const model = { preHome: g.preHome, ot: g.ot, lambdaT: g.lambdaT };
    for (const mo of MOMENTS) {
      const live = liveCtxFromDetail(detailAt(g, mo.elapsed)) as LiveGameCtx;
      const p1 = pctById(computeLiveModelGroups(model, { ...live, state: { ...live.state, effects: null } }));
      const p2 = pctById(computeLiveModelGroups(model, { ...live, state: { ...live.state, effects: MEASURED_LIVE_EFFECTS } }));
      for (const q of QUESTIONS) {
        const a = p1.get(q.id), b = p2.get(q.id);
        if (a == null || b == null) continue;
        const y = q.won(g);
        for (const k of [keyOf(g.season, mo.id, q.id), keyOf('all', mo.id, q.id)]) {
          const s = stats.get(k) ?? acc();
          s.n++;
          s.b1 += brier(a, y); s.b2 += brier(b, y);
          s.l1 += logLoss(a, y); s.l2 += logLoss(b, y);
          s.dl.push(logLoss(b, y) - logLoss(a, y));
          s.db.push(brier(b, y) - brier(a, y));
          stats.set(k, s);
        }
      }
    }
    if (++done % 500 === 0) console.log(`  ${done}/${games.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }

  // ── Rapport ────────────────────────────────────────────────────────────────
  const rows: any[] = [];
  const lines: string[] = [];
  lines.push('# Rejeu des prédictions en direct — phase 1 contre phase 2');
  lines.push('');
  lines.push(`Généré le ${new Date().toISOString().slice(0, 10)} par \`server/scripts/replay-live.ts\`. `
    + `${games.length} matchs de saison régulière, saisons de test ${[...testSeasons].map(s => `${s}-${String(s + 1).slice(2)}`).join(', ')}. `
    + `Effets de score entraînés sur ${train.trainSeasons?.[0]}-${train.trainSeasons?.[1]} (rétrécissement a = ${train.shrink}).`);
  lines.push('');
  lines.push('Point de départ : chiffres d\'avant-match hors échantillon du modèle de score (walk-forward). '
    + 'Moteur : `liveCtxFromDetail` + `computeLiveModelGroups` (paquet ML en direct). '
    + 'Phase 1 = cadence fixe ; phase 2 = effets de score mesurés (`liveEffects.json`). '
    + 'Δ = phase 2 − phase 1 (négatif = phase 2 meilleure), ± 1,96 erreur type appariée par match.');
  lines.push('');
  for (const scope of ['all' as const, ...[...testSeasons].sort()]) {
    lines.push(`## ${scope === 'all' ? 'Toutes saisons de test' : `Saison ${scope}-${String(scope + 1).slice(2)}`}`);
    lines.push('');
    for (const mo of MOMENTS) {
      lines.push(`### ${mo.label}`);
      lines.push('');
      lines.push('| Question | n | Brier P1 | Brier P2 | Δ Brier | Log-loss P1 | Log-loss P2 | Δ log-loss |');
      lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
      for (const q of QUESTIONS) {
        const s = stats.get(keyOf(scope, mo.id, q.id));
        if (!s) continue;
        const dl = meanSe(s.dl), db = meanSe(s.db);
        const sig = (m: { mean: number; se: number }) =>
          `${m.mean >= 0 ? '+' : ''}${m.mean.toFixed(5)} ± ${(1.96 * m.se).toFixed(5)}${Math.abs(m.mean) > 1.96 * m.se ? (m.mean < 0 ? ' ✅' : ' ❌') : ''}`;
        lines.push(`| ${q.label} | ${s.n} | ${(s.b1 / s.n).toFixed(4)} | ${(s.b2 / s.n).toFixed(4)} | ${sig(db)} | `
          + `${(s.l1 / s.n).toFixed(4)} | ${(s.l2 / s.n).toFixed(4)} | ${sig(dl)} |`);
        rows.push({ scope, moment: mo.id, question: q.id, n: s.n,
          brier1: s.b1 / s.n, brier2: s.b2 / s.n, dBrier: db.mean, dBrierSe: db.se,
          logloss1: s.l1 / s.n, logloss2: s.l2 / s.n, dLogloss: dl.mean, dLoglossSe: dl.se });
      }
      lines.push('');
    }
  }
  // Synthèse : somme des log-loss sur toutes les questions et tous les moments.
  const all = rows.filter(r => r.scope === 'all');
  const tot1 = all.reduce((a, r) => a + r.logloss1 * r.n, 0), tot2 = all.reduce((a, r) => a + r.logloss2 * r.n, 0);
  const better = all.filter(r => r.dLogloss < 0 && Math.abs(r.dLogloss) > 1.96 * r.dLoglossSe).length;
  const worse = all.filter(r => r.dLogloss > 0 && Math.abs(r.dLogloss) > 1.96 * r.dLoglossSe).length;
  lines.splice(6, 0, `**Synthèse** : log-loss cumulée phase 1 ${tot1.toFixed(1)}, phase 2 ${tot2.toFixed(1)} `
    + `(${tot2 < tot1 ? '−' : '+'}${Math.abs(100 * (tot2 - tot1) / tot1).toFixed(2)} %). `
    + `Cases (question × moment) significativement meilleures : ${better}, pires : ${worse}, sur ${all.length}.`, '');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'live_report.md'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'live_report.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), seasons: [...testSeasons], games: games.length,
    effectsTrainSeasons: train.trainSeasons, rows,
  }, null, 2));
  console.log(lines.slice(0, 8).join('\n'));
  console.log(`✅ ${path.relative(process.cwd(), path.join(OUT_DIR, 'live_report.md'))}`);
  process.exit(0);
}

main();
