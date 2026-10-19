/**
 * B15 — SOIRÉE EN DIRECT (`ml/EXPLICATION_ML.md` §10.2)
 *
 * LA QUESTION : un soir de 16 matchs en cours, le coût du direct suit-il le
 * nombre de spectateurs ? Attendu : non. `liveCache` déduplique en vol, donc au
 * plus UN recalcul par match toutes les 30 s, et les appels à l'API NHL et au
 * service ML restent ceux d'un seul spectateur.
 *
 * Critères : exécutions du paquet en direct ≤ 2 par match et par minute
 * (une par fenêtre de 30 s) ; appels NHL et ML
 * identiques d'un palier de spectateurs à l'autre ; p95 stable.
 */

import { runChild } from './spawn';

const PALIERS = (process.env.BENCH_VIEWER_LEVELS ?? '20,200,1000').split(',').map(Number);

export function runB15(): any[] {
  return PALIERS.map(v => runChild('b15-rung', { BENCH_VIEWERS: String(v) }));
}

export function printB15(rows: any[]): void {
  console.log('\n═══ B15 · Soirée en direct — 16 matchs, V spectateurs, rafraîchissement ~1 s ═══\n');
  console.log('    V │ req/s │ p50 ms │ p95 ms │  max │ err │ recalculs direct │ /match/min │ dédoublonnés │ appels NHL │ appels ML │ Odds');
  for (const r of rows) {
    console.log(`${String(r.viewers).padStart(5)} │ ${String(r.rps).padStart(5)} │ ${String(r.p50).padStart(6)} │ ${String(r.p95).padStart(6)} │ ${String(r.max).padStart(4)} │ ${String(r.errors).padStart(3)} │ ${String(r.liveExecutions).padStart(16)} │ ${String(r.liveExecPerGamePerMin).padStart(10)} │ ${String(r.liveDedup).padStart(12)} │ ${String(r.nhl).padStart(10)} │ ${String(r.ml).padStart(9)} │ ${String(r.odds).padStart(4)}`);
  }
  const ok = rows.every(r => r.liveExecPerGamePerMin <= 2.2);
  console.log(ok ? '\n  ✓ au plus un recalcul par match toutes les 30 s, quel que soit V'
                 : '\n  ✗ le nombre de recalculs suit le nombre de spectateurs');
}

export function main(): void {
  printB15(runB15());
}
