/**
 * trialLifecycle.service.ts
 * ------------------------------------------------------------------
 * Courriels de fin d'essai Pro (2026-11-20, audit Growth).
 *
 * LE CONSTAT. Au 2026-11-20 : 4 essais gratuits de 7 jours démarrés en
 * novembre, 2 terminés, 0 converti. Rien ne disait à la personne que son essai
 * finissait ni qu'il avait fini — et 98 % des sessions sont de nouveaux
 * visiteurs (Clarity) : la plupart ne reviennent pas voir un paywall dans
 * l'app. Le courriel est le seul canal qui les atteint.
 *
 * CE QUE ÇA FAIT. Toutes les 3 h (verrou de job : une seule instance) :
 *   • essai qui finit dans 1 à 30 h  → `sendTrialEndingEmail`  (une fois) ;
 *   • essai fini depuis moins de 72 h → `sendTrialEndedEmail`   (une fois).
 * Le dédoublonnage passe par `product_events` (`email_trial_ending` /
 * `email_trial_ended`) : la ligne est écrite AVANT l'envoi et retirée si
 * l'envoi échoue, pour qu'une panne de Resend ne fasse ni doublon ni oubli.
 *
 * Seulement les comptes `account_kind = 'real'` et les essais `source = local`
 * (un essai Stripe, s'il en existe un jour, a ses propres courriels Stripe).
 *
 * OPT-IN : TRIAL_EMAILS_ENABLED=true sur Railway. Sans la variable, rien ne
 * part — l'envoi de courriels aux utilisateurs reste une décision explicite.
 * Prérequis : migration 055 appliquée (`npm run db:migrate:all`).
 */

import { pool } from '../db/connection';
import { logger } from '../logger';
import { withJobLock } from './jobLock';
import { sendTrialEndedEmail, sendTrialEndingEmail } from './email.service';

const TICK_MS = 3 * 60 * 60 * 1000;
const LOCK_TTL_MS = 10 * 60 * 1000;
/** Garde-fou : jamais plus de N courriels par passage. */
const MAX_PER_RUN = 50;

type Kind = 'email_trial_ending' | 'email_trial_ended';

interface Target { id: string; email: string; first_name: string | null }

const WINDOWS: Record<Kind, string> = {
  email_trial_ending: `s.current_period_end >  NOW() + INTERVAL '1 hour'
                   AND s.current_period_end <= NOW() + INTERVAL '30 hours'`,
  email_trial_ended:  `s.current_period_end <= NOW()
                   AND s.current_period_end >  NOW() - INTERVAL '72 hours'`,
};

async function targets(kind: Kind): Promise<Target[]> {
  const { rows } = await pool.query<Target>(
    `SELECT u.id, u.email, u.first_name
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id
      WHERE s.status = 'trialing' AND s.source = 'local' AND s.trial_used
        AND u.account_kind = 'real' AND u.is_active
        AND ${WINDOWS[kind]}
        AND NOT EXISTS (SELECT 1 FROM product_events e WHERE e.user_id = u.id AND e.name = $1)
      ORDER BY s.current_period_end
      LIMIT ${MAX_PER_RUN}`,
    [kind],
  );
  return rows;
}

async function sendOne(kind: Kind, t: Target): Promise<boolean> {
  // Réserve d'abord (dédoublonnage même si deux passages se chevauchaient).
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO product_events (user_id, name, props) VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
    [t.id, kind],
  );
  try {
    if (kind === 'email_trial_ending') await sendTrialEndingEmail(t.email, t.first_name);
    else await sendTrialEndedEmail(t.email, t.first_name);
    return true;
  } catch (err) {
    await pool.query('DELETE FROM product_events WHERE id = $1', [rows[0].id]).catch(() => {});
    logger.warn({ err: (err as Error)?.message, kind }, '[trial-emails] envoi échoué — nouvel essai au prochain passage');
    return false;
  }
}

export async function runTrialLifecycle(): Promise<{ ending: number; ended: number }> {
  const sent = { ending: 0, ended: 0 };
  for (const kind of ['email_trial_ending', 'email_trial_ended'] as const) {
    for (const t of await targets(kind)) {
      if (await sendOne(kind, t)) {
        if (kind === 'email_trial_ending') sent.ending += 1;
        else sent.ended += 1;
      }
    }
  }
  if (sent.ending || sent.ended) logger.info(sent, '[trial-emails] courriels de fin d\'essai envoyés');
  return sent;
}

export function trialEmailsEnabled(): boolean {
  return process.env.TRIAL_EMAILS_ENABLED === 'true';
}

/** Planifie le job (5 min après le démarrage, puis toutes les 3 h). Null si désactivé. */
export function startTrialLifecycleJob(): NodeJS.Timeout | null {
  if (!trialEmailsEnabled()) {
    logger.info('[trial-emails] désactivé (TRIAL_EMAILS_ENABLED≠true)');
    return null;
  }
  const tick = () => {
    withJobLock('trial-lifecycle', LOCK_TTL_MS, runTrialLifecycle)
      .catch((err) => logger.error({ err: err?.message }, '[trial-emails] échec du passage'));
  };
  setTimeout(tick, 5 * 60_000).unref();
  const handle = setInterval(tick, TICK_MS);
  handle.unref();
  return handle;
}
