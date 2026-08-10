/**
 * notify-slips-visibility.ts — Avis préalable à la mise en service de la page
 * joueur (coupons visibles aux membres Pro).
 *
 *   npm run notify:slips -- --date 2026-10-07              → simulation (défaut)
 *   npm run notify:slips -- --date 2026-10-07 --send       → envoi réel
 *   npm run notify:slips -- --date 2026-10-07 --send --only moi@exemple.com
 *
 * À exécuter AVANT de renseigner `PUBLIC_SLIPS_SINCE` (cf. §7 de DEPLOYMENT.md).
 * Un avis qui arrive après la mise en service n'informe plus, il constate.
 *
 * SIMULATION PAR DÉFAUT — l'envoi exige `--send`. Un script de diffusion de
 * masse qui part au premier lancement est une erreur qu'on ne commet qu'une
 * fois, et qu'on ne peut pas défaire : un courriel envoyé ne se rappelle pas.
 */

import 'dotenv/config';
import { pool } from '../src/db/connection';
import { sendSlipsVisibilityNotice } from '../src/services/email.service';

/** Pause entre deux envois — reste bien sous les limites de débit de Resend. */
const DELAY_MS = 600;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function clientBaseUrl(): string {
  return (
    process.env.CLIENT_URL ||
    (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',')[0].trim()
  );
}

async function main(): Promise<void> {
  const rawDate = arg('date');
  const send    = process.argv.includes('--send');
  const only    = arg('only');

  if (!rawDate || Number.isNaN(new Date(rawDate).getTime())) {
    console.error('Usage : --date YYYY-MM-DD [--send] [--only courriel]');
    process.exitCode = 1;
    return;
  }

  // La date affichée est celle que la personne lira ; on la formate une fois
  // ici plutôt que dans le gabarit, qui ne doit rien savoir des locales.
  const liveDate = new Date(rawDate).toLocaleDateString('fr-CA', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
  const settingsUrl = `${clientBaseUrl()}/profile`;

  // Comptes actifs et vérifiés seulement : écrire à une adresse jamais confirmée
  // n'informe personne et abîme la réputation d'envoi du domaine.
  const params: unknown[] = [];
  let where = 'is_active = TRUE AND email_verified = TRUE';
  if (only) { params.push(only); where += ` AND email = $${params.length}`; }

  const { rows } = await pool.query<{ email: string; firstName: string | null }>(
    `SELECT email, first_name AS "firstName" FROM users WHERE ${where} ORDER BY created_at ASC`,
    params,
  );

  console.log(`${rows.length} destinataire(s) · date annoncée : ${liveDate}`);
  console.log(`Lien de gestion : ${settingsUrl}`);
  if (!send) {
    console.log('\n— SIMULATION — aucun courriel envoyé. Ajouter --send pour envoyer.');
    for (const r of rows.slice(0, 10)) console.log(`   ${r.email}`);
    if (rows.length > 10) console.log(`   … et ${rows.length - 10} autres`);
    return;
  }

  let sent = 0;
  const failed: string[] = [];
  for (const r of rows) {
    try {
      await sendSlipsVisibilityNotice(r.email, { firstName: r.firstName, liveDate, settingsUrl });
      sent++;
      if (sent % 25 === 0) console.log(`   ${sent}/${rows.length}…`);
    } catch (err) {
      // Un échec ne doit pas interrompre la diffusion : les suivants n'y sont
      // pour rien, et relancer le script entier réécrirait à tous les autres.
      failed.push(r.email);
      console.error(`   ✗ ${r.email} : ${(err as Error).message}`);
    }
    await new Promise((res) => setTimeout(res, DELAY_MS));
  }

  console.log(`\n${sent} envoyé(s), ${failed.length} échec(s).`);
  if (failed.length) {
    console.log('À reprendre un par un avec --only :');
    for (const e of failed) console.log(`   npm run notify:slips -- --date ${rawDate} --send --only ${e}`);
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
