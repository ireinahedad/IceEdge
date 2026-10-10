// ============================================================
//  APNs sender — APPLE_PLAN 4.1
// ============================================================
// Envoie les notifications natives iOS directement à Apple, en HTTP/2, avec
// une clé d'authentification `.p8` (token-based auth). Aucune dépendance :
// `node:http2` et `node:crypto` suffisent, et une bibliothèque de plus serait
// une surface de plus à maintenir pour ~100 lignes.
//
// Variables d'environnement (Railway) :
//   APNS_KEY_ID     — identifiant de la clé (10 caractères, portail Apple → Keys)
//   APNS_TEAM_ID    — Team ID du compte développeur
//   APNS_KEY_P8     — le contenu du fichier .p8, en clair (PEM) OU en base64
//   APNS_BUNDLE_ID  — défaut com.arakice.arakice
//   APNS_HOST       — défaut https://api.push.apple.com (production).
//                     ⚠️ TestFlight ET l'App Store utilisent la production.
//                     Le bac à sable (api.sandbox.push.apple.com) ne sert qu'aux
//                     builds de développement installées depuis Xcode.
//
// Sans ces variables, le canal est simplement désactivé (journalisé une fois).

import http2 from 'node:http2';
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { logger } from '../logger';

const HOST      = process.env.APNS_HOST || 'https://api.push.apple.com';
const BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'com.arakice.arakice';

/** Apple refuse un jeton d'auth de plus d'une heure, et en limite le renouvellement
 *  à un toutes les 20 min. 50 min : bien dans la fenêtre. */
const JWT_TTL_MS = 50 * 60_000;
/** Un appel bloqué ne doit pas retenir le lot. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface ApnsMessage {
  title: string;
  body:  string;
  /** Route de l'app à ouvrir au toucher (ex. `/player/<id>`). */
  url?:  string;
}

export interface ApnsResult {
  status: number;
  /** Raison renvoyée par Apple (`BadDeviceToken`, `Unregistered`…), si erreur. */
  reason?: string;
}

// ---- Configuration ---------------------------------------------------------

let checked = false;
let key: KeyObject | null = null;

/** Accepte le PEM brut, le PEM avec des `\n` échappés (copier-coller dans une
 *  variable d'environnement), ou le fichier entier encodé en base64. */
export function parseP8(raw: string): string {
  const unescaped = raw.replace(/\\n/g, '\n').trim();
  if (unescaped.includes('BEGIN PRIVATE KEY')) return unescaped;
  return Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8').trim();
}

function getKey(): KeyObject | null {
  if (checked) return key;
  checked = true;
  const raw = process.env.APNS_KEY_P8;
  if (!raw || !process.env.APNS_KEY_ID || !process.env.APNS_TEAM_ID) {
    logger.warn('[APNs] APNS_KEY_P8 / APNS_KEY_ID / APNS_TEAM_ID absents — notifications iOS désactivées.');
    return null;
  }
  try {
    key = createPrivateKey(parseP8(raw));
  } catch (err: any) {
    logger.error({ err: err?.message }, '[APNs] APNS_KEY_P8 illisible — notifications iOS désactivées.');
    key = null;
  }
  return key;
}

export function apnsEnabled(): boolean {
  return !!getKey();
}

// ---- Jeton d'authentification (JWT ES256) ----------------------------------

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

let jwt: { value: string; at: number } | null = null;

export function buildProviderToken(k: KeyObject, keyId: string, teamId: string, nowSec: number): string {
  const header  = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims  = b64url(JSON.stringify({ iss: teamId, iat: nowSec }));
  const signing = `${header}.${claims}`;
  // ES256 dans un JWT = signature brute r||s (64 octets), pas le DER par défaut.
  const sig = sign('sha256', Buffer.from(signing), { key: k, dsaEncoding: 'ieee-p1363' });
  return `${signing}.${b64url(sig)}`;
}

