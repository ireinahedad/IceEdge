import { describe, it, expect } from 'vitest';
import { parse } from 'pg-connection-string';
import { pinSslMode } from './pgUrl';

const NEON = 'postgresql://u:p%40ss@ep-x-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

describe('pinSslMode', () => {
  it('rewrites require / prefer / verify-ca to verify-full', () => {
    for (const mode of ['require', 'prefer', 'verify-ca']) {
      const out = pinSslMode(`postgres://u:p@h/db?sslmode=${mode}`)!;
      expect(new URL(out).searchParams.get('sslmode')).toBe('verify-full');
    }
  });

  it('keeps the rest of a Neon URL intact (password encoding, channel_binding, host)', () => {
    const out = pinSslMode(NEON)!;
    const u = new URL(out);
    expect(u.hostname).toBe('ep-x-pooler.us-east-1.aws.neon.tech');
    expect(decodeURIComponent(u.password)).toBe('p@ss');
    expect(u.searchParams.get('channel_binding')).toBe('require');
    expect(u.searchParams.get('sslmode')).toBe('verify-full');
  });

  it('gives pg the same ssl config as before (certificate checked)', () => {
    const before = parse(NEON) as any;
    const after = parse(pinSslMode(NEON)!) as any;
    expect(after.ssl).toEqual(before.ssl);
    expect(after.password).toBe(before.password);
    expect(after.database).toBe(before.database);
  });

  it('leaves other URLs alone', () => {
    const cases = [
      undefined,
      '',
      'postgres://u:p@localhost/db',
      'postgres://u:p@h/db?sslmode=disable',
      'postgres://u:p@h/db?sslmode=verify-full',
      'postgres://u:p@h/db?sslmode=require&uselibpqcompat=true',
      'not a url',
    ];
    for (const c of cases) expect(pinSslMode(c)).toBe(c);
  });
});
