import * as Sentry from "@sentry/react";
import { useI18n } from "../i18n";
import { env } from "../env";

/**
 * ErrorScreen — l'écran unique affiché quand un rendu plante.
 *
 * Deux filets le montrent : `ErrorBoundary` (autour de toute l'app) et
 * l'`errorElement` du routeur (`RouteError`, qui attrape les erreurs AVANT
 * qu'elles ne remontent jusqu'à la boundary). Avant, chacun dessinait le sien,
 * en français codé en dur, et aucun des deux ne prévenait Sentry — une erreur
 * attrapée par React n'atteint jamais le gestionnaire global.
 *
 * Trois variantes, choisies d'après l'erreur :
 *   offline — le navigateur se sait hors ligne : c'est presque toujours la
 *             vraie cause (chunk introuvable, fetch raté), et « ça a planté »
 *             serait faux.
 *   update  — chunk d'un ancien build introuvable après un déploiement.
 *   crash   — tout le reste.
 *
 * `useI18n` a une valeur par défaut (anglais) : l'écran reste lisible même si
 * l'erreur vient d'au-dessus de LanguageProvider.
 */

const CHUNK_ERROR = /dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError/i;

export function isChunkError(error: unknown): boolean {
  return error instanceof Error && (error.name === "ChunkLoadError" || CHUNK_ERROR.test(error.message));
}

/**
 * Envoie l'erreur à Sentry et rend l'identifiant de l'événement, ou `undefined`
 * quand Sentry n'est pas configuré. Les chunks manquants ne sont pas remontés :
 * c'est le bruit normal d'un déploiement, déjà traité par `vite:preloadError`.
 */
export function reportError(error: unknown, componentStack?: string): string | undefined {
  if (!env.sentryDsn || isChunkError(error)) return undefined;
  return Sentry.captureException(error, componentStack ? { contexts: { react: { componentStack } } } : undefined);
}

export function ErrorScreen({ error, eventId }: { error: unknown; eventId?: string }) {
  const { t } = useI18n();
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const variant = offline ? "offline" : isChunkError(error) ? "update" : "crash";

  const title = variant === "offline" ? t("error.offlineTitle") : variant === "update" ? t("error.updateTitle") : t("error.title");
  const body  = variant === "offline" ? t("error.offlineBody")  : variant === "update" ? t("error.updateBody")  : t("error.body");
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center min-h-screen text-white max-w-[430px] mx-auto px-6 text-center"
      style={{ background: "#0A0E0C" }}
    >
      <p className="text-5xl mb-4" aria-hidden="true">{variant === "offline" ? "📡" : variant === "update" ? "✨" : "🧊"}</p>
      <h1 className="text-white font-bold text-lg mb-2">{title}</h1>
      <p className="text-[#92A08A] text-sm mb-8">{body}</p>

      <div className="flex flex-col gap-2 w-full max-w-[260px]">
        <button
          onClick={() => window.location.reload()}
          className="px-6 py-2.5 rounded-xl text-sm font-bold active:scale-[0.98] transition-all"
          style={{ background: "#86d1ea", color: "#0A0E0C" }}
        >
          {variant === "update" ? t("error.reload") : t("common.retry")}
        </button>
        {variant !== "update" && (
          <button
            onClick={() => window.location.assign("/")}
            className="px-6 py-2.5 rounded-xl text-sm border border-white/10 text-white/80"
          >
            {t("share.goHome")}
          </button>
        )}
      </div>

      {/* Un identifiant à recopier au support : sans lui, retrouver l'événement
          Sentry d'un utilisateur précis est impossible. */}
      {eventId && (
        <p className="text-white/30 text-[11px] mt-6 select-all">
          {t("error.code", { id: eventId.slice(0, 8) })}
        </p>
      )}

      {import.meta.env.DEV && variant === "crash" && (
        <pre className="mt-6 w-full text-left text-[11px] leading-snug p-3 rounded-lg overflow-auto max-h-48 whitespace-pre-wrap"
          style={{ background: "#131A12", border: "1px solid #283323", color: "#ffb4b4" }}>
          {detail}
        </pre>
      )}
    </div>
  );
}
