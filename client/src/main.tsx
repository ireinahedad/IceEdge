import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/react";
import App from "./app/App.tsx";
import "./styles/index.css";

// Error monitoring — no-op unless VITE_SENTRY_DSN is set (dev stays quiet).
if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
  });
}

createRoot(document.getElementById("root")!).render(<App />);

// Register the service worker (PWA install + push notifications).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[SW] registration failed:", err);
    });
  });
}
