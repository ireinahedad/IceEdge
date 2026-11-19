import { useEffect, useSyncExternalStore } from "react";
import { useGeo } from "../services/geo";
import { useI18n } from "../i18n";
import {
  analyticsActive, consentRequired, onConsentChange, readConsent, resolveRegion, setConsent,
} from "../analytics";

/**
 * Bandeau de consentement aux cookies (2026-11-18) — Europe, Royaume-Uni et
 * Suisse seulement (voir `analytics.ts`). « Accepter » et « Refuser » ont le
 * même poids, comme l'exige la CNIL : refuser ne doit pas être plus difficile.
 * Posé au-dessus de la barre d'onglets du bas.
 */
export function ConsentBanner() {
  const { t } = useI18n();
  const geo = useGeo();
  // Relit l'état à chaque réponse, réinitialisation ou chargement de Clarity.
  const snapshot = useSyncExternalStore(
    onConsentChange,
    () => `${analyticsActive()}|${readConsent() ?? ""}`,
    () => "false|",
  );
  const [active, choice] = snapshot.split("|");

  useEffect(() => { resolveRegion(geo.country); }, [geo.country, active, choice]);

  if (active !== "true" || choice || !consentRequired(geo.country)) return null;

  return (
    <div
      role="dialog"
      aria-live="polite"
      aria-label={t("consent.title")}
      className="fixed left-1/2 -translate-x-1/2 w-[94%] max-w-[420px] z-[60] rounded-2xl border border-white/15 p-4 shadow-2xl"
      style={{
        bottom: "calc(5.5rem + env(safe-area-inset-bottom, 0px))",
        background: "rgba(10, 22, 30, 0.96)",
        backdropFilter: "blur(18px)",
      }}
    >
      <p className="text-white text-sm font-semibold mb-1">{t("consent.title")}</p>
      <p className="text-[#bfc8cc] text-xs leading-relaxed mb-3">
        {t("consent.body")}{" "}
        {/* <a>, pas <Link> : ce bandeau est rendu HORS du RouterProvider (App.tsx).
            Un <Link> hors routeur lève une erreur → écran « Something went wrong »
            pour TOUS les visiteurs européens (corrigé 2026-11-19). */}
        <a href="/privacy" className="underline text-white">{t("consent.more")}</a>
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setConsent("denied")}
          className="flex-1 h-10 rounded-xl border border-white/20 bg-white/[0.06] text-white text-sm font-semibold active:scale-95 transition-transform"
        >
          {t("consent.refuse")}
        </button>
        <button
          type="button"
          onClick={() => setConsent("granted")}
          className="flex-1 h-10 rounded-xl border border-white/20 bg-white/[0.06] text-white text-sm font-semibold active:scale-95 transition-transform"
        >
          {t("consent.accept")}
        </button>
      </div>
    </div>
  );
}
