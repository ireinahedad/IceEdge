/**
 * redis.ts — le Redis partagé entre instances, et rien d'autre.
 *
 * ── POURQUOI CE FICHIER EXISTE ──────────────────────────────────────────────
 *
 * Tant qu'il n'y a qu'une instance, la mémoire du process suffit à tout : les
 * caches, les compteurs de débit, la liste des sockets d'un salon. À partir de
 * la DEUXIÈME instance, chacune de ces mémoires devient une vérité partielle —
 * et le plus grave est invisible : `io.to(room).emit()` ne parle qu'aux sockets
 * de SON process, donc deux personnes du même salon cessent de se voir si le
 * répartiteur les a posées sur des conteneurs différents. Pas d'erreur, pas de
 * log : un chat qui « marche une fois sur deux ».
 *
 * C'est la ligne D de `AUDIT_SCALABILITE_COUTS.md`, et le banc
 * `loadtest/bench/b12-multiinstance.ts` la mesure : deux instances, un lecteur
 * sur chacune, un message qui n'arrive qu'à un seul.
 *
 * ── OPTIONNEL PAR CONSTRUCTION ──────────────────────────────────────────────
 *
 * `REDIS_URL` absent → ce module ne fait RIEN et n'ouvre aucune connexion. Le
 * serveur se comporte exactement comme avant (adaptateur mémoire), ce qui est
 * correct tant qu'on tourne à une instance. C'est ce qui permet de livrer le
 * code AVANT de provisionner le service, et de garder le développement local
 * sans dépendance supplémentaire.
 *
 * Le choix inverse — exiger Redis — rendrait le démarrage dépendant d'un
 * service de plus pour un bénéfice nul à une instance.
 *
 * ── POURQUOI `ioredis` ET PAS LE CLIENT REST ────────────────────────────────
 *
 * L'adaptateur repose sur le pub/sub Redis, qui exige une connexion PERSISTANTE
 * (un `SUBSCRIBE` qui reste ouvert). Les clients « serverless » en HTTP/REST —
 * dont `@upstash/redis` — ne savent pas faire ça. Sur Upstash, il faut donc
 * l'endpoint Redis classique (`rediss://…`), pas l'URL REST. Sur Railway, le
 * plugin Redis expose `REDIS_URL` sur le réseau privé du projet, ce qui est le
 * chemin le plus court.
 *
 * ── DEUX CLIENTS, PAS UN ────────────────────────────────────────────────────
 *
 * Une connexion Redis en mode abonné ne peut plus rien faire d'autre : c'est le
 * protocole qui l'impose. `createAdapter` demande donc un client qui publie et
 * un client qui écoute. `duplicate()` est prévu pour ça.
 */

import { Redis } from 'ioredis';
import { logger } from './logger';

const REDIS_URL = process.env.REDIS_URL?.trim();

/** Vrai quand le déploiement est configuré pour partager son état. */
export const redisEnabled = Boolean(REDIS_URL);

/**
 * Construit un client.
 *
 * `maxRetriesPerRequest: null` et `enableOfflineQueue` : un Redis
 * momentanément injoignable ne doit pas faire échouer une requête HTTP ni tuer
 * le process. L'adaptateur retombe alors sur son comportement local — les
 * sockets de CETTE instance continuent de se voir — et se recolle tout seul au
 * retour du service. Le sens de la panne est choisi : dégradé, jamais mort.
 */
function creerClient(role: 'pub' | 'sub'): Redis {
  const client = new Redis(REDIS_URL as string, {
    lazyConnect: false,
    maxRetriesPerRequest: null,
    // Laisse ioredis retenter indéfiniment, en espaçant : un redémarrage du
    // service Redis ne doit pas demander un redémarrage de l'application.
    retryStrategy: (essais) => Math.min(essais * 200, 5_000),
  });

  client.on('error', (err: Error) => {
    // `warn` et pas `error` : c'est une dégradation, pas une panne applicative.
    // Sans ce gestionnaire, une erreur de socket Redis est une exception non
    // capturée — donc un conteneur qui redémarre à cause de son CACHE.
    logger.warn({ err: err.message, role }, '[Redis] connexion en erreur — mode dégradé (diffusion locale)');
  });
  client.on('ready', () => logger.info({ role }, '[Redis] prêt'));

  return client;
}

let pub: Redis | null = null;
let sub: Redis | null = null;

/**
 * Les deux clients de l'adaptateur Socket.io, ou `null` sans `REDIS_URL`.
 * Créés une seule fois, à la première demande.
 */
export function socketRedisClients(): { pub: Redis; sub: Redis } | null {
  if (!REDIS_URL) return null;
  if (!pub || !sub) {
    pub = creerClient('pub');
    sub = pub.duplicate();
    sub.on('error', (err: Error) => {
      logger.warn({ err: err.message, role: 'sub' }, '[Redis] connexion en erreur — mode dégradé (diffusion locale)');
    });
  }
  return { pub, sub };
}

/** Ferme proprement les connexions — appelé par l'arrêt gracieux. */
export async function closeRedis(): Promise<void> {
  const clients = [pub, sub].filter(Boolean) as Redis[];
  pub = null;
  sub = null;
  await Promise.all(clients.map((c) => c.quit().catch(() => c.disconnect())));
}
