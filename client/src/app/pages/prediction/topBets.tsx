/**
 * topBets.tsx — section « Top 90% + » de la page Prédiction
 * (2026-10-13, demande du user).
 *
 * Elle rassemble les paris DE LA PAGE dont le chiffre ML atteint 90 % ou plus.
 *
 * ── D'où viennent les paris ─────────────────────────────────────────────────
 *
 * Chaque producteur de tuiles — `MarketGroup` et `PlayerPropGrid` — déclare
 * ses options dans un registre (`useRegisterTopBets`), qu'il soit plié ou non :
 * plier un groupe ne le retire pas du Top. Les grilles joueur déclarent TOUS
 * leurs joueurs, des deux équipes, et pas seulement le top 5 affiché.
 *
 * Le registre lui-même vit dans `topBetsRegistry.tsx`.
 *
 * ── Le chiffre ──────────────────────────────────────────────────────────────
 *
 * Le même que celui de la tuile : `mlPreset.probability`. Toutes les tuiles de
 * ces pages sont `mlExternal` (chiffre fourni par leur conteneur), donc le Top
 * n'a aucun appel à faire. Les tuiles du Top sont les MÊMES `BetOption` :
 * fiche, coupon et prix du livre compris.
 */
import { useContext, useMemo } from "react";
import { ChevronDown } from "lucide-react";
import { useI18n } from "../../i18n";
import type { BetOpt } from "./gameMarkets";
import { BetOption, isDecidedLive } from "./PredictionSheet";
import { GameLiveCtx } from "./predictionShared";
import { useSectionFold } from "./foldAll";
import { TopBetsDataCtx } from "./topBetsRegistry";

/** Seuil du Top, en pourcentage ML. */
export const TOP_PCT = 90;

const mlPctOf = (o: BetOpt): number | null =>
  typeof o.mlPreset?.probability === "number" ? o.mlPreset.probability : null;

export function TopBetsSection({ accent }: { accent: string }) {
  const { t } = useI18n();
  const data = useContext(TopBetsDataCtx);
  const gameLive = useContext(GameLiveCtx);
  // Fermée par défaut : c'est « un bouton qui ouvre » la section.
  const [collapsed, toggle] = useSectionFold("top90", true);

  const { top, pending } = useMemo(() => {
    const seen = new Set<string>();
    const top: { opt: BetOpt; pct: number }[] = [];
    let pending = false;
    for (const opts of Object.values(data)) {
      for (const o of opts) {
        if (seen.has(o.id)) continue;
        seen.add(o.id);
        if (o.mlPreset === undefined) { pending = true; continue; }
        const pct = mlPctOf(o);
        if (pct == null || pct < TOP_PCT) continue;
        // Pari déjà tranché pendant le match : plus rien à parier.
        if (gameLive && isDecidedLive(o)) continue;
        top.push({ opt: o, pct });
      }
    }
    top.sort((a, b) => b.pct - a.pct);
    return { top, pending };
  }, [data, gameLive]);

  return (
    <div
      className="rounded-2xl overflow-hidden border"
      style={{ background: "#0A0E0C", borderColor: accent + "55" }}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="w-full flex items-center gap-2 px-4 py-3"
        style={{ borderBottom: collapsed ? "none" : "1px solid rgba(255,255,255,0.06)" }}
      >
        <span className="text-xs font-bold uppercase tracking-wider" style={{ color: accent }}>
          {t("pred.top90")}
        </span>
        <span
          className="text-[10px] font-bold tabular-nums px-1.5 py-0.5 rounded-full"
          style={{ background: accent + "22", color: accent }}
        >
          {pending && top.length === 0 ? "…" : top.length}
        </span>
        <ChevronDown
          size={14}
          className="ml-auto text-[#3a5060] transition-transform"
          style={{ transform: collapsed ? "rotate(0deg)" : "rotate(180deg)" }}
        />
      </button>
      {!collapsed && (
        <div className="p-3 flex flex-col gap-2">
          <p className="text-[#8a9ea6] text-[11px] px-0.5">{t("pred.top90Hint")}</p>
          {top.length === 0 ? (
            <p className="text-[#8a9ea6] text-xs text-center py-4">
              {pending ? t("pred.top90Loading") : t("pred.top90Empty")}
            </p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {top.map(({ opt }) => <BetOption key={opt.id} opt={opt} accent={accent} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
