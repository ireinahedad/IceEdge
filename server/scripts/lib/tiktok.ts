/**
 * tiktok.ts — envoi du Short TikTok dans la BOÎTE DE RÉCEPTION du compte (2026-11-24)
 * ------------------------------------------------------------------------------
 * Content Posting API, mode « Upload » (portée `video.upload`) : la vidéo arrive
 * en brouillon dans les notifications TikTok ; on y ajoute un son tendance et on
 * publie depuis l'app. Choix du user : la version TikTok est volontairement
 * MUETTE (TikTok favorise ses sons natifs), et ce mode ne dépend pas de l'audit
 * « Direct Post » qui force les publications en privé.
 *
 * Envoi du FICHIER (FILE_UPLOAD), pas PULL_FROM_URL : ce dernier exige un domaine
 * vérifié chez TikTok, et les vidéos vivent sur l'URL publique R2.
 *
 * ⚠️ JETONS. Le jeton d'accès dure ~2 h ; le jeton de rafraîchissement est
 * REMPLACÉ à chaque rafraîchissement. Le nouveau doit être rangé (secret GitHub
 * TIKTOK_REFRESH_TOKEN, voir content-parlays.yml), sinon le run suivant échoue.
 * Aucun jeton n'est jamais écrit dans la console.
 */

import { promises as fs } from 'fs';

const API = 'https://open.tiktokapis.com/v2';
/** Au-delà, il faudrait découper en morceaux de 5 à 64 Mo ; un Short en fait ~10. */
const SINGLE_CHUNK_MAX = 64 * 1024 * 1024;

export interface TiktokTokens { accessToken: string; refreshToken: string; refreshExpiresIn: number | null }

/** Les trois variables présentes = envoi automatique activé. */
export function tiktokConfigured(): boolean {
  return ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REFRESH_TOKEN']
    .every((k) => Boolean(process.env[k]?.trim()));
}

export async function refreshTiktok(): Promise<TiktokTokens> {
  const res = await fetch(`${API}/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY!.trim(),
      client_secret: process.env.TIKTOK_CLIENT_SECRET!.trim(),
      grant_type: 'refresh_token',
      refresh_token: process.env.TIKTOK_REFRESH_TOKEN!.trim(),
    }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token || !body.refresh_token) {
    // invalid_grant = jeton expiré, révoqué, ou déjà remplacé et jamais rangé :
    // relancer `node scripts/tiktok-auth.mjs`.
    throw new Error(`TikTok : jeton refusé (${body.error ?? res.status}${body.error_description ? ` : ${body.error_description}` : ''}) — relancer node scripts/tiktok-auth.mjs`);
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token, refreshExpiresIn: body.refresh_expires_in ?? null };
}

/**
 * Envoie le mp4 en brouillon dans la boîte de réception TikTok ; renvoie le
 * `publish_id`. La légende ne passe pas par l'API en mode Upload : elle reste
 * dans le courriel, à coller dans l'app.
 */
export async function uploadTiktokInbox(file: string, accessToken: string): Promise<string> {
  const size = (await fs.stat(file)).size;
  if (size > SINGLE_CHUNK_MAX) throw new Error(`TikTok : vidéo de ${Math.round(size / 1e6)} Mo, envoi en un seul morceau impossible`);

  const init = await fetch(`${API}/post/publish/inbox/video/init/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: size, total_chunk_count: 1 } }),
  });
  const ib: any = await init.json().catch(() => ({}));
  const publishId: string | undefined = ib?.data?.publish_id;
  const uploadUrl: string | undefined = ib?.data?.upload_url;
  if (!init.ok || ib?.error?.code !== 'ok' || !publishId || !uploadUrl) {
    // spam_risk_too_many_pending_share = 5 brouillons en attente dans l'app : en publier ou en supprimer.
    throw new Error(`TikTok init : ${ib?.error?.code ?? init.status}${ib?.error?.message ? ` (${ib.error.message})` : ''}`);
  }

  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size), 'Content-Range': `bytes 0-${size - 1}/${size}` },
    body: await fs.readFile(file),
  });
  if (!put.ok) throw new Error(`TikTok envoi : HTTP ${put.status} ${await put.text().catch(() => '')}`.trim());
  return publishId;
}

/** Statut du brouillon (PROCESSING_UPLOAD, SEND_TO_USER_INBOX, FAILED…), pour le résumé du run. */
export async function tiktokStatus(publishId: string, accessToken: string): Promise<string> {
  const res = await fetch(`${API}/post/publish/status/fetch/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ publish_id: publishId }),
  });
  const b: any = await res.json().catch(() => ({}));
  return b?.data?.status ?? (b?.error?.code ? `erreur ${b.error.code}` : `HTTP ${res.status}`);
}
