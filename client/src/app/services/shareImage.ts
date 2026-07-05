/**
 * shareImage.ts — capture a DOM node as a PNG and share/download it.
 *
 * Uses html-to-image (add with `npm i html-to-image`). Elements marked with
 * `data-noshot` are excluded from the capture (e.g. the share button itself).
 */
import { toPng } from 'html-to-image';

const filter = (node: HTMLElement) =>
  !(node instanceof HTMLElement && node.dataset && node.dataset.noshot !== undefined);

export async function shareNodeAsImage(
  node: HTMLElement,
  filename: string,
  title = 'IceEdge',
): Promise<void> {
  const dataUrl = await toPng(node, {
    filter,
    pixelRatio: 2,
    backgroundColor: '#0A0E0C',
    cacheBust: true,
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

  // Fallback: trigger a download.
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
