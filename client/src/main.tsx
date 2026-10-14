import { createRoot } from "react-dom/client";
import { startSentry, captureException, captureMessage } from "./app/sentry";
import { envProblems, assertEnv } from "./app/env";
import { features } from "./app/platform";
import App from "./app/App";
import "./styles/index.css";

// Sentry : chargé après le premier rendu (QA P4, LCP) — voir app/sentry.ts.
startSentry();

// PRE_IOS_PLAN.md R7 — report every configuration problem before assertEnv()
// acts on it, so Sentry carries the diagnosis even when the next line stops the
// app. Sentry is initialised above, so these are not lost.
for (const problem of envProblems) {
  captureMessage(`[env] ${problem.message}`, "error");
}

const rootEl = document.getElementById("root")!;

/**
 * R7.5 — a configuration failure must read as a configuration failure, not as
 * a white page. Plain DOM on purpose: if the app is misconfigured, this screen
 * must not depend on anything the app configures.
 */
function renderConfigError(err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);

  const box = document.createElement("div");
  box.style.cssText =
    "min-height:100vh;display:flex;align-items:center;justify-content:center;" +
    "padding:24px;background:#0b1220;color:#e6edf6;" +
    "font:14px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif";

  const inner = document.createElement("div");
  inner.style.cssText = "max-width:560px";

  const title = document.createElement("h1");
  title.style.cssText = "margin:0 0 8px;font-size:20px;font-weight:600";
  title.textContent = "Configuration error";

  const lead = document.createElement("p");
  lead.style.cssText = "margin:0 0 16px;color:#9fb2c8";
  lead.textContent =
    "The app is missing one or more required settings and cannot start. " +
    "L'application n'a pas pu démarrer : configuration incomplète.";

  const pre = document.createElement("pre");
  pre.style.cssText =
    "margin:0;padding:12px 14px;border-radius:8px;background:#111c2e;" +
    "border:1px solid #1e2d45;color:#ffb4b4;white-space:pre-wrap;" +
    "font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace";
  pre.textContent = detail;

  inner.append(title, lead, pre);
  box.append(inner);
  rootEl.replaceChildren(box);
}

// Après un déploiement, un onglet ouvert avant garde l'ancien index.html et
// réclame des chunks hachés qui n'existent plus (« Failed to fetch dynamically
// imported module »). Vite émet `vite:preloadError` pour tout import() raté :
// on recharge la page pour récupérer le nouveau build. Garde-fou de 10 s en
// sessionStorage pour ne pas boucler si le chunk manque vraiment (panne réseau).
window.addEventListener("vite:preloadError", (event) => {
  const KEY = "arakice:chunk-reload-at";
  let last = 0;
  try { last = Number(sessionStorage.getItem(KEY)) || 0; } catch { /* stockage bloqué */ }
  if (Date.now() - last < 10_000) return; // déjà rechargé : laisser l'erreur remonter
  try { sessionStorage.setItem(KEY, String(Date.now())); } catch { /* idem */ }
  event.preventDefault();
  window.location.reload();
});

try {
  // Throws when a required variable is missing or not https in production.
  // The check lives in a function rather than at import time on purpose: a
  // module that throws while being evaluated cannot be caught by its importer,
  // and the user would get the white page this whole item exists to remove.
  assertEnv();

  // APPLE_PLAN 3.9 — iOS shell glue (external links). Not in the web bundle.
  // Inline literal (not `isIOS`) so Rollup drops the branch — and the chunk — from the web build.
  if (import.meta.env.VITE_TARGET === "ios") void import("./app/native").then((m) => m.installNativeShell());
  createRoot(rootEl).render(<App />);

  // Register the service worker (PWA install + push notifications).
  // R6 — WKWebView has no service worker, and iOS notifications go through
  // APNs, so the iOS build must not try to register one.
  if (features.serviceWorker && "serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        console.warn("[SW] registration failed:", err);
      });
    });
  }
} catch (err) {
  console.error("[boot] the app could not start:", err);
  captureException(err);
  renderConfigError(err);
}
