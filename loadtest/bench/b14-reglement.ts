/**
 * B14 — SOIRÉE DE RÈGLEMENT (scénario S6)
 *
 * CE QUE S6 DEMANDE : 2 000 tickets en attente sur une dizaine de matchs, les
 * matchs passent finaux, une passe de règlement. Critère : la file est vidée en
 * moins de dix minutes.
 *
 * POURQUOI CE TEST A CHANGÉ DE NATURE. Avec l'ancien plafond de 200 tickets par
 * passe, il échouait PAR CONSTRUCTION : une soirée à 2 000 tickets se vidait à
 * 200 par passe, et des gens attendaient des jours le règlement d'un pari dont
 * le résultat était public. Depuis le lot du 2026-08-02, c'est le BUDGET TEMPS
 * qui arrête la passe, pas une constante — donc le test mesure enfin un débit.
 *
 * LES TROIS CHIFFRES :
 *
 *  1. **`exhausted`** — la file a-t-elle été vidée ? C'est la seule réponse
 *     binaire de S6. Faux durablement = la file se remplit plus vite qu'elle ne
 *     se vide, et aucun débit ne rattrape ça.
 *
 *  2. **Appels NHL par passe.** Régler 500 tickets portant sur 10 matchs doit
 *     coûter **10 récupérations, pas 500** : les caches de passe sont créés une
 *     fois pour toute la boucle. Si cette colonne suit le nombre de TICKETS, le
 *     regroupement par match ne fonctionne pas, et une soirée chargée
 *     martèlerait l'API NHL au lieu de la consulter.
 *
 *  3. **Requêtes SQL par ticket réglé.** C'est ce qui décide du débit réel
 *     quand la base est à Francfort : chaque aller-retour Neon coûte 20-40 ms
 *     et une place dans un pool qui en compte dix.
 *
 * LE PALIER « MATCHS NON TERMINÉS » est le contrôle : rien ne doit être réglé,
 * et la passe doit quand même se terminer proprement. Un banc qui ne sait
 * distinguer « tout réglé » de « rien à régler » ne prouve pas grand-chose.
 */

import { runChild } from './spawn';

const PALIERS = (process.env.BENCH_SLIP_LEVELS ?? '200,1000').split(',').map(Number);
const MATCHS = Number(process.env.BENCH_GAMES_FINAL ?? 10);

export interface B14Row {
  tickets: number; matchs: number; matchsTermines: boolean;
  budgetMs: number; dureeMs: number;
  resume: { checked: number; settled: number; wins: number; losses: number; exhausted: boolean };
  restants: number;
  parIssue: { win: number; loss: number };
  nhl: number; appels: number; appelsDistincts: number;
  sql: number; sqlParReglement: number;
  detailSql: Array<{ sql: string; n: number }>;
  debitParSeconde: number;
}

export function runB14(): B14Row[] {
  const rows = PALIERS.map((n) => runChild<B14Row>('b14-rung', {
    BENCH_SLIPS: String(n),
    BENCH_GAMES_FINAL: String(MATCHS),
  }));
  // Contrôle : mêmes tickets, matchs NON terminés.
  rows.push(runChild<B14Row>('b14-rung', {
    BENCH_SLIPS: String(PALIERS[0]),
    BENCH_GAMES_FINAL: String(MATCHS),
    BENCH_GAMES_OVER: 'false',
  }));
  return rows;
}

