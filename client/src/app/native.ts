/**
 * native.ts — APPLE_PLAN 3.9. iOS-only glue, loaded by main.tsx behind `isIOS`
 * (a build constant): the web bundle never contains it.
 *
 * External links. Inside WKWebView an `<a href="https://elsewhere">` either does
 * nothing (target=_blank) or navigates the whole app away with no way back.
 * Every external http(s) link is opened in an in-app Safari sheet instead
 * (SFSafariViewController through @capacitor/browser). `tel:` and `mailto:` are
 * left alone — Capacitor hands them to the Phone / Mail apps.
 *
 * Notifications (APPLE_PLAN 4.1): tap → route, and the APNs token is refreshed
 * server-side on every launch when the user has opted in (`nativePush.ts`).
 */
import { Browser } from "@capacitor/browser";
import { installNotificationTapHandler, syncNativePush } from "./services/nativePush";
import { App } from "@capacitor/app";
import { reloadWidget, syncWidget } from "./services/widgetBridge";

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
  // APPLE_PLAN 4.1 — notifications. The tap handler goes in first so a tap that
  // cold-launches the app is not lost; the router is imported lazily (it is
  // already loaded by then — this only avoids an import cycle at startup).
  const navigate = (to: string) => { void import("./routes").then((m) => m.router.navigate(to)); };
  installNotificationTapHandler(navigate);
  void syncNativePush();

  // APPLE_PLAN 4.6 / 4.2 — an arakice.com link (Universal Link) or a tap on the
  // home-screen widget (`arakice://app/bet?tab=slips`) opens the matching route.
  void App.addListener("appUrlOpen", ({ url }) => {
    const to = routeFromUrl(url);
    if (to) navigate(to);
  });

  // APPLE_PLAN 4.2 — the widget gets its token (if signed in) and is redrawn
  // when the user leaves the app, so a slip placed a minute ago shows up.
  void syncWidget();
  void App.addListener("appStateChange", ({ isActive }) => { if (!isActive) reloadWidget(); });

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

/**
 * In-app route for an incoming URL, or null. Only our own links are honoured:
 * `https://arakice.com/...` (Universal Links, see public/.well-known/) and the
 * `arakice://` scheme the widget uses (the host is ignored: `arakice://app/bet`).
 */
export function routeFromUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const ours =
    ((u.protocol === "https:" || u.protocol === "http:") && /^(www\.)?arakice\.com$/i.test(u.hostname))
    || u.protocol === "arakice:";
  if (!ours) return null;
  const path = u.pathname && u.pathname.startsWith("/") ? u.pathname : "/";
  return `${path}${u.search}${u.hash}`;
}
