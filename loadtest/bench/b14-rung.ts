/**
 * Palier du banc B14 — une soirée de règlement, processus neuf.
 *
 * `settlePendingSlips` est appelée DIRECTEMENT, sans passer par HTTP : c'est un
 * job de fond, pas une route. Le reste est le vrai code — pagination par
 * curseur, caches de passe, budget temps, garde d'idempotence.
 */

import { boot } from './harness';
import * as upstream from './upstream';
import * as pgstub from './pgstub';
import { emit, envInt } from './spawn';

export async function main() {
  const tickets = envInt('BENCH_SLIPS', 500);
  const matchs = envInt('BENCH_GAMES_FINAL', 10);
  const budgetMs = envInt('BENCH_SETTLE_BUDGET_MS', 120_000);
  const matchsTermines = process.env.BENCH_GAMES_OVER !== 'false';

  upstream.setLeague({ teams: 32, games: matchs, players: 20 });
  // Latence NHL réaliste : c'est elle qui décide si « 10 récupérations » ou
  // « 500 » change quelque chose. À 0 ms, le regroupement par match serait
  // invisible et le banc ne dirait rien de ce qu'il est censé mesurer.
  upstream.setLatency({ nhl: 120, odds: 20, ml: 10 });
  upstream.setGamesFinal(matchsTermines);
  pgstub.setUserRole('user');
  pgstub.seedPendingSlips(tickets, matchs);

  const { metrics, close } = await boot({ sqlLatencyMs: 4 });
  const { settlePendingSlips } = await import('../../server/src/services/settlement.service');

  upstream.reset();
  pgstub.reset();
  metrics.resetMetrics();

  const debut = Date.now();
  const resume = await settlePendingSlips(undefined, { budgetMs });
  const dureeMs = Date.now() - debut;

  const c = upstream.counts();
  const parIssue = pgstub.reglesParIssue();

  emit({
    tickets,
    matchs,
    matchsTermines,
    budgetMs,
    dureeMs,
    resume,
    restants: pgstub.pendingRestants(),
    parIssue,
    nhl: c['nhl-web'] + c['nhl-stats'],
    appels: upstream.total(),
    appelsDistincts: upstream.distinct(),
    sql: pgstub.total(),
    sqlParReglement: resume.settled ? +(pgstub.total() / resume.settled).toFixed(2) : 0,
    detailSql: pgstub.byStatement().slice(0, 5),
    debitParSeconde: dureeMs ? +((resume.settled / dureeMs) * 1000).toFixed(1) : 0,
  });

  await close();
}
