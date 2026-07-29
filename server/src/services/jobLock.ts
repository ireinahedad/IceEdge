/**
 * jobLock.ts
 * ------------------------------------------------------------------
 * Unicité d'exécution des jobs planifiés, et état partagé entre instances.
 *
 * LE PROBLÈME (audit P1-4)
 *
 * Les quatre jobs de fond tournent dans le process web et ne se coordonnent pas.
 * Avec une seule instance c'est sans conséquence ; à la deuxième, chacun tourne
 * en double — donc 2× les appels à The Odds API, 2× le travail de règlement, et
 * surtout **deux notifications push identiques** par utilisateur.
 *
 * POURQUOI UN BAIL EN TABLE ET NON `pg_try_advisory_lock`
 *
 * Le verrou consultatif de Postgres est lié à la SESSION. L'endpoint Neon
 * `-pooler` — celui que ce projet doit utiliser (audit, ligne 7) — est un
 * PgBouncer en mode transaction : le backend est réassigné après chaque
 * transaction, donc un verrou de session ne survit pas d'une requête à la
 * suivante. Neon documente explicitement que les verrous consultatifs de session
 * ne sont pas supportés sur les connexions poolées.
 *
 * Ce serait le pire des bugs : `pg_try_advisory_lock` fonctionne sur un Postgres
 * local (connexion directe), donc en développement tout paraîtrait correct, et
 * la protection tomberait précisément en production. Un bail en table ne dépend
 * d'aucun mode de pooling, et il est observable (`SELECT * FROM job_locks`).
 *
 * CE QUE LE VERROU NE FAIT PAS
 *
 * Il n'est tenu QUE pendant l'exécution. Deux instances dont les timers sont
 * décalés de 30 s le prendront l'une après l'autre et feront chacune un tour —
 * ce qui est voulu (le travail n'appartient à personne), mais ne suffit pas là
 * où le job a un effet externe non idempotent. Pour les notifications push,
 * c'est `jobState` (mémoire commune du « déjà envoyé ») qui empêche le doublon,
 * pas le verrou.
 */

import crypto from 'crypto';
import { pool } from '../db/connection';
import { logger } from '../logger';

/**
 * Identité de cette instance. Régénérée à chaque démarrage : un process
 * redémarré est une nouvelle instance et ne doit pas hériter d'un bail que son
 * prédécesseur tenait — sinon un crash en cours de job laisserait le
 * redémarrage se croire propriétaire et casserait l'exclusion mutuelle.
 */
export const INSTANCE_ID = `${process.env.RAILWAY_REPLICA_ID ?? process.pid}-${crypto.randomBytes(4).toString('hex')}`;

/**
 * Tente de prendre le bail `jobName` pour `ttlMs`.
 *
 * Un seul énoncé, donc atomique sans transaction explicite : si la ligne existe
 * et n'a pas expiré, la clause `WHERE` du `DO UPDATE` est fausse, aucune ligne
 * n'est renvoyée, et l'appelant sait qu'il n'a pas le bail. Il n'y a pas de
 * fenêtre entre « lire » et « écrire » où deux instances pourraient toutes deux
 * se croire gagnantes.
 */
async function acquire(jobName: string, ttlMs: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO job_locks (job_name, owner, acquired_at, expires_at)
     VALUES ($1, $2, NOW(), NOW() + ($3 || ' milliseconds')::interval)
     ON CONFLICT (job_name) DO UPDATE
        SET owner       = EXCLUDED.owner,
            acquired_at = EXCLUDED.acquired_at,
            expires_at  = EXCLUDED.expires_at
      WHERE job_locks.expires_at < NOW()
     RETURNING job_name`,
    [jobName, INSTANCE_ID, String(ttlMs)],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Rend le bail — uniquement si on le détient encore.
 *
 * La condition sur `owner` est ce qui rend un dépassement de TTL inoffensif :
 * si notre job a duré plus longtemps que prévu et qu'une autre instance a repris
 * le bail entre-temps, on ne le lui retire pas en partant.
 *
 * Best-effort : un relâchement raté laisse simplement le bail expirer seul.
 */
async function release(jobName: string): Promise<void> {
  try {
    await pool.query('DELETE FROM job_locks WHERE job_name = $1 AND owner = $2', [jobName, INSTANCE_ID]);
  } catch (err: any) {
    logger.warn({ err: err?.message, jobName }, '[jobLock] relâchement échoué (le bail expirera seul)');
  }
}

/**
 * Exécute `fn` seulement si cette instance obtient le bail.
 *
 * @returns `true` si `fn` a été exécutée, `false` si une autre instance l'avait.
 *
 * `ttlMs` doit couvrir confortablement la durée maximale du job : c'est le délai
 * au bout duquel une autre instance considère le détenteur comme mort. Trop
 * court, le job peut être relancé pendant qu'il tourne encore ; trop long, une
 * instance tuée net bloque le job jusqu'à l'expiration. Les jobs restent
 * idempotents de leur côté, donc l'erreur penche vers le TTL généreux.
 *
 * Une erreur de `fn` est propagée à l'appelant APRÈS relâchement du bail : un
 * échec ne doit pas geler le job jusqu'à expiration.
 */
export async function withJobLock<T>(
  jobName: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false }> {
  let held = false;
  try {
    held = await acquire(jobName, ttlMs);
  } catch (err: any) {
    // Base injoignable : on ne fait rien plutôt que de tourner sans protection.
    // Le tick suivant retentera ; les jobs sont tous périodiques.
    logger.warn({ err: err?.message, jobName }, '[jobLock] acquisition impossible — tour sauté');
    return { ran: false };
  }

  if (!held) {
    logger.debug({ jobName }, '[jobLock] déjà détenu par une autre instance — tour sauté');
    return { ran: false };
  }

  try {
    return { ran: true, result: await fn() };
  } finally {
    await release(jobName);
  }
}

// ── État partagé ────────────────────────────────────────────────────────────

/** Lit une valeur d'état partagé. `null` si absente ou si la base est KO. */
export async function getJobState(key: string): Promise<string | null> {
  try {
    const { rows } = await pool.query('SELECT value FROM job_state WHERE key = $1', [key]);
    return rows[0]?.value ?? null;
  } catch (err: any) {
    logger.warn({ err: err?.message, key }, '[jobState] lecture échouée');
    return null;
  }
}

/**
 * Écrit une valeur d'état partagé.
 *
 * Renvoie `false` si l'écriture a échoué. Les appelants dont la correction
 * dépend de cette écriture (anti-doublon de notification) doivent en tenir
 * compte : ne pas pouvoir mémoriser « déjà envoyé » signifie qu'il vaut mieux ne
 * pas envoyer que d'envoyer sans pouvoir s'en souvenir.
 */
export async function setJobState(key: string, value: string): Promise<boolean> {
  try {
    await pool.query(
      `INSERT INTO job_state (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value],
    );
    return true;
  } catch (err: any) {
    logger.warn({ err: err?.message, key }, '[jobState] écriture échouée');
    return false;
  }
}
