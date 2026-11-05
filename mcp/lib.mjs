// lib.mjs — pure parts of the ArakIce MCP server: configuration, spend limits,
// payment policy, response shaping. No network, no key handling beyond validation.

export const MAINNET = 'eip155:8453';
export const TESTNET = 'eip155:84532';
/** USDC has 6 decimals on Base and Base Sepolia. */
const USDC_DECIMALS = 6;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/** "$0.25" or "0.25" → atomic USDC units (bigint). Throws on anything else. */
export function usdToAtomic(v) {
  const m = String(v ?? '').trim().replace(/^\$/, '').match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!m) throw new Error(`not a USD amount: ${v}`);
  return BigInt(m[1]) * 10n ** BigInt(USDC_DECIMALS) + BigInt((m[2] ?? '').padEnd(USDC_DECIMALS, '0'));
}
export const atomicToUsd = (a) => `$${(Number(a) / 10 ** USDC_DECIMALS).toFixed(USDC_DECIMALS).replace(/0{1,4}$/, '')}`;

/**
 * Configuration from the environment. The buyer key is optional: without it the
 * free tool works and the paid tool explains how to enable payments.
 */
export function loadConfig(env = process.env) {
  const api = String(env.ARAKICE_API ?? 'https://agents.arakice.com').trim().replace(/\/$/, '');
  if (!/^https:\/\//.test(api) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(api)) {
    throw new Error('ARAKICE_API must be https:// (http only for localhost)');
  }
  const network = String(env.ARAKICE_NETWORK ?? MAINNET).trim();
  if (network !== MAINNET && network !== TESTNET) throw new Error(`ARAKICE_NETWORK must be ${MAINNET} or ${TESTNET}`);
  const key = String(env.ARAKICE_BUYER_PRIVATE_KEY ?? '').trim();
  if (key && !KEY_RE.test(key)) throw new Error('ARAKICE_BUYER_PRIVATE_KEY must be 0x followed by 64 hex characters');
  const payTo = String(env.ARAKICE_PAY_TO ?? '').trim();
  if (payTo && !/^0x[0-9a-fA-F]{40}$/.test(payTo)) throw new Error('ARAKICE_PAY_TO must be a 0x address');
  const maxPerCall = usdToAtomic(env.ARAKICE_MAX_PER_CALL_USD ?? '0.25');
  const maxPerDay = usdToAtomic(env.ARAKICE_MAX_PER_DAY_USD ?? '1.00');
  if (maxPerCall > maxPerDay) throw new Error('ARAKICE_MAX_PER_CALL_USD is above ARAKICE_MAX_PER_DAY_USD');
  return { api, network, key: key || null, payTo: payTo ? payTo.toLowerCase() : null, maxPerCall, maxPerDay };
}

/** In-memory daily budget (UTC day). Restarting the server resets it: the per-call cap still holds. */
export class SpendLedger {
  constructor(maxPerDay, now = () => Date.now()) { this.maxPerDay = maxPerDay; this.now = now; this.day = null; this.spent = 0n; }
  #roll() { const d = new Date(this.now()).toISOString().slice(0, 10); if (d !== this.day) { this.day = d; this.spent = 0n; } }
  remaining() { this.#roll(); return this.maxPerDay - this.spent; }
  record(amount) { this.#roll(); this.spent += BigInt(amount); }
  spentToday() { this.#roll(); return this.spent; }
}

/**
 * x402 payment policy: keeps only requirements on the configured network, USDC
 * `exact`, at or under the per-call cap and the day's remaining budget, and (if
 * pinned) paying the expected address. An empty result means nothing is signed.
 * `onPick` receives the first requirement left, to record the spend after success.
 */
export function paymentPolicy(cfg, ledger, onPick) {
  return (_version, reqs) => {
    const ok = reqs.filter((r) => r.scheme === 'exact'
      && r.network === cfg.network
      && /^\d+$/.test(String(r.amount ?? ''))
      && BigInt(r.amount) <= cfg.maxPerCall
      && BigInt(r.amount) <= ledger.remaining()
      && (!cfg.payTo || String(r.payTo).toLowerCase() === cfg.payTo));
    if (ok[0]) onPick(ok[0]);
    return ok;
  };
}

/** Why a 402 could not be paid, in plain words (for the tool result). */
export function refusalReason(cfg, ledger, reqs) {
  const r = reqs.find((x) => x.network === cfg.network) ?? reqs[0];
  if (!r) return 'the server offered no payment option';
  if (r.network !== cfg.network) return `the server asks for ${r.network}, this client is set to ${cfg.network}`;
  const amount = BigInt(r.amount ?? 0);
  if (amount > cfg.maxPerCall) return `price ${atomicToUsd(amount)} is above ARAKICE_MAX_PER_CALL_USD (${atomicToUsd(cfg.maxPerCall)})`;
  if (amount > ledger.remaining()) return `daily budget reached (${atomicToUsd(ledger.spentToday())} of ${atomicToUsd(cfg.maxPerDay)} spent today)`;
  if (cfg.payTo && String(r.payTo).toLowerCase() !== cfg.payTo) return `the server asks to pay ${r.payTo}, not the pinned ARAKICE_PAY_TO`;
  return 'payment requirements not accepted';
}

export function validDate(d) {
  if (d == null) return null;
  if (!DATE_RE.test(d) || Number.isNaN(Date.parse(`${d}T12:00:00Z`))) throw new Error('date must be YYYY-MM-DD');
  return d;
}

export const decodeHeader = (h) => { try { return h ? JSON.parse(Buffer.from(h, 'base64').toString('utf8')) : null; } catch { return null; } };

/** MCP tool result: JSON text, plus `isError` when it failed. */
export const result = (obj, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], ...(isError ? { isError: true } : {}) });
