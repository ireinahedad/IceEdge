/**
 * B15 — SOIRÉE EN DIRECT (`ml/EXPLICATION_ML.md` §10.2)
 *
 * LA QUESTION : un soir de 16 matchs en cours, le coût du direct suit-il le
 * nombre de spectateurs ? Attendu : non. `liveCache` déduplique en vol, donc au
 * plus UN recalcul par match par fenêtre — 30 s en cours de match, 10 s en fin
 * de match (`liveRefresh.ts`) — et les appels à l'API NHL et au service ML
 * restent ceux d'un seul spectateur.
 *
 * Critères : ≤ 2 recalculs par match et par minute en cours de match, ≤ 6 en
 * fin de match ; 2 appels NHL par recalcul (landing + boxscore) ; appels NHL et ML
 * identiques d'un palier de spectateurs à l'autre ; p95 stable.
 */

import { runChild } from './spawn';

const PALIERS = (process.env.BENCH_VIEWER_LEVELS ?? '20,200,1000').split(',').map(Number);

export function runB15(): any[] {
  return PALIERS.map(v => runChild('b15-rung', { BENCH_VIEWERS: String(v) }));
}

export function printB15(rows: any[]): void {
  console.log('\n═══ B15 · Soirée en direct — 16 matchs, V spectateurs, rafraîchissement ~1 s ═══\n');
  console.log('    V │ req/s │ p50 ms │ p95 ms │  max │ err │ recalculs/min (cours) │ (fin) │ NHL/recalcul │ appels ML │ Ko/réponse');
  for (const r of rows) {
    console.log(`${String(r.viewers).padStart(5)} │ ${String(r.rps).padStart(5)} │ ${String(r.p50).padStart(6)} │ ${String(r.p95).padStart(6)} │ ${String(r.max).padStart(4)} │ ${String(r.errors).padStart(3)} │ ${String(r.recalcPerMinMid).padStart(21)} │ ${String(r.recalcPerMinEndgame).padStart(5)} │ ${String(r.nhlPerRecalc).padStart(12)} │ ${String(r.ml).padStart(9)} │ ${String(r.avgKb).padStart(10)}`);
  }
  const ok = rows.every(r => r.recalcPerMinMid <= 2.2 && r.recalcPerMinEndgame <= 6.6 && r.nhlPerRecalc <= 2.05);
  console.log(ok ? '\n  ✓ un recalcul par match et par fenêtre (30 s, 10 s en fin de match), 2 appels NHL par recalcul, quel que soit V'
                 : '\n  ✗ recalculs ou appels NHL au-delà du rythme attendu');
}

export function main(): void {
  printB15(runB15());
}
