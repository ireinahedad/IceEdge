/**
 * llmSensitivity.ts — « et si le gardien change ? », chiffré.
 *
 * Quand le partant d'une équipe n'est pas confirmé, le modèle suppose un
 * gardien moyen. On relance donc le MÊME modèle avec chacun des gardiens de
 * l'effectif (3 au plus) à la place de l'inconnu, et on rend la fourchette du
 * chiffre du pari. Un seul appel `/predict/game/bundle` (un marché, N jeux de
 * features) ; échec ou délai dépassé = `null` (la réserve reste qualitative).
 *
 * Les gardiens viennent de l'effectif sans statistiques : la fourchette dit
 * « selon le gardien qui joue », pas « selon le plus probable ».
 */

import { mlApiClient } from './mlApiClient';
import { fetchTeamGoalies } from './nhlApiClient';
import type { GameFeatures } from './featureEngineering';
import type { GoalieSensitivity } from './llmFacts';
import { TtlCache } from './ttlCache';
import { modelMarket, mlBundleKey } from './gameMlBundle';

const MAX_GOALIES = 3;
const TIMEOUT_MS = 4000;

export interface SensitivityBet {
  market: string | undefined;
  line: number | null | undefined;
  selection: string | null | undefined;
  isHome: boolean | undefined;
  optId?: string | null;
  /** Sert à la clé du cache. */
  gameId?: string;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

/** Côté dont le gardien manque (un seul : si les deux manquent, null). */
export function pendingSide(f: Pick<GameFeatures, 'home_goalie' | 'away_goalie'>): 'home' | 'away' | null {
  const h = !!f.home_goalie, a = !!f.away_goalie;
  return h && !a ? 'away' : !h && a ? 'home' : null;
}

/** Fourchette du chiffre quand `side` change de gardien, l'autre côté restant tel que le modèle l'a vu. */
async function sideSensitivity(
  features: GameFeatures, side: 'home' | 'away', bet: SensitivityBet,
): Promise<GoalieSensitivity | null> {
  const abbr = String((side === 'home' ? features.home_team : features.away_team) ?? '');
  if (!abbr) return null;
  const goalies = (await withTimeout(fetchTeamGoalies(abbr), TIMEOUT_MS)).slice(0, MAX_GOALIES);
  if (goalies.length < 2) return null;

  const market = modelMarket(bet.optId ?? '', bet.market ?? 'moneyline');
  const key = mlBundleKey(market, bet.line ?? null, bet.selection ?? null, bet.isHome !== false);
  const runs = await Promise.all(goalies.map(async g => {
    const feats = { ...features, [`${side}_goalie`]: g.name, [`${side}_goalie_id`]: g.id } as GameFeatures;
    const out = await withTimeout(mlApiClient.predictGameBundle({
      features: feats,
      markets: [{ id: key, market_type: market, line: bet.line ?? null, selection: bet.selection ?? null,
                  subject_is_home: bet.isHome !== false }],
    }), TIMEOUT_MS);
    const p = out.results?.[key]?.probability;
    return typeof p === 'number' && Number.isFinite(p) ? { name: g.name, pct: Math.round(p) } : null;
  }));
  const ok = runs.filter((r): r is { name: string; pct: number } => r !== null);
  if (ok.length < 2) return null;
  ok.sort((x, y) => x.pct - y.pct);
  const low = ok[0], high = ok[ok.length - 1];
  return {
    side, team: abbr, lowPct: low.pct, highPct: high.pct, lowGoalie: low.name, highGoalie: high.name,
    swingPts: high.pct - low.pct,
  };
}

/** Côtés dont le gardien manque : un seul, ou les deux (veille de match, avant les annonces). */
export function unknownSides(f: Pick<GameFeatures, 'home_goalie' | 'away_goalie'>): Array<'home' | 'away'> {
  return [!f.home_goalie ? 'home' : null, !f.away_goalie ? 'away' : null].filter((x): x is 'home' | 'away' => x !== null);
}

// 10 min comme le paquet ML : les mêmes visiteurs ne relancent pas 3 à 6 prédictions par pari.
const cache = new TtlCache<GoalieSensitivity[]>(Number(process.env.ML_BUNDLE_TTL_MS) || 10 * 60_000, 500, 'llmGoalieSensitivity');

/**
 * Sensibilités de chaque côté au gardien inconnu (0, 1 ou 2 entrées). Quand les
 * deux manquent, chaque côté est varié SEUL, l'autre gardien restant « moyen » :
 * on ne cumule pas les deux effets, ce qui serait une extrapolation du modèle.
 * Ne lève jamais ; `[]` = rien de chiffrable.
 */
export async function computeGoalieSensitivities(
  features: GameFeatures, bet: SensitivityBet, modelPct: number | null,
): Promise<GoalieSensitivity[]> {
  try {
    const sides = unknownSides(features);
    if (!sides.length || modelPct == null) return [];
    const run = async () => (await Promise.all(sides.map(sd => sideSensitivity(features, sd, bet).catch(() => null))))
      .filter((x): x is GoalieSensitivity => x !== null);
    if (!bet.gameId) return await run();
    const k = `${bet.gameId}|${bet.optId ?? ''}|${bet.market}|${bet.line}|${bet.selection}|${bet.isHome}|${sides.join('+')}|${features.home_goalie ?? ''}|${features.away_goalie ?? ''}`;
    return await cache.wrap(k, run);
  } catch {
    return [];
  }
}

/** Version « un seul côté inconnu » (compatibilité) : la fourchette, ou null. */
export async function computeGoalieSensitivity(
  features: GameFeatures, bet: SensitivityBet, modelPct: number | null,
): Promise<GoalieSensitivity | null> {
  if (pendingSide(features) == null) return null;
  return (await computeGoalieSensitivities(features, bet, modelPct))[0] ?? null;
}
