/**
 * x402-measure.ts — la décision à 60 jours, mesurée sur la chaîne (X402_PLAN.md, phase 5).
 *
 *   npm run x402:measure                                     # Base, 60 derniers jours
 *   npm run x402:measure -- --since=2026-12-01 --json
 *   npm run x402:measure -- --network=base-sepolia           # testnet
 *
 *   X402_PAY_TO           portefeuille vendeur (ou --pay-to=0x…)
 *   X402_OWNER_WALLETS    portefeuilles d'Ireina à exclure, séparés par des virgules (ou --exclude=…)
 *   X402_MEASURE_RPC      RPC Base (défaut : RPC public, lent mais gratuit)
 *
 * Lit les événements USDC `Transfer` vers le portefeuille vendeur, puis, pour chaque
 * transaction, vérifie la présence de `AuthorizationUsed` (EIP-3009) : c'est la
 * signature d'un paiement x402. Aucune clé, aucune écriture. Les requêtes 402 ne
 * laissent aucune trace sur la chaîne : elles ne comptent pas, comme le veut le plan.
 */

import { analyze, type Payment } from '../src/services/x402/measure';

const NETWORKS = {
  base: { usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', rpc: 'https://mainnet.base.org' },
  'base-sepolia': { usdc: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', rpc: 'https://sepolia.base.org' },
} as const;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const AUTHORIZATION_USED = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5';
const BLOCK_SECONDS = 2; // Base : un bloc toutes les 2 s (estimation du bloc de départ, corrigée par l'horodatage)

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--'))
  .map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || 'true']; }));
const fail = (m: string): never => { console.error(`✗ ${m}`); process.exit(1); };

const netName = String(args.network ?? 'base') as keyof typeof NETWORKS;
const net = NETWORKS[netName] ?? fail(`--network=base|base-sepolia`);
const rpc = String(args.rpc ?? process.env.X402_MEASURE_RPC ?? net.rpc);
const payTo = String(args['pay-to'] ?? process.env.X402_PAY_TO ?? '').toLowerCase();
if (!/^0x[0-9a-f]{40}$/.test(payTo)) fail('X402_PAY_TO (ou --pay-to=0x…) requis');
const exclude = String(args.exclude ?? process.env.X402_OWNER_WALLETS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
for (const a of exclude) if (!/^0x[0-9a-f]{40}$/.test(a)) fail(`adresse à exclure invalide : ${a}`);
const sinceMs = args.since ? Date.parse(`${args.since}T00:00:00Z`) : Date.now() - 60 * 86_400_000;
if (!Number.isFinite(sinceMs)) fail('--since=AAAA-MM-JJ');

let id = 0;
async function call<T>(method: string, params: unknown[], attempt = 0): Promise<T> {
  const res = await fetch(rpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { message: e.message } }) }) as any);
  const body: any = await res.json().catch(() => ({}));
  if (res.ok && !body.error) return body.result as T;
  const msg = body.error?.message ?? `HTTP ${res.status}`;
  if (attempt < 4 && (res.status === 429 || res.status >= 500 || /rate|limit|timeout/i.test(msg))) {
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    return call(method, params, attempt + 1);
  }
  throw new Error(`${method}: ${msg}`);
}
const hex = (n: number) => `0x${n.toString(16)}`;
const topicAddr = (a: string) => `0x${a.slice(2).padStart(64, '0')}`;
const addrFromTopic = (t: string) => `0x${t.slice(26)}`.toLowerCase();

const blockTime = new Map<number, number>();
async function timeOf(block: number) {
  if (!blockTime.has(block)) {
    const b = await call<{ timestamp: string }>('eth_getBlockByNumber', [hex(block), false]);
    blockTime.set(block, Number(BigInt(b.timestamp)) * 1000);
  }
  return blockTime.get(block)!;
}

