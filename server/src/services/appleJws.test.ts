import { describe, expect, it } from 'vitest';
import { X509Certificate, createPrivateKey, sign } from 'node:crypto';
import {
  APPLE_ROOT_CA_G3_SHA256, AppleJwsError, AppleTransaction, entitlementFromApple, verifyAppleJws,
} from './appleJws';
import { TEST_INTERMEDIATE, TEST_LEAF, TEST_LEAF_KEY, TEST_PLAIN_LEAF, TEST_ROOT } from './__fixtures__/appleTestChain';

const ROOT_FP = new X509Certificate(Buffer.from(TEST_ROOT, 'base64')).fingerprint256;
const key = createPrivateKey(TEST_LEAF_KEY);
const opts = { rootFingerprint: ROOT_FP };

function jws(payload: object, x5c = [TEST_LEAF, TEST_INTERMEDIATE, TEST_ROOT], alg = 'ES256'): string {
  const h = Buffer.from(JSON.stringify({ alg, x5c })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const s = sign('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${h}.${p}.${s}`;
}

const NOW = Date.now();
const DAY = 86_400_000;
const tx = (over: Partial<AppleTransaction> = {}): AppleTransaction => ({
  transactionId: '2000000001', originalTransactionId: '2000000000', bundleId: 'com.arakice.arakice',
  productId: 'com.arakice.arakice.pro.monthly', type: 'Auto-Renewable Subscription',
  purchaseDate: NOW - DAY, expiresDate: NOW + 29 * DAY, environment: 'Sandbox', signedDate: NOW, ...over,
});

describe('verifyAppleJws', () => {
  it('accepte une chaîne complète signée par la feuille', () => {
    const out = verifyAppleJws<AppleTransaction>(jws(tx()), opts);
    expect(out.productId).toBe('com.arakice.arakice.pro.monthly');
  });

  it('épingle la vraie racine Apple par défaut : la chaîne de test est refusée', () => {
    expect(APPLE_ROOT_CA_G3_SHA256).toMatch(/^63:34:3A:BF/);
    expect(() => verifyAppleJws(jws(tx()))).toThrow(/racine inconnue/);
  });

  it('refuse un contenu modifié après signature', () => {
    const [h, , s] = jws(tx()).split('.');
    const forged = Buffer.from(JSON.stringify(tx({ expiresDate: NOW + 3650 * DAY }))).toString('base64url');
    expect(() => verifyAppleJws(`${h}.${forged}.${s}`, opts)).toThrow(/signature/);
  });

  it('refuse une feuille sans le marqueur Apple, même bien chaînée', () => {
    expect(() => verifyAppleJws(jws(tx(), [TEST_PLAIN_LEAF, TEST_INTERMEDIATE, TEST_ROOT]), opts)).toThrow(/marqueur/);
  });

  it('refuse une chaîne dans le désordre ou incomplète', () => {
    expect(() => verifyAppleJws(jws(tx(), [TEST_LEAF, TEST_ROOT]), opts)).toThrow(/chaîne rompue/);
    expect(() => verifyAppleJws(jws(tx(), [TEST_LEAF]), opts)).toThrow(/x5c/);
  });

  it('refuse un autre algorithme et un format invalide', () => {
    expect(() => verifyAppleJws(jws(tx(), undefined, 'none'), opts)).toThrow(/algorithme/);
    expect(() => verifyAppleJws('abc.def', opts)).toThrow(AppleJwsError);
  });

  it('refuse une signature datée hors de la validité des certificats', () => {
    expect(() => verifyAppleJws(jws(tx({ signedDate: Date.UTC(2001, 0, 1) })), opts)).toThrow(/validité/);
  });
});

describe('entitlementFromApple', () => {
  it('période payée en cours → Pro actif', () => {
    expect(entitlementFromApple(tx(), null, NOW)).toMatchObject({ plan: 'pro', status: 'active', cancelAtPeriodEnd: false });
  });

  it("offre d'introduction → trialing", () => {
    expect(entitlementFromApple(tx({ offerType: 1 }), null, NOW).status).toBe('trialing');
  });

  it('renouvellement automatique coupé → Pro jusqu’à la fin, annulation annoncée', () => {
    const e = entitlementFromApple(tx(), { originalTransactionId: '2000000000', autoRenewStatus: 0, signedDate: NOW }, NOW);
    expect(e).toMatchObject({ plan: 'pro', cancelAtPeriodEnd: true });
  });

  it('expiré → gratuit ; en relance de facturation → past_due', () => {
    expect(entitlementFromApple(tx({ expiresDate: NOW - 1 }), null, NOW)).toMatchObject({ plan: 'free', status: 'canceled' });
    const retry = { originalTransactionId: '2000000000', autoRenewStatus: 1 as const, isInBillingRetryPeriod: true, signedDate: NOW };
    expect(entitlementFromApple(tx({ expiresDate: NOW - 1 }), retry, NOW)).toMatchObject({ plan: 'free', status: 'past_due' });
  });

  it('période de grâce → Pro jusqu’à la fin de la grâce', () => {
    const grace = { originalTransactionId: '2000000000', autoRenewStatus: 1 as const, isInBillingRetryPeriod: true, gracePeriodExpiresDate: NOW + 3 * DAY, signedDate: NOW };
    const e = entitlementFromApple(tx({ expiresDate: NOW - 1 }), grace, NOW);
    expect(e.plan).toBe('pro');
    expect(e.status).toBe('active');
    expect(e.currentPeriodEnd?.getTime()).toBe(NOW + 3 * DAY);
  });

  it('remboursé → gratuit immédiatement, même si la période courait encore', () => {
    expect(entitlementFromApple(tx({ revocationDate: NOW - 1000 }), null, NOW)).toMatchObject({ plan: 'free', status: 'canceled' });
  });
});
