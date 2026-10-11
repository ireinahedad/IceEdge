/**
 * appleJws.ts — vérification des JWS signés par l'App Store (StoreKit 2 et
 * App Store Server Notifications V2). APPLE_PLAN Phase 5.
 *
 * ── POURQUOI SANS DÉPENDANCE ───────────────────────────────────────────────
 *
 * Même choix que `apns.ts`. La librairie officielle d'Apple demande de lui
 * fournir le certificat racine en fichier ; ici on n'en a pas besoin, parce
 * que chaque JWS d'Apple TRANSPORTE sa chaîne complète dans l'en-tête `x5c`
 * (feuille → intermédiaire WWDR → Apple Root CA - G3). Ce qu'on vérifie :
 *
 *   1. la racine de la chaîne est bien Apple Root CA - G3 (empreinte SHA-256
 *      épinglée ci-dessous — c'est elle qui ancre toute la confiance) ;
 *   2. chaque certificat est émis ET signé par le suivant ;
 *   3. la feuille et l'intermédiaire portent les marqueurs d'Apple (OID
 *      1.2.840.113635.100.6.11.1 et 1.2.840.113635.100.6.2.1), comme le fait
 *      la librairie officielle — un autre certificat émis par Apple ne suffit pas ;
 *   4. les certificats étaient valides à la date de signature (`signedDate`) ;
 *   5. la signature ES256 du JWS avec la clé de la feuille.
 *
 * Ce qu'on NE fait pas : la vérification OCSP en ligne (révocation des
 * certificats intermédiaires). La librairie officielle la rend aussi optionnelle.
 *
 * Empreinte : https://www.apple.com/certificateauthority/ → « Apple Root CA - G3 ».
 */

import { X509Certificate, verify as cryptoVerify } from 'node:crypto';

export const APPLE_ROOT_CA_G3_SHA256 =
  '63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79';

/** OID encodés en DER (tag 06, longueur 0A, valeur) — cherchés tels quels dans le certificat. */
const OID_LEAF         = Buffer.from('060a2a864886f76364060b01', 'hex'); // 1.2.840.113635.100.6.11.1
const OID_INTERMEDIATE = Buffer.from('060a2a864886f76364060201', 'hex'); // 1.2.840.113635.100.6.2.1

export class AppleJwsError extends Error {
  status = 400;
  code = 'APPLE_JWS_INVALID';
  constructor(message: string) { super(`JWS Apple refusé : ${message}`); }
}

export interface VerifyOptions {
  /** Empreinte de la racine attendue. Remplacée UNIQUEMENT par les tests. */
  rootFingerprint?: string;
  /** Date de référence si le contenu n'a pas de `signedDate` (ms). */
  nowMs?: number;
}

function b64urlJson(part: string): any {
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); }
  catch { throw new AppleJwsError('segment illisible'); }
}

/** Vérifie un JWS Apple et renvoie son contenu décodé. Lève `AppleJwsError` sinon. */
export function verifyAppleJws<T = Record<string, unknown>>(token: string, opts: VerifyOptions = {}): T {
  if (typeof token !== 'string') throw new AppleJwsError('absent');
  const parts = token.split('.');
  if (parts.length !== 3) throw new AppleJwsError('format');
  const [h, p, s] = parts;

  const header = b64urlJson(h);
  if (header?.alg !== 'ES256') throw new AppleJwsError('algorithme');
  const x5c: unknown = header.x5c;
  if (!Array.isArray(x5c) || x5c.length < 2 || x5c.length > 4) throw new AppleJwsError('chaîne x5c');

  let certs: X509Certificate[];
  try { certs = x5c.map((c) => new X509Certificate(Buffer.from(String(c), 'base64'))); }
  catch { throw new AppleJwsError('certificat illisible'); }

  const root = certs[certs.length - 1];
  if (root.fingerprint256 !== (opts.rootFingerprint ?? APPLE_ROOT_CA_G3_SHA256)) {
    throw new AppleJwsError('racine inconnue');
  }
  if (!root.verify(root.publicKey)) throw new AppleJwsError('racine non auto-signée');
  for (let i = 0; i < certs.length - 1; i++) {
    if (!certs[i].checkIssued(certs[i + 1]) || !certs[i].verify(certs[i + 1].publicKey)) {
      throw new AppleJwsError('chaîne rompue');
    }
  }
  if (!certs[0].raw.includes(OID_LEAF)) throw new AppleJwsError('feuille sans marqueur Apple');
  if (certs.length >= 3 && !certs[1].raw.includes(OID_INTERMEDIATE)) {
    throw new AppleJwsError('intermédiaire sans marqueur Apple');
  }

  const payload = b64urlJson(p);
  const signedMs = typeof payload?.signedDate === 'number' ? payload.signedDate : (opts.nowMs ?? Date.now());
  for (const c of certs) {
    if (signedMs < Date.parse(c.validFrom) || signedMs > Date.parse(c.validTo)) {
      throw new AppleJwsError('certificat hors validité');
    }
  }

  const sig = Buffer.from(s, 'base64url');
  if (sig.length !== 64) throw new AppleJwsError('signature');
  const ok = cryptoVerify('sha256', Buffer.from(`${h}.${p}`), { key: certs[0].publicKey, dsaEncoding: 'ieee-p1363' }, sig);
  if (!ok) throw new AppleJwsError('signature');

  return payload as T;
}

