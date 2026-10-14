/**
 * sentryImpl.ts — le vrai Sentry, dans son propre chunk (chargé par `sentry.ts`
 * après le premier rendu). Configuration inchangée depuis main.tsx.
 */
import * as Sentry from "@sentry/react";
import { env } from "./env";
import { isIOS } from "./platform";

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

export function init(): void {
  if (!env.sentryDsn) return;
  Sentry.init({
    dsn: env.sentryDsn,
    // iOS errors are tagged apart from the web ones (same DSN).
    environment: isIOS ? `${import.meta.env.MODE}-ios` : import.meta.env.MODE,
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

/** `event_id` imposé : `sentry.ts` l'a déjà rendu à l'appelant (ErrorScreen l'affiche). */
export function captureException(error: unknown, id: string, contexts?: Record<string, unknown>): void {
  Sentry.captureException(error, { event_id: id, ...(contexts ? { captureContext: { contexts } as any } : {}) });
}

// `Sentry.captureMessage` n'accepte pas d'EventHint (2e argument = niveau ou contexte) :
// on passe par le scope, qui prend (message, niveau, hint).
export function captureMessage(msg: string, level: string, id: string): void {
  Sentry.getCurrentScope().captureMessage(msg, level as Sentry.SeverityLevel, { event_id: id });
}
