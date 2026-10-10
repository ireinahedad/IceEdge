/**
 * shareImage.ts — remet une image PNG à l'utilisateur : feuille de partage
 * native quand elle accepte des fichiers, téléchargement sinon.
 *
 * Ce fichier ne FABRIQUE plus l'image. Il capturait la carte à l'écran avec
 * `html-to-image` ; c'est `slipShareCanvas.ts` qui la dessine désormais, et le
 * pourquoi est écrit en tête de ce fichier-là. Ne reste ici que la dernière
 * étape — celle qui, seule, décide si l'utilisateur reçoit quelque chose.
 *
 * ── Ce qui échouait EN SILENCE avant le 2026-09-08 ──────────────────────────
 *
 * L'échec ne remontait pas à l'appelant : un `console.warn`, et rien à l'écran.
 * L'utilisateur touchait « Partager » et il ne se passait rien — le pire mode
 * de panne possible, parce qu'il est indiscernable d'un bouton mort. Tout
 * échec remonte maintenant, et l'appelant l'affiche.
 */
import { isIOS } from '../platform';

/** Levée quand il n'existe aucun moyen de remettre l'image à l'utilisateur. */
export class ShareUnavailableError extends Error {
  constructor() { super('share_unavailable'); this.name = 'ShareUnavailableError'; }
}

/**
 * Propose l'image, par la feuille de partage du système si elle sait prendre un
 * fichier, sinon par un téléchargement.
 */
export async function shareImageBlob(
  blob:     Blob,
  filename: string,
  title = 'ArakIce',
): Promise<void> {
  // APPLE_PLAN 4.3 — iOS: the native share sheet (no Web Share API in WKWebView).
  // Inline literal so Rollup drops the branch — and the plugins — from the web build.
  if (import.meta.env.VITE_TARGET === 'ios') {
    const m = await import('./nativeShare');
    await m.shareFileNative(blob, filename, title);
    return;
  }

  const file = new File([blob], filename, { type: blob.type || 'image/png' });

  const nav = navigator as Navigator & { canShare?: (data: unknown) => boolean };
  if (nav.canShare && nav.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return;
    } catch (err) {
      // ⚠️ Distinguer l'ANNULATION de l'échec. Auparavant les deux retombaient
      // sur le téléchargement : fermer la feuille de partage déclenchait quand
      // même un fichier, alors que la personne venait exactement de dire non.
      if ((err as DOMException | undefined)?.name === 'AbortError') return;
      // Tout autre échec : on tente encore le repli ci-dessous.
    }
  }

  // Repli : déclencher un téléchargement.
  //
  // ⚠️ **`a.download` ne fait RIEN en WKWebView.** Sur le build iOS, arriver
  // ici signifie donc qu'on n'a aucun moyen de remettre le fichier — mieux vaut
  // le dire que simuler un clic sans effet. Sur le web, le téléchargement
  // marche et reste le bon repli.
  if (isIOS) throw new ShareUnavailableError();

  // Une URL d'objet plutôt qu'une data-URL : le PNG fait plusieurs centaines de
  // kilooctets, et le passer en base64 dans un attribut le gonfle d'un tiers
  // pour rien.
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Révoquer tout de suite annulerait le téléchargement dans certains
    // navigateurs : on laisse la fenêtre s'ouvrir avant de rendre la mémoire.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
