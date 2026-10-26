/**
 * parlayPublish.ts — envoi des vidéos de combinés (MARKETING_PLAN Phase D)
 * ------------------------------------------------------------------
 * Trois sorties, sans SDK (fetch seul, sauf R2 qui reprend le client S3 déjà
 * utilisé par les avatars) :
 *   • YouTube Shorts — `videos.insert` en envoi « resumable » ;
 *   • R2             — le mp4 dans le bucket public `arakice-content` ;
 *   • Resend         — le courriel « à publier sur TikTok » (lien + légende).
 * Aucun secret n'est jamais écrit dans la console.
 */

import { promises as fs } from 'fs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`variable ${name} absente`);
  return v;
}

// ─── YouTube ─────────────────────────────────────────────────────────────────

export type Privacy = 'public' | 'unlisted' | 'private';

async function youtubeAccessToken(): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: need('YOUTUBE_CLIENT_ID'),
      client_secret: need('YOUTUBE_CLIENT_SECRET'),
      refresh_token: need('YOUTUBE_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    // `invalid_grant` = jeton expiré ou révoqué : écran de consentement resté en
    // « Test » (7 jours), ou accès retiré. Relancer `npm run youtube:auth`.
    throw new Error(`YouTube : jeton refusé (${body.error ?? res.status}${body.error === 'invalid_grant' ? ' — relancer npm run youtube:auth' : ''})`);
  }
  return body.access_token;
}

export interface YoutubeMeta {
  title: string; description: string; tags: string[]; privacy: Privacy;
  /** ISO : envoi en « private » programmé, YouTube le rend public à cette heure. */
  publishAt?: string | null;
}

/** Envoie le mp4, renvoie l'id de la vidéo. */
export async function uploadYoutube(file: string, meta: YoutubeMeta): Promise<string> {
  const token = await youtubeAccessToken();
  const video = await fs.readFile(file);
  const init = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(video.length),
        'X-Upload-Content-Type': 'video/mp4',
      },
      body: JSON.stringify({
        snippet: {
          title: meta.title.slice(0, 100),
          description: meta.description.slice(0, 5000),
          tags: meta.tags.map((t) => t.replace(/^#/, '')),
          categoryId: '17',                 // Sports
          defaultLanguage: 'en',
          defaultAudioLanguage: 'en',
        },
        status: meta.publishAt
          ? { privacyStatus: 'private', publishAt: meta.publishAt, selfDeclaredMadeForKids: false, embeddable: true }
          : { privacyStatus: meta.privacy, selfDeclaredMadeForKids: false, embeddable: true },
      }),
    },
  );
  const location = init.headers.get('location');
  if (!init.ok || !location) throw new Error(`YouTube : ouverture de l'envoi refusée (HTTP ${init.status} ${await init.text().catch(() => '')})`);

  const put = await fetch(location, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(video.length) },
    body: video,
  });
  const body: any = await put.json().catch(() => ({}));
  if (!put.ok || !body.id) throw new Error(`YouTube : envoi refusé (HTTP ${put.status} ${JSON.stringify(body.error ?? body)})`);
  return body.id;
}

// ─── R2 ──────────────────────────────────────────────────────────────────────

/** Dépose le mp4 dans le bucket public, renvoie son URL publique. */
export async function uploadR2(file: string, key: string): Promise<string> {
  const accountId = need('R2_ACCOUNT_ID');
  const client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: need('R2_ACCESS_KEY_ID'), secretAccessKey: need('R2_SECRET_ACCESS_KEY') },
  });
  await client.send(new PutObjectCommand({
    Bucket: need('R2_BUCKET'),
    Key: key,
    Body: await fs.readFile(file),
    ContentType: 'video/mp4',
    ContentDisposition: `attachment; filename="${key.split('/').pop()}"`,
    CacheControl: 'public, max-age=604800',
  }));
  return `${need('R2_PUBLIC_URL').replace(/\/+$/, '')}/${key}`;
}

// ─── Courriel TikTok ─────────────────────────────────────────────────────────

const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export interface TiktokMail {
  subject: string;
  videoUrl: string;
  caption: string;          // légende + hashtags, prête à coller
  youtubeUrl: string | null;
  trial: boolean;
  /** Ligne d'information sous la légende (heure de sortie YouTube…). */
  note?: string;
}

export async function sendTiktokMail(m: TiktokMail): Promise<void> {
  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;padding:28px 22px;background:#0A0E0C;color:#F3F7F0;border-radius:16px">
    <h1 style="font-size:18px;letter-spacing:0.14em;text-transform:uppercase;color:#90C9F0;margin:0 0 18px">ArakIce · TikTok${m.trial ? ' · ESSAI' : ''}</h1>
    <p style="margin:0 0 18px"><a href="${escHtml(m.videoUrl)}" style="display:inline-block;background:#90C9F0;color:#0A0E0C;font-weight:700;padding:14px 22px;border-radius:12px;text-decoration:none">Télécharger la vidéo</a></p>
    <p style="margin:0 0 8px;color:#8A9EA6">Légende à coller :</p>
    <pre style="white-space:pre-wrap;font:15px/1.45 -apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#131A12;padding:14px;border-radius:10px;margin:0 0 18px;color:#F3F7F0">${escHtml(m.caption)}</pre>
    ${m.note ? `<p style="margin:0 0 12px;color:#F3F7F0">${escHtml(m.note)}</p>` : ''}
    ${m.youtubeUrl ? `<p style="margin:0;color:#8A9EA6">YouTube : <a href="${escHtml(m.youtubeUrl)}" style="color:#90C9F0">${escHtml(m.youtubeUrl)}</a></p>` : ''}
    ${m.trial ? '<p style="margin:18px 0 0;color:#FACC15">Mode essai : la vidéo YouTube est « non répertoriée ». Ne pas publier sur TikTok avant la fin de l’essai.</p>' : ''}
  </div>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${need('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: need('RESEND_FROM'),
      to: need('NOTIFY_EMAIL'),
      subject: m.subject,
      html,
      text: `${m.videoUrl}\n\n${m.caption}${m.note ? `\n\n${m.note}` : ''}${m.youtubeUrl ? `\n\nYouTube : ${m.youtubeUrl}` : ''}`,
    }),
  });
  if (!res.ok) throw new Error(`Resend : HTTP ${res.status} ${await res.text().catch(() => '')}`);
}
