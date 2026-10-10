import { describe, expect, it } from 'vitest';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { buildApnsBody, buildProviderToken, isDeadToken, parseP8 } from './apns';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

describe('parseP8', () => {
  it('accepte le PEM brut, le PEM aux \\n échappés et le base64 du fichier', () => {
    expect(parseP8(pem)).toBe(pem.trim());
    expect(parseP8(pem.replace(/\n/g, '\\n'))).toBe(pem.trim());
    expect(parseP8(Buffer.from(pem).toString('base64'))).toBe(pem.trim());
  });
});

describe('buildProviderToken', () => {
  it('produit un JWT ES256 vérifiable avec kid et iss', () => {
    const jwt = buildProviderToken(privateKey, 'ABC123DEFG', 'TEAM123456', 1_760_000_000);
    const [h, c, sig] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' });
    expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toEqual({ iss: 'TEAM123456', iat: 1_760_000_000 });
    const raw = Buffer.from(sig, 'base64url');
    expect(raw).toHaveLength(64); // r||s, pas du DER
    const ok = verify('sha256', Buffer.from(`${h}.${c}`), { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' }, raw);
    expect(ok).toBe(true);
  });
});

describe('isDeadToken', () => {
  it('ne supprime que les jetons qu’Apple déclare morts', () => {
    expect(isDeadToken({ status: 410, reason: 'Unregistered' })).toBe(true);
    expect(isDeadToken({ status: 400, reason: 'BadDeviceToken' })).toBe(true);
    expect(isDeadToken({ status: 400, reason: 'DeviceTokenNotForTopic' })).toBe(true);
    expect(isDeadToken({ status: 400, reason: 'PayloadTooLarge' })).toBe(false);
    expect(isDeadToken({ status: 403, reason: 'ExpiredProviderToken' })).toBe(false);
    expect(isDeadToken({ status: 429 })).toBe(false);
    expect(isDeadToken({ status: 0, reason: 'Timeout' })).toBe(false);
  });
});

describe('buildApnsBody', () => {
  it('met le titre et le texte dans aps.alert, et l’URL à côté', () => {
    expect(JSON.parse(buildApnsBody({ title: 'T', body: 'B', url: '/x' }))).toEqual({
      aps: { alert: { title: 'T', body: 'B' }, sound: 'default' },
      url: '/x',
    });
  });
});
