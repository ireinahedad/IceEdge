import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, verify } from 'node:crypto';
import { cdpJwt, cdpAuthHeaders, parseCdpSecret, CDP_FACILITATOR_URL } from './cdpAuth';

/**
 * JWT du facilitateur Coinbase (X402_PLAN.md, phase 3). Même format que
 * `generateJwt` de @coinbase/cdp-sdk 1.60.0 ; ici, on vérifie la signature avec
 * la clé publique et chaque champ dont dépend l'API CDP.
 */

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

function ed25519Secret() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string };
  const secret = Buffer.concat([Buffer.from(jwk.d, 'base64url'), Buffer.from(jwk.x, 'base64url')]).toString('base64');
  return { secret, publicKey };
}

function check(jwt: string, publicKey: any, alg: 'EdDSA' | 'ES256') {
  const [h, p, s] = jwt.split('.');
  const ok = alg === 'EdDSA'
    ? verify(null, Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'))
    : verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  expect(ok).toBe(true);
  return { header: decode(h), payload: decode(p) };
}

describe('cdpJwt', () => {
  it('Ed25519 (format actuel des clés CDP) : signature valide, champs attendus', () => {
    const { secret, publicKey } = ed25519Secret();
    const jwt = cdpJwt({ apiKeyId: 'org/key', apiKeySecret: secret },
      { method: 'POST', host: 'api.cdp.coinbase.com', path: '/platform/v2/x402/settle' }, undefined, 1_800_000_000);
    const { header, payload } = check(jwt, publicKey, 'EdDSA');
    expect(header).toMatchObject({ alg: 'EdDSA', kid: 'org/key', typ: 'JWT' });
    expect(header.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(payload).toEqual({
      sub: 'org/key', iss: 'cdp', uris: ['POST api.cdp.coinbase.com/platform/v2/x402/settle'],
      iat: 1_800_000_000, nbf: 1_800_000_000, exp: 1_800_000_120,
    });
  });

  it('EC P-256 en PEM (ancien format), y compris collé sur une ligne avec « \\n »', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = privateKey.export({ format: 'pem', type: 'sec1' }).toString();
    const oneLine = pem.replace(/\n/g, '\\n');
    const jwt = cdpJwt({ apiKeyId: 'k', apiKeySecret: oneLine }, { method: 'GET', host: 'h', path: '/p' });
    expect(check(jwt, publicKey, 'ES256').header.alg).toBe('ES256');
  });

  it('refuse un secret inconnu, abîmé ou d\'une autre courbe', () => {
    expect(() => parseCdpSecret('abc')).toThrow(/CDP_API_KEY_SECRET/);
    expect(() => parseCdpSecret(Buffer.alloc(64, 7).toString('base64'))).toThrow(/corrupted/);
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    expect(() => parseCdpSecret(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())).toThrow(/P-256/);
  });

  it('un nonce neuf à chaque jeton', () => {
    const { secret } = ed25519Secret();
    const a = cdpJwt({ apiKeyId: 'k', apiKeySecret: secret }, { method: 'GET', host: 'h', path: '/p' });
    const b = cdpJwt({ apiKeyId: 'k', apiKeySecret: secret }, { method: 'GET', host: 'h', path: '/p' });
    expect(decode(a.split('.')[0]).nonce).not.toBe(decode(b.split('.')[0]).nonce);
  });
});

describe('cdpAuthHeaders', () => {
  it('un jeton par chemin, lié à la bonne méthode (forme exigée par HTTPFacilitatorClient)', async () => {
    const { secret, publicKey } = ed25519Secret();
    const all = await cdpAuthHeaders({ apiKeyId: 'k', apiKeySecret: secret })();
    expect(Object.keys(all).sort()).toEqual(['settle', 'supported', 'verify']);
    const uri = (h: Record<string, string>) => check(h.Authorization.replace(/^Bearer /, ''), publicKey, 'EdDSA').payload.uris[0];
    expect(uri(all.verify)).toBe('POST api.cdp.coinbase.com/platform/v2/x402/verify');
    expect(uri(all.settle)).toBe('POST api.cdp.coinbase.com/platform/v2/x402/settle');
    expect(uri(all.supported)).toBe('GET api.cdp.coinbase.com/platform/v2/x402/supported');
    expect(CDP_FACILITATOR_URL).toBe('https://api.cdp.coinbase.com/platform/v2/x402');
  });

  it('suit une autre URL de base (chemin sans barre finale)', async () => {
    const { secret, publicKey } = ed25519Secret();
    const all = await cdpAuthHeaders({ apiKeyId: 'k', apiKeySecret: secret }, 'https://staging.example.com/v2/x402/')();
    const p = check(all.verify.Authorization.slice(7), publicKey, 'EdDSA').payload;
    expect(p.uris).toEqual(['POST staging.example.com/v2/x402/verify']);
  });
});
