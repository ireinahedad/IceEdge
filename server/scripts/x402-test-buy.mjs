#!/usr/bin/env node
// x402-test-buy.mjs — un agent acheteur de TEST (X402_PLAN.md, phase 2).
//
// Découvre la route, paie en USDC de test sur Base Sepolia, vérifie la réponse
// contre le schéma annoncé, puis rejoue le MÊME paiement pour vérifier qu'il est
// refusé. Testnet SEULEMENT : refuse tout autre réseau.
//
//   BUYER_PRIVATE_KEY=0x…   clé d'un portefeuille JETABLE de test (jamais le vendeur,
//                           jamais un portefeuille avec de vrais fonds)
//   node scripts/x402-test-buy.mjs https://agents.arakice.com [AAAA-MM-JJ]
//
// Le portefeuille acheteur a besoin d'USDC de test Base Sepolia (faucet Circle :
// https://faucet.circle.com, réseau « Base Sepolia »). Pas besoin d'ETH : le
// facilitateur paie le gaz.

import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';

const TESTNET = 'eip155:84532';
const base = (process.argv[2] || '').replace(/\/$/, '');
const date = process.argv[3];
const key = process.env.BUYER_PRIVATE_KEY;
function fail(msg) { console.error(`✗ ${msg}`); process.exit(1); }
if (!/^https?:\/\//.test(base)) fail('usage : node scripts/x402-test-buy.mjs <url de base> [date]');
if (!/^0x[0-9a-fA-F]{64}$/.test(key || '')) fail('BUYER_PRIVATE_KEY (0x + 64 hex) requis — portefeuille de TEST');
if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`date invalide : ${date}`);

const url = `${base}/v1/nhl/games${date ? `?date=${date}` : ''}`;
const account = privateKeyToAccount(key);
console.log(`acheteur ${account.address}`);

// 1. Découverte : la 402 doit annoncer le testnet, sinon on s'arrête avant de signer.
const first = await fetch(url);
if (first.status !== 402) fail(`attendu 402 sans paiement, reçu ${first.status}`);
const pr = JSON.parse(Buffer.from(first.headers.get('payment-required') || '', 'base64').toString('utf8'));
const req = pr.accepts?.[0];
if (!req || req.network !== TESTNET) fail(`réseau annoncé ${req?.network} : ce script ne paie que sur ${TESTNET}`);
console.log(`402 ok : ${Number(req.amount) / 1e6} USDC → ${req.payTo} (${req.network})`);
if (!pr.extensions?.bazaar) console.warn('⚠ pas d\'extension bazaar dans la 402');

// 2. Paiement, en gardant l'en-tête signé pour le rejeu.
let signedHeader = null;
const recordingFetch = async (input, init) => {
  const h = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
  if (h.get('payment-signature')) signedHeader = h.get('payment-signature');
  return fetch(input, init);
};
const pay = wrapFetchWithPaymentFromConfig(recordingFetch, { schemes: [{ network: TESTNET, client: new ExactEvmScheme(account) }] });
const res = await pay(url);
const body = await res.json().catch(() => null);
if (res.status !== 200) fail(`paiement : reçu ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
const receipt = JSON.parse(Buffer.from(res.headers.get('payment-response') || '', 'base64').toString('utf8') || '{}');
console.log(`200 ok : ${body.games.length} match(s), tx ${receipt.transaction}`);
console.log(`   vérifier sur la chaîne : https://sepolia.basescan.org/tx/${receipt.transaction}`);

// 3. Schéma annoncé.
const bad = [];
for (const k of ['date', 'games', 'asOf', 'source', 'disclaimer']) if (!(k in body)) bad.push(`champ ${k} manquant`);
for (const g of body.games) {
  const p = g.probabilities || {};
  if (!(p.homeWin > 0 && p.homeWin < 1)) bad.push(`${g.gameId} homeWin hors (0,1)`);
  for (const k of ['homeMinus1_5', 'awayMinus1_5']) if (p[k] !== null && !(p[k] > 0 && p[k] < p.homeWin + 1)) bad.push(`${g.gameId} ${k}`);
  if (Date.parse(g.startTimeUTC) <= Date.now()) bad.push(`${g.gameId} déjà commencé`);
  if (typeof g.goalies?.confirmed !== 'boolean') bad.push(`${g.gameId} goalies.confirmed`);
}
if (/iceedge/i.test(JSON.stringify(body))) bad.push('« ICEEDGE » dans la réponse');
if (bad.length) fail(`schéma : ${bad.join(' ; ')}`);
console.log('schéma ok');

// 4. Rejeu du même paiement : doit être refusé (pas de second débit, pas de corps).
if (!signedHeader) fail('en-tête PAYMENT-SIGNATURE non capturé : rejeu non testé');
const replay = await fetch(url, { headers: { 'PAYMENT-SIGNATURE': signedHeader } });
const replayBody = await replay.json().catch(() => ({}));
if (replay.status === 200 && replayBody.games) fail('REJEU ACCEPTÉ : le même paiement a été servi deux fois');
console.log(`rejeu refusé : ${replay.status}`);
console.log('\n✓ découverte, paiement, réponse et rejeu : OK');
