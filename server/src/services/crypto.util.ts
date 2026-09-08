/**
 * crypto.util.ts — symmetric encryption for secrets at rest (AES-256-GCM).
 *
 * Used to encrypt user-supplied secrets (e.g. a free-tier user's own OpenAI
 * API key) before they are written to Postgres, so a DB dump / backup leak
 * never exposes usable credentials.
 *
 * Key management:
 *   Provide a 32-byte master key via ENCRYPTION_KEY, as 64 hex chars OR base64.
 *   Generate one with:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Storage format (single string, colon-delimited, versioned):
 *   enc:v1:<iv-b64>:<authTag-b64>:<ciphertext-b64>
 *
 * Backwards compatibility:
 *   decrypt() returns any value that is NOT in the enc:v1: format unchanged, so
 *   legacy plaintext rows keep working until the one-time migration
 *   (db/encrypt-openai-keys.ts) rewrites them.
 */

import crypto from 'crypto';
import { logger } from '../logger';

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length

let warnedNoKey = false;

/** Parse ENCRYPTION_KEY (hex or base64) into a 32-byte Buffer, or null if unset. */
function getKey(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY?.trim();
  if (!raw) return null;

  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes (got ' + key.length + ')');
  }
  return key;
}

/**
 * Sonde de démarrage : ENCRYPTION_KEY est-elle réellement utilisable ?
 *
 * Ajoutée le 2026-09-08 après un `PATCH /api/users/me` qui répondait 500 en
 * production dès qu'on enregistrait une clé OpenAI. La cause possible tient en
 * deux lignes de ce fichier — `encryptSecret` LÈVE quand la clé est absente en
 * production, et `getKey` lève quand elle ne fait pas 32 octets — mais rien ne
 * le disait avant la première écriture d'un utilisateur, et `sendError` masque
 * le message des 5xx en production. Le symptôme était donc « le bouton
 * Enregistrer renvoie 500 », sans rien de plus, des semaines après le
 * déploiement fautif.
 *
 * Même principe que `verifyAvatarStorage` et `verifyOddsApiKey` : une variable
 * dont l'absence ne casse rien AU DÉMARRAGE mérite une ligne de log au
 * démarrage, sinon la panne apparaît chez l'utilisateur et pas dans les logs.
 * On fait un vrai aller-retour chiffrement/déchiffrement, pas seulement un test
 * de présence — une clé de 32 octets mais tronquée à la copie passerait le test
 * de présence et échouerait en usage.
 *
 * Ne lève jamais : un serveur qui démarre à moitié est plus difficile à
 * diagnostiquer qu'un serveur qui démarre en criant dans ses logs.
 */
export function verifyEncryptionKey(): void {
  let key: Buffer | null;
  try {
    key = getKey();
  } catch (err: any) {
    logger.error(
      { err: err?.message },
      '[crypto] ⚠️ ENCRYPTION_KEY INVALIDE — tout enregistrement de clé OpenAI ' +
      '(PATCH /api/users/me) répondra 500. Attendu : 64 caractères hexadécimaux, ' +
      'ou du base64 décodant sur exactement 32 octets.',
    );
    return;
  }

  if (!key) {
    const msg =
      '[crypto] ENCRYPTION_KEY ABSENTE — aucun secret ne peut être chiffré. ' +
      'En production, PATCH /api/users/me répond 500 dès qu\'une clé OpenAI est enregistrée.';
    if (process.env.NODE_ENV === 'production') logger.error(msg);
    else logger.warn(msg + ' (dev : les secrets seraient stockés EN CLAIR)');
    return;
  }

  try {
    const probe = 'encryption-key-probe';
    if (decryptSecret(encryptSecret(probe)) !== probe) {
      throw new Error('aller-retour chiffrement/déchiffrement incohérent');
    }
    logger.info('[crypto] ✅ ENCRYPTION_KEY valide — chiffrement des secrets au repos opérationnel');
  } catch (err: any) {
    logger.error(
      { err: err?.message },
      '[crypto] ⚠️ ENCRYPTION_KEY présente mais INUTILISABLE — PATCH /api/users/me répondra 500.',
    );
  }
}

/** True if a value is already in our encrypted envelope format. */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * Encrypt a plaintext secret. Returns the enc:v1: envelope.
 *
 * If ENCRYPTION_KEY is not configured:
 *   - in production → throws (we must never silently persist plaintext);
 *   - otherwise (dev) → returns the plaintext unchanged, logging one warning,
 *     so local development works without a key.
 */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('ENCRYPTION_KEY is required in production to store secrets at rest');
    }
    if (!warnedNoKey) {
      logger.warn('[crypto] ENCRYPTION_KEY not set — storing secret UNENCRYPTED (dev only).');
      warnedNoKey = true;
    }
    return plaintext;
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/**
 * Decrypt an enc:v1: envelope back to plaintext.
 * Any value not in that format is returned unchanged (legacy plaintext).
 */
export function decryptSecret(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (!isEncrypted(value)) return value; // legacy plaintext or already-clear

  const key = getKey();
  if (!key) {
    throw new Error('ENCRYPTION_KEY is required to decrypt a stored secret but is not set');
  }

  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Malformed encrypted secret');
  const [ivB64, tagB64, dataB64] = parts;

  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(dataB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
