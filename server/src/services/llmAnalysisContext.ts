/**
 * llmAnalysisContext.ts — va chercher ce qu'il faut pour bâtir le bloc FAITS
 * d'un pari de MATCH : le paquet ML (cache 10 min par match, partagé avec la
 * page du match), les features du même instant, et le résultat de CETTE tuile.
 *
 * Les paris joueur / équipe n'ont pas de décomposition du modèle : leurs faits
 * viennent des lignes préparées par le client (`BetDescriptor.extraFacts`).
 *
 * Ne lève jamais : `null` = « pas de faits exploitables », et la route retombe
 * sur l'ancien chemin (invite libre) plutôt que de refuser l'analyse.
 *
 * Nouvelles (NEWS_CONSENSUS_PLAN.md, étape 4) : les publications absent /
 * gardien des 24 dernières heures des deux équipes, en liste courte. Contexte
 * cité par l'IA, JAMAIS une entrée du modèle. Pas en direct. Une base muette
 * = pas de bloc, l'analyse continue.
 */

import { getGameMlBundle, getGameFeatures, mlBundleKey } from './gameMlBundle';
import { buildGameFacts, buildFreeFacts, MAX_NEWS_IN_FACTS, type BetDescriptor, type Facts, type FactsLocale, type FactsNews } from './llmFacts';
import { listNews } from './newsSync.service';
import { computeGoalieSensitivities } from './llmSensitivity';
import { logger } from '../logger';

const NEWS_HOURS = 24;

/** Nouvelles absent / gardien des deux équipes, les plus récentes d'abord. `[]` en cas d'échec. */
export async function recentFlaggedNews(home: string | undefined, away: string | undefined): Promise<FactsNews[]> {
  const teams = [home, away].filter((t): t is string => !!t);
  if (teams.length === 0) return [];
  try {
    // Cache mémoire de `listNews` (2 min) : plusieurs analyses du même match ne relisent pas Neon.
    const items = await listNews(teams, NEWS_HOURS, 20);
    const out: FactsNews[] = [];
    for (const n of items) {
      const flags = n.flags.filter((x): x is 'goalie' | 'lineup' => x === 'goalie' || x === 'lineup');
      const team = n.teams.find((t) => teams.includes(t));
      if (flags.length === 0 || !team) continue;
      out.push({ team, author: n.author, postedAt: n.postedAt, excerpt: n.excerpt, flags });
      if (out.length >= MAX_NEWS_IN_FACTS) break;
    }
    return out;
  } catch (err: any) {
    logger.warn({ err: err?.message }, '[LLM] nouvelles indisponibles — analyse sans bloc NOUVELLES');
    return [];
  }
}

export async function buildBetFacts(bet: BetDescriptor, locale: FactsLocale): Promise<Facts | null> {
  try {
    if (bet.type === 'game' && bet.gameId) {
      const bundle = await getGameMlBundle(bet.gameId);
      const features = await getGameFeatures(bet.gameId);
      const market = bet.propType ?? 'moneyline';
      const result = (bet.optId ? bundle.results[bet.optId] : null)
        ?? bundle.byKey[mlBundleKey(market, bet.line, bet.selection, bet.isHome !== false)]
        ?? null;
      const live = !!(bundle.live?.label || result?.live);
      const goalieSensitivities = !live && result
        ? await computeGoalieSensitivities(features, {
            market, line: bet.line, selection: bet.selection, isHome: bet.isHome, optId: bet.optId, gameId: bet.gameId,
          }, typeof result.probability === 'number' ? Math.round(result.probability) : null)
        : [];
      const news = live ? [] : await recentFlaggedNews(features.home_team, features.away_team);
      return buildGameFacts({
        bet, result, features, goalieSensitivities, news,
        lambdaHome: bundle.lambdaHome, lambdaAway: bundle.lambdaAway,
        liveLabel: bundle.live?.label ?? null, locale,
      });
    }
    return bet.extraFacts?.length ? buildFreeFacts(bet, locale) : null;
  } catch (err: any) {
    logger.warn({ err: err?.message, gameId: bet.gameId }, '[LLM] faits du pari indisponibles — repli sur l’invite libre');
    return null;
  }
}
