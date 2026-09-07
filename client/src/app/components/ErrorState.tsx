/**
 * ErrorState — le message d'échec et son bouton « Réessayer ».
 *
 * Existe pour une raison précise : avant lui, un écran qui n'arrivait pas à
 * charger affichait au mieux une ligne rouge muette (`schedule.error`), au pire
 * l'état vide de la même page — « aucun match ce soir » pour un réseau coupé.
 * Dans les deux cas le seul recours était de recharger l'application.
 *
 * Il ne prend PAS l'erreur en charge : il prend un `onRetry`, et c'est l'écran
 * qui sait ce que « recharger » veut dire chez lui. Un composant qui devinerait
 * quoi rappeler serait un routeur déguisé.
 *
 * ⚠️ Le bouton passe par `AppButton` et non par un bouton dessiné à la main :
 * c'est exactement la dérive (cyan/vert/violet mélangés pour la même action)
 * que `AppButton` a été créé pour arrêter.
 */

import { AlertTriangle } from "lucide-react";
import { AppButton } from "./AppButton";
import { useI18n } from "../i18n";
import { isRequestTimeout } from "../services/http";

export function ErrorState({
  onRetry,
  error,
  title,
  hint,
  retrying = false,
  compact = false,
  className = "",
}: {
  /** Rejoue le chargement de l'écran. */
  onRetry: () => void;
  /** L'erreur attrapée, seulement pour choisir le titre (délai dépassé ou non). */
  error?: unknown;
  /** Titre imposé — sinon il est déduit de `error`. */
  title?: string;
  /** Sous-titre imposé — passer `null` pour n'en afficher aucun. */
  hint?: string | null;
  /** Grise le bouton pendant que le rechargement est en vol. */
  retrying?: boolean;
  /** Version en ligne, pour un panneau déjà étroit (onglet, encart). */
  compact?: boolean;
  className?: string;
}) {
  const { t } = useI18n();

  // Un délai dépassé et un serveur injoignable ne se disent pas pareil :
  // « ça prend trop de temps » invite à réessayer, « impossible de charger »
  // laisse croire que c'est définitif.
  const heading = title ?? (isRequestTimeout(error) ? t("common.timedOut") : t("common.loadFailed"));
  const sub = hint === null ? null : (hint ?? t("common.loadFailedHint"));

  return (
    <div
      role="alert"
      className={`flex flex-col items-center justify-center text-center gap-3 ${compact ? "py-6 px-4" : "py-14 px-6"} ${className}`}
    >
      <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/25 flex items-center justify-center">
        <AlertTriangle size={20} className="text-red-400" />
      </div>

      <div>
        <p className="text-white font-bold text-sm">{heading}</p>
        {sub && <p className="text-[#8a9ea6] text-xs mt-1 leading-relaxed">{sub}</p>}
      </div>

      {/* `tap-44` : la cible tactile minimale iOS, posée hors couche Tailwind
          dans theme.css. Sans elle un bouton de 32 px de haut est refusé en
          revue d'accessibilité. */}
      <AppButton variant="ghost" size="sm" onClick={onRetry} loading={retrying} className="tap-44 mt-1">
        {t("common.retry")}
      </AppButton>
    </div>
  );
}
