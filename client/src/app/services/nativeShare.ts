/**
 * nativeShare.ts — APPLE_PLAN 4.3. iOS share sheet for a generated image.
 *
 * WKWebView has no Web Share API and ignores `<a download>`, so on iOS the PNG
 * is written to the app's cache folder and handed to the native share sheet
 * (Messages, Instagram, Photos « Enregistrer l'image »…). iOS-only: loaded by a
 * dynamic import behind a VITE_TARGET literal in `shareImage.ts`.
 */
import { Share } from '@capacitor/share';
import { Directory, Filesystem } from '@capacitor/filesystem';

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    // `data:image/png;base64,XXXX` → `XXXX` (Filesystem wants the raw base64).
    r.onload = () => resolve(String(r.result).split(',', 2)[1] ?? '');
    r.readAsDataURL(blob);
  });
}

/** Resolves when shared OR cancelled; rejects only on a real failure. */
export async function shareFileNative(blob: Blob, filename: string, title: string): Promise<void> {
  const data = await blobToBase64(blob);
  const { uri } = await Filesystem.writeFile({ path: filename, data, directory: Directory.Cache });
  try {
    await Share.share({ title, dialogTitle: title, files: [uri] });
  } catch (err) {
    // Closing the sheet rejects with « Share canceled » — that is the user
    // saying no, not an error to show.
    if (/cancel/i.test(String((err as Error)?.message ?? err))) return;
    throw err;
  }
}
