/**
 * encrypt-openai-keys.ts — one-time migration.
 *
 * Encrypts any existing PLAINTEXT user_profiles.openai_api_key values in place
 * using the AES-256-GCM helper (crypto.util). Rows already in the enc:v1:
 * format are skipped, so this script is idempotent and safe to re-run.
 *
 * Prerequisite: ENCRYPTION_KEY must be set in the environment.
 *
 * Run:  cd server && npm run db:encrypt-keys
 */

import 'dotenv/config';
import { pool } from './connection';
import { encryptSecret, isEncrypted } from '../services/crypto.util';

(async () => {
  if (!process.env.ENCRYPTION_KEY) {
    console.error('[encrypt-keys] ENCRYPTION_KEY is not set — aborting.');
    process.exit(1);
  }

  const { rows } = await pool.query<{ user_id: string; openai_api_key: string }>(
    `SELECT user_id, openai_api_key
       FROM user_profiles
      WHERE openai_api_key IS NOT NULL AND openai_api_key <> ''`,
  );

  let encrypted = 0;
  let skipped = 0;

  for (const row of rows) {
    if (isEncrypted(row.openai_api_key)) {
      skipped++;
      continue;
    }
    const enc = encryptSecret(row.openai_api_key);
    await pool.query(
      'UPDATE user_profiles SET openai_api_key = $1 WHERE user_id = $2',
      [enc, row.user_id],
    );
    encrypted++;
  }

  console.log(`[encrypt-keys] Done. Encrypted ${encrypted}, already-encrypted ${skipped}, total ${rows.length}.`);
  await pool.end();
  process.exit(0);
})().catch(async (err: any) => {
  console.error('[encrypt-keys] Fatal:', err?.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
