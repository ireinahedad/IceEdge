/**
 * instrument.ts — Sentry initialisation.
 *
 * MUST be imported before anything else in server.ts (right after
 * `dotenv/config`) so Sentry can auto-instrument HTTP, Express and pg.
 *
 * No-op when SENTRY_DSN is unset, so local dev and CI stay quiet.
 * Configure with:
 *   SENTRY_DSN=...                       (from your Sentry project settings)
 *   SENTRY_TRACES_SAMPLE_RATE=0.01       (optional — voir ci-dessous)
 */

import * as Sentry from '@sentry/node';

/**
 * ÉCHANTILLONNAGE DU TRACING (audit, ligne 10)
 *
 * Ce réglage ne concerne QUE le tracing de performance. Les **erreurs** sont
 * envoyées à 100 % quoi qu'il arrive — c'est la confusion classique, et elle
 * pousse à garder un taux trop élevé « pour ne rien rater ».
 *
 * Pourquoi 0.01 et non 0.1 en production : à ~200 req/s, 10 % font environ
 * 52 millions de transactions par mois, quand les plans en incluent quelques
 * dizaines de milliers. Le dépassement est facturé à l'unité, et c'est un coût
 * qui n'apparaît que sur la facture — aucun symptôme applicatif ne le signale.
 * 1 % reste largement suffisant pour voir une distribution de latence : ce qu'on
 * cherche dans une trace, c'est une forme, pas un exhaustif.
 *
 * Le défaut vit ICI plutôt que dans une variable Railway, délibérément. Un
 * garde-fou qu'il faut penser à activer est un garde-fou éteint : si personne ne
 * pose la variable — ou si elle est perdue en recréant le service — le
 * comportement sûr doit être celui par défaut. La variable ne sert plus qu'à
 * s'en écarter volontairement, par exemple pour tracer 100 % le temps d'une
 * investigation.
 *
 * Hors production, 0.1 : le volume est négligeable et une trace sur dix rend le
 * débogage local nettement plus lisible.
 */
const isProd = process.env.NODE_ENV === 'production';
const configured = Number(process.env.SENTRY_TRACES_SAMPLE_RATE);
// `Number('')` vaut 0, et 0 est une valeur légitime (« ne trace rien »). D'où le
// test sur la chaîne : seule une variable ABSENTE retombe sur le défaut.
const tracesSampleRate =
  process.env.SENTRY_TRACES_SAMPLE_RATE && Number.isFinite(configured)
    ? configured
    : (isProd ? 0.01 : 0.1);

// La sonde imprime SA REUSSITE, pas seulement ses echecs. Sans elle, une DSN
// correcte, une DSN mal collee et une DSN absente donnent exactement la meme
// sortie -- rien -- et « Sentry est branche » devient une croyance invérifiable.
// `console` et non `logger` : ce fichier doit s'executer AVANT tout le reste
// (cf. l'en-tete), donc avant que le logger n'existe.
if (process.env.SENTRY_DSN) {
  try {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate,
      // Don't send PII by default.
      sendDefaultPii: false,
    });
    console.log(
      `[Sentry] ✅ armé — environment=${process.env.NODE_ENV || 'development'}, ` +
      `tracesSampleRate=${tracesSampleRate}`,
    );
  } catch (e: any) {
    // Le monitoring ne doit jamais empecher de demarrer ce qu'il surveille.
    console.warn(`[Sentry] ⚠️  non armé : ${e?.message ?? e} — le serveur démarre sans`);
  }
} else {
  console.log('[Sentry] ℹ️  inactif — SENTRY_DSN non définie');
}

export { tracesSampleRate };
