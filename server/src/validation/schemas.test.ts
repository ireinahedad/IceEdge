import { describe, it, expect } from 'vitest';
import { registerSchema, loginSchema, avatarSchema, slipSubmitSchema, ruleWeightsSchema, profileUpdateSchema } from './schemas';

describe('registerSchema', () => {
  it('rejects passwords under 8 chars', () => {
    const r = registerSchema.safeParse({ email: 'a@b.co', username: 'abc', password: 'short' });
    expect(r.success).toBe(false);
  });

  it('rejects usernames with invalid characters', () => {
    const r = registerSchema.safeParse({ email: 'a@b.co', username: 'bad name!', password: 'longenough' });
    expect(r.success).toBe(false);
  });

  it('normalises email (trim + lowercase)', () => {
    const r = registerSchema.safeParse({ email: '  A@B.CO ', username: 'abc', password: 'longenough' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe('a@b.co');
  });
});

describe('loginSchema', () => {
  it('accepts an optional remember flag', () => {
    expect(loginSchema.safeParse({ email: 'a@b.co', password: 'x', remember: true }).success).toBe(true);
  });
});

describe('avatarSchema', () => {
  it('rejects a non data-URI', () => {
    expect(avatarSchema.safeParse({ avatarDataUrl: 'http://x/y.png' }).success).toBe(false);
  });
  it('rejects oversized images', () => {
    const huge = 'data:image/png;base64,' + 'A'.repeat(2_900_000);
    expect(avatarSchema.safeParse({ avatarDataUrl: huge }).success).toBe(false);
  });
});

describe('slipSubmitSchema', () => {
  it('requires at least one leg', () => {
    expect(slipSubmitSchema.safeParse({ legs: [] }).success).toBe(false);
  });
  it('rejects more than 30 legs', () => {
    expect(slipSubmitSchema.safeParse({ legs: Array(31).fill({ a: 1 }) }).success).toBe(false);
  });
  it('accepts a bounded slip with a percentage probability', () => {
    expect(slipSubmitSchema.safeParse({ legs: [{ a: 1 }], sport: 'hockey', combinedProbability: 45 }).success).toBe(true);
  });
});

describe('ruleWeightsSchema', () => {
  it('accepts the shape the client actually stores', () => {
    const r = ruleWeightsSchema.safeParse({
      match:  { quality: 40, homeIce: 20, fatigue: 15, odds: 25 },
      totals: { expectedTotal: 60, shotPace: 40 },
    });
    expect(r.success).toBe(true);
  });

  it('accepts an empty store (aucun réglage)', () => {
    expect(ruleWeightsSchema.safeParse({}).success).toBe(true);
  });

  it('rejects a flat map — ce n_est pas la forme du store', () => {
    expect(ruleWeightsSchema.safeParse({ quality: 40 }).success).toBe(false);
  });

  it('rejects weights outside 0-100', () => {
    expect(ruleWeightsSchema.safeParse({ match: { quality: 101 } }).success).toBe(false);
    expect(ruleWeightsSchema.safeParse({ match: { quality: -1 } }).success).toBe(false);
  });

  it('rejects unbounded payloads (familles, facteurs, longueur de clé)', () => {
    const families = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, { a: 1 }]));
    expect(ruleWeightsSchema.safeParse(families).success).toBe(false);

    const factors = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`f${i}`, 1]));
    expect(ruleWeightsSchema.safeParse({ match: factors }).success).toBe(false);

    expect(ruleWeightsSchema.safeParse({ ['x'.repeat(33)]: { a: 1 } }).success).toBe(false);
    expect(ruleWeightsSchema.safeParse({ match: { ['y'.repeat(41)]: 1 } }).success).toBe(false);
  });

  it('rejects reserved keys', () => {
    expect(ruleWeightsSchema.safeParse({ ['__proto__']: { quality: 1 } }).success).toBe(false);
    expect(ruleWeightsSchema.safeParse({ match: { ['__proto__']: 1 } }).success).toBe(false);
  });

  it('rejects non-numeric weights', () => {
    expect(ruleWeightsSchema.safeParse({ match: { quality: '40' } }).success).toBe(false);
    expect(ruleWeightsSchema.safeParse({ match: { quality: NaN } }).success).toBe(false);
  });
});

describe('profileUpdateSchema', () => {
  it('accepte ce que l’écran Paramètres envoie réellement', () => {
    const r = profileUpdateSchema.safeParse({
      username: 'ireina',
      displayName: 'Ireina',
      bio: 'Fan des Bruins',
      favoriteTeam: 'BOS',
      isPublic: true,
      showSlips: false,
      notifyValueBets: true,
      valueBetMinEvPct: 3,
      openaiApiKey: null,
    });
    expect(r.success).toBe(true);
  });

  it('retire les clés inconnues au lieu de les laisser filer jusqu’au service', () => {
    const r = profileUpdateSchema.safeParse({ bio: 'ok', tier: 'legend', performanceScore: 9999 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ bio: 'ok' });
  });

  it('refuse les champs texte démesurés — c’est tout l’objet du schéma', () => {
    // Colonnes `TEXT` : sans borne ici, ces 100 ko partaient en base et
    // revenaient dans CHAQUE lecture de profil.
    expect(profileUpdateSchema.safeParse({ bio: 'x'.repeat(100_000) }).success).toBe(false);
    expect(profileUpdateSchema.safeParse({ displayName: 'x'.repeat(500) }).success).toBe(false);
    expect(profileUpdateSchema.safeParse({ openaiApiKey: 'x'.repeat(5_000) }).success).toBe(false);
  });

  it('refuse un type qui ne correspond pas', () => {
    expect(profileUpdateSchema.safeParse({ isPublic: 'oui' }).success).toBe(false);
    expect(profileUpdateSchema.safeParse({ valueBetMinEvPct: 'beaucoup' }).success).toBe(false);
    expect(profileUpdateSchema.safeParse({ ruleWeights: { match: { quality: 101 } } }).success).toBe(false);
  });

  it('laisse passer `null` là où le client efface une valeur', () => {
    expect(profileUpdateSchema.safeParse({ openaiApiKey: null }).success).toBe(true);
    expect(profileUpdateSchema.safeParse({ avatarUrl: null }).success).toBe(true);
    expect(profileUpdateSchema.safeParse({ ruleWeights: null }).success).toBe(true);
  });

  it('garde `username` large — la vraie règle vit dans le service', () => {
    // Le service tranche 3-20 minuscules AVEC le contrôle d'unicité et le
    // message affiché par l'UI ; dupliquer la règle ici la ferait diverger.
    expect(profileUpdateSchema.safeParse({ username: 'Deux Mots' }).success).toBe(true);
  });
});
