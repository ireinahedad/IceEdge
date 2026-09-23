/**
 * gameMlBundle.ts — les prédictions ML de TOUTES les tuiles d'un match, en une
 * requête, mises en cache par match.
 *
 * ── Ce que ça remplace ──────────────────────────────────────────────────────
 *
 * En mode ML, chacune des ~95 tuiles de la page d'un match appelait
 * `POST /api/predict/ml`. Chaque appel reconstruisait les features du match
 * (`buildGameFeatures` : fiches d'équipe, repos, cotes, gardiens, absents) et
 * refaisait tourner le classifieur, le modèle de score et l'ensemble bootstrap
 * côté Python — pour les MÊMES λ à chaque fois. Avec `predictLimiter` à 60
 * requêtes/minute, la moitié des tuiles finissait en 429 et en « — ».
 *
 * ── Ce que ça fait ──────────────────────────────────────────────────────────
 *
 *   1. La liste des tuiles vient de `buildGameMarkets` — la même que celle que
 *      la page affiche, avec le marché ML que chaque tuile annonce (`ml`).
 *   2. Les features du match sont construites UNE fois.
 *   3. Python price tous les marchés depuis un seul contexte
 *      (`/predict/game/bundle`).
 *   4. Le résultat est gardé 10 minutes par match, pour tout le monde : le
 *      modèle est d'avant-match, ses entrées ne bougent qu'avec les blessures,
 *      le gardien annoncé ou les cotes. Deux requêtes simultanées sur un match
 *      froid ne déclenchent qu'un calcul (`TtlCache.wrap`).
 *
 * Coût : ~1 calcul Python par match et par tranche de 10 minutes, quel que
 * soit le trafic — au lieu de ~95 par visiteur qui bascule en mode ML.
 */

import { TtlCache } from './ttlCache';
import { buildGameMarkets } from './nhlPredictions';
import { buildGameFeatures } from './featureEngineering';
import { fetchGameById, fetchTeamRoster } from './nhlApiClient';
import { mlApiClient, type MLPredictionResult } from './mlApiClient';

export interface GameMlBundle {
  gameId:      string;
  generatedAt: string;
  lambdaHome:  number | null;
  lambdaAway:  number | null;
  /** Par identifiant de tuile de la page MATCH (`option.id`). `null` = le modèle ne price pas ce marché. */
  results:     Record<string, MLPredictionResult | null>;
  /**
   * Par QUESTION (`mlBundleKey`) — pour les pages qui ont leurs propres tuiles
   * (page équipe, gardien sur la page joueur) : elles retrouvent leur chiffre
   * par le marché qu'elles posent, pas par un identifiant de la page match.
   */
  byKey:       Record<string, MLPredictionResult | null>;
  /**
   * Modèle JOUEUR (`train_player.py`), servi dans la même réponse Python :
   * cadence par match de chaque patineur des deux alignements. Vide si le
   * modèle n'est pas déployé — `playerRates.ts` garde alors sa règle.
   */
  playerRates:      Record<string, Record<string, number>>;
  /** k de la binomiale négative par stat du modèle joueur ; `null` = Poisson. */
  playerDispersion: Record<string, number | null>;
  playerModelAsOf:  string | null;
}

/**
 * Marchés où le côté du sujet ne change pas la réponse : « plus de 5.5 »,
 * « les deux marquent », « va en prolongation », un score exact (donné dans
 * l'ordre domicile–visiteur)… Leur clé ignore le côté, sinon la page d'une
 * équipe visiteuse ne retrouverait pas le chiffre calculé côté domicile.
 */
const SIDELESS = new Set([
  'total_goals', 'total_goals_over', 'total_goals_under', 'both_teams_score',
  'game_to_ot', 'period1_total_goals', 'period2_total_goals', 'period3_total_goals',
  'correct_score',
]);

/**
 * Clé d'une QUESTION posée au modèle : marché, ligne, sélection, côté du sujet.
 * ⚠️ Jumelle de `mlBundleKey` côté client (`gameMarkets.tsx`) — les deux
 * doivent produire la même chaîne.
 */
export function mlBundleKey(market: string, line: number | null | undefined,
                            selection: string | null | undefined, subjectIsHome: boolean): string {
  const sel = (selection ?? '').trim().toLowerCase();
  const side = SIDELESS.has(market) || sel === 'draw' ? 'h' : (subjectIsHome ? 'h' : 'a');
  return `${market}|${line ?? ''}|${sel}|${side}`;
}

