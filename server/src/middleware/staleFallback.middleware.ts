/**
 * staleFallback.middleware.ts
 * ------------------------------------------------------------------
 * Sert la dernière réponse connue quand l'amont est mort, au lieu d'un 500.
 *
 * POURQUOI CE MODULE EXISTE — TROUVÉ PAR LE TIR S1 (2026-08-03)
 *
 * Pendant le tir, l'API NHL est devenue injoignable : `upstream.nhl` a rendu
 * **5 appels, 5 échecs**, tous au plafond du timeout. Le reste de la stack s'est
 * comporté exactement comme prévu — 5 appels sortants seulement pour 50
 * utilisateurs virtuels, donc caches et déduplication ont fait leur travail —
 * mais `/api/nhl/games?date=` a propagé un 500 à chaque requête. C'est la
 * totalité du taux d'erreur observé.
 *
 * Or le proxy Odds, lui, traite déjà ce cas : quand l'amont tombe, il sert
 * `oddsCache.getStale()` plutôt qu'une page vide. Les routes NHL n'avaient pas
 * cet équivalent. Ce module comble l'écart.
 *
 * POURQUOI AU NIVEAU DE LA ROUTE ET NON DANS `nhlApiClient`
 *
 * `TtlCache.getStale` existe déjà dans le client et contient la donnée voulue :
 * la version « au niveau du client » serait plus économe en mémoire, puisqu'elle
 * réutiliserait le cache existant au lieu d'en tenir un second.
 *
 * Elle demanderait en revanche de modifier une à une les 19 fonctions du client,
 * dont chacune a sa propre logique de « quand mettre en cache » (jour sans
 * match, boxscore absent, match non trouvé). Reproduire 19 fois une gestion
 * d'erreur, c'est 19 occasions de se tromper, et l'oubli est silencieux — la
 * route concernée continue simplement de renvoyer 500 le jour où l'amont tombe.
 *
 * Ici : un seul point, monté une fois sur le routeur, qui couvre les 20 routes
 * NHL **et** toute route ajoutée demain. Le prix est une seconde copie de la
 * dernière réponse par URL, bornée par `maxEntries`. C'est un compromis assumé :
 * quelques mégaoctets contre une classe entière de pannes visibles.
 *
 * CE QU'IL NE FAIT PAS
 *
 *  - **Il ne masque pas les 4xx.** Un 404 est une réponse légitime et définitive
 *    (« ce match n'existe pas ») ; servir une vieille valeur à la place serait
 *    un mensonge, pas une dégradation.
 *  - **Il ne rend jamais une réponse d'erreur périmée.** Seules les réponses
 *    2xx sont mémorisées, donc le repli ne peut pas servir un 500 d'hier.
 *  - **Il ne prolonge pas indéfiniment.** Passé `STALE_TTL_MS`, l'entrée est
 *    oubliée et la route redevient franche : mieux vaut une erreur qu'un
 *    calendrier vieux d'une journée présenté comme courant.
 */

import { Request, Response, NextFunction } from 'express';
import { TtlCache } from '../services/ttlCache';
import { logger } from '../logger';

/**
 * Durée pendant laquelle une réponse reste utilisable en repli.
 *
 * 30 min : assez pour traverser une coupure d'API tierce, assez court pour
 * qu'un score de match en direct ne soit pas servi comme frais des heures
 * durant. Le client voit l'en-tête `X-Stale-Response` et peut le signaler.
 */
const STALE_TTL_MS = Number(process.env.STALE_FALLBACK_TTL_MS) || 30 * 60_000;

/**
 * Plafond d'URL mémorisées. Les clés dérivent de la query string
 * (`?date=`, `?start=&end=`), donc elles sont potentiellement nombreuses —
 * le plafond est ce qui empêche un appelant d'y faire grossir la mémoire.
 */
const STALE_MAX_ENTRIES = Number(process.env.STALE_FALLBACK_MAX_ENTRIES) || 120;

const lastGood = new TtlCache<unknown>(STALE_TTL_MS, STALE_MAX_ENTRIES, 'stale-fallback');

/**
 * Mémorise la dernière réponse 2xx par URL, et la ressert si un 5xx survient.
 *
 * À monter AVANT les gestionnaires de route, sur un routeur de lecture publique
 * uniquement. Ne jamais monter sur une route authentifiée : la clé est l'URL,
 * donc deux utilisateurs différents partageraient la même entrée.
 */
export function staleFallback(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'GET') return next();

  const key = req.originalUrl;
  const originalJson = res.json.bind(res);

  res.json = (body: unknown) => {
    const status = res.statusCode;

    if (status >= 200 && status < 300) {
      lastGood.set(key, body);
      return originalJson(body);
    }

    // 5xx seulement : l'amont a échoué, pas l'appelant.
    if (status >= 500) {
      const stale = lastGood.getStale(key);
      if (stale !== null && stale !== undefined) {
        logger.warn({ key, status }, '[staleFallback] amont KO — dernière réponse connue servie');
        res.status(200);
        // En-tête explicite : un client qui veut afficher « données non à jour »
        // a de quoi le faire, et un incident reste lisible dans les logs d'accès.
        res.set('X-Stale-Response', '1');
        // Court, et surtout PAS `stale-while-revalidate` : on ne veut pas qu'un
        // CDN reconduise du périmé tout seul par-dessus du périmé.
        res.set('Cache-Control', 'public, max-age=30');
        return originalJson(stale);
      }
    }

    return originalJson(body);
  };

  next();
}

/** Tests / exploitation. */
export function resetStaleFallback(): void {
  lastGood.clear();
}
