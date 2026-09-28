/**
 * cleanup.service.ts
 * ------------------------------------------------------------------
 * M3 — DB housekeeping. Prunes rows that are safe to delete once expired so the
 * auth tables don't grow unbounded (which slowly degrades token/code lookups):
 *   • refresh_tokens          — expired, OR revoked more than a grace window ago
 *   • email_verification_codes — consumed, OR expired
 *   • manual_data (datés)      — gardiens partants et absents des jours passés
 *   • llm_free_daily           — compteurs d'appels IA gratuits des jours passés
 *
 * Runs once shortly after boot and then daily. Best-effort: a failed run is
 * logged and retried on the next tick, never crashes the process.
 */

import { pool } from '../db/connection';
import { logger } from '../logger';
import { withJobLock } from './jobLock';
import { purgeDatedBefore, coverage } from './manualData.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Deux DELETE : quelques secondes au pire. TTL large pour absorber une base froide. */
const LOCK_TTL_MS = 10 * 60 * 1000;
// Keep revoked tokens for a short window (audit / debugging) before pruning.
const REVOKED_GRACE_DAYS = Number(process.env.TOKEN_CLEANUP_GRACE_DAYS) || 7;

/** Fenêtre de rejeu de Stripe : au-delà, un événement ne reviendra plus, donc
 *  le garder ne dédoublonne plus rien. 30 jours pour couvrir largement. */
const STRIPE_EVENT_RETENTION_DAYS = Number(process.env.STRIPE_EVENT_RETENTION_DAYS) || 30;

/**
 * Rétention des saisies datées (gardiens partants, absents du soir).
 *
 * L'ancienne consigne était « purge-les de temps en temps pour la lisibilité »,
 * c'est-à-dire jamais : personne n'ouvre un fichier JSON pour y supprimer des
 * lignes qui ne gênent rien. Une entrée datée devient inerte après le match,
 * mais elle reste, et une saison en produit ~180. Quinze jours laissent large de
 * quoi relire une soirée récente pour comprendre une prédiction passée.
 */
const MANUAL_DATED_RETENTION_DAYS = Number(process.env.MANUAL_DATED_RETENTION_DAYS) || 15;

/**
 * Compteurs journaliers des appels IA gratuits (migration 039). Une ligne ne
 * sert que le jour même ; sept jours laissent de quoi relire une semaine.
 */
const LLM_FREE_DAILY_RETENTION_DAYS = Number(process.env.LLM_FREE_DAILY_RETENTION_DAYS) || 7;

async function runCleanup(): Promise<{ tokens: number; codes: number; stripeEvents: number; manualDated: number; llmFreeDaily: number }> {
  const tokensRes = await pool.query(
    `DELETE FROM refresh_tokens
      WHERE expires_at < NOW()
         OR (revoked = TRUE AND created_at < NOW() - ($1 || ' days')::interval)`,
    [String(REVOKED_GRACE_DAYS)],
  );
  const codesRes = await pool.query(
    `DELETE FROM email_verification_codes
      WHERE consumed = TRUE OR expires_at < NOW()`,
  );
  // Registre de déduplication des webhooks Stripe (migration 026).
  const stripeRes = await pool.query(
    `DELETE FROM stripe_events
      WHERE processed_at < NOW() - ($1 || ' days')::interval`,
    [String(STRIPE_EVENT_RETENTION_DAYS)],
  );
  // Saisies datées passées (migration 034). La date est la CLÉ, au format
  // YYYY-MM-DD : la comparaison de chaînes suffit et fait exactement la même
  // chose qu'une comparaison de dates, sans cast.
  const cutoff = new Date(Date.now() - MANUAL_DATED_RETENTION_DAYS * DAY_MS)
    .toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const manualDated = await purgeDatedBefore(cutoff);

  // Compteurs d'appels IA gratuits (migration 039). Clé 'YYYY-MM-DD' en UTC :
  // comparaison de chaînes, comme pour les saisies datées.
  const freeCutoff = new Date(Date.now() - LLM_FREE_DAILY_RETENTION_DAYS * DAY_MS).toISOString().slice(0, 10);
  const freeRes = await pool.query(`DELETE FROM llm_free_daily WHERE day < $1`, [freeCutoff]);

  // Relevé de couverture : voir `coverage()`. Il ne nettoie rien — il est ici
  // parce que c'est le seul rendez-vous quotidien du serveur, et parce qu'une
  // ligne par jour dans les journaux est exactement la bonne dose pour une
  // donnée qui n'a d'intérêt que sur la durée. Les quatre jeux sont énumérés
  // même à zéro : « injuries=0 » est l'information, l'absence de ligne non.
  const cov = await coverage();
  logger.info(
    {
      injuries:          cov.injuries          ?? 0,
      starting_goalies:  cov.starting_goalies   ?? 0,
      scratches:         cov.scratches          ?? 0,
      ref_tendency:      cov.ref_tendency       ?? 0,
      ref_tendency_auto: cov.ref_tendency_auto  ?? 0,
    },
    '[manual] couverture des saisies — un 0 signifie facteur neutre, pas absence de blessés',
  );

  const tokens = tokensRes.rowCount ?? 0;
  const codes  = codesRes.rowCount ?? 0;
  return { tokens, codes, stripeEvents: stripeRes.rowCount ?? 0, manualDated, llmFreeDaily: freeRes.rowCount ?? 0 };
}

/** Schedules the cleanup: once ~1 min after boot, then every 24h. Returns the
 *  interval handle so callers/tests can stop it. Errors are swallowed. */
export function startCleanupJob(): NodeJS.Timeout {
  // Le nettoyage est idempotent (DELETE conditionnels) : le verrou n'évite pas
  // une corruption, il évite que N instances fassent N fois le même DELETE au
  // même instant — soit N× le compute Neon pour un seul résultat utile.
  const tick = () => {
    withJobLock('cleanup', LOCK_TTL_MS, runCleanup)
      .catch((err) => logger.error({ err: err?.message }, '[cleanup] failed'));
  };
  setTimeout(tick, 60_000).unref();
  const handle = setInterval(tick, DAY_MS);
  handle.unref();
  return handle;
}
