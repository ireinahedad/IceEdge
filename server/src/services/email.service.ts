// ============================================================
//  Email service — Resend (https://resend.com)
// ============================================================
// Uses Resend's REST API via fetch (no extra dependency).
//
// Required env:
//   RESEND_API_KEY   — API key from the Resend dashboard
//   RESEND_FROM      — verified sender, e.g. "ArakIce <no-reply@yourdomain.com>"
//                      (use "onboarding@resend.dev" while testing)
//
// If RESEND_API_KEY is missing, emails are logged to the console instead of
// sent — handy for local development without hitting the network.

import { logger } from '../logger';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Adresse de support publiée (PRE_IOS_PLAN.md R4.0).
 *
 * Elle part dans les e-mails sortants, et le client l'affiche sur Support,
 * Confidentialité et Conditions. ⚠️ Le CLIENT lit sa propre variable
 * `VITE_SUPPORT_EMAIL` (`client/src/app/env.ts`) : c'est un bundle statique
 * construit par Vercel alors que l'API tourne sur Railway, donc chaque côté a
 * sa copie. Les deux doivent porter la MÊME adresse, sinon les pages et les
 * e-mails ne racontent pas la même chose.
 *
 * Repli plutôt qu'obligation : rendre la variable obligatoire ferait échouer un
 * déploiement tant qu'elle n'est pas posée des deux côtés. Le repli EST
 * l'adresse en service (2026-09-04), donc le contact publié fonctionne que la
 * variable soit posée ou non ; la variable sert à en changer sans redéployer.
 *
 * ⚠️ À UN ORDRE DE MOTS PRÈS D'UNE BOÎTE MORTE. Le compte que ce projet a
 * abandonné était `arakice.support@gmail.com` ; celui-ci est `support.arakice@`.
 * Côte à côte, ils ont l'air d'être une faute de frappe l'un de l'autre. Ils ne
 * le sont pas. Ne pas « corriger » vers l'ancien, ne pas le recopier d'un vieux
 * commit.
 *
 * Le repli est dupliqué dans `client/src/app/env.ts` — changer les deux.
 */
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL?.trim() || 'support.arakice@gmail.com';

function getConfig() {
  const apiKey = process.env.RESEND_API_KEY;
  const from   = process.env.RESEND_FROM || 'ArakIce <onboarding@resend.dev>';
  return { apiKey, from };
}

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

async function sendEmail({ to, subject, html, text }: SendArgs): Promise<void> {
  const { apiKey, from } = getConfig();

  // Dev fallback: no key configured → log instead of send.
  if (!apiKey) {
    logger.warn({ to, subject }, '[Email] RESEND_API_KEY not set — email NOT sent (dev fallback)');
    return;
  }

  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, html, text }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw Object.assign(new Error(`Email send failed: ${detail}`), { status: 502 });
  }
}

// ---- Verification code email ----------------------------------------------

/** Sends the 6-digit confirmation code to a newly registered user. */
export async function sendVerificationCode(to: string, code: string, firstName?: string | null): Promise<void> {
  const hello = firstName ? `Bonjour ${firstName},` : 'Bonjour,';
  const subject = `Votre code de confirmation ArakIce : ${code}`;

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0A0E0C;color:#F3F7F0;border-radius:16px">
    <h1 style="font-size:20px;letter-spacing:0.16em;text-transform:uppercase;color:#9BF019;margin:0 0 24px">ARAKICE</h1>
    <p style="margin:0 0 16px;color:#F3F7F0">${hello}</p>
    <p style="margin:0 0 24px;color:#B7C4AD">Voici votre code de confirmation pour activer votre compte&nbsp;:</p>
    <div style="font-size:34px;font-weight:700;letter-spacing:10px;text-align:center;padding:20px;background:#131A12;border:1px solid #283323;border-radius:12px;color:#9BF019">${code}</div>
    <p style="margin:24px 0 0;color:#92A08A;font-size:13px">Ce code expire dans 15 minutes. Si vous n'avez pas créé de compte ArakIce, ignorez ce courriel.</p>
  </div>`;

  const text =
    `${hello}\n\nVotre code de confirmation ArakIce est : ${code}\n` +
    `Ce code expire dans 15 minutes.\n\nSi vous n'avez pas créé de compte, ignorez ce courriel.`;

  await sendEmail({ to, subject, html, text });
}

/** Sends a 6-digit code used to reset a forgotten password. */
export async function sendPasswordResetCode(to: string, code: string, firstName?: string | null): Promise<void> {
  const hello = firstName ? `Bonjour ${firstName},` : 'Bonjour,';
  const subject = `Réinitialisation de votre mot de passe ArakIce : ${code}`;

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0A0E0C;color:#F3F7F0;border-radius:16px">
    <h1 style="font-size:20px;letter-spacing:0.16em;text-transform:uppercase;color:#9BF019;margin:0 0 24px">ARAKICE</h1>
    <p style="margin:0 0 16px;color:#F3F7F0">${hello}</p>
    <p style="margin:0 0 24px;color:#B7C4AD">Voici votre code pour réinitialiser votre mot de passe&nbsp;:</p>
    <div style="font-size:34px;font-weight:700;letter-spacing:10px;text-align:center;padding:20px;background:#131A12;border:1px solid #283323;border-radius:12px;color:#9BF019">${code}</div>
    <p style="margin:24px 0 0;color:#92A08A;font-size:13px">Ce code expire dans 15 minutes. Si vous n'avez pas demandé de réinitialisation, ignorez ce courriel — votre mot de passe reste inchangé.</p>
  </div>`;

  const text =
    `${hello}\n\nVotre code de réinitialisation ArakIce est : ${code}\n` +
    `Ce code expire dans 15 minutes.\n\nSi vous n'avez pas demandé de réinitialisation, ignorez ce courriel.`;

  await sendEmail({ to, subject, html, text });
}

/** Code à 6 chiffres qui confirme la suppression d'un compte sans mot de passe (Google). */
export async function sendAccountDeletionCode(to: string, code: string, firstName?: string | null): Promise<void> {
  const hello = firstName ? `Bonjour ${firstName},` : 'Bonjour,';
  const subject = `Suppression de votre compte ArakIce : ${code}`;

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0A0E0C;color:#F3F7F0;border-radius:16px">
    <h1 style="font-size:20px;letter-spacing:0.16em;text-transform:uppercase;color:#9BF019;margin:0 0 24px">ARAKICE</h1>
    <p style="margin:0 0 16px;color:#F3F7F0">${hello}</p>
    <p style="margin:0 0 24px;color:#B7C4AD">Voici votre code pour confirmer la suppression définitive de votre compte&nbsp;:</p>
    <div style="font-size:34px;font-weight:700;letter-spacing:10px;text-align:center;padding:20px;background:#131A12;border:1px solid #283323;border-radius:12px;color:#9BF019">${code}</div>
    <p style="margin:24px 0 0;color:#92A08A;font-size:13px">Ce code expire dans 15 minutes. Si vous n'avez pas demandé la suppression de votre compte, ignorez ce courriel — rien ne sera supprimé — et écrivez-nous à ${SUPPORT_EMAIL}.</p>
  </div>`;

  const text =
    `${hello}\n\nVotre code pour confirmer la suppression de votre compte ArakIce est : ${code}\n` +
    `Ce code expire dans 15 minutes.\n\nSi vous n'avez pas demandé cette suppression, ignorez ce courriel et écrivez-nous à ${SUPPORT_EMAIL}.`;

  await sendEmail({ to, subject, html, text });
}
