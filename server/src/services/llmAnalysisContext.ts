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
 */

import { getGameMlBundle, getGameFeatures, mlBundleKey } from './gameMlBundle';
import { buildGameFacts, buildFreeFacts, type BetDescriptor, type Facts, type FactsLocale } from './llmFacts';
import { computeGoalieSensitivities } from './llmSensitivity';
import { logger } from '../logger';

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
      return buildGameFacts({
        bet, result, features, goalieSensitivities,
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
