// node --test   — unit tests (lib.mjs) and an end-to-end run: a real MCP client talks to the
// server over an in-memory transport; a fake API answers 402, then checks the signed x402
// payment (EIP-3009 authorization) before serving the body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { privateKeyToAccount } from 'viem/accounts';
import { createServer } from './server.mjs';
import { atomicToUsd, loadConfig, paymentPolicy, refusalReason, SpendLedger, usdToAtomic, validDate, MAINNET, TESTNET } from './lib.mjs';

const KEY = '0x' + '11'.repeat(32);
const BUYER = privateKeyToAccount(KEY).address;
const PAY_TO = '0x51978CeE549f17039d4450784db846f2A7521C87';
const API = 'https://agents.arakice.com';

test('usd ↔ atomic USDC', () => {
  assert.equal(usdToAtomic('$0.10'), 100000n);
  assert.equal(usdToAtomic('1'), 1000000n);
  assert.equal(usdToAtomic('0.000001'), 1n);
  assert.throws(() => usdToAtomic('0.0000001'));
  assert.throws(() => usdToAtomic('-1'));
  assert.equal(atomicToUsd(100000n), '$0.10');
  assert.equal(atomicToUsd(1000000n), '$1.00');
});

test('loadConfig: safe defaults and refusals', () => {
  const c = loadConfig({});
  assert.deepEqual([c.api, c.network, c.key, c.maxPerCall, c.maxPerDay], [API, MAINNET, null, 250000n, 1000000n]);
  assert.throws(() => loadConfig({ ARAKICE_API: 'http://evil.example' }), /https/);
  assert.equal(loadConfig({ ARAKICE_API: 'http://localhost:4000' }).api, 'http://localhost:4000');
  assert.throws(() => loadConfig({ ARAKICE_NETWORK: 'eip155:1' }), /NETWORK/);
  assert.throws(() => loadConfig({ ARAKICE_BUYER_PRIVATE_KEY: '0x123' }), /PRIVATE_KEY/);
  assert.throws(() => loadConfig({ ARAKICE_MAX_PER_CALL_USD: '5', ARAKICE_MAX_PER_DAY_USD: '1' }), /above/);
});

test('SpendLedger resets at UTC midnight', () => {
  let t = Date.parse('2026-11-04T23:59:00Z');
  const l = new SpendLedger(1000000n, () => t);
  l.record(400000n);
  assert.equal(l.remaining(), 600000n);
  t = Date.parse('2026-11-05T00:01:00Z');
  assert.equal(l.remaining(), 1000000n);
});

