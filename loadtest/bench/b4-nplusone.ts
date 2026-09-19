/**
 * B4 — REQUÊTES N+1
 *
 * LA QUESTION : le nombre de requêtes SQL émises pour servir UNE requête HTTP
 * dépend-il du nombre de LIGNES ramenées ?
 *
 * C'est la définition du N+1, et c'est aussi la seule façon de le détecter sans
 * lire tout le code : on sert la même requête HTTP avec 5 lignes puis avec 100,
 * et on compare. Un code sain fait le même nombre de requêtes dans les deux cas
 * (il ramène plus de lignes, pas plus de requêtes). Un code en N+1 fait
 * « 1 + nombre de lignes ».
 *
 * POURQUOI LA LATENCE NE SUFFIT PAS. En local, la base est à côté : cent
 * requêtes coûtent cent millisecondes et personne ne les remarque. En
 * production la base est chez Neon, derrière PgBouncer, à 20-40 ms
 * l'aller-retour : les mêmes cent requêtes coûtent trois secondes ET cent
 * places dans un pool qui en a dix. Le seul chiffre qui prédit ça est le
 * COMPTE, et il ne dépend ni de la machine ni du réseau.
 *
 * Un processus par taille de données, pour que la mesure « à froid » le soit.
 */

import { runChild } from './spawn';

const TAILLES = (process.env.BENCH_ROWS_LEVELS ?? '5,100').split(',').map(Number);

export interface B4Endpoint {
  id: string; status: number; statusChaud: number;
  sqlFroid: number; sqlChaud: number;
  detail: Array<{ sql: string; n: number }>;
}
export interface B4Row { rows: number; endpoints: B4Endpoint[] }

export function runB4(): B4Row[] {
  return TAILLES.map((rows) => runChild<B4Row>('b4-rung', { BENCH_ROWS: String(rows) }));
}

export function printB4(runs: B4Row[]): void {
  console.log('\n═══ B4 · Requêtes N+1 — requêtes SQL par requête HTTP ═══\n');
  const entetes = runs.map((r) => `${r.rows} lignes`);
  console.log(` endpoint     │ ${entetes.map((e) => `froid ${e}`.padStart(16)).join(' │ ')} │ ${entetes.map((e) => `chaud ${e}`.padStart(16)).join(' │ ')}`);
  console.log(`──────────────┼${runs.map(() => '─'.repeat(18)).join('┼')}─┼${runs.map(() => '─'.repeat(18)).join('┼')}`);

  const ids = runs[0].endpoints.map((e) => e.id);
  const suspects: string[] = [];

  for (const id of ids) {
    const froids = runs.map((r) => r.endpoints.find((e) => e.id === id)!.sqlFroid);
    const chauds = runs.map((r) => r.endpoints.find((e) => e.id === id)!.sqlChaud);
    console.log(
      ` ${id.padEnd(12)}│ ${froids.map((v) => String(v).padStart(16)).join(' │ ')} │ ${chauds.map((v) => String(v).padStart(16)).join(' │ ')}`,
    );

    // Critère : le compte ne doit pas suivre la taille des données. Une
    // différence de 1 ou 2 peut venir d'un chemin conditionnel ; une différence
    // proportionnelle est un N+1.
    const ecart = Math.max(...froids) - Math.min(...froids);
    const ecartLignes = Math.max(...TAILLES) - Math.min(...TAILLES);
    if (ecart > 2 && ecart >= ecartLignes * 0.5) suspects.push(`${id} (${froids.join(' → ')})`);
  }

  console.log(
    suspects.length
      ? `\n  ✗ le nombre de requêtes SQL suit le nombre de lignes : ${suspects.join(', ')}`
      : `\n  ✓ nombre de requêtes SQL constant de ${Math.min(...TAILLES)} à ${Math.max(...TAILLES)} lignes — pas de N+1 sur ces chemins`,
  );

  // Le détail des requêtes du plus gros palier : c'est là qu'une boucle se voit.
  const gros = runs[runs.length - 1];
  console.log(`\n  Détail à ${gros.rows} lignes (requêtes émises à froid) :`);
  for (const e of gros.endpoints) {
    if (!e.detail.length) { console.log(`    ${e.id} → aucune requête SQL`); continue; }
    console.log(`    ${e.id} →`);
    for (const d of e.detail) console.log(`        ${String(d.n).padStart(3)}×  ${d.sql}`);
  }
}

export function main(): void {
  printB4(runB4());
}
