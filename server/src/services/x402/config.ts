/**
 * config.ts — réglages de l'API pour agents (X402_PLAN.md, phase 2).
 *
 * Tout passe par l'environnement Railway ; rien n'est actif par défaut.
 *
 *   X402_ENABLED=true          active le routeur `agents.` (sinon : absent, 0 coût)
 *   X402_PAY_TO=0x…            adresse PUBLIQUE du portefeuille vendeur (jamais la clé)
 *   X402_NETWORK               eip155:84532 (Base Sepolia, défaut) | eip155:8453 (Base)
 *   X402_MAINNET_GO=true       requis pour eip155:8453 : le « go » d'Ireina (plan §9)
 *   X402_FACILITATOR_URL       défaut https://x402.org/facilitator (testnet, sans clé)
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
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PRICE_RE = /^\$\d+(\.\d{1,6})?$/;

export interface X402Config {
  payTo: `0x${string}`;
  network: typeof TESTNET | typeof MAINNET;
  facilitatorUrl: string;
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

  const gamesPrice = String(env.X402_PRICE_GAMES ?? '$0.10').trim();
  if (!PRICE_RE.test(gamesPrice)) throw new Error('X402_PRICE_GAMES must look like $0.10');

  const allowAnyHost = env.X402_ALLOW_ANY_HOST === 'true';
  if (allowAnyHost && env.NODE_ENV === 'production') throw new Error('X402_ALLOW_ANY_HOST is not allowed in production');

  const host = String(env.X402_HOST ?? 'agents.arakice.com').trim().toLowerCase();
  return {
    payTo: payTo as `0x${string}`,
    network,
    facilitatorUrl: String(env.X402_FACILITATOR_URL ?? 'https://x402.org/facilitator').trim(),
    host,
    publicUrl: String(env.X402_PUBLIC_URL ?? `https://${host}`).trim().replace(/\/$/, ''),
    gamesPrice,
    allowAnyHost,
    proofRepo: String(env.X402_PROOF_REPO ?? 'ireinahedad/arakice-nhl-predictions').trim(),
    iconUrl: 'https://arakice.com/arakice-icon-192.png',
  };
}
