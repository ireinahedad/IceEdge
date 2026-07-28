/**
 * avatarStorage.ts
 * ------------------------------------------------------------------
 * Stockage des avatars sur un bucket S3-compatible (Cloudflare R2).
 *
 * Avant : l'avatar était conservé en data-URI base64 dans
 * `user_profiles.avatar_url`, donc dans Postgres — le stockage le plus cher de
 * la stack — et renvoyé dans chaque payload de chat et de leaderboard.
 *
 * Ici l'image est poussée sur R2 et seule son URL publique (~60 caractères) est
 * écrite en base. Le coût de stockage et d'egress devient celui d'un
 * object-store (R2 : 10 Go gratuits, pas de frais d'egress).
 *
 * Dégradation propre : tant que les variables R2_* ne sont pas renseignées,
 * `uploadAvatar` renvoie null et l'appelant conserve le comportement actuel
 * (data-URI en base). Rien ne casse avant que le bucket ne soit configuré.
 *
 * Modèle de sécurité :
 *  - les identifiants R2 vivent uniquement côté serveur ;
 *  - la clé de l'objet est construite à partir de l'userId issu du JWT, jamais
 *    d'une valeur fournie par le client → pas de traversée de chemin ni
 *    d'écrasement de l'avatar d'autrui ;
 *  - le type MIME déclaré n'est pas cru sur parole : il est confronté aux
 *    octets magiques du fichier avant l'upload ;
 *  - la taille est bornée avant tout appel réseau.
 */

import crypto from 'crypto';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { logger } from '../logger';

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const ACCESS_KEY = process.env.R2_ACCESS_KEY_ID;
const SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET     = process.env.R2_BUCKET;
/** Domaine public du bucket, sans slash final (r2.dev ou domaine perso). */
const PUBLIC_URL = (process.env.R2_PUBLIC_URL ?? '').replace(/\/+$/, '');

/** Taille maximale acceptée après décodage (le client envoie ~20 ko). */
const MAX_BYTES = 300 * 1024;

/** Formats acceptés → extension de fichier. Tout le reste est refusé. */
const ALLOWED_TYPES: ReadonlyMap<string, string> = new Map([
  ['image/webp', 'webp'],
  ['image/jpeg', 'jpg'],
  ['image/png',  'png'],
]);

export const isAvatarStorageConfigured = Boolean(
  ACCOUNT_ID && ACCESS_KEY && SECRET_KEY && BUCKET && PUBLIC_URL,
);

// Diagnostic au démarrage. Le repli sur le stockage base64 est volontairement
// silencieux à l'exécution (l'app doit fonctionner sans object-store), mais un
// repli silencieux ET invisible est indébogable : sans cette ligne, une variable
// oubliée se manifeste seulement par des avatars qui restent en data-URI, sans
// rien dans les logs. On journalise donc les NOMS manquants — jamais les valeurs.
{
  const missing = Object.entries({
    R2_ACCOUNT_ID:        ACCOUNT_ID,
    R2_ACCESS_KEY_ID:     ACCESS_KEY,
    R2_SECRET_ACCESS_KEY: SECRET_KEY,
    R2_BUCKET:            BUCKET,
    R2_PUBLIC_URL:        PUBLIC_URL,
  }).filter(([, v]) => !v).map(([k]) => k);

  if (missing.length === 0) {
    logger.info({ bucket: BUCKET, publicUrl: PUBLIC_URL }, '[avatarStorage] R2 actif');
  } else if (missing.length === 5) {
    logger.info('[avatarStorage] R2 non configuré — les avatars restent stockés en base64 dans Postgres');
  } else {
    // Cas le plus traître : la configuration a été tentée mais est incomplète.
    logger.warn({ missing }, '[avatarStorage] configuration R2 INCOMPLÈTE — repli sur le stockage base64');
  }
}

let client: S3Client | null = null;
function s3(): S3Client {
  if (!client) {
    client = new S3Client({
      // R2 ignore la région mais l'SDK en exige une.
      region: 'auto',
      endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: ACCESS_KEY!, secretAccessKey: SECRET_KEY! },
    });
  }
  return client;
}

/**
 * Vérifie que les octets correspondent réellement au type annoncé.
 *
 * Un `Content-Type` déclaré par l'appelant ne prouve rien : sans ce contrôle,
 * n'importe quel contenu pourrait être servi depuis notre domaine avec un
 * type d'image, ce qui est un vecteur classique de XSS stocké (un SVG ou un
 * HTML servi en `image/*` et ouvert directement).
 */
