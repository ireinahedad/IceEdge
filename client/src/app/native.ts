/**
 * native.ts — APPLE_PLAN 3.9. iOS-only glue, loaded by main.tsx behind `isIOS`
 * (a build constant): the web bundle never contains it.
 *
 * External links. Inside WKWebView an `<a href="https://elsewhere">` either does
 * nothing (target=_blank) or navigates the whole app away with no way back.
 * Every external http(s) link is opened in an in-app Safari sheet instead
 * (SFSafariViewController through @capacitor/browser). `tel:` and `mailto:` are
 * left alone — Capacitor hands them to the Phone / Mail apps.
 */
import { Browser } from "@capacitor/browser";

function isExternalHttp(href: string): boolean {
  try {
    const url = new URL(href, window.location.href);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin !== window.location.origin;
  } catch {
    return false;
  }
}

/** Open a URL outside the app shell. Safe to call from anywhere on iOS. */
export function openExternal(href: string): void {
  void Browser.open({ url: href, presentationStyle: "popover" });
}

export function installNativeShell(): void {
  document.addEventListener(
    "click",
    (e) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || !isExternalHttp(a.href)) return;
      e.preventDefault();
      openExternal(a.href);
    },
    true,
  );

  // window.open (used by a few share/help paths) gets the same treatment.
  const nativeOpen = window.open.bind(window);
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    const href = url ? String(url) : "";
    if (href && isExternalHttp(href)) { openExternal(href); return null; }
    return nativeOpen(url, target, features);
  }) as typeof window.open;
}