export function printB14(rows: B14Row[]): void {
  console.log(`\n═══ B14 · Soirée de règlement — tickets en attente sur ${rows[0].matchs} matchs (S6) ═══\n`);
  console.log(' tickets │ matchs finaux │ examinés │ réglés │ G/P      │ vidée │ durée   │ débit/s │ appels NHL │ SQL/réglé');
  console.log('─────────┼───────────────┼──────────┼────────┼──────────┼───────┼─────────┼─────────┼────────────┼──────────');
  for (const r of rows) {
    console.log(
      ` ${String(r.tickets).padStart(7)} │ ${(r.matchsTermines ? 'oui' : 'NON (contrôle)').padStart(13)} │` +
      ` ${String(r.resume.checked).padStart(8)} │ ${String(r.resume.settled).padStart(6)} │` +
      ` ${`${r.resume.wins}/${r.resume.losses}`.padStart(8)} │ ${(r.resume.exhausted ? 'oui' : 'NON').padStart(5)} │` +
      ` ${String(Math.round(r.dureeMs / 100) / 10 + ' s').padStart(7)} │ ${String(r.debitParSeconde).padStart(7)} │` +
      ` ${String(r.nhl).padStart(10)} │ ${String(r.sqlParReglement).padStart(9)}`,
    );
  }

  const reels = rows.filter((r) => r.matchsTermines);
  const controle = rows.find((r) => !r.matchsTermines);
  const gros = reels[reels.length - 1];

  // ── 1. La file est-elle vidée ? ─────────────────────────────────────────
  const toutesVidees = reels.every((r) => r.resume.exhausted && r.restants === 0);
  console.log(
    toutesVidees
      ? `\n  ✓ la file est VIDÉE à tous les paliers (\`exhausted\` vrai, 0 ticket restant).`
      : `\n  ✗ file non vidée : ${reels.filter((r) => !r.resume.exhausted).map((r) => `${r.tickets} tickets → ${r.restants} restants`).join(', ')}`,
  );

  // Extrapolation au volume de S6, honnêtement étiquetée.
  if (gros.debitParSeconde > 0) {
    const minutes2000 = 2000 / gros.debitParSeconde / 60;
    console.log(
      `  · au débit mesuré (${gros.debitParSeconde} tickets/s), les 2 000 tickets de S6 prendraient` +
      ` ~${minutes2000.toFixed(1)} min — critère : < 10 min.\n` +
      '    À lire comme un ORDRE DE GRANDEUR : la base et l\'API NHL sont bouchonnées avec des\n' +
      '    latences fixes, donc ce débit décrit le coût CPU et le nombre d\'allers-retours, pas\n' +
      '    ce que fera Neon un soir de match.',
    );
  }

  // ── 2. Le regroupement par match ────────────────────────────────────────
  const parMatch = reels.map((r) => `${r.tickets}→${r.nhl}`);
  const suitLesTickets = gros.nhl > gros.matchs * 3;
  console.log(
    suitLesTickets
      ? `  ✗ les appels NHL suivent le nombre de TICKETS (${parMatch.join(', ')}) — les caches de passe\n` +
        '    ne regroupent pas par match.'
      : `  ✓ appels NHL constants quel que soit le nombre de tickets (${parMatch.join(', ')}) :\n` +
        `    ${gros.nhl} récupérations pour ${gros.tickets} tickets sur ${gros.matchs} matchs. Les caches de passe tiennent.`,
  );

  // ── 3. Le coût SQL par règlement ────────────────────────────────────────
  console.log(
    `  · ${gros.sqlParReglement} requêtes SQL par ticket réglé (${gros.sql} au total).` +
    ' C\'est ce chiffre qui décide du débit\n    réel quand la base est distante.',
  );
  if (gros.detailSql.length) {
    console.log('    Répartition :');
    for (const d of gros.detailSql) console.log(`        ${String(d.n).padStart(5)}×  ${d.sql}`);
  }

  // ── 4. Le contrôle ──────────────────────────────────────────────────────
  if (controle) {
    const bonControle = controle.resume.settled === 0 && controle.resume.checked > 0;
    console.log(
      bonControle
        ? `  ✓ contrôle : matchs non terminés → ${controle.resume.checked} tickets examinés, ${controle.resume.settled} réglé.\n` +
          '    Le banc sait donc distinguer « tout réglé » de « rien à régler ».'
        : `  ✗ contrôle inexploitable : ${controle.resume.checked} examinés, ${controle.resume.settled} réglés alors que\n` +
          '    les matchs ne sont pas terminés. Un ticket ne devrait jamais se régler contre un match en cours.',
    );
  }
}

export function main(): void {
  printB14(runB14());
}