function providerToken(k: KeyObject): string {
  const now = Date.now();
  if (!jwt || now - jwt.at > JWT_TTL_MS) {
    jwt = {
      value: buildProviderToken(k, process.env.APNS_KEY_ID!, process.env.APNS_TEAM_ID!, Math.floor(now / 1000)),
      at: now,
    };
  }
  return jwt.value;
}

// ---- Session HTTP/2 --------------------------------------------------------
// Une seule connexion, réutilisée : Apple demande explicitement de ne pas en
// ouvrir une par notification. Recréée si elle se ferme ou tombe en erreur.

let session: http2.ClientHttp2Session | null = null;

function getSession(): http2.ClientHttp2Session {
  if (session && !session.closed && !session.destroyed) return session;
  const s = http2.connect(HOST);
  s.on('error', (err) => {
    logger.warn({ err: err?.message }, '[APNs] session en erreur — recréée au prochain envoi');
    if (session === s) session = null;
  });
  s.on('close',  () => { if (session === s) session = null; });
  s.on('goaway', () => { if (session === s) session = null; });
  // La connexion ne doit pas empêcher le process de s'arrêter proprement
  // (le serveur HTTP, lui, garde la boucle vivante).
  s.unref();
  session = s;
  return s;
}

// ---- Envoi -----------------------------------------------------------------

export function buildApnsBody(msg: ApnsMessage): string {
  return JSON.stringify({
    aps: { alert: { title: msg.title, body: msg.body }, sound: 'default' },
    ...(msg.url ? { url: msg.url } : {}),
  });
}

/**
 * Vrai quand Apple dit que le jeton ne servira plus jamais : l'app a été
 * désinstallée (410 Unregistered) ou le jeton n'existe pas pour cette app.
 * Ces jetons sont supprimés ; toute autre erreur est transitoire.
 */
export function isDeadToken(r: ApnsResult): boolean {
  return r.status === 410
    || (r.status === 400 && (r.reason === 'BadDeviceToken' || r.reason === 'DeviceTokenNotForTopic'));
}

export async function sendApns(deviceToken: string, msg: ApnsMessage): Promise<ApnsResult> {
  const k = getKey();
  if (!k) return { status: 0, reason: 'NotConfigured' };

  const body = buildApnsBody(msg);
  let s: http2.ClientHttp2Session;
  try {
    s = getSession();
  } catch (err: any) {
    return { status: 0, reason: err?.message ?? 'ConnectFailed' };
  }

  return new Promise<ApnsResult>((resolve) => {
    let settled = false;
    const done = (r: ApnsResult) => {
      if (settled) return;
      settled = true;
      if (r.status === 403 && r.reason === 'ExpiredProviderToken') jwt = null;
      resolve(r);
    };

    let req: http2.ClientHttp2Stream;
    try {
      req = s.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${providerToken(k)}`,
        'apns-topic': BUNDLE_ID,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        // Un téléphone éteint toute la nuit reçoit encore l'alerte le matin,
        // mais pas une semaine plus tard.
        'apns-expiration': String(Math.floor(Date.now() / 1000) + 24 * 3600),
        'content-type': 'application/json',
      });
    } catch (err: any) {
      session = null;
      return done({ status: 0, reason: err?.message ?? 'RequestFailed' });
    }

    let status = 0;
    let data = '';
    req.setEncoding('utf8');
    req.on('response', (h) => { status = Number(h[':status']) || 0; });
    req.on('data', (chunk: string) => { data += chunk; });
    req.on('end', () => {
      let reason: string | undefined;
      if (data) { try { reason = JSON.parse(data)?.reason; } catch { /* corps vide ou non JSON */ } }
      done({ status, reason });
    });
    req.on('error', (err) => done({ status: 0, reason: err?.message ?? 'StreamError' }));
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.close(http2.constants.NGHTTP2_CANCEL);
      done({ status: 0, reason: 'Timeout' });
    });
    req.end(body);
  });
}
