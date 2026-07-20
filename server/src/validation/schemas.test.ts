import { describe, it, expect } from 'vitest';
import { registerSchema, loginSchema, avatarSchema, slipSubmitSchema } from './schemas';

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
