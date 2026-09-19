/**
 * profileEnsured.ts — mémoire partagée « ce compte a déjà sa ligne de profil ».
 *
 * LE DÉFAUT QUE ÇA CORRIGE (bancs `b4-nplusone.ts` et `b10-authentifie.ts`,
 * 2026-09-18)
 *
 * Deux chemins très fréquentés faisaient la MÊME écriture inutile :
 *
 *   • `auth.service.login` → `INSERT INTO user_profiles … ON CONFLICT DO
 *     NOTHING` à chaque connexion ;
 *   • `profile.service.getProfileById` → la même chose à chaque lecture de
 *     `GET /api/users/me`, c'est-à-dire à chaque chargement de l'application.
 *
 * Ce n'est pas un N+1 — c'est plus discret, et c'est pour ça que trois
 * relectures de code ne l'avaient pas signalé : une écriture par requête, qui
 * n'insère rien. Postgres prend le chemin d'écriture même lorsque le
 * `ON CONFLICT` ne fait rien, et sur Neon derrière PgBouncer elle prend en plus
 * une place dans un pool qui en compte dix. Sur une vague d'arrivées, c'est
 * autant de places retirées aux requêtes qui, elles, servent quelqu'un.
 *
 * POURQUOI UNE MÉMOIRE ET PAS UN `SELECT` PRÉALABLE : remplacer l'écriture par
 * une lecture aurait gardé un aller-retour par requête. Ici, un compte déjà vu
 * n'émet plus RIEN pour ce contrôle.
 *
 * POURQUOI UN MODULE À PART : les deux appelants décrivent le même fait. Deux
 * mémoires séparées se contrediraient dès que l'une expire et pas l'autre, et
 * le compteur de `/api/dev/metrics` deviendrait illisible — on ne saurait pas
 * laquelle il décrit.
 *
 * CE QUE LE FILET CONTINUE DE COUVRIR : le `ON CONFLICT DO NOTHING` reste la
 * garantie réelle. Cette mémoire ne fait que sauter l'appel quand on sait déjà
 * que la ligne est là. Au pire — redémarrage, TTL écoulé, autre instance — on
 * repaie une écriture inutile, exactement comme avant. Le sens de la panne est
 * choisi : jamais « profil manquant », au pire « écriture en trop ».
 *
 * TTL 1 h et non infini : une mémoire sans expiration croît avec le nombre de
 * comptes vus, et rien ici ne justifie de la garder au-delà d'une session.
 */

import { TtlCache } from './ttlCache';

const TTL_MS = Number(process.env.PROFILE_CACHE_TTL_MS) || 60 * 60_000;

const cache = new TtlCache<boolean>(TTL_MS, 20_000, 'profileEnsured');

/** Vrai si ce compte a déjà été vu avec une ligne de profil garantie. */
export function profileAlreadyEnsured(userId: string): boolean {
  return cache.peekFresh(userId) === true;
}

/** Mémorise que ce compte a sa ligne de profil. */
export function markProfileEnsured(userId: string): void {
  cache.set(userId, true);
}

/** Oublie ce compte — pour les tests, et si un jour un profil est supprimé. */
export function forgetProfileEnsured(userId: string): void {
  cache.delete(userId);
}
