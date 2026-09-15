/**
 * oddsQuota.ts — Arbitre unique du quota The Odds API.
 *
 * PROBLÈME. Deux consommateurs partagent une seule clé et un seul quota :
 *
 *   • le proxy public (`odds.routes.ts`), qui sert les cotes aux visiteurs ;
 *   • le collecteur (`oddsLogger.service.ts`), qui constitue le jeu de
 *     données de réentraînement.
 *
 * Sur une clé gratuite (500 crédits/mois), le proxy seul peut vider le quota
 * en une journée : son TTL de 5 minutes vaut ~288 appels/jour, soit ~576
 * crédits/jour à 2 marchés. Ce dimensionnement suppose un plan payant.
 *
 * RÈGLE. Le collecteur cède toujours la priorité au visiteur.
 *
 *   - `user`      peut dépenser jusqu'à 0. Un visiteur n'est jamais bloqué par
 *                 un job de fond.
 *   - `collector` ne dépense que tant qu'il reste plus que `ODDS_USER_RESERVE`
 *                 crédits. En dessous, la collecte s'arrête d'elle-même.
 *
 * Ce n'est pas symétrique, et c'est voulu : une journée de collecte perdue est
 * irrattrapable (la cote de clôture d'hier n'existe plus), mais un visiteur qui
 * voit une page vide est un problème immédiat et visible. On protège donc le
 * visiteur par une réserve dure, et on accepte que la collecte s'interrompe.
 *
 * SOURCE DE VÉRITÉ. Le solde n'est jamais estimé — il est lu dans l'en-tête
 * `x-requests-remaining` de chaque réponse. Toute estimation locale dériverait
 * (appels concurrents, autres environnements partageant la clé, remise à zéro
 * mensuelle). Entre deux observations on décrémente d'un coût connu, mais la
 * prochaine réponse fait autorité.
 */

import { pool } from '../db/connection';
import { logger } from '../logger';

const DEFAULT_USER_RESERVE = 150;

/**
 * Plancher réservé aux visiteurs : la collecte n'y touche pas.
 *
 * La lecture est durcie parce que cette variable se pose **à la main dans une
 * console Railway**, et que les deux fautes de frappe possibles échouaient en
 * silence :
 *
 *   - valeur vide → `Number('')` vaut **0**, donc plus aucune réserve : la
 *     collecte devenait libre de vider le quota et un visiteur tombait sur une
 *     page sans cotes ;
 *   - valeur non numérique → `NaN`, et `remaining - cost >= NaN` est TOUJOURS
 *     faux : la collecte ne démarrait jamais, sans un seul message.
 *
 * Le second cas est le plus coûteux ici : chaque jour sans collecte est perdu
 * définitivement (la cote de clôture d'hier n'existe plus nulle part). On
 * retombe donc sur le défaut et on le dit fort.
 */
const USER_RESERVE = ((): number => {
  const raw = process.env.ODDS_USER_RESERVE;
  if (raw === undefined || raw.trim() === '') return DEFAULT_USER_RESERVE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    logger.warn(
      { raw, fallback: DEFAULT_USER_RESERVE },
      '[oddsQuota] ODDS_USER_RESERVE illisible — défaut appliqué.',
    );
    return DEFAULT_USER_RESERVE;
  }
  return Math.floor(n);
})();

/**
 * Solde supposé tant qu'aucune réponse n'a été observée ET que la base ne sait
 * rien. Volontairement bas : mieux vaut suspendre la collecte à tort pendant
 * un cycle que dépenser un quota qu'on n'a peut-être plus. Le premier appel du
 * proxy — qui, lui, n'est pas soumis à la réserve — rétablit la vérité.
 */
const UNKNOWN_REMAINING = 0;

let cached: { remaining: number; used: number | null } | null = null;
let loaded = false;
/**
 * Une sonde est concédée au collecteur tant qu'aucun solde n'est connu.
 *
 * Sans elle, un démarrage sur base vierge est un blocage : le solde vaut 0 par
 * prudence, la collecte se suspend donc, et rien ne la débloque tant qu'aucun
 * visiteur n'a déclenché un appel du proxy. Sur un site peu fréquenté en début
 * de saison, la collecte pourrait ne jamais démarrer — exactement ce qu'on
 * cherche à éviter, puisqu'un jour manqué est définitivement perdu.
 *
 * Le coût est borné : un appel par processus, et la réponse renseigne le solde
 * pour de bon (y compris en base, donc au-delà du redéploiement suivant).
 */
let probeAvailable = true;

/** Recharge le dernier solde connu depuis la base (une fois par processus). */
async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const { rows } = await pool.query(
      'SELECT remaining, used FROM odds_quota_state WHERE id = 1',
    );
    if (rows[0]?.remaining != null) {
      cached = { remaining: Number(rows[0].remaining), used: rows[0].used ?? null };
    }
  } catch (err: any) {
    // Migration pas encore passée, ou base indisponible : on n'empêche pas le
    // service de démarrer pour autant.
    logger.warn({ err: err?.message }, '[oddsQuota] état non relu');
  }
}

/**
 * Enregistre le solde renvoyé par The Odds API.
 *
 * À appeler après CHAQUE réponse, y compris en erreur : un 429 porte lui aussi
 * l'information, et c'est précisément le moment où elle compte.
 */
