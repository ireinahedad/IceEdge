import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/react";
import { env, envProblems, assertEnv } from "./app/env";
import { features } from "./app/platform";
import App from "./app/App";
import "./styles/index.css";

/**
 * Remplace la valeur de tout `access_token=` (ou `refresh_token=`) dans une URL.
 *
 * Deuxième filet, pas le premier : le callback Google passe désormais par le
 * fragment et efface l'URL dès son premier effet (`AuthCallback.tsx`). Celui-ci
 * couvre ce qui échappe à ça — un fil d'Ariane posé par Sentry avant que React
 * n'ait rendu quoi que ce soit, une URL construite ailleurs, ou le jour où
 * quelqu'un remet un jeton dans une chaîne de requête sans y penser.
 *
 * Volontairement une regex sur la chaîne, et non un parcours d'`URL` : la valeur
 * doit disparaître même d'une URL malformée, et un `URL()` qui lève sur une
 * chaîne bizarre ferait perdre l'événement entier.
 */
const TOKEN_IN_URL = /\b((?:access|refresh)_token)=[^&#\s]*/gi;
function redactTokens<T>(value: T): T {
  return (typeof value === "string" ? value.replace(TOKEN_IN_URL, "$1=[redacted]") : value) as T;
}

// Error monitoring — no-op unless VITE_SENTRY_DSN is set (dev stays quiet).
if (env.sentryDsn) {
  Sentry.init({
    dsn: env.sentryDsn,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,

    // L'URL de la page voyage avec CHAQUE événement, et les fils d'Ariane de
    // navigation en portent une copie : masquer l'un sans l'autre ne sert à rien.
    beforeSend(event) {
      if (event.request?.url) event.request.url = redactTokens(event.request.url);
      for (const b of event.breadcrumbs ?? []) {
        if (b.data?.from) b.data.from = redactTokens(b.data.from);
        if (b.data?.to)   b.data.to   = redactTokens(b.data.to);
        if (typeof b.message === "string") b.message = redactTokens(b.message);
      }
      return event;
    },

    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.data?.from) breadcrumb.data.from = redactTokens(breadcrumb.data.from);
      if (breadcrumb.data?.to)   breadcrumb.data.to   = redactTokens(breadcrumb.data.to);
      if (typeof breadcrumb.message === "string") breadcrumb.message = redactTokens(breadcrumb.message);
      return breadcrumb;
    },
  });
}

// PRE_IOS_PLAN.md R7 — report every configuration problem before assertEnv()
// acts on it, so Sentry carries the diagnosis even when the next line stops the
// app. Sentry is initialised above, so these are not lost.
for (const problem of envProblems) {
  Sentry.captureMessage(`[env] ${problem.message}`, "error");
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

try {
  // Throws when a required variable is missing or not https in production.
  // The check lives in a function rather than at import time on purpose: a
  // module that throws while being evaluated cannot be caught by its importer,
  // and the user would get the white page this whole item exists to remove.
  assertEnv();

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
  Sentry.captureException(err);
  renderConfigError(err);
}
