/**
 * sentry.ts — Sentry chargé APRÈS le premier rendu.
 *
 * QA P4 (LCP mobile, 2026-10-13) : `@sentry/react` pesait ~70 ko dans le bundle
 * principal et s'initialisait avant le rendu. Il vit maintenant dans un chunk à
 * part (`sentryImpl.ts`), chargé à l'événement `load` puis quand le navigateur est
 * inactif (au plus 4 s après).
 *
 * Rien n'est perdu en attendant :
 *   · `captureException` / `captureMessage` mettent l'appel en file et rendent
 *     TOUT DE SUITE l'identifiant de l'événement (généré ici, transmis à Sentry
 *     par `event_id`) — `ErrorScreen` peut l'afficher sans attendre ;
 *   · les erreurs non attrapées (`error`, `unhandledrejection`) sont écoutées dès
 *     maintenant et rejouées ; une fois Sentry initialisé, ses propres
 *     gestionnaires prennent le relais et les nôtres sont retirés.
 * Sans `VITE_SENTRY_DSN`, tout est sans effet (dev silencieux), comme avant.
 */
import { env } from "./env";

type Ctx = Record<string, unknown> | undefined;
type Op =
  | { t: "exception"; error: unknown; id: string; ctx: Ctx }
  | { t: "message"; msg: string; level: string; id: string };

const queue: Op[] = [];
let impl: typeof import("./sentryImpl") | null = null;
let started = false;

function newId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function run(op: Op) {
  if (!impl) { queue.push(op); return; }
  if (op.t === "exception") impl.captureException(op.error, op.id, op.ctx);
  else impl.captureMessage(op.msg, op.level, op.id);
}

/** Identifiant de l'événement, ou `undefined` si Sentry n'est pas configuré. */
export function captureException(error: unknown, contexts?: Ctx): string | undefined {
  if (!env.sentryDsn) return undefined;
  const id = newId();
  run({ t: "exception", error, id, ctx: contexts });
  return id;
}

export function captureMessage(msg: string, level: "error" | "warning" | "info" = "error"): string | undefined {
  if (!env.sentryDsn) return undefined;
  const id = newId();
  run({ t: "message", msg, level, id });
  return id;
}

const onError = (e: ErrorEvent) => { captureException(e.error ?? e.message); };
const onRejection = (e: PromiseRejectionEvent) => { captureException(e.reason); };

/** À appeler une fois, au démarrage (main.tsx). */
export function startSentry(): void {
  if (!env.sentryDsn || started) return;
  started = true;
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  const load = () => {
    import("./sentryImpl")
      .then((m) => {
        m.init();
        window.removeEventListener("error", onError);
        window.removeEventListener("unhandledrejection", onRejection);
        impl = m;
        queue.splice(0).forEach(run);
      })
      .catch(() => { /* chunk introuvable (déploiement) : vite:preloadError recharge */ });
  };
  const idle = () => {
    const w = window as any;
    if (w.requestIdleCallback) w.requestIdleCallback(load, { timeout: 4000 });
    else window.setTimeout(load, 1500);
  };
  if (document.readyState === "complete") idle();
  else window.addEventListener("load", idle, { once: true });
}
