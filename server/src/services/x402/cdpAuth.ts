/**
 * cdpAuth.ts — authentification du facilitateur Coinbase (CDP) pour x402
 * (X402_PLAN.md, phase 3 : réseau réel).
 *
 * Le facilitateur public x402.org ne sert que le testnet. Sur Base (eip155:8453),
 * on passe par celui de Coinbase, qui exige un JWT signé par une clé API CDP à
 * CHAQUE appel (verify, settle, supported). C'est aussi lui qui indexe les
 * routes dans le Bazaar.
 *
 * Réécriture sans dépendance de `generateJwt` (@coinbase/cdp-sdk 1.60.0,
 * `_cjs/auth/utils/jwt.js`) et de `createCdpFacilitatorClient`
 * (`_cjs/x402/facilitator.js`) : le SDK complet pèse ~136 Mo pour ces ~60
 * lignes. Même format, vérifié contre le SDK officiel le 2026-11-04 (jetons
 * croisés acceptés des deux côtés, mêmes champs).
 *
 *   en-tête  { alg: EdDSA | ES256, kid: <id de clé>, typ: 'JWT', nonce: 16 octets hex }
 *   charge   { sub: <id de clé>, iss: 'cdp', uris: ['<MÉTHODE> <hôte><chemin>'], iat, nbf, exp = iat + 120 }
 *
 * Deux formats de secret, comme le SDK : Ed25519 en base64 (64 octets :
 * graine + clé publique, format actuel) ou clé EC P-256 en PEM (ancien format).
 *
 * Le secret vit dans Railway (CDP_API_KEY_SECRET). Il permet d'appeler l'API
 * CDP, PAS de dépenser les fonds du portefeuille vendeur (X402_PAY_TO), dont la
 * clé privée ne touche jamais le serveur.
 */

import { createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject } from 'node:crypto';

export const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';
const JWT_TTL_S = 120;
/** En-tête DER PKCS#8 d'une clé Ed25519 : suivi des 32 octets de la graine. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface CdpCredentials {
  apiKeyId: string;
  apiKeySecret: string;
}

type ParsedKey = { alg: 'EdDSA' | 'ES256'; key: KeyObject };

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Lit le secret CDP. Lève avec un message clair si le format est inconnu. */
export function parseCdpSecret(secret: string): ParsedKey {
  const s = secret.trim().replace(/\\n/g, '\n'); // Railway : un PEM collé sur une ligne garde ses « \n »
  if (s.includes('-----BEGIN')) {
    try {
      const key = createPrivateKey({ key: s, format: 'pem' });
      if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1') return { alg: 'ES256', key };
    } catch { /* message commun ci-dessous */ }
    throw new Error('CDP_API_KEY_SECRET: PEM key must be an EC P-256 private key');
  }
  const raw = Buffer.from(s, 'base64');
  if (raw.length === 64) {
    // Clé construite depuis la graine seule (32 premiers octets), puis la moitié
    // publique est comparée : un secret tronqué ou mal collé échoue ici, au
    // démarrage, avec un message clair (selon la version de Node, l'import JWK
    // levait « Invalid JWK OKP key »).
    const key = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, raw.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
    const x = (createPublicKey(key).export({ format: 'jwk' }) as { x?: string }).x;
    if (x !== b64url(raw.subarray(32))) throw new Error('CDP_API_KEY_SECRET: Ed25519 key is corrupted (public half does not match)');
    return { alg: 'EdDSA', key };
  }
  throw new Error('CDP_API_KEY_SECRET: expected a base64 Ed25519 key (64 bytes) or an EC PEM key');
}

/** Un JWT CDP pour une requête REST précise (méthode + hôte + chemin). */
export function cdpJwt(
  creds: CdpCredentials,
  req: { method: string; host: string; path: string },
  parsed: ParsedKey = parseCdpSecret(creds.apiKeySecret),
  nowS: number = Math.floor(Date.now() / 1000),
): string {
  const header = { alg: parsed.alg, kid: creds.apiKeyId, typ: 'JWT', nonce: randomBytes(16).toString('hex') };
  const payload = {
    sub: creds.apiKeyId,
    iss: 'cdp',
    uris: [`${req.method} ${req.host}${req.path}`],
    iat: nowS,
    nbf: nowS,
    exp: nowS + JWT_TTL_S,
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = parsed.alg === 'EdDSA'
    ? sign(null, Buffer.from(input), parsed.key)
    : sign('sha256', Buffer.from(input), { key: parsed.key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(sig)}`;
}

/**
 * `createAuthHeaders` pour `HTTPFacilitatorClient` (@x402/core) : un jeton par
 * chemin, liés à la méthode réelle (supported = GET, verify/settle = POST).
 * Le secret est lu une fois ici : une clé invalide fait échouer le démarrage.
 */
export function cdpAuthHeaders(creds: CdpCredentials, baseUrl: string = CDP_FACILITATOR_URL) {
  const parsed = parseCdpSecret(creds.apiKeySecret);
  const u = new URL(baseUrl);
  const base = u.pathname.replace(/\/$/, '');
  const headers = (method: string, path: string) => ({
    Authorization: `Bearer ${cdpJwt(creds, { method, host: u.host, path: `${base}/${path}` }, parsed)}`,
    'Correlation-Context': 'sdkLanguage=typescript,source=arakice',
  });
  return async () => ({
    verify: headers('POST', 'verify'),
    settle: headers('POST', 'settle'),
    supported: headers('GET', 'supported'),
  });
}
