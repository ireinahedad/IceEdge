/**
 * B8 — LA CLÉ DE CACHE EST-ELLE PILOTABLE DEPUIS LA QUERY STRING ?
 *
 * LA QUESTION que B2 et B3 ne posent pas. Ils vérifient qu'UNE clé est bien
 * cachée et bien dédoublonnée — et elle l'est. Mais un cache parfait sur chaque
 * clé ne protège de rien si l'appelant choisit la clé : il lui suffit d'en
 * demander une nouvelle à chaque requête pour que chaque requête paie un
 * recalcul complet. Le cache est alors intact, et inutile.
 *
 * `getBestBets` construit sa clé avec `limit|days|maxPlayers|source|mlDepth`,
 * et la route `/api/predict/best-bets` laisse l'appelant poser `limit`, `days`
 * et `players`. Trois paramètres publics dans la clé d'un calcul lourd.
 *
 * CE QUI DISTINGUE UN PARAMÈTRE LÉGITIME D'UN TROU : est-ce qu'il change le
 * CALCUL, ou seulement sa PRÉSENTATION ? `days` et `players` changent
 * réellement ce qui est calculé — leur place dans la clé est justifiée.
 * `limit` ne fait que TRONQUER une liste déjà triée : le mettre dans la clé
 * transforme 50 façons de demander la même chose en 50 calculs distincts.
 *
 * Le banc mesure les deux, caches NHL déjà chauds pour qu'on voie le coût
 * MARGINAL d'un recalcul, pas celui d'un démarrage à froid.
 */

import { boot, request, sleep } from './harness';
import * as upstream from './upstream';
import * as pgstub from './pgstub';

export async function main() {
  upstream.setLeague({ teams: 32, games: 12, players: 40 });
  upstream.setLatency({ nhl: 10, odds: 10, ml: 5 });

  const { base, metrics, close } = await boot({ sqlLatencyMs: 2 });

  // Réchauffage : tout ce qui peut être en cache l'est.
  await request(base, '/api/predict/best-bets?limit=15');
  await sleep(50);

  const mesures: Record<string, { requetes: number; executions: number; hits: number; appels: number; ms: number }> = {};

  const essai = async (cle: string, titre: string, chemins: string[]) => {
    upstream.reset(); pgstub.reset(); metrics.resetMetrics();
    const t0 = Date.now();
    for (const p of chemins) await request(base, p, { discardBody: true });
    const dt = Date.now() - t0;
    const s = metrics.snapshotMetrics();
    const bb = s.caches['best-bets'];
    console.log(
      `${titre.padEnd(34)} requêtes=${String(chemins.length).padStart(3)}` +
      `  exécutions(best-bets.misses)=${String(bb.misses).padStart(3)}` +
      `  hits=${String(bb.hits).padStart(3)}` +
      `  appels amont=${String(upstream.total()).padStart(4)}` +
      `  ml=${String(upstream.total('ml')).padStart(3)}` +
      `  sql=${String(pgstub.total()).padStart(3)}` +
      `  ${dt} ms`,
    );
    mesures[cle] = { requetes: chemins.length, executions: bb.misses, hits: bb.hits, appels: upstream.total(), ms: dt };
  };

  console.log('\n═══ B8 · Clé de cache pilotable depuis la query string (caches NHL chauds) ═══\n');

  await essai('identique', 'même URL, 20 fois',
    Array.from({ length: 20 }, () => '/api/predict/best-bets?limit=15'));

  await essai('limit', 'limit=1..20 (20 URL)',
    Array.from({ length: 20 }, (_, i) => `/api/predict/best-bets?limit=${i + 1}`));

  await essai('players', 'players=1..20 (20 URL)',
    Array.from({ length: 20 }, (_, i) => `/api/predict/best-bets?players=${i + 1}`));

  await essai('days', 'days=1..7 (7 URL)',
    Array.from({ length: 7 }, (_, i) => `/api/predict/best-bets?days=${i + 1}`));

  await essai('horsBornes', 'limit hors bornes 51..70 (20 URL)',
    Array.from({ length: 20 }, (_, i) => `/api/predict/best-bets?limit=${51 + i}`));

  const s = metrics.snapshotMetrics();
  const bb = s.caches['best-bets'];
  console.log(`\n  cache best-bets : ${bb.size} / ${bb.maxEntries} entrées, ${bb.evictions} éviction(s)`);

  console.log(
    mesures.limit.executions > 1
      ? `\n  ✗ \`limit\` pilote la clé de cache : ${mesures.limit.executions} recalculs pour ${mesures.limit.requetes} requêtes\n` +
        `      (~${Math.round(mesures.limit.ms / mesures.limit.requetes)} ms de calcul chacune, contre ~${Math.round(mesures.identique.ms / mesures.identique.requetes)} ms servies depuis le cache).\n` +
        '      Or `limit` ne fait que tronquer une liste déjà triée : il n\'a pas à entrer dans la clé.\n' +
        '      Correctif : calculer au plafond (50), mettre CELA en cache, trancher à la sortie.'
      : '\n  ✓ `limit` n\'entre pas dans la clé de cache.',
  );

  // `days` et `players` changent RÉELLEMENT le calcul : leur place dans la clé
  // est justifiée. Ce qu'on vérifie ici, c'est que la liste blanche de
  // `ml.routes.ts` borne le nombre de calculs distincts qu'une URL peut
  // commander — 3 valeurs chacun, donc au plus 3 exécutions sur un balayage.
  const PLAFOND_LISTE_BLANCHE = 3;
  const debordent = [
    mesures.players.executions > PLAFOND_LISTE_BLANCHE ? `players (${mesures.players.executions})` : null,
    mesures.days.executions    > PLAFOND_LISTE_BLANCHE ? `days (${mesures.days.executions})`       : null,
  ].filter(Boolean);
  console.log(
    debordent.length
      ? `  ✗ ${debordent.join(' et ')} commandent plus de calculs que la liste blanche n'autorise :\n` +
        '      un balayage de l\'URL rouvre l\'espace de clés. Vérifier `BEST_BETS_DAYS` /\n' +
        '      `BEST_BETS_PLAYERS` dans `ml.routes.ts`.'
      : `  ✓ \`days\` et \`players\` restent bornés par la liste blanche` +
        ` (${mesures.days.executions} et ${mesures.players.executions} exécutions sur un balayage complet).\n` +
        '      Ils changent le calcul, donc leur place dans la clé est justifiée ; c\'est le NOMBRE\n' +
        '      de valeurs joignables qui devait être fermé, et il l\'est.',
  );

  console.log(
    `  · \`limit\` hors bornes (51..70) → ${mesures.horsBornes.executions} recalcul : \`normalizeOptions\` borne bien\n` +
    '    l\'espace des clés. C\'est le plafond qui tient, pas l\'absence de trou.',
  );

  await close();
}
