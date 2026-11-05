#!/usr/bin/env node
// server.mjs — ArakIce NHL MCP server (stdio). A thin client over the public HTTP API:
//
//   nhl_track_record          free   GET /v1/nhl/results  (fallback: record.json of the public git repository)
//   nhl_pregame_probabilities paid   GET /v1/nhl/games    (x402, USDC on Base, paid from the user's own wallet)
//
// The key never leaves this process: x402 signs a USDC transfer authorization
// locally (EIP-3009) for the exact price the server asks, within the caps below.
// The API settles only when it returns a successful response: an error is not charged.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { atomicToUsd, decodeHeader, loadConfig, paymentPolicy, refusalReason, result, SpendLedger, validDate } from './lib.mjs';

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const RECORD_FALLBACK = 'https://raw.githubusercontent.com/ireinahedad/arakice-nhl-predictions/main/record.json';
const PUBLIC_REPO = 'https://github.com/ireinahedad/arakice-nhl-predictions';

/** Builds the server. `fetchImpl` is injectable for tests. */
export function createServer(cfg = loadConfig(), { fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const ledger = new SpendLedger(cfg.maxPerDay, now);
  // x402 retries with a Request that carries PAYMENT-SIGNATURE: keep its headers, add ours underneath.
  const get = (input, init = {}) => {
    const headers = new Headers({ accept: 'application/json', 'user-agent': `arakice-nhl-mcp/${VERSION}` });
    for (const src of [input instanceof Request ? input.headers : null, init.headers]) {
      if (src) new Headers(src).forEach((v, k) => headers.set(k, v));
    }
    return fetchImpl(input, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(30_000) });
  };

  let picked = null;
  const payFetch = cfg.key
    ? wrapFetchWithPaymentFromConfig(get, {
      schemes: [{ network: cfg.network, client: new ExactEvmScheme(privateKeyToAccount(cfg.key)) }],
      policies: [paymentPolicy(cfg, ledger, (r) => { picked = r; })],
      spendControls: { maxAmountPerPayment: atomicToUsd(cfg.maxPerCall) },
    })
    : null;

  const server = new McpServer({ name: 'arakice-nhl', version: VERSION });

  server.registerTool('nhl_track_record', {
    title: 'ArakIce NHL track record',
    description: 'Free. Settled NHL games with the probability the ArakIce model published before puck drop, the final '
      + 'score, and log-loss, Brier score, accuracy and calibration. Every number is also committed to a public git '
      + 'repository before the game. No odds, no betting returns.',
    inputSchema: {
      kind: z.enum(['morning', 'pregame']).optional().describe('morning = publicly timestamped numbers (default); pregame = last update before the game'),
      limit: z.number().int().min(1).max(500).optional().describe('how many recent games to list (default 50)'),
    },
  }, async ({ kind = 'morning', limit = 50 }) => {
    try {
      const res = await get(`${cfg.api}/v1/nhl/results?kind=${kind}&limit=${limit}`);
      if (res.ok) return result(await res.json());
      throw new Error(`HTTP ${res.status}`);
    } catch (apiErr) {
      if (kind !== 'morning') return result({ error: `API unavailable (${apiErr.message})` }, true);
      try {
        const res = await get(RECORD_FALLBACK);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rec = await res.json();
        return result({ source: `${PUBLIC_REPO} (record.json; API unavailable: ${apiErr.message})`, summary: rec.summary, counts: rec.counts, games: (rec.games ?? []).slice(0, limit), disclaimer: rec.disclaimer });
      } catch (e) {
        return result({ error: `API and public record both unavailable (${apiErr.message}; ${e.message})` }, true);
      }
    }
  });

  server.registerTool('nhl_pregame_probabilities', {
    title: 'ArakIce NHL pre-game probabilities',
    description: 'Paid per call in USDC (x402), flat price per date. NHL pre-game probabilities for every game of the date '
      + 'that has not started: home win, home -1.5 and away -1.5, from a model that takes no market odds as input, '
      + 'with starting goalies when known and a timestamp. Dates: today to two days ahead (US Eastern). '
      + 'Not charged when the API returns an error.',
    inputSchema: {
      date: z.string().optional().describe('YYYY-MM-DD, US Eastern game day; default today'),
    },
  }, async ({ date }) => {
    let d;
    try { d = validDate(date); } catch (e) { return result({ error: e.message }, true); }
    const url = `${cfg.api}/v1/nhl/games${d ? `?date=${d}` : ''}`;
    if (!payFetch) {
      return result({
        error: 'Payments are not configured: set ARAKICE_BUYER_PRIVATE_KEY (a dedicated wallet holding a little USDC on Base).',
        free: `Each morning's numbers are also published free, without goalies, at ${PUBLIC_REPO}/tree/main/data`,
      }, true);
    }
    picked = null;
    let res;
    try {
      res = await payFetch(url);
    } catch (e) {
      // No acceptable requirement (caps, network, payee): explain from the 402 itself. Nothing was signed.
      try {
        const probe = await get(url);
        const pr = decodeHeader(probe.headers.get('payment-required'));
        if (probe.status === 402 && pr) return result({ error: `Not paid: ${refusalReason(cfg, ledger, pr.accepts ?? [])}.` }, true);
      } catch { /* fall through */ }
      return result({ error: `Request failed: ${e.message}` }, true);
    }
    const body = await res.json().catch(() => null);
    const receipt = decodeHeader(res.headers.get('payment-response') ?? res.headers.get('x-payment-response'));
    if (!res.ok) return result({ error: `HTTP ${res.status}`, detail: body, charged: false }, true);
    if (receipt?.success !== false && picked) ledger.record(picked.amount);
    return result({
      ...body,
      payment: picked ? {
        amount: atomicToUsd(picked.amount),
        network: picked.network,
        transaction: receipt?.transaction ?? null,
        spentTodayInThisSession: atomicToUsd(ledger.spentToday()),
        dailyLimit: atomicToUsd(cfg.maxPerDay),
      } : null,
    });
  });

  return server;
}
