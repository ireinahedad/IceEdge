/**
 * B1 — MULTIPLICATION INATTENDUE DES REQUÊTES
 *
 * LA QUESTION : pour UNE requête HTTP entrante sur un cache entièrement froid,
 * combien d'appels sortants partent — et combien d'entre eux demandent une URL
 * déjà demandée pendant la même requête ?
 *
 * POURQUOI LA SECONDE MOITIÉ EST LA VRAIE QUESTION. Un endpoint qui agrège
 * douze matchs a besoin de plusieurs appels : ça n'est pas un défaut, c'est son
 * travail. Ce qui EST un défaut, c'est de demander DEUX FOIS la même URL dans
 * la même requête — la ligne Z de l'audit (26 appels Odds pour une exécution de
 * `best-bets`), ou le calendrier d'équipe payé deux fois parce que le repos et
 * le voyage mettaient en cache leurs résultats dérivés sous deux clés.
 *
 * D'où la colonne « gaspillage » = appels émis − URL distinctes. Elle doit
 * valoir 0. Elle ne dépend d'aucun seuil arbitraire, ce qui en fait un critère
 * qu'on peut laisser dans un test de non-régression.
 *
 * Chaque endpoint est mesuré dans SON processus : sinon le second profiterait
 * des caches chauffés par le premier et on mesurerait l'ordre du tableau.
 */

import { TOUS } from './endpoints';
import { runChild } from './spawn';

const env = {
  BENCH_TEAMS: process.env.BENCH_TEAMS ?? '32',
  BENCH_GAMES: process.env.BENCH_GAMES ?? '8',
  BENCH_PLAYERS: process.env.BENCH_PLAYERS ?? '30',
};

export interface B1Row {
  id: string; status: number; ms: number; cacheControl: string | null;
  nhl: number; odds: number; ml: number; sql: number;
  appels: number; appelsDistincts: number; gaspillage: number;
  pires: Array<{ url: string; n: number }>;
  caches: Record<string, { h: number; m: number; d: number }>;
  erreur: string | null;
}

export function runB1(): B1Row[] {
  return TOUS.map((ep) => runChild<B1Row>('b1-rung', { ...env, BENCH_EP: ep.id }));
}

export function printB1(rows: B1Row[]): void {
  console.log('\n═══ B1 · Multiplication des requêtes — 1 requête HTTP, cache froid ═══\n');
  console.log(' endpoint     │ HTTP │ appels │ dont distincts │ gaspillage │ nhl │ odds │ ml │ sql');
  console.log('──────────────┼──────┼────────┼────────────────┼────────────┼─────┼──────┼────┼────');
  for (const r of rows) {
    console.log(
      ` ${r.id.padEnd(12)}│ ${String(r.status).padStart(4)} │ ${String(r.appels).padStart(6)} │` +
      ` ${String(r.appelsDistincts).padStart(14)} │ ${String(r.gaspillage).padStart(10)} │` +
      ` ${String(r.nhl).padStart(3)} │ ${String(r.odds).padStart(4)} │ ${String(r.ml).padStart(2)} │ ${String(r.sql).padStart(3)}`,
    );
  }
  const fautifs = rows.filter((r) => r.gaspillage > 0);
  console.log(
    fautifs.length
      ? `\n  ✗ ${fautifs.length} endpoint(s) émettent deux fois le même appel dans la même requête :\n` +
        fautifs.map((r) => `      ${r.id} → ${r.pires.filter((p) => p.n > 1).map((p) => `${p.n}× ${p.url}`).join(', ')}`).join('\n')
      : '\n  ✓ aucun appel émis deux fois dans une même requête (gaspillage = 0 partout)',
  );
  const ko = rows.filter((r) => r.status >= 400);
  if (ko.length) console.log(`  ⚠ ${ko.length} endpoint(s) en erreur : ${ko.map((r) => `${r.id}=${r.status}`).join(', ')}`);
}

export function main(): void {
  printB1(runB1());
}
