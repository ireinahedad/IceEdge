/**
 * tiktok-test.ts — envoie UN mp4 en brouillon dans la boîte de réception TikTok.
 * Sert à l'essai et à la vidéo de démonstration demandée par TikTok (2026-11-24),
 * sans relancer toute la chaîne du jour (gel, YouTube, courriel).
 *
 *   npx ts-node scripts/tiktok-test.ts --file=chemin/video.mp4
 *
 * Mêmes variables que le run du jour : TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET,
 * TIKTOK_REFRESH_TOKEN, et TIKTOK_REFRESH_OUT (fichier où écrire le NOUVEAU jeton,
 * que le workflow range ensuite). ⚠️ Lancé en local sans ranger le nouveau jeton,
 * il rend le secret GitHub obsolète : passer par le workflow « TikTok — essai ».
 */

import { promises as fs } from 'fs';
import { tiktokConfigured, refreshTiktok, uploadTiktokInbox, tiktokStatus } from './lib/tiktok';

async function main(): Promise<void> {
  const file = process.argv.slice(2).find((a) => a.startsWith('--file='))?.slice(7);
  if (!file) throw new Error('usage : --file=video.mp4');
  await fs.access(file);
  if (!tiktokConfigured()) throw new Error('TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET et TIKTOK_REFRESH_TOKEN sont requis');

  const t = await refreshTiktok();
  if (process.env.TIKTOK_REFRESH_OUT) await fs.writeFile(process.env.TIKTOK_REFRESH_OUT, t.refreshToken, { encoding: 'utf8', mode: 0o600 });
  console.log('Jeton TikTok renouvelé.');

  const publishId = await uploadTiktokInbox(file, t.accessToken);
  console.log(`Envoyé : ${publishId}`);
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = await tiktokStatus(publishId, t.accessToken);
    console.log(`Statut : ${s}`);
    if (s === 'SEND_TO_USER_INBOX' || s === 'PUBLISH_COMPLETE' || s === 'FAILED' || s.startsWith('erreur')) {
      if (s === 'FAILED' || s.startsWith('erreur')) process.exitCode = 1;
      else console.log('Brouillon dans la boîte de réception TikTok : ouvre l’app.');
      return;
    }
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