export function observe(
  headers?: { get?(name: string): string | null } | null,
): void {
  // Deux pièges, tous deux découverts par les tests, tous deux silencieux en
  // production :
  //
  // 1. `headers` peut être absent. Toute réponse qui ne ressemble pas
  //    exactement à un `Response` du runtime — un mock, un polyfill, un client
  //    HTTP substitué — faisait lever une TypeError ICI, et comme l'appel est
  //    dans le `try` de `fetchAllOdds`, la récupération des cotes échouait
  //    entièrement. Un compteur de crédits ne doit jamais pouvoir casser la
  //    fonctionnalité qu'il observe.
  //
  // 2. `Number(null)` vaut **0**, qui est fini. Un simple test
  //    `Number.isFinite` laissait donc passer une réponse SANS en-tête de
  //    quota, écrasait le solde réel à zéro, et suspendait la collecte
  //    définitivement — sans le moindre message d'erreur. Il faut donc
  //    inspecter la chaîne brute avant toute conversion.
  const read = (name: string): string | null =>
    typeof headers?.get === 'function' ? headers.get(name) : null;

  const rawRemaining = read('x-requests-remaining');
  if (rawRemaining === null || rawRemaining === undefined || rawRemaining === '') return;
  const remaining = Number(rawRemaining);
  if (!Number.isFinite(remaining)) return;

  const rawUsed = read('x-requests-used');
  const usedNum = rawUsed === null || rawUsed === '' ? NaN : Number(rawUsed);
  const used = Number.isFinite(usedNum) ? usedNum : null;

  const before = cached?.remaining;
  cached = { remaining, used };
  loaded = true;

  // Écriture au fil de l'eau : la valeur doit survivre à un redéploiement,
  // sinon le processus repart en croyant le quota intact.
  pool
    .query(
      `UPDATE odds_quota_state
          SET remaining = $1, used = $2, observed_at = NOW()
        WHERE id = 1`,
      [remaining, used],
    )
    .catch((err) => logger.warn({ err: err?.message }, '[oddsQuota] état non écrit'));

  if (before === undefined || Math.floor(before / 50) !== Math.floor(remaining / 50)) {
    logger.info({ remaining, used, reserve: USER_RESERVE }, '[oddsQuota] solde');
  }
}

/**
 * Dernier solde connu, ou `UNKNOWN_REMAINING` si aucune observation.
 *
 * **Synchrone, et délibérément.** Une première version attendait la relecture
 * en base ici. Or cette fonction est appelée sur le chemin chaud de la
 * récupération des cotes : sans base joignable, chaque fetch encaissait le
 * délai de connexion (5 s) avant même de commencer. Un compteur de crédits ne
 * doit rien ralentir de ce qu'il observe — la relecture est donc lancée au
 * chargement du module, sans être attendue, et le pire cas est de fonctionner
 * un instant sur un solde inconnu.
 */
export function remaining(): number {
  return cached?.remaining ?? UNKNOWN_REMAINING;
}

/**
 * La collecte a-t-elle le droit de dépenser `cost` crédits ?
 *
 * Faux dès que la dépense entamerait la réserve des visiteurs. Le collecteur
 * doit alors passer son tour — pas réessayer plus agressivement.
 */
export async function collectorMaySpend(cost: number): Promise<boolean> {
  // Ici l'attente est acceptable, et même souhaitable : le collecteur tourne
  // toutes les 6 h, il peut patienter le temps d'une lecture, et se tromper
  // lui coûte des crédits qu'on cherche justement à préserver.
  await ensureLoaded();
  if (cached === null) {
    // Solde inconnu : on concède une sonde unique plutôt que de rester bloqué.
    if (!probeAvailable) return false;
    probeAvailable = false;
    logger.info('[oddsQuota] solde inconnu — une sonde concédée à la collecte');
    return true;
  }
  return cached.remaining - cost >= USER_RESERVE;
}

/**
 * Décrémente le solde d'un coût connu, en attendant l'observation réelle.
 *
 * Utile quand plusieurs appels s'enchaînent avant la première réponse : sans
 * ça, deux appels lancés coup sur coup verraient le même solde périmé.
 */
export function debit(cost: number): void {
  if (cached) cached.remaining = Math.max(0, cached.remaining - cost);
}

/**
 * TTL du cache proxy, adapté au solde restant.
 *
 * Rallonger le TTL quand les crédits se raréfient est la façon la moins
 * douloureuse d'économiser : le visiteur voit toujours des cotes, simplement
 * un peu plus datées. L'alternative — couper le proxy — lui donnerait une page
 * vide, ce qu'on cherche justement à éviter. Les cotes NHL bougent lentement :
 * une demi-heure d'ancienneté reste utilisable pour de l'affichage.
 */
export function proxyTtlMs(baseTtlMs: number): number {
  const left = remaining();
  // Solde encore inconnu : on ne pénalise personne. Le TTL de base s'applique,
  // et la première réponse renseignera le solde. Allonger le TTL par défaut
  // reviendrait à servir des cotes périmées à chaque redémarrage.
  if (cached === null) return baseTtlMs;
  if (left <= 0) return 24 * 60 * 60_000;   // plus rien : on sert le cache
  if (left < 100) return 6 * 60 * 60_000;
  if (left < 250) return 60 * 60_000;
  if (left < 400) return 15 * 60_000;
  return baseTtlMs;
}

// Relecture du dernier solde connu, lancée au chargement et NON attendue :
// elle réchauffe l'état pour le collecteur sans jamais retarder une requête.
void ensureLoaded();

/** Réinitialise l'état mémoire — tests uniquement. */
export function __resetForTests(): void {
  cached = null;
  loaded = false;
  probeAvailable = true;
}