const req = (over = {}) => ({ scheme: 'exact', network: TESTNET, amount: '100000', payTo: PAY_TO, asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' }, ...over });

test('paymentPolicy: network, per-call cap, daily budget, pinned payee', () => {
  const cfg = loadConfig({ ARAKICE_NETWORK: TESTNET, ARAKICE_MAX_PER_CALL_USD: '0.20', ARAKICE_MAX_PER_DAY_USD: '0.30', ARAKICE_PAY_TO: PAY_TO });
  const ledger = new SpendLedger(cfg.maxPerDay);
  let picked = null;
  const pol = paymentPolicy(cfg, ledger, (r) => { picked = r; });
  assert.equal(pol(2, [req()]).length, 1);
  assert.equal(picked.amount, '100000');
  assert.equal(pol(2, [req({ network: MAINNET })]).length, 0);
  assert.equal(pol(2, [req({ amount: '250000' })]).length, 0);
  assert.equal(pol(2, [req({ payTo: '0x' + '22'.repeat(20) })]).length, 0);
  ledger.record(250000n);
  assert.equal(pol(2, [req()]).length, 0); // 0.25 spent, 0.10 > remaining 0.05
  assert.match(refusalReason(cfg, ledger, [req()]), /daily budget/);
  assert.match(refusalReason(cfg, new SpendLedger(cfg.maxPerDay), [req({ amount: '250000' })]), /above ARAKICE_MAX_PER_CALL_USD/);
  assert.match(refusalReason(cfg, new SpendLedger(cfg.maxPerDay), [req({ network: MAINNET })]), /asks for eip155:8453/);
});

test('validDate', () => {
  assert.equal(validDate(undefined), null);
  assert.equal(validDate('2026-11-04'), '2026-11-04');
  assert.throws(() => validDate('11/04/2026'));
});

// ── End to end ──────────────────────────────────────────────────────────────
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
const GAMES = { date: '2026-11-04', games: [{ gameId: '2026020247', home: 'TOR', away: 'MTL', probabilities: { homeWin: 0.57 } }], disclaimer: 'Model estimate.' };

function fakeApi({ price = '100000', status = 200 } = {}) {
  const calls = { paid: 0, unpaid: 0, payloads: [] };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const headers = new Headers(init.headers ?? (typeof input === 'string' ? undefined : input.headers));
    if (url.pathname === '/v1/nhl/results') return new Response(JSON.stringify({ kind: 'morning', summary: { games: 2 } }), { status: 200 });
    if (url.pathname !== '/v1/nhl/games') return new Response('{}', { status: 404 });
    const sig = headers.get('payment-signature');
    if (!sig) {
      calls.unpaid++;
      const pr = { x402Version: 2, error: 'Payment required', resource: { url: url.href, description: 'games', mimeType: 'application/json' }, accepts: [req({ amount: price })] };
      return new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': b64(pr) } });
    }
    calls.paid++;
    const p = unb64(sig);
    calls.payloads.push(p);
    if (status !== 200) return new Response(JSON.stringify({ error: 'down' }), { status });
    return new Response(JSON.stringify(GAMES), { status: 200, headers: { 'PAYMENT-RESPONSE': b64({ success: true, transaction: '0x' + 'ab'.repeat(32), network: TESTNET, payer: BUYER }) } });
  };
  return { calls, fetchImpl };
}

async function connect(env, api) {
  const server = createServer(loadConfig(env), { fetchImpl: api.fetchImpl });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const parse = (r) => JSON.parse(r.content[0].text);
const ENV = { ARAKICE_NETWORK: TESTNET, ARAKICE_BUYER_PRIVATE_KEY: KEY, ARAKICE_MAX_PER_CALL_USD: '0.20', ARAKICE_MAX_PER_DAY_USD: '0.30' };

test('e2e: tools listed, free record, paid call signs the exact price to the payee', async () => {
  const api = fakeApi();
  const client = await connect(ENV, api);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['nhl_pregame_probabilities', 'nhl_track_record']);
  for (const t of (await client.listTools()).tools) assert.doesNotMatch(t.description, /profit|guarantee|beat the market|iceedge/i);

  assert.equal(parse(await client.callTool({ name: 'nhl_track_record', arguments: {} })).summary.games, 2);

  const r = await client.callTool({ name: 'nhl_pregame_probabilities', arguments: { date: '2026-11-04' } });
  assert.ok(!r.isError, r.content[0].text);
  const out = parse(r);
  assert.equal(out.games[0].home, 'TOR');
  assert.equal(out.payment.amount, '$0.10');
  assert.equal(out.payment.spentTodayInThisSession, '$0.10');
  const auth = api.calls.payloads[0].payload.authorization;
  assert.equal(auth.value, '100000');
  assert.equal(auth.to.toLowerCase(), PAY_TO.toLowerCase());
  assert.equal(auth.from.toLowerCase(), BUYER.toLowerCase());
});

test('e2e: over the per-call cap → nothing signed, clear reason', async () => {
  const api = fakeApi({ price: '500000' });
  const client = await connect(ENV, api);
  const r = await client.callTool({ name: 'nhl_pregame_probabilities', arguments: {} });
  assert.ok(r.isError);
  assert.match(parse(r).error, /above ARAKICE_MAX_PER_CALL_USD/);
  assert.equal(api.calls.paid, 0);
});

test('e2e: daily budget stops the third call', async () => {
  const api = fakeApi();
  const client = await connect(ENV, api);
  for (let i = 0; i < 3; i++) await client.callTool({ name: 'nhl_pregame_probabilities', arguments: {} });
  const r = await client.callTool({ name: 'nhl_pregame_probabilities', arguments: {} });
  assert.equal(api.calls.paid, 3); // 0.10 × 3 = 0.30 = the daily limit
  assert.match(parse(r).error, /daily budget/);
});

test('e2e: API error is reported as not charged and not counted', async () => {
  const api = fakeApi({ status: 503 });
  const client = await connect(ENV, api);
  const r = await client.callTool({ name: 'nhl_pregame_probabilities', arguments: {} });
  assert.ok(r.isError);
  assert.equal(parse(r).charged, false);
  const r2 = await client.callTool({ name: 'nhl_pregame_probabilities', arguments: {} });
  assert.equal(api.calls.paid, 2); // budget untouched by the failed call
  assert.ok(r2.isError);
});

test('e2e: without a key, the paid tool explains and points to the free data', async () => {
  const api = fakeApi();
  const client = await connect({ ARAKICE_NETWORK: TESTNET }, api);
  const r = await client.callTool({ name: 'nhl_pregame_probabilities', arguments: {} });
  assert.ok(r.isError);
  assert.match(parse(r).error, /ARAKICE_BUYER_PRIVATE_KEY/);
  assert.equal(api.calls.unpaid + api.calls.paid, 0);
});
