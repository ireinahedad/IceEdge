/**
 * httpCache.middleware.ts
 *
 * En-têtes `Cache-Control` pour l'API.
 *
 * POURQUOI
 *
 * Les données NHL sont quasi-statiques et déjà mises en cache côté serveur avec
 * des TTL de 30 s à 6 h (`nhlApiClient`). Sans `Cache-Control`, ni le navigateur
 * ni un CDN ne peuvent réutiliser ces réponses : chaque navigation refait
 * l'aller-retour complet jusqu'à Railway. C'est du trafic et du compute payés
 * pour rien, et c'est le levier n°1 identifié pour la marche 500 → 5 000
 * utilisateurs simultanés (voir AUDIT_SCALABILITE_COUTS.md, P1-9).
 *
 * Le motif existait déjà en une ligne dans `odds.routes.ts`, `ml.routes.ts` et
 * sur `/api/leaderboard`. Ce module ne l'invente pas : il l'extrait pour qu'il
 * soit appliquable route par route sans recopier une chaîne littérale à chaque
 * fois — et surtout pour y mettre les deux garde-fous ci-dessous, qu'une
 * chaîne littérale posée avant `res.json()` n'a pas.
 *
 * GARDE-FOU 1 — ne jamais cacher une réponse d'erreur
 *
 * `res.set(...)` posé au montage du middleware s'appliquerait AUSSI aux 4xx/5xx
 * traversant le gestionnaire d'erreurs global. Un 502 de l'API NHL caché 30 min
 * par un CDN transforme une panne amont de 10 secondes en panne de 30 minutes.
 * L'en-tête n'est donc posé qu'au moment de l'envoi, et uniquement sur un 2xx ;
 * tout le reste part explicitement en `no-store`.
 *
 * GARDE-FOU 2 — jamais `public` sur une donnée d'utilisateur
 *
 * `public` autorise explicitement un cache PARTAGÉ à stocker une réponse, y
 * compris celles d'une requête portant un en-tête `Authorization` (RFC 9111
 * §3.5) — c'est un piège classique : la directive lève la protection au lieu de
 * l'ajouter. `noStore` est donc exporté et monté sur les routers authentifiés,
 * plutôt que de compter sur le fait qu'un CDN ne cache pas le JSON par défaut.
 *
 * NOTE SUR `Vary: Origin`
 *
 * Le middleware `cors` pose `Vary: Origin` dès que l'origine est dynamique
 * (c'est notre cas, cf. `corsOriginCallback`). Sans lui, un cache partagé
 * pourrait renvoyer à l'origine B une réponse dont l'en-tête
 * `Access-Control-Allow-Origin` désigne l'origine A. Vérifié par un test.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';

/** Politique des routes authentifiées ou porteuses de données par utilisateur. */
export const NO_STORE = 'private, no-store';

/** Durées usuelles, en secondes, alignées sur les TTL serveur de nhlApiClient. */
export const TTL = {
  /** Matchs en direct : le serveur les recache toutes les 30 s. */
  LIVE:     30,
  /** Équipes, classement : TTL serveur 5 min. */
  SHORT:    5 * 60,
  /** Calendrier sur une plage, top joueurs : TTL serveur 10 min. */
  MEDIUM:   10 * 60,
  /** Effectifs, splits, saisons : TTL serveur 30 min. */
  LONG:     30 * 60,
  /** Ancre de calendrier : TTL serveur 1 h. */
  HOUR:     60 * 60,
  /** Match terminé : ne changera plus jamais (TTL serveur 6 h). */
  FINAL:    6 * 60 * 60,
} as const;

/**
 * Construit la politique publique. `stale-while-revalidate` vaut 2× `max-age`
 * par défaut : passé le `max-age`, le CDN sert la copie périmée immédiatement
 * et rafraîchit en arrière-plan. C'est ce qui absorbe une vague d'arrivée sur
 * un cache tout juste expiré sans la renvoyer sur le serveur.
 */
export function publicPolicy(maxAgeSec: number, swrSec = maxAgeSec * 2): string {
  return `public, max-age=${maxAgeSec}, stale-while-revalidate=${swrSec}`;
}

/**
 * Pose la politique au moment de l'envoi.
 *
 * Un handler qui a déjà positionné `Cache-Control` garde la main : c'est
 * l'échappatoire utilisée par les routes de match, qui allongent le cache quand
 * le match est terminé (cf. `nhl.routes.ts`).
 */
function applyOnSend(res: Response, policy: string): void {
  const ok = res.statusCode >= 200 && res.statusCode < 300;
  if (res.get('Cache-Control')) return;
  res.set('Cache-Control', ok ? policy : NO_STORE);
}

/**
 * Enveloppe `res.json` et `res.send` : c'est le seul endroit où le code de
 * statut définitif est connu. Les deux sont enveloppés parce que `res.json`
 * délègue à `res.send` — la double pose est sans effet, `applyOnSend` étant
 * idempotent.
 */
function atSendTime(policy: (req: Request) => string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const json = res.json.bind(res);
    const send = res.send.bind(res);
    res.json = (body?: unknown) => { applyOnSend(res, policy(req)); return json(body); };
    res.send = (body?: unknown) => { applyOnSend(res, policy(req)); return send(body); };
    next();
  };
}

/**
 * Cache public (navigateur + CDN) sur les réponses 2xx.
 *
 * À n'utiliser que sur des routes dont la réponse est IDENTIQUE pour tous les
 * appelants. Les méthodes autres que GET/HEAD ne sont jamais cachées.
 */
/**
 * Match en FIN de match (`services/nhl/liveRefresh.ts`) : le navigateur revalide
 * à chaque rappel (max-age=0 — sinon son cache et `stale-while-revalidate`
 * ajoutent un ou deux rappels de retard là où un but change tout), un CDN garde
 * la réponse au rythme du serveur (`s-maxage`).
 */
export function liveEndgamePolicy(refreshSec: number): string {
  return `public, max-age=0, s-maxage=${refreshSec}`;
}

export function publicCache(maxAgeSec: number, swrSec = maxAgeSec * 2): RequestHandler {
  const policy = publicPolicy(maxAgeSec, swrSec);
  return atSendTime((req) =>
    req.method === 'GET' || req.method === 'HEAD' ? policy : NO_STORE
  );
}

/**
 * Cache navigateur uniquement, jamais un cache partagé.
 *
 * Pour les réponses qui ne dépendent pas de l'utilisateur mais dont la REQUÊTE
 * en dit quelque chose sur lui — typiquement une recherche en texte libre, dont
 * l'URL est une trace de navigation qu'on ne veut pas voir dormir dans un CDN.
 */
export function privateCache(maxAgeSec: number): RequestHandler {
  const policy = `private, max-age=${maxAgeSec}`;
  return atSendTime((req) =>
    req.method === 'GET' || req.method === 'HEAD' ? policy : NO_STORE
  );
}

/**
 * Interdit tout stockage — navigateur, CDN, proxy d'entreprise.
 * À monter sur tout ce qui dépend de l'utilisateur appelant.
 */
export const noStore: RequestHandler = atSendTime(() => NO_STORE);
