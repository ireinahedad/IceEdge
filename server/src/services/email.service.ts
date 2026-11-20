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
  /** Adresse qui reçoit les réponses (l'expéditeur est souvent un no-reply). */
  replyTo?: string;
}

async function sendEmail({ to, subject, html, text, replyTo }: SendArgs): Promise<void> {
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
    body: JSON.stringify({ from, to, subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
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

// ---- Fin d'essai Pro (2026-11-20, audit Growth) ---------------------------
//
// Avant ce courriel, un essai de 7 jours se terminait sans qu'on le dise : ni
// courriel, ni message dans l'app. Résultat mesuré : 0 conversion essai →
// payant. Envoyés par `trialLifecycle.service.ts`, une fois chacun par compte.
// Bilingues (anglais d'abord : public visé = É.-U./Canada anglophone).
// Liens UTM : la visite et l'abonnement qui suivent sont attribués au courriel.

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const PRO_URL = (campaign: string) =>
  `https://arakice.com/pro?utm_source=email&utm_medium=lifecycle&utm_campaign=${campaign}`;

function lifecycleHtml(opts: {
  hello: string; helloFr: string; lines: string[]; linesFr: string[]; cta: string; ctaFr: string; url: string;
}): string {
  const p = (t: string, color = '#B7C4AD') => `<p style="margin:0 0 14px;color:${color};line-height:1.5">${t}</p>`;
  const btn = (label: string) =>
    `<a href="${opts.url}" style="display:inline-block;margin:8px 0 22px;padding:12px 22px;background:#9BF019;color:#0A0E0C;font-weight:700;text-decoration:none;border-radius:10px">${label}</a>`;
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0A0E0C;color:#F3F7F0;border-radius:16px">
    <h1 style="font-size:20px;letter-spacing:0.16em;text-transform:uppercase;color:#9BF019;margin:0 0 24px">ARAKICE</h1>
    ${p(opts.hello, '#F3F7F0')}
    ${opts.lines.map((l) => p(l)).join('\n    ')}
    ${btn(opts.cta)}
    <hr style="border:none;border-top:1px solid #283323;margin:8px 0 22px">
    ${p(opts.helloFr, '#F3F7F0')}
    ${opts.linesFr.map((l) => p(l)).join('\n    ')}
    ${btn(opts.ctaFr)}
    <p style="margin:8px 0 0;color:#92A08A;font-size:12px">Questions? / Une question ? ${SUPPORT_EMAIL}</p>
  </div>`;
}

/** Veille de la fin de l'essai. */
export async function sendTrialEndingEmail(to: string, firstName?: string | null): Promise<void> {
  const name = firstName ? escapeHtml(firstName) : '';
  const url = PRO_URL('trial_ending');
  const subject = 'Your ArakIce Pro trial ends tomorrow / Votre essai Pro se termine demain';
  const lines = [
    'Your 7-day Pro trial ends tomorrow. After that, Daily Best Bets, the value-bet (+EV) finder and its alerts, and the included AI analysis switch off.',
    'Keep them for CA$5.99/month, or CA$60/year. Cancel anytime.',
  ];
  const linesFr = [
    "Votre essai Pro de 7 jours se termine demain. Ensuite, les Meilleurs paris du jour, le détecteur de paris à valeur (+EV) et ses alertes, et l'analyse IA incluse se désactivent.",
    'Gardez-les pour 5,99 $ CA par mois, ou 60 $ CA par an. Annulable en tout temps.',
  ];
  const html = lifecycleHtml({
    hello: name ? `Hi ${name},` : 'Hi,', helloFr: name ? `Bonjour ${name},` : 'Bonjour,',
    lines, linesFr, cta: 'Keep Pro', ctaFr: 'Garder Pro', url,
  });
  const text = `${lines.join('\n\n')}\n\nKeep Pro: ${url}\n\n---\n\n${linesFr.join('\n\n')}\n\nGarder Pro : ${url}`;
  await sendEmail({ to, subject, html, text, replyTo: SUPPORT_EMAIL });
}

/** Le jour où l'essai s'est terminé. */
export async function sendTrialEndedEmail(to: string, firstName?: string | null): Promise<void> {
  const name = firstName ? escapeHtml(firstName) : '';
  const url = PRO_URL('trial_ended');
  const subject = 'Your ArakIce Pro trial has ended / Votre essai Pro est terminé';
  const lines = [
    "Your Pro trial has ended, so your account is back on the free plan. Your slips and history are still there.",
    'Pro brings back Daily Best Bets, the +EV finder with alerts, and the included AI analysis, for CA$5.99/month (or CA$60/year). Cancel anytime.',
    "If something made you hesitate, just reply to this email. I read every reply.",
  ];
  const linesFr = [
    "Votre essai Pro est terminé : votre compte est revenu au plan gratuit. Vos coupons et votre historique sont toujours là.",
    "Pro ramène les Meilleurs paris du jour, le détecteur +EV avec alertes, et l'analyse IA incluse, pour 5,99 $ CA par mois (ou 60 $ CA par an). Annulable en tout temps.",
    "Si quelque chose vous a fait hésiter, répondez simplement à ce courriel. Je lis toutes les réponses.",
  ];
  const html = lifecycleHtml({
    hello: name ? `Hi ${name},` : 'Hi,', helloFr: name ? `Bonjour ${name},` : 'Bonjour,',
    lines, linesFr, cta: 'Get Pro', ctaFr: 'Passer à Pro', url,
  });
  const text = `${lines.join('\n\n')}\n\nGet Pro: ${url}\n\n---\n\n${linesFr.join('\n\n')}\n\nPasser à Pro : ${url}`;
  await sendEmail({ to, subject, html, text, replyTo: SUPPORT_EMAIL });
}