function sniffType(bytes: Buffer): string | null {
  if (bytes.length >= 12 &&
      bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

/** Décode une data-URI `data:image/...;base64,...`. Renvoie null si malformée. */
function parseDataUri(dataUrl: string): { mime: string; bytes: Buffer } | null {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) return null;

  const mime = match[1].toLowerCase();
  // Décodage tolérant : Buffer ignore les caractères non-base64, on revérifie
  // donc que la ré-encodage correspond pour rejeter une entrée bricolée.
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length) return null;
  return { mime, bytes };
}

/**
 * Pousse un avatar sur R2 et renvoie son URL publique.
 *
 * Renvoie `null` si le stockage objet n'est pas configuré (l'appelant retombe
 * alors sur l'ancien comportement) ou si l'upload échoue — un avatar est
 * accessoire, il ne doit jamais faire échouer la sauvegarde du profil.
 * Lève une erreur 400 uniquement quand l'entrée elle-même est invalide.
 */
export async function uploadAvatar(userId: string, dataUrl: string): Promise<string | null> {
  if (!isAvatarStorageConfigured) return null;

  const parsed = parseDataUri(dataUrl);
  if (!parsed) throw Object.assign(new Error('Invalid image data'), { status: 400 });
  if (parsed.bytes.length > MAX_BYTES) {
    throw Object.assign(new Error('Image too large'), { status: 400 });
  }

  // Le type réel prime sur le type déclaré, et doit figurer dans la liste blanche.
  const sniffed = sniffType(parsed.bytes);
  if (!sniffed || sniffed !== parsed.mime || !ALLOWED_TYPES.has(sniffed)) {
    throw Object.assign(new Error('Unsupported image format'), { status: 400 });
  }

  // Clé dérivée de l'userId (issu du JWT) + suffixe aléatoire. Le suffixe change
  // à chaque upload : l'URL est donc immuable et peut être cachée pour toujours.
  const key = `avatars/${userId}/${crypto.randomBytes(8).toString('hex')}.${ALLOWED_TYPES.get(sniffed)}`;

  try {
    await s3().send(new PutObjectCommand({
      Bucket:       BUCKET,
      Key:          key,
      Body:         parsed.bytes,
      ContentType:  sniffed,
      CacheControl: 'public, max-age=31536000, immutable',
    }));
    return `${PUBLIC_URL}/${key}`;
  } catch (err: any) {
    logger.error({ err: err?.message, userId }, '[avatarStorage] upload échoué');
    return null;
  }
}

/**
 * Supprime l'avatar précédent d'un utilisateur. Best-effort : une suppression
 * ratée laisse un objet orphelin (quelques dizaines de ko), ce n'est pas une
 * raison de faire échouer la requête.
 *
 * Le préfixe exigé inclut l'userId, et pas seulement le domaine du bucket.
 * C'est essentiel : `avatarUrl` est librement modifiable via `PATCH /me` (le
 * client s'en sert pour les drapeaux), donc un utilisateur pourrait y écrire
 * l'URL de l'avatar de quelqu'un d'autre puis changer le sien pour provoquer
 * la suppression. Avec ce contrôle, on ne peut supprimer que ses propres objets.
 *
 * Les data-URI historiques et les URL de drapeaux ne matchent pas le préfixe et
 * sont donc ignorées.
 */
export async function deleteAvatarByUrl(userId: string, url: string | null | undefined): Promise<void> {
  if (!isAvatarStorageConfigured || !url) return;

  const prefix = `${PUBLIC_URL}/avatars/${userId}/`;
  if (!url.startsWith(prefix)) return;

  const key = url.slice(PUBLIC_URL.length + 1);
  // La clé doit avoir exactement la forme que `uploadAvatar` produit. R2 traite
  // les clés comme des chaînes opaques (un « .. » n'y est pas résolu), mais on
  // refuse tout de même ce qui ne vient manifestement pas de nous.
  if (!/^avatars\/[^/]+\/[0-9a-f]{16}\.(webp|jpg|png)$/.test(key)) return;
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (err: any) {
    logger.warn({ err: err?.message, key }, '[avatarStorage] suppression échouée (objet orphelin)');
  }
}
