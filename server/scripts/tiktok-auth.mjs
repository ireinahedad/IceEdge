#!/usr/bin/env node
/**
 * tiktok-auth.mjs — relier le compte TikTok à l'envoi automatique (une fois, puis
 * à refaire seulement si le jeton est perdu ou révoqué).
 *
 *   1. node scripts/tiktok-auth.mjs
 *        → affiche le lien de connexion TikTok. L'ouvrir, se connecter, autoriser.
 *   2. TikTok renvoie vers https://arakice.com/tiktok-callback, qui affiche la
 *      commande complète à coller ici :
 *        node scripts/tiktok-auth.mjs --code=… --state=…
 *      (TIKTOK_CLIENT_SECRET doit être dans l'environnement pour cette étape.)
 *   3. Le jeton de rafraîchissement est rangé directement dans le secret GitHub
 *      TIKTOK_REFRESH_TOKEN via `gh` s'il est installé et connecté ; sinon il
 *      est écrit dans un fichier local à coller soi-même dans GitHub, puis à effacer.
 *
 * Aucune dépendance (Node 18+). Le secret client n'est jamais affiché.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// La clé client n'est pas un secret (elle apparaît dans le lien de connexion).
// Clé du mode SANDBOX (2026-11-24) : tant que l'app n'est pas approuvée, seuls
// les comptes « target users » du sandbox peuvent se connecter. Après
// approbation, passer à la clé de production (aw2issrtgxkchr8b), ici ET dans la
// variable GitHub TIKTOK_CLIENT_KEY, puis relancer ce script : un jeton obtenu
// avec la clé sandbox ne marche pas avec la clé de production.
const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY?.trim() || 'sbawi7g2aox3p9qk0l';
const REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI?.trim() || 'https://arakice.com/tiktok-callback';
const SCOPES = (process.env.TIKTOK_SCOPES?.trim() || 'user.info.basic,video.upload');
const STATE_FILE = path.join(os.tmpdir(), 'arakice-tiktok-state.txt');

const arg = (name) => process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

async function start() {
  const state = randomBytes(16).toString('hex');
  await fs.writeFile(STATE_FILE, state, 'utf8');
  const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
  url.search = new URLSearchParams({
    client_key: CLIENT_KEY, scope: SCOPES, response_type: 'code', redirect_uri: REDIRECT_URI, state,
  }).toString();
  console.log('\nOuvre ce lien, connecte-toi avec le compte TikTok et autorise ArakIce :\n');
  console.log(url.toString());
  console.log('\nLa page arakice.com/tiktok-callback affichera ensuite la commande à coller ici.\n');
}

async function finish(code, state) {
  const expected = (await fs.readFile(STATE_FILE, 'utf8').catch(() => '')).trim();
  // Le `state` protège contre un code injecté par un tiers : il doit venir du lien qu'on a ouvert.
  if (!expected || state !== expected) {
    console.error('« state » inattendu : relancer `node scripts/tiktok-auth.mjs` et utiliser le nouveau lien.');
    process.exit(1);
  }
  const secret = process.env.TIKTOK_CLIENT_SECRET?.trim();
  if (!secret) {
    console.error('TIKTOK_CLIENT_SECRET absent de l’environnement (PowerShell : $env:TIKTOK_CLIENT_SECRET="…").');
    process.exit(1);
  }
  const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: CLIENT_KEY, client_secret: secret, code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.refresh_token) {
    console.error(`TikTok a refusé le code : ${body.error ?? res.status}${body.error_description ? ` (${body.error_description})` : ''}`);
    console.error('Un code ne sert qu’une fois et expire vite : relancer depuis l’étape 1.');
    process.exit(1);
  }
  await fs.rm(STATE_FILE, { force: true });
  const scopes = String(body.scope ?? '');
  const days = body.refresh_expires_in ? Math.round(body.refresh_expires_in / 86400) : '?';
  console.log(`\nConnecté. Portées accordées : ${scopes || '(non précisées)'} · jeton valable ${days} jours.`);
  if (!scopes.includes('video.upload')) console.log('⚠️  « video.upload » n’est pas dans les portées accordées : l’envoi échouera.');

  const gh = spawnSync('gh', ['secret', 'set', 'TIKTOK_REFRESH_TOKEN'], { input: body.refresh_token, encoding: 'utf8' });
  if (gh.status === 0) {
    console.log('Secret GitHub TIKTOK_REFRESH_TOKEN mis à jour. C’est fini.\n');
    return;
  }
  const out = path.resolve('tiktok-refresh-token.txt');
  await fs.writeFile(out, body.refresh_token, { encoding: 'utf8', mode: 0o600 });
  console.log(`\n\`gh\` indisponible : le jeton est dans ${out}`);
  console.log('Colle son contenu dans GitHub → Settings → Secrets and variables → Actions → TIKTOK_REFRESH_TOKEN, puis EFFACE ce fichier.\n');
}

const code = arg('code');
if (code) await finish(code, arg('state') ?? '');
else await start();
