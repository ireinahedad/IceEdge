/**
 * EvSection.tsx
 *
 * Extrait de HockeyLanding.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { useNavigate } from "react-router";
import { Zap, Settings, Lightbulb } from "lucide-react";
import { ProLock } from "../../components/ProLock";
import { useI18n } from "../../i18n";


// ─── Value Bets (EV) — Pro only ─────────────────────────────────────────────

export interface EvItem {
  id: string;
  logo: string;
  label: string;
  context: string;
  pct: number;   // model probability
  edge: number;  // model% − implied%
}

// Static, realistic-looking rows shown (blurred) to non-Pro users so they can
// see what the feature looks like without exposing real value bets.
// (Le tennis est sorti du produit le 2026-08-24 : plus de ligne tennis ici.)
export const EV_SAMPLE: EvItem[] = [
  { id: "ev-s1", logo: "🏒", label: "TOR ML vs MTL",       context: "Value spot", pct: 58, edge: 11 },
  { id: "ev-s2", logo: "🏒", label: "Over 5.5 · BOS–FLA",  context: "Value spot", pct: 63, edge: 9 },
  { id: "ev-s3", logo: "🏒", label: "EDM ML vs CGY",       context: "Value spot", pct: 61, edge: 8 },
];

/**
 * Une ligne de value bet, lisible sans connaître le jargon (2026-09-27) :
 * « +11 pts » en vert = l'écart, et dessous les deux chances qui le font —
 * celle du modèle contre celle que suppose la cote du bookmaker. La chance du
 * livre se déduit de l'écart (`edge = modèle − implicite`, `calcEdge`).
 */
export function EvRow({ item }: { item: EvItem }) {
  const { t } = useI18n();
  const bookPct = item.pct - item.edge;
  return (
    <div className="flex items-center gap-2.5 icy-card rounded-xl px-2.5 py-2">
      {item.logo?.startsWith("http")
        ? <img src={item.logo} alt="" className="w-5 h-5 object-contain flex-shrink-0" />
        : <span className="text-base flex-shrink-0">{item.logo}</span>}
      <div className="flex-1 min-w-0">
        <div className="text-white text-[11px] font-medium truncate">{item.label}</div>
        <div className="text-[#8a9ea6] text-[11px] truncate">{item.context}</div>
      </div>
      <div className="text-right flex-shrink-0">
        <div className="text-green-400 text-[11px] font-bold tabular-nums">{t("home.evEdge", { edge: item.edge })}</div>
        <div className="text-[#bfc8cc] text-[11px] tabular-nums">
          {t("home.evVs", { model: item.pct, book: bookPct })}
        </div>
      </div>
    </div>
  );
}

export function EvSection({ isPro, items, isLoading, accent }: {
  isPro: boolean; items: EvItem[]; isLoading: boolean; accent: string;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();

  const list = (rows: EvItem[]) => (
    <div className="flex flex-col gap-1.5">{rows.map((i) => <EvRow key={i.id} item={i} />)}</div>
  );

  return (
    <section className="px-4">
      <div className="flex items-center gap-2 mb-3">
        <Zap size={13} style={{ color: accent }} />
        <span className="text-white text-sm font-medium">{t("home.evTitle")}</span>
        {/* « Réglages des alertes » ouvrait /profile, c'est-à-dire l'onglet
            Aperçu : il fallait ensuite trouver Paramètres, puis faire défiler
            jusqu'aux notifications. Le lien porte maintenant l'onglet ET la
            section (`ProfilePage` lit `focus=notifications`). */}
        {isPro && (
          <button
            onClick={() => navigate("/profile?tab=settings&focus=notifications")}
            aria-label={t("home.evSettings")}
            title={t("home.evSettings")}
            className="ml-auto flex items-center gap-1 text-white/50 hover:text-white transition-colors"
          >
            <Settings size={13} />
            <span className="text-[11px]">{t("home.evSettings")}</span>
          </button>
        )}
      </div>

      {/* Ce qu'est un value bet, pour quelqu'un qui n'a jamais parié
          (2026-09-27). Toujours visible : c'est la clé de lecture des lignes. */}
      {isPro && (
        <div className="flex gap-2 rounded-xl px-3 py-2.5 mb-3"
          style={{ background: "rgba(74,222,128,0.06)", border: "1px solid rgba(74,222,128,0.18)" }}>
          <Lightbulb size={14} className="flex-shrink-0 mt-0.5 text-green-400" />
          <div className="text-[11px] leading-relaxed text-[#bfc8cc]">
            <p><span className="font-bold text-white">{t("home.evWhatTitle")}</span> {t("home.evWhat")}</p>
            <p className="mt-1 text-[#8a9ea6]">{t("home.evExample")}</p>
            <p className="mt-1 text-[#8a9ea6]">{t("home.evHowToRead")}</p>
          </div>
        </div>
      )}

      {isPro ? (
        isLoading ? (
          <div className="flex flex-col gap-1.5">{[1, 2, 3].map((i) => <div key={i} className="h-11 icy-tile rounded-xl animate-pulse" />)}</div>
        ) : items.length === 0 ? (
          <div className="py-6 text-center text-[#bfc8cc] text-xs">{t("home.evEmpty")}</div>
        ) : list(items)
      ) : (
        <ProLock locked title={t("home.evTitle")} description={t("home.evLockDesc")}>
          {list(EV_SAMPLE)}
        </ProLock>
      )}
    </section>
  );
}
