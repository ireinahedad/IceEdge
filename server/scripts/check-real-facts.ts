/**
 * check-real-facts.ts — le bloc FAITS sur de VRAIS matchs (pas des fixtures).
 *
 * Pour un match (`--game=<id>`), construit le paquet ML, les features et le bloc
 * FAITS de plusieurs tuiles, l'affiche, et applique des contrôles de cohérence
 * (probabilités, parts, sens pour/contre, écart au marché recalculé…).
 *
 *   npx ts-node scripts/check-real-facts.ts --list=2026-10-05           # liste les matchs d'un jour avec leurs identifiants
 *   npx ts-node scripts/check-real-facts.ts --game=2026020123            # lit et contrôle
 *   npx ts-node scripts/check-real-facts.ts --game=2026020123 --freeze   # + fige dans llmEval/real/
 *   npx ts-node scripts/check-real-facts.ts --game=… --max=20 --locale=en --sens
 *
 * `--freeze` écrit des fixtures JSON (résultat ML, features, λ) rejouées par
 * `llmEval.real.test.ts` : un vrai match devient un test de non-régression.
 * Nécessite le service ML, la base et l'API NHL (donc à lancer en local).
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { getGameMlBundle, getGameFeatures, mlBundleKey } from '../src/services/gameMlBundle';
import { buildPrematchGameMarkets } from '../src/services/nhlPredictions';
import { buildGameFacts, type BetDescriptor } from '../src/services/llmFacts';
import { computeGoalieSensitivities } from '../src/services/llmSensitivity';
import { fetchNHL } from '../src/services/nhl/core';
import { fetchGamesByDate } from '../src/services/nhl/teamsAndGames';
import { sanityCheckFacts } from '../src/services/llmEval/metrics';

const arg = (n: string): string | undefined => process.argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1];
const flag = (n: string): boolean => process.argv.includes(`--${n}`);

async function main(): Promise<void> {
  const list = arg('list');
  if (list) {
    const games = await fetchGamesByDate(list);
    if (!games.length) console.log(`Aucun match le ${list} (ou date hors calendrier).`);
    for (const g of games) console.log(`${g.id}  ${g.awayTeam?.abbreviation} @ ${g.homeTeam?.abbreviation}  ${g.status}  ${g.gameDate ?? ''}`);
    return;
  }
  const gameId = arg('game');
  if (!gameId) { console.error('Usage : --game=<gameId> [--freeze] | --list=AAAA-MM-JJ [--max=12] [--locale=fr|en] [--sens]'); process.exit(1); }
  const locale = arg('locale') === 'en' ? 'en' : 'fr';
  const max = Number(arg('max')) || 12;

  // `fetchGameById` avale la vraie cause (réseau, 404, JSON…) sous « Game not found » :
  // on la rend visible avant de conclure que l'identifiant est faux.
  try { await fetchNHL(`v1/gamecenter/${gameId}/landing`); }
  catch (e: any) {
    console.error(`API NHL v1/gamecenter/${gameId}/landing → ${e?.message ?? e}${e?.cause ? ` (cause : ${e.cause?.code ?? e.cause?.message ?? e.cause})` : ''}`);
    console.error('Astuce : --list=AAAA-MM-JJ affiche les identifiants valides d\'un jour. NHL_USE_MOCK=true dans .env ? Le mock ne connaît que ses propres matchs.');
    process.exit(1);
  }
  const [bundle, features, groups] = await Promise.all([
    getGameMlBundle(gameId), getGameFeatures(gameId), buildPrematchGameMarkets(gameId),
  ]);
  const live = bundle.live?.label ?? null;
  console.log(`Match ${gameId} : ${features.home_team} (dom.) – ${features.away_team}${live ? ` · EN COURS ${live}` : ''}`);
  console.log(`λ ${bundle.lambdaHome} – ${bundle.lambdaAway} · gardiens : ${features.home_goalie ?? '?'} / ${features.away_goalie ?? '?'}\n`);

  // Tuiles à contrôler : les deux vainqueurs d'abord, puis les premières de chaque groupe.
  const all = groups.flatMap(g => g.options.filter(o => o.ml?.type === 'game'));
  const priority = all.filter(o => o.id === 'ml-home' || o.id === 'ml-away');
  const rest = groups.flatMap(g => g.options.filter(o => o.ml?.type === 'game' && !priority.includes(o)).slice(0, 2));
  const picked = [...priority, ...rest].slice(0, max);

  const frozen: unknown[] = [];
  let bad = 0;
  for (const o of picked) {
    const ml = o.ml!;
    const bet: BetDescriptor = {
      type: 'game', label: o.label, gameId, optId: o.id,
      propType: ml.propType, line: ml.line, selection: ml.selection, isHome: ml.isHome,
    };
    const market = ml.propType ?? 'moneyline';
    const result = bundle.results[o.id]
      ?? bundle.byKey[mlBundleKey(market, ml.line, ml.selection, ml.isHome !== false)] ?? null;
    const sens = flag('sens') && !live && result
      ? await computeGoalieSensitivities(features, { market, line: ml.line, selection: ml.selection, isHome: ml.isHome, optId: o.id, gameId },
          Math.round(result.probability))
      : [];
    const facts = buildGameFacts({
      bet, result, features, lambdaHome: bundle.lambdaHome, lambdaAway: bundle.lambdaAway,
      liveLabel: live, goalieSensitivities: sens, locale,
    });
    const problems = sanityCheckFacts(facts, result);
    if (problems.length) bad++;
    console.log(`── ${o.id} · ${o.label} ${problems.length ? '⚠' : '✓'}`);
    console.log(facts.text);
    if (facts.caveat) console.log(`(réserve affichée : ${facts.caveat})`);
    for (const p of problems) console.log(`  ⚠ ${p}`);
    console.log('');
    frozen.push({ id: `${gameId}:${o.id}`, bet, result, features, lambdaHome: bundle.lambdaHome, lambdaAway: bundle.lambdaAway,
                  liveLabel: live, goalieSensitivities: sens });
  }
  console.log(`${picked.length - bad}/${picked.length} tuiles sans alerte.`);

  if (flag('freeze')) {
    const dir = path.join(__dirname, '..', 'src', 'services', 'llmEval', 'real');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${gameId}.json`);
    await fs.writeFile(file, JSON.stringify(frozen, null, 2));
    console.log(`Fixtures figées : ${file}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
