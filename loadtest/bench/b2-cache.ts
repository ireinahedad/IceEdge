/**
 * B2 — ABSENCE DE CACHE
 *
 * LA QUESTION : quand la MÊME requête arrive R fois d'affilée à l'intérieur du
 * TTL, combien d'appels sortants partent ?
 *
 * La réponse attendue est « ceux de la première, et plus rien ». Le chiffre qui
 * la dit est la colonne « appels 2→R » : elle doit valoir 0. Si elle suit R, il
 * n'y a pas de cache ; si elle vaut une poignée, un TTL est plus court qu'on ne
 * croit ou une clé de cache varie alors qu'elle ne devrait pas.
 *
 * DEUX CACHES SONT MESURÉS EN MÊME TEMPS, et ce n'est pas un défaut : le cache
 * de réponse (mémoire du serveur) ET le cache HTTP annoncé au navigateur et au
 * CDN. Le second est celui qui, en production derrière Cloudflare, fait que la
 * requête n'atteint même pas le serveur. Une réponse publique SANS
 * `Cache-Control` n'est pas « non cachable » : elle est laissée à l'heuristique
 * du cache, ce qui varie d'un proxy à l'autre — donc la colonne est affichée,
 * même quand le cache mémoire est parfait.
 *
 * Un processus par endpoint : le premier ne doit pas chauffer les caches du
 * suivant.
 */

import { TOUS } from './endpoints';
import { runChild } from './spawn';

export interface B2Row {
  id: string; repeats: number; cacheControl: string | null;
  premier: number; suivants: number;
  sqlPremier: number; sqlSuivants: number;
  parAppel: number[]; erreurs: number;
}

export function runB2(repeats = Number(process.env.BENCH_REPEATS ?? 20)): B2Row[] {
  return TOUS.map((ep) => runChild<B2Row>('b2-rung', {
    BENCH_EP: ep.id,
    BENCH_REPEATS: String(repeats),
  }));
}

export function printB2(rows: B2Row[]): void {
  const R = rows[0]?.repeats ?? 0;
  console.log(`\n═══ B2 · Absence de cache — ${R} requêtes identiques dans le TTL ═══\n`);
  console.log(' endpoint     │ appels 1re │ appels 2→R │ sql 1re │ sql 2→R │ Cache-Control renvoyé');
  console.log('──────────────┼────────────┼────────────┼─────────┼─────────┼──────────────────────');
  for (const r of rows) {
    console.log(
      ` ${r.id.padEnd(12)}│ ${String(r.premier).padStart(10)} │ ${String(r.suivants).padStart(10)} │` +
      ` ${String(r.sqlPremier).padStart(7)} │ ${String(r.sqlSuivants).padStart(7)} │ ${r.cacheControl ?? '— (aucun)'}`,
    );
  }

  const sansCacheMemoire = rows.filter((r) => r.suivants > 0);
  const sansEnTete = rows.filter((r) => !r.cacheControl);
  console.log(
    sansCacheMemoire.length
      ? `\n  ✗ cache mémoire inopérant sur : ${sansCacheMemoire.map((r) => `${r.id} (${r.suivants} appels pour ${R - 1} requêtes)`).join(', ')}`
      : `\n  ✓ cache mémoire : 0 appel sortant sur les ${R - 1} requêtes suivantes, partout`,
  );
  if (sansEnTete.length) {
    console.log(`  ⚠ sans en-tête Cache-Control : ${sansEnTete.map((r) => r.id).join(', ')} — laissé à l'heuristique du CDN`);
  }
  const sqlChaud = rows.filter((r) => r.sqlSuivants > 0);
  if (sqlChaud.length) {
    console.log(`  · accès base encore présents à chaud : ${sqlChaud.map((r) => `${r.id}=${r.sqlSuivants}`).join(', ')}`);
  }
}

export function main(): void {
  printB2(runB2());
}
