/**
 * config.ts — réglages de l'API pour agents (X402_PLAN.md, phase 2).
 *
 * Tout passe par l'environnement Railway ; rien n'est actif par défaut.
 *
 *   X402_ENABLED=true          active le routeur `agents.` (sinon : absent, 0 coût)
 *   X402_PAY_TO=0x…            adresse PUBLIQUE du portefeuille vendeur (jamais la clé)
 *   X402_NETWORK               eip155:84532 (Base Sepolia, défaut) | eip155:8453 (Base)
 *   X402_MAINNET_GO=true       requis pour eip155:8453 : le « go » d'Ireina (plan §9)
 *   X402_FACILITATOR_URL       par défaut, selon le cas :
 *                                • clés CDP réglées → https://api.cdp.coinbase.com/platform/v2/x402
 *                                • sinon sur Base   → https://facilitator.payai.network (PayAI : sans compte
 *                                  ni clé jusqu'à 1 000 règlements gratuits par portefeuille vendeur)
 *                                • sinon (testnet)  → https://x402.org/facilitator
 *   CDP_API_KEY_ID / CDP_API_KEY_SECRET
 *                              facultatif : clé Coinbase Developer Platform → facilitateur CDP (seul à
 *                              indexer dans le Bazaar de Coinbase). Le compte CDP n'accepte pas le Canada
 *                              comme pays de résidence (constaté par Ireina le 2026-11-04) : PayAI par défaut.
 *   X402_HOST                  défaut agents.arakice.com — seul hôte servi
 *   X402_PUBLIC_URL            défaut https://<X402_HOST>
 *   X402_PRICE_GAMES           défaut $0.10 — forfait par date (voir gamesPrice ci-dessous)
 *   X402_ALLOW_ANY_HOST=true   tests et essais locaux seulement (refusé en production)
 *
 * Le prix : avec le schéma `exact`, il est fixé AVANT la réponse, donc avant de
 * savoir combien de matchs elle contiendra. Un forfait par date est la seule
 * règle que l'acheteur peut vérifier lui-même (X402_PLAN.md §6, phase 2).
 */

export const TESTNET = 'eip155:84532';
export const MAINNET = 'eip155:8453';
import { CDP_FACILITATOR_URL, parseCdpSecret, type CdpCredentials } from './cdpAuth';

const PUBLIC_FACILITATOR_URL = 'https://x402.org/facilitator';
export const PAYAI_FACILITATOR_URL = 'https://facilitator.payai.network';
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PRICE_RE = /^\$\d+(\.\d{1,6})?$/;

export interface X402Config {
  payTo: `0x${string}`;
  network: typeof TESTNET | typeof MAINNET;
  facilitatorUrl: string;
  /** Clé API CDP : présente = facilitateur Coinbase authentifié. */
  cdp: CdpCredentials | null;
  host: string;
  publicUrl: string;
  gamesPrice: string;
  allowAnyHost: boolean;
  proofRepo: string;
  iconUrl: string;
}

/**
 * La configuration, ou `null` si l'API est désactivée. Lève si elle est
 * activée mais mal réglée : mieux vaut un démarrage qui échoue qu'une API qui
 * encaisse sur une mauvaise adresse ou le mauvais réseau.
 */
export function loadX402Config(env: NodeJS.ProcessEnv = process.env): X402Config | null {
  if (env.X402_ENABLED !== 'true') return null;

  const payTo = String(env.X402_PAY_TO ?? '').trim();
  if (!ADDRESS_RE.test(payTo)) throw new Error('X402_PAY_TO must be a 0x… address (40 hex characters)');

  const network = String(env.X402_NETWORK ?? TESTNET).trim();
  if (network !== TESTNET && network !== MAINNET) throw new Error(`X402_NETWORK must be ${TESTNET} or ${MAINNET}`);
  if (network === MAINNET && env.X402_MAINNET_GO !== 'true') {
    throw new Error('X402_NETWORK is mainnet but X402_MAINNET_GO is not true (X402_PLAN.md §9)');
  }

  const cdpId = String(env.CDP_API_KEY_ID ?? '').trim();
  const cdpSecret = String(env.CDP_API_KEY_SECRET ?? '').trim();
  if (Boolean(cdpId) !== Boolean(cdpSecret)) throw new Error('CDP_API_KEY_ID and CDP_API_KEY_SECRET must be set together');
  const cdp = cdpId ? { apiKeyId: cdpId, apiKeySecret: cdpSecret } : null;
  if (cdp) parseCdpSecret(cdp.apiKeySecret); // format vérifié au démarrage
  const defaultFacilitator = cdp ? CDP_FACILITATOR_URL : network === MAINNET ? PAYAI_FACILITATOR_URL : PUBLIC_FACILITATOR_URL;
  // `||` et non `??` : une variable Railway vidée vaut '' et doit retomber sur le défaut.
  const facilitatorUrl = (String(env.X402_FACILITATOR_URL ?? '').trim() || defaultFacilitator).replace(/\/+$/, '');
  if (!/^https:\/\//.test(facilitatorUrl)) throw new Error('X402_FACILITATOR_URL must be https://');
  // Toute variante de x402.org (www., chemin différent) : testnet seulement.
  if (network === MAINNET && /^https:\/\/(www\.)?x402\.org(\/|$)/i.test(facilitatorUrl)) {
    throw new Error(`X402_FACILITATOR_URL (${facilitatorUrl}): x402.org does not settle on mainnet — delete the variable to use PayAI`);
  }

  const gamesPrice = String(env.X402_PRICE_GAMES ?? '$0.10').trim();
  if (!PRICE_RE.test(gamesPrice)) throw new Error('X402_PRICE_GAMES must look like $0.10');

  const allowAnyHost = env.X402_ALLOW_ANY_HOST === 'true';
  if (allowAnyHost && env.NODE_ENV === 'production') throw new Error('X402_ALLOW_ANY_HOST is not allowed in production');

  const host = String(env.X402_HOST ?? 'agents.arakice.com').trim().toLowerCase();
  return {
    payTo: payTo as `0x${string}`,
    network,
    facilitatorUrl,
    cdp,
    host,
    publicUrl: String(env.X402_PUBLIC_URL ?? `https://${host}`).trim().replace(/\/$/, ''),
    gamesPrice,
    allowAnyHost,
    proofRepo: String(env.X402_PROOF_REPO ?? 'ireinahedad/arakice-nhl-predictions').trim(),
    iconUrl: 'https://arakice.com/arakice-icon-192.png',
  };
}