// ─── Contenus décodés (champs utilisés seulement) ─────────────────────────────

export type AppleEnvironment = 'Production' | 'Sandbox' | 'Xcode' | 'LocalTesting';

/** JWSTransactionDecodedPayload */
export interface AppleTransaction {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  type: string;                 // « Auto-Renewable Subscription » pour nous
  purchaseDate: number;
  expiresDate?: number;
  appAccountToken?: string;     // notre user_id, posé par l'app à l'achat
  environment: AppleEnvironment;
  revocationDate?: number;      // remboursement ou retrait
  offerType?: number;           // 1 = offre d'introduction (l'essai de 7 jours)
  signedDate: number;
}

/** JWSRenewalInfoDecodedPayload */
export interface AppleRenewalInfo {
  originalTransactionId: string;
  autoRenewStatus: 0 | 1;
  autoRenewProductId?: string;
  isInBillingRetryPeriod?: boolean;
  gracePeriodExpiresDate?: number;
  signedDate: number;
}

/** ResponseBodyV2DecodedPayload */
export interface AppleNotification {
  notificationType: string;
  subtype?: string;
  notificationUUID: string;
  signedDate: number;
  data?: {
    bundleId?: string;
    environment?: AppleEnvironment;
    signedTransactionInfo?: string;
    signedRenewalInfo?: string;
  };
}

export interface AppleEntitlement {
  plan: 'free' | 'pro';
  status: 'active' | 'trialing' | 'past_due' | 'canceled';
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

/**
 * Ce que vaut une transaction (et, si on l'a, son état de renouvellement)
 * à l'instant `nowMs`. Fonction pure : c'est elle que les tests couvrent.
 *
 *  • remboursée / retirée → gratuit tout de suite ;
 *  • période payée (ou période de grâce de facturation) en cours → Pro,
 *    « trialing » pendant l'offre d'introduction ;
 *  • sinon → gratuit, « past_due » si Apple réessaie encore de facturer.
 */
export function entitlementFromApple(
  tx: AppleTransaction,
  renewal: AppleRenewalInfo | null,
  nowMs: number = Date.now(),
): AppleEntitlement {
  if (tx.revocationDate) {
    return { plan: 'free', status: 'canceled', currentPeriodEnd: new Date(tx.revocationDate), cancelAtPeriodEnd: false };
  }
  const expires = tx.expiresDate ?? 0;
  const grace = renewal?.gracePeriodExpiresDate ?? 0;
  const end = Math.max(expires, grace);
  const cancelAtPeriodEnd = renewal ? renewal.autoRenewStatus === 0 : false;

  if (end > nowMs) {
    // En période de grâce, l'accès court jusqu'à la fin de la grâce, pas de la période.
    return {
      plan: 'pro',
      status: tx.offerType === 1 && expires > nowMs ? 'trialing' : 'active',
      currentPeriodEnd: new Date(end),
      cancelAtPeriodEnd,
    };
  }
  return {
    plan: 'free',
    status: renewal?.isInBillingRetryPeriod ? 'past_due' : 'canceled',
    currentPeriodEnd: end ? new Date(end) : null,
    cancelAtPeriodEnd,
  };
}