/**
 * Questions que la page MATCH n'affiche pas mais que d'autres pages posent sur
 * le même match : la victoire toutes issues confondues (page équipe, victoire
 * d'un gardien), le blanchissage, l'avantage et l'infériorité numériques, et
 * l'écart de victoire du VISITEUR (la page match ne cote que le domicile).
 */
const EXTRAS: Array<{ market: string; selection?: string }> = [
  { market: 'moneyline' },
  { market: 'clean_sheet', selection: 'yes' },
  { market: 'team_pp_goals', selection: 'yes' },
  { market: 'team_penalty_kill', selection: 'yes' },
  { market: 'winning_margin', selection: '1' },
  { market: 'winning_margin', selection: '2' },
  { market: 'winning_margin', selection: '3+' },
];

const BUNDLE_TTL_MS = Number(process.env.ML_BUNDLE_TTL_MS) || 10 * 60_000;
const bundleCache = new TtlCache<GameMlBundle>(BUNDLE_TTL_MS, 500, 'mlGameBundles');

/**
 * Marché demandé au modèle pour une tuile.
 *
 * Presque toujours le marché qu'elle annonce. Exception : les deux tuiles
 * « in Reg » de Match Betting annoncent `moneyline` (c'est le marché que règle
 * le coupon) alors qu'elles posent la question « gagne en 60 minutes » — les
 * règles le font via `pctScale`. Au modèle, on pose la vraie question.
 */
function modelMarket(optionId: string, propType: string | undefined): string {
  if (optionId === 'ml-home' || optionId === 'ml-away') return 'regulation_result';
  return propType ?? 'moneyline';
}

async function computeBundle(gameId: string): Promise<GameMlBundle> {
  const [groups, game] = await Promise.all([buildGameMarkets(gameId), fetchGameById(gameId)]);
  const home = String(game?.homeTeam?.abbreviation ?? '');
  const away = String(game?.awayTeam?.abbreviation ?? '');
  if (!home || !away) throw Object.assign(new Error('Game not found'), { status: 404 });

  // Une entrée par QUESTION distincte : « Goes to OT » et « égalité après la
  // 3e » posent la même, elle n'est pricée qu'une fois.
  const markets: Array<{ id: string; market_type: string; line: number | null; selection: string | null; subject_is_home: boolean }> = [];
  const seen = new Set<string>();
  const idToKey: Record<string, string> = {};
  const push = (market: string, line: number | null, selection: string | null, subjectIsHome: boolean): string => {
    const key = mlBundleKey(market, line, selection, subjectIsHome);
    if (!seen.has(key)) {
      seen.add(key);
      markets.push({ id: key, market_type: market, line, selection, subject_is_home: subjectIsHome });
    }
    return key;
  };
  for (const o of groups.flatMap(g => g.options)) {
    if (!o.ml || o.ml.type !== 'game') continue;
    idToKey[o.id] = push(modelMarket(o.id, o.ml.propType), o.ml.line ?? null,
                         o.ml.selection ?? null, o.ml.isHome !== false);
  }
  for (const e of EXTRAS) for (const side of [true, false]) {
    push(e.market, null, e.selection ?? null, side);
  }

  // Une seule construction de features, orientée domicile ; le côté de chaque
  // question voyage dans `subject_is_home` de chaque marché.
  const [features, homeRoster, awayRoster] = await Promise.all([
    buildGameFeatures(home, away, 'moneyline', undefined, { subjectIsHome: true }),
    // Effectifs (cache 30 min) : leurs identifiants NHL suffisent au modèle
    // joueur, qui a son propre état. Un échec ne coûte que les cadences joueur.
    fetchTeamRoster(home).catch(() => [] as any[]),
    fetchTeamRoster(away).catch(() => [] as any[]),
  ]);
  const skaters = (r: any[]) => r.filter(p => (p.position ?? 'F') !== 'G').map(p => String(p.id));
  const out = await mlApiClient.predictGameBundle({
    features, markets,
    players: { home: skaters(homeRoster), away: skaters(awayRoster) },
  });

  const byKey = out.results ?? {};
  const results: Record<string, MLPredictionResult | null> = {};
  for (const [id, key] of Object.entries(idToKey)) results[id] = byKey[key] ?? null;

  return {
    gameId,
    generatedAt: new Date().toISOString(),
    lambdaHome:  out.lambda_home ?? null,
    lambdaAway:  out.lambda_away ?? null,
    results,
    byKey,
    playerRates:      out.player_rates ?? {},
    playerDispersion: out.player_dispersion ?? {},
    playerModelAsOf:  out.player_model_as_of ?? null,
  };
}

export function getGameMlBundle(gameId: string): Promise<GameMlBundle> {
  return bundleCache.wrap(gameId, () => computeBundle(gameId));
}
