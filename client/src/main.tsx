import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/react";
import { env, envProblems, assertEnv } from "./app/env";
import App from "./app/App";
import "./styles/index.css";

// Error monitoring — no-op unless VITE_SENTRY_DSN is set (dev stays quiet).
if (env.sentryDsn) {
  Sentry.init({
    dsn: env.sentryDsn,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
  });
}

// PRE_IOS_PLAN.md R7, stage 1 — a missing or non-https API URL is reported,
// not fatal. env.ts already logged it to the console; this is how it reaches
// you in production. Sentry is initialised above, so these are not lost.
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
  // Stage 1: no-op. Stage 2 (ENFORCEMENT = 'throw' in env.ts): throws here,
  // which is why the check lives in a function rather than at import time —
  // a module that throws while being evaluated cannot be caught by its importer.
  assertEnv();

  createRoot(rootEl).render(<App />);

  // Register the service worker (PWA install + push notifications).
  if ("serviceWorker" in navigator) {
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
