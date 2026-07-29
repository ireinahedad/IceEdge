/**
 * Banc de mesure du troupeau (stampede) sur `nhlApiClient`.
 *
 * QUESTION TRANCHÉE ICI
 *
 * `nhlApiClient` utilise le couple `getCached`/`setCached` et non `TtlCache.wrap`.
 * Entre le moment où N requêtes concurrentes lisent un cache froid et celui où
 * la première écrit sa réponse, TOUTES voient `null` et partent chercher la même
 * donnée. Combien d'appels NHL cela produit-il réellement ?
 *
 * Ce banc répond sur le vrai code, sans base de données, sans serveur, sans
 * réseau : `fetch` est remplacé par un bouchon qui compte et simule une latence.
 *
 * LANCER (depuis server/) :
 *
 *   ./node_modules/.bin/ts-node --transpile-only \
 *     --compiler-options '{"module":"commonjs","resolveJsonModule":true,"esModuleInterop":true}' \
 *     ../loadtest/stampede.ts
 *
 * LIRE : si la colonne « appels NHL émis » suit N, il n'y a aucune
 * déduplication en vol. Le bloc `wrap` juste en dessous montre ce que la même
 * charge donne avec — c'est l'écart qui décide de la migration.
 *
 * À REJOUER APRÈS MIGRATION : les deux blocs doivent alors afficher 1.
 */

import { join } from 'path';

const SRC = join(__dirname, '..', 'server', 'src');

let fetchCount = 0;
let upstreamLatencyMs = 200;

// Bouchon : compte, temporise, et rend la forme minimale que `fetchTeams`
// attend de `v1/standings/now`.
(globalThis as any).fetch = async () => {
  fetchCount += 1;
  await new Promise((r) => setTimeout(r, upstreamLatencyMs));
  return {
    ok: true,
    status: 200,
    json: async () => ({
      standings: [{
        teamAbbrev: { default: 'BOS' },
        teamFullName: { default: 'Boston Bruins' },
        gamesPlayed: 10, wins: 6, losses: 3, otLosses: 1, points: 13,
      }],
    }),
  };
};

async function main() {
  const { TtlCache } = await import(`${SRC}/services/ttlCache`);
  const metrics = await import(`${SRC}/metrics`);

  console.log('\n═══ Clé froide — nhlApiClient.fetchTeams() ═══\n');
  console.log(' N concurrents │ latence amont │ appels NHL émis │ gaspillage');
  console.log('───────────────┼───────────────┼─────────────────┼───────────');

  const profils: [number, number][] = [[10, 200], [50, 200], [100, 200], [500, 200], [500, 50], [500, 500]];

  for (const [n, lat] of profils) {
    // Le cache vit dans le module : pour repartir VRAIMENT froid à chaque tour,
    // on recharge le module plutôt que d'attendre l'expiration du TTL (5 min).
    delete require.cache[require.resolve(`${SRC}/services/nhlApiClient`)];
    const nhl = await import(`${SRC}/services/nhlApiClient`);

    fetchCount = 0;
    upstreamLatencyMs = lat;
    await Promise.all(Array.from({ length: n }, () => nhl.fetchTeams()));

    console.log(
      ` ${String(n).padStart(13)} │ ${String(lat + ' ms').padStart(13)} │ ` +
      `${String(fetchCount).padStart(15)} │ ${String(fetchCount - 1).padStart(9)}`,
    );
  }

  // ── Contrôle : une fois le cache REMPLI, la même vague doit coûter 0 ────────
  // Sans ce contrôle, on ne saurait pas distinguer « pas de déduplication » de
  // « le cache ne marche pas du tout » — deux diagnostics très différents.
  delete require.cache[require.resolve(`${SRC}/services/nhlApiClient`)];
  const chaud = await import(`${SRC}/services/nhlApiClient`);
  upstreamLatencyMs = 200;
  await chaud.fetchTeams();          // réchauffage, seul
  fetchCount = 0;
  await Promise.all(Array.from({ length: 500 }, () => chaud.fetchTeams()));
  console.log(`\n Contrôle — cache chaud, 500 concurrents → ${fetchCount} appel(s)`);
  console.log(' (0 attendu : le cache fonctionne, le trou est la fenêtre froide)');

  // ── Comparaison : la même charge à travers wrap ─────────────────────────────
  console.log('\n═══ Même charge, à travers TtlCache.wrap ═══\n');
  for (const n of [100, 500]) {
    const cache = new TtlCache<string>(60_000, 10, `bench-${n}`);
    fetchCount = 0;
    await Promise.all(
      Array.from({ length: n }, () =>
        cache.wrap('k', async () => { await (globalThis as any).fetch(); return 'v'; }),
      ),
    );
    const s = metrics.snapshotMetrics().caches[`bench-${n}`];
    console.log(` ${String(n).padStart(3)} concurrents → ${fetchCount} appel(s)  (misses=${s.misses}, dedup=${s.dedup})`);
  }

  // ── Ordre de grandeur en trafic réel ───────────────────────────────────────
  // Le banc ci-dessus fait arriver tout le monde au même instant : c'est le
  // pire cas. En trafic réel, seules les requêtes arrivant PENDANT l'appel
  // amont se dupliquent.
  console.log('\n═══ Ordre de grandeur en trafic réel ═══\n');
  console.log(' doublons ≈ débit d\'arrivée × latence amont, par fenêtre froide\n');
  for (const rps of [10, 50, 100]) {
    for (const lat of [200, 500]) {
      console.log(`  ${String(rps).padStart(3)} req/s × ${lat} ms → ~${Math.round((rps * lat) / 1000)} appels au lieu de 1`);
    }
  }
  console.log('');
}

main().catch((e) => { console.error('ÉCHEC', e); process.exit(1); });
