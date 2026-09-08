/**
 * shareImage.ts — capture a DOM node as a PNG and share/download it.
 *
 * Uses html-to-image (add with `npm i html-to-image`). Elements marked with
 * `data-noshot` are excluded from the capture (e.g. the share button itself).
 *
 * ── Ce qui échouait EN SILENCE avant le 2026-09-08 ──────────────────────────
 *
 * La carte contient des logos NHL servis par un CDN tiers. Sans
 * `crossOrigin="anonymous"` sur ces `<img>`, les dessiner dans un canvas le
 * **contamine**, et `toDataURL` lève alors `SecurityError`. L'appelant ne
 * faisait qu'un `console.warn` : **l'utilisateur touchait « Partager » et il ne
 * se passait rien.** Un `console.warn` n'est pas une gestion d'erreur.
 *
 * Trois choses ont changé, et aucune ne suffit seule :
 *   1. l'`<img>` de la carte demande le mode CORS (voir `MySlipsTab`) ;
 *   2. `cacheBust` est retiré — il ajoutait `?t=…` à chaque URL d'image, ce qui
 *      **force un nouvel aller-retour réseau** et perd le bénéfice d'une image
 *      déjà chargée proprement ;
 *   3. l'échec REMONTE désormais à l'appelant, qui l'affiche.
 */
import { toPng } from 'html-to-image';
import { isIOS } from '../platform';

const filter = (node: HTMLElement) =>
  !(node instanceof HTMLElement && node.dataset && node.dataset.noshot !== undefined);

/** Levée quand il n'existe aucun moyen de remettre l'image à l'utilisateur. */
export class ShareUnavailableError extends Error {
  constructor() { super('share_unavailable'); this.name = 'ShareUnavailableError'; }
}

export async function shareNodeAsImage(
  node: HTMLElement,
  filename: string,
  title = 'ArakIce',
): Promise<void> {
  const dataUrl = await toPng(node, {
    filter,
    // `2` en dur allouait 4× la surface de la carte en mémoire, quelle que soit
    // la densité réelle de l'écran — notable sur un iPhone ancien, pour un
    // gain invisible sur un écran à 1×.
    pixelRatio: Math.min(2, window.devicePixelRatio || 1),
    backgroundColor: '#0A0E0C',
  });

  const blob = await (await fetch(dataUrl)).blob();
  const file = new File([blob], filename, { type: 'image/png' });

  // Prefer the native share sheet (mobile) when it can share files.
  const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
  if (nav.canShare && nav.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return;
    } catch {
      // user cancelled or share failed → fall back to download
    }
  }

  // Repli : déclencher un téléchargement.
  //
  // ⚠️ **`a.download` ne fait RIEN en WKWebView.** Sur le build iOS, arriver
  // ici signifie donc qu'on n'a aucun moyen de remettre le fichier — mieux vaut
  // le dire que simuler un clic sans effet. Sur le web, le téléchargement
  // marche et reste le bon repli.
  if (isIOS) throw new ShareUnavailableError();

  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
