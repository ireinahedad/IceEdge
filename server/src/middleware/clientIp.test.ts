import { describe, it, expect, afterEach } from 'vitest';
import { clientIp } from './clientIp';

const req = (headers: Record<string, string>, ip = '172.70.1.1') => ({ headers, ip } as any);

describe('clientIp', () => {
  afterEach(() => { delete process.env.TRUST_CF_CONNECTING_IP; });

  it('ignore CF-Connecting-IP tant que le drapeau n’est pas posé (en-tête forgeable)', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '1.2.3.4' }))).toBe('172.70.1.1');
  });

  it('lit CF-Connecting-IP derrière Cloudflare', () => {
    process.env.TRUST_CF_CONNECTING_IP = 'true';
    expect(clientIp(req({ 'cf-connecting-ip': '203.0.113.7' }))).toBe('203.0.113.7');
    expect(clientIp(req({ 'cf-connecting-ip': '2001:db8::1' }))).toBe('2001:db8::1');
  });

  it('refuse une valeur qui n’est pas une adresse, et retombe sur req.ip', () => {
    process.env.TRUST_CF_CONNECTING_IP = 'true';
    expect(clientIp(req({ 'cf-connecting-ip': 'u:admin' }))).toBe('172.70.1.1');
    expect(clientIp(req({}))).toBe('172.70.1.1');
  });
});
