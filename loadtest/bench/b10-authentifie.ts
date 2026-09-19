/**
 * B10 — CHEMINS AUTHENTIFIÉS : Pro, tickets, chat
 *
 * POURQUOI CE BANC EXISTE. La première campagne n'a mesuré que l'anonyme : la
 * landing, les cotes, les prédictions. Le rapport du 2026-09-18 le disait en
 * une ligne — « `isPro` est resté à zéro », c'est-à-dire que le cache
 * d'entitlement de l'audit (ligne L) n'avait JAMAIS été exercé. Un cache dont
 * on n'a pas mesuré le taux de hit est un cache dont on espère qu'il marche.
 *
 * TROIS QUESTIONS :
 *
 *  1. **N+1 sur les listings.** Tickets, salons, messages, membres : ces
 *     endpoints servent des COLLECTIONS. On sert la même requête avec 5 lignes
 *     puis 100 et on compare le nombre de requêtes SQL. Constant = sain ;
 *     « 1 + nombre de lignes » = N+1. C'est la méthode de B4, appliquée là où
 *     les collections sont vraiment grandes.
 *
 *  2. **Le coût d'une ouverture de salon.** Le scénario S4 de l'audit fixe le
 *     critère explicitement : « le nombre de requêtes Neon par ouverture de
 *     salon doit être ~1, pas ~100 ». `getMessages` charge 100 messages puis
 *     leurs réactions ; si les réactions repartaient en base par message, une
 *     ouverture coûterait 100 allers-retours — sur un pool qui en compte dix.
 *
 *  3. **Le cache `isPro`.** Une rafale sur une route `requirePro` : `misses`
 *     doit rester très inférieur au nombre de requêtes. Sinon l'entitlement est
 *     relu en base à chaque appel, ce qui était l'état d'avant la ligne L.
 *
 * Un processus par taille de données, comme partout : « à froid » ne veut rien
 * dire dans un processus qui vient d'en servir un autre.
 */

import { runChild } from './spawn';

const TAILLES = (process.env.BENCH_ROWS_LEVELS ?? '5,100').split(',').map(Number);

export interface B10Endpoint {
  id: string; taille: boolean; pro: boolean;
  status: number; statusChaud: number;
  sqlFroid: number; sqlChaud: number; ms: number;
  detail: Array<{ sql: string; n: number }>;
  erreur: string | null;
}
export interface B10Row {
  rows: number; rafale: number;
  endpoints: B10Endpoint[];
  isPro: { hits: number; misses: number; dedup: number; hitRate: number } | null;
  sqlRafale: number;
}

export function runB10(): B10Row[] {
  return TAILLES.map((rows) => runChild<B10Row>('b10-rung', { BENCH_ROWS: String(rows) }));
}

export function printB10(runs: B10Row[]): void {
  console.log('\n═══ B10 · Chemins authentifiés — requêtes SQL par requête HTTP ═══\n');

  const entetes = runs.map((r) => `${r.rows} lignes`);
  console.log(
    ` endpoint          │ ${entetes.map((e) => `froid ${e}`.padStart(15)).join(' │ ')} │` +
    ` ${entetes.map((e) => `chaud ${e}`.padStart(15)).join(' │ ')}`,
  );
  console.log(
    `───────────────────┼${runs.map(() => '─'.repeat(17)).join('┼')}─┼${runs.map(() => '─'.repeat(17)).join('┼')}`,
  );

  const ids = runs[0].endpoints.map((e) => e.id);
  const suspects: string[] = [];
  const ecartLignes = Math.max(...TAILLES) - Math.min(...TAILLES);

  for (const id of ids) {
    const e0 = runs[0].endpoints.find((e) => e.id === id)!;
    const froids = runs.map((r) => r.endpoints.find((e) => e.id === id)!.sqlFroid);
    const chauds = runs.map((r) => r.endpoints.find((e) => e.id === id)!.sqlChaud);
    console.log(
      ` ${id.padEnd(17)}│ ${froids.map((v) => String(v).padStart(15)).join(' │ ')} │` +
      ` ${chauds.map((v) => String(v).padStart(15)).join(' │ ')}`,
    );

    // Seuls les endpoints de COLLECTION peuvent être en N+1 : comparer les
    // autres reviendrait à comparer du bruit.
    if (!e0.taille) continue;
    const ecart = Math.max(...froids) - Math.min(...froids);
    if (ecart > 2 && ecart >= ecartLignes * 0.5) suspects.push(`${id} (${froids.join(' → ')})`);
  }

  console.log(
    suspects.length
      ? `\n  ✗ le nombre de requêtes SQL suit le nombre de lignes : ${suspects.join(', ')}`
      : `\n  ✓ nombre de requêtes SQL constant de ${Math.min(...TAILLES)} à ${Math.max(...TAILLES)} lignes — pas de N+1`,
  );

  // ── Critère S4 : le coût d'une ouverture de salon ───────────────────────
  const gros = runs[runs.length - 1];
  const messages = gros.endpoints.find((e) => e.id === 'chat/messages')!;
  console.log(
    messages.sqlFroid <= 4
      ? `  ✓ ouvrir un salon de ${gros.rows} messages coûte ${messages.sqlFroid} requêtes Neon` +
        ` — le critère S4 (« ~1, pas ~100 ») est tenu.`
      : `  ✗ ouvrir un salon de ${gros.rows} messages coûte ${messages.sqlFroid} requêtes Neon` +
        ` — S4 demande ~1. Chercher une lecture par message.`,
  );

  // ── Le cache d'entitlement ──────────────────────────────────────────────
  const pro = gros.isPro;
  if (!pro || pro.hits + pro.misses + pro.dedup === 0) {
    console.log('  ⚠ le cache `isPro` n\'a pas été exercé : la rafale n\'a pas touché de route Pro.');
  } else {
    console.log(
      pro.misses <= 2
        ? `  ✓ cache \`isPro\` : ${pro.misses} lecture(s) en base pour ${gros.rafale} requêtes Pro` +
          ` (${pro.hits} hits, ${pro.dedup} dédoublonnées).`
        : `  ✗ cache \`isPro\` : ${pro.misses} lectures en base pour ${gros.rafale} requêtes Pro —` +
          ` l'entitlement repart en base trop souvent.`,
    );
  }

  const ko = runs.flatMap((r) => r.endpoints).filter((e) => e.status >= 400);
  if (ko.length) {
    console.log(`  ⚠ ${ko.length} réponse(s) en erreur : ${[...new Set(ko.map((e) => `${e.id}=${e.status}`))].join(', ')}`);
  }

  // Le détail du plus gros palier : c'est là qu'une boucle se verrait.
  console.log(`\n  Détail à ${gros.rows} lignes (requêtes émises à froid) :`);
  for (const e of gros.endpoints) {
    if (!e.detail.length) { console.log(`    ${e.id.padEnd(17)} → aucune requête SQL`); continue; }
    console.log(`    ${e.id} →`);
    for (const d of e.detail) console.log(`        ${String(d.n).padStart(3)}×  ${d.sql}`);
  }
}

export function main(): void {
  printB10(runB10());
}
