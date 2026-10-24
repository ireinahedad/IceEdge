/**
 * clientIp.ts — l'adresse du VISITEUR, pour les clés des limiteurs de débit.
 *
 * PERF_PLAN.md §4 bis (2026-10-24). Derrière Cloudflare (proxy, nuage orange),
 * `req.ip` (avec `trust proxy` à 1) devient l'adresse d'un serveur Cloudflare :
 * tous les visiteurs passés par le même serveur partageraient un compteur
 * (`apiLimiter`, `predictLimiter`, `authLimiter`, chat…) et prendraient des 429
 * en série. Cloudflare transmet la vraie adresse dans `CF-Connecting-IP`.
 *
 * Cet en-tête n'est lu QUE si `TRUST_CF_CONNECTING_IP=true`. Sans Cloudflare
 * devant, n'importe quel appelant peut l'écrire lui-même et choisir sa clé de
 * limiteur — c'est-à-dire contourner tous les plafonds. À poser seulement
 * quand les deux conditions sont réunies : `api.arakice.com` passe par
 * Cloudflare, ET le domaine public `*.up.railway.app` du service est fermé
 * (sinon on peut joindre le serveur sans Cloudflare et forger l'en-tête).
 */
import type { Request } from 'express';

/** Une adresse IPv4 ou IPv6 plausible — pas de texte libre dans une clé. */
const IP_RE = /^[0-9a-fA-F:.]{3,45}$/;

export function trustCfConnectingIp(): boolean {
  return process.env.TRUST_CF_CONNECTING_IP === 'true';
}

export function clientIp(req: Pick<Request, 'headers' | 'ip'>): string | undefined {
  if (trustCfConnectingIp()) {
    const raw = req.headers['cf-connecting-ip'];
    const v = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (v && IP_RE.test(v)) return v;
  }
  return req.ip;
}