async function main() {
  const latest = Number(BigInt(await call<string>('eth_blockNumber', [])));
  const latestMs = await timeOf(latest);
  let from = Math.max(0, latest - Math.ceil((latestMs - sinceMs) / 1000 / BLOCK_SECONDS) - 3600);

  // getLogs par tranches ; une tranche refusée (trop de blocs) est coupée en deux.
  const logs: any[] = [];
  // `ceiling` retient la plus petite tranche refusée : on ne la retente plus.
  let step = 10_000, ceiling = Infinity;
  while (from <= latest) {
    const to = Math.min(latest, from + step - 1);
    try {
      logs.push(...await call<any[]>('eth_getLogs', [{ address: net.usdc, fromBlock: hex(from), toBlock: hex(to), topics: [TRANSFER, null, topicAddr(payTo)] }]));
      from = to + 1;
    } catch (e: any) {
      if (step <= 50) throw e;
      ceiling = Math.min(ceiling, step);
      step = Math.floor(step / 2);
      continue;
    }
    if (step * 2 < ceiling) step *= 2;
  }

  const payments: Payment[] = [];
  for (const l of logs) {
    const block = Number(BigInt(l.blockNumber));
    const timeMs = await timeOf(block);
    if (timeMs < sinceMs) continue;
    const payer = addrFromTopic(l.topics[1]);
    const receipt = await call<any>('eth_getTransactionReceipt', [l.transactionHash]);
    const x402 = (receipt?.logs ?? []).some((r: any) => String(r.address).toLowerCase() === net.usdc
      && r.topics?.[0] === AUTHORIZATION_USED && addrFromTopic(r.topics[1]) === payer);
    payments.push({ tx: l.transactionHash, block, timeMs, from: payer, amount: BigInt(l.data), x402 });
  }

  const report = analyze(payments, { exclude, nowMs: Date.now() });
  if (args.json) { console.log(JSON.stringify({ network: netName, payTo, since: new Date(sinceMs).toISOString(), excludedWallets: exclude, ...report }, null, 2)); return; }

  console.log(`ArakIce x402 — ${netName}, vendeur ${payTo}, depuis ${new Date(sinceMs).toISOString().slice(0, 10)}`);
  console.log(`Portefeuilles exclus : ${exclude.length ? exclude.join(', ') : 'AUCUN (régler X402_OWNER_WALLETS)'}\n`);
  console.log(`Paiements x402 extérieurs : ${report.totals.payments}, ${report.totals.usd} $, ${report.totals.payers} payeur(s) `
    + `(${report.totals.byKind.returning} revien(nen)t, ${report.totals.byKind.checker} contrôleur(s), ${report.totals.byKind.single} une fois)`);
  console.log(`Exclus (Ireina) : ${report.excluded.payments} paiement(s), ${report.excluded.usd} $`);
  if (report.nonX402Transfers.length) console.log(`Virements USDC hors x402 (non comptés) : ${report.nonX402Transfers.length}`);
  console.log('\nSemaine (lundi)   Paiements  Payeurs      $');
  for (const w of report.weeks) console.log(`${w.weekStart}        ${String(w.payments).padStart(6)}  ${String(w.payers).padStart(7)}  ${w.usd.toFixed(2).padStart(6)}`);
  console.log(`Moyenne : ${report.avgWeekUsd} $/semaine\n`);
  if (report.payers.length) {
    console.log('Payeur                                       Type        Paiem.  Jours      $   Écart médian');
    for (const p of report.payers.slice(0, 20)) {
      console.log(`${p.address}  ${p.kind.padEnd(10)} ${String(p.payments).padStart(6)} ${String(p.activeDays).padStart(6)} ${p.usd.toFixed(2).padStart(6)}   ${p.medianIntervalHours == null ? '—' : `${p.medianIntervalHours} h`}`);
    }
  }
  console.log(`\nDécision (tableau du plan) : ${report.verdict} — ${report.reason}`);
  console.log(report.note);
}

main().catch((e) => fail(e.message));
