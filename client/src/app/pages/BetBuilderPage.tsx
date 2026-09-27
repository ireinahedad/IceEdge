/**
 * BetBuilderPage.tsx — coquille du constructeur de coupon.
 *
 * Ce fichier faisait 739 lignes ; il a été découpé le 2026-08-10 en 3 fichiers
 * sans toucher une ligne de code — seuls les imports et les `export` ont été
 * ajoutés. Il ne reste ici que les onglets et l'assemblage.
 *
 *   bet/betParts.tsx    toOddsLabel, ProbabilityGauge, LegCard, EmptySlip,
 *                       LockSlipCTA
 *   bet/MySlipsTab.tsx  SlipCard + l'onglet historique des coupons
 *
 * `BetBuilderPage` reste le seul export public : `routes.tsx` est inchangé.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Plus, Lightbulb, Trash2 } from "lucide-react";
import { useBet } from "../context/BetContext";
import { useAuth } from "../context/AuthContext";
import { MarketSelectorSheet } from "../components/MarketSelectorSheet";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { BottomNav } from "../components/BottomNav";
import { getMySlips, submitSlip } from "../services/slipApiService";
import { isRequestTimeout } from "../services/http";
import { useSport } from "../context/SportContext";
import { useI18n } from "../i18n";
import { readMode, type AppearanceMode } from "../appearance";
import { toast } from "sonner";
import "./bet-theme.css";
import { MySlipsTab } from "./bet/MySlipsTab";
import "../components/rink-theme.css";
import { EmptySlip, LegCard, LockSlipCTA, ProbabilityGauge, SlipNotices, impliedDecimal, toOddsLabel } from "./bet/betParts";
import { useOddsFormat } from "../context/OddsFormatContext";
import { fetchLegPrices } from "../services/oddsApiService";
import { BookPricePill } from "../components/BookPricePill";


// ─── Main page ─────────────────────────────────────────────────────────────────

type PageTab = "build" | "slips";

export function BetBuilderPage() {
  const { legs, removeLeg, clearSlip, combinedProbability, slipAnalysis } = useBet();
  const { user } = useAuth();
  const { sport } = useSport();
  const { t } = useI18n();
  // Cote équivalente sous la jauge : suit le format des Réglages (voir `impliedDecimal`).
  const { odds } = useOddsFormat();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<PageTab>(searchParams.get("tab") === "slips" ? "slips" : "build");
  // Apparence sombre / claire — réglage partagé, cf. `appearance.ts`.
  const [mode] = useState<AppearanceMode>(readMode);
  const [showSheet, setShowSheet] = useState(false);
  // Vrais prix Betano Ontario des jambes, par id — voir `POST /api/odds/legs`.
  const [legPrices, setLegPrices] = useState<Record<string, { price: number; bookTitle: string }>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  // `message` vient du serveur ; il était jeté à la réception puis lu au rendu,
  // donc le sous-titre de l'écran de succès était vide depuis toujours.
  const [submitResult, setSubmitResult] = useState<{ slipId: string; message?: string } | null>(null);
  // ⚠️ Cet état était ÉCRIT et jamais LU : aucune ligne du rendu ne le
  // mentionnait. Un verrouillage raté — un délai dépassé sur un coupon de trois
  // matchs, par exemple — laissait donc l'écran exactement comme avant le clic,
  // ce qui ne se distingue pas d'un bouton mort. Il est maintenant passé à
  // `LockSlipCTA`, c'est-à-dire là où le pouce se trouve déjà, ET doublé d'un
  // toast pour le cas où le bloc serait hors champ.
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // ── Vrais prix des jambes ─────────────────────────────────────────────────
  // Rechargés quand la COMPOSITION du coupon change (pas à chaque rendu). Un
  // échec rend `{}` : les jambes restent sans prix, rien d'autre ne bouge.
  const legsKey = legs.map((l) => `${l.id}|${l.gameId ?? ""}|${l.selectionValue ?? ""}|${l.line ?? ""}`).join(",");
  useEffect(() => {
    let alive = true;
    fetchLegPrices(legs.map((l) => ({
      id: l.id, gameId: l.gameId ?? "", marketType: l.marketType,
      selectionValue: l.selectionValue ?? "", line: l.line ?? null,
    }))).then((p) => { if (alive) setLegPrices(p); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legsKey]);

  // Cote combinée RÉELLE : produit des prix, mais seulement si TOUTES les
  // jambes sont cotées et portent sur des matchs DIFFÉRENTS. Deux jambes du
  // même match sont corrélées, et un livre ne paie pas leur produit — il
  // refuserait ou reprixerait le combiné. Dans ce cas, rien plutôt qu'un faux.
  const bookCombined = (() => {
    if (legs.length < 2) return null;
    const games = new Set(legs.map((l) => l.gameId));
    if (games.size !== legs.length || games.has(undefined)) return null;
    let prod = 1;
    for (const l of legs) {
      const p = legPrices[l.id]?.price;
      if (!p) return null;
      prod *= p;
    }
    return Math.round(prod * 100) / 100;
  })();

  // ── Nombre de coupons EN COURS, affiché sur l'onglet « Mes paris » ─────────
  // La page le lit elle-même : `MySlipsTab` n'est monté que lorsque son onglet
  // est ouvert, or c'est justement depuis l'onglet « Créer » qu'on a besoin du
  // chiffre. Une fois l'onglet ouvert, c'est `MySlipsTab` qui le tient à jour
  // (règlement, rechargement) via `onPendingCount` — pas de second appel.
  // `null` = inconnu (déconnecté, ou chargement raté) : pas de pastille plutôt
  // qu'un « 0 » faux.
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  // Incrémenté après un verrouillage réussi : un coupon de plus est en cours.
  const [slipsVersion, setSlipsVersion] = useState(0);

  useEffect(() => {
    if (!user) { setPendingCount(null); return; }
    let alive = true;
    getMySlips(100)
      .then((all) => { if (alive) setPendingCount(all.filter((s) => s.outcome === "pending").length); })
      .catch(() => { /* la pastille reste sur sa dernière valeur connue */ });
    return () => { alive = false; };
    // `user?.id` et non `user` : même raison que dans MySlipsTab.
  }, [user?.id, slipsVersion]);

  // ── Marge basse sous le bloc « prêts à verrouiller » ────────────────────────
  // Ce bloc est `fixed` : il ne pousse rien et recouvrait la fin de l'onglet
  // Build (la carte « comment on calcule »), qu'aucun défilement ne pouvait
  // faire remonter. On MESURE sa hauteur plutôt que de la coder en dur : elle
  // change avec la langue et avec la largeur de l'écran, et le 160px figé
  // d'avant était déjà trop court en anglais.
  const ctaRef = useRef<HTMLDivElement | null>(null);
  // Valeur de départ ~ la hauteur réelle, pour qu'il n'y ait pas de saut entre
  // la première peinture et la première mesure.
  const [ctaHeight, setCtaHeight] = useState(150);

  useLayoutEffect(() => {
    const el = ctaRef.current;
    if (!el) return;
    const measure = () => setCtaHeight(el.getBoundingClientRect().height);
    measure();
    // Le contenu du bloc bouge tout seul (« Submitting… », le texte de
    // visibilité qui passe à la ligne) : un observateur, pas une mesure unique.
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tab, legs.length]);

  // 68px = l'écart entre le bas de l'écran et le bloc (`bottom-[68px]`, il
  // laisse passer BottomNav), 16px = de l'air sous le dernier élément.
  // L'inset du bas s'ajoute à tout ça : la nav et le bloc CTA sont eux-mêmes
  // remontés de `env(safe-area-inset-bottom)`.
  const buildPaddingBottom =
    legs.length > 0
      ? `calc(${Math.ceil(ctaHeight) + 68 + 16}px + env(safe-area-inset-bottom, 0px))`
      : "calc(112px + env(safe-area-inset-bottom, 0px))";

  async function handleLock() {
    if (!user) {
      navigate("/login?returnTo=/bet");
      return;
    }
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const slipLegs = legs.map((l) => ({
        marketType:     l.marketType,
        subjectId:      l.subjectId,
        subjectName:    l.subjectName,
        subjectLogo:    l.subjectLogo,
        selection:      l.selection,
        line:           l.line,
        probability:    l.probability,
        oddsLabel:      toOddsLabel(l.probability),
        // Machine-readable fields — without these the slip can never be
        // auto-settled and stays "pending" forever, even for simple markets.
        gameId:         l.gameId,
        selectionValue: l.selectionValue,
      }));
      const { slipId, message } = await submitSlip(slipLegs, sport, combinedProbability);
      setSubmitResult({ slipId, message });
      clearSlip();
      setSlipsVersion((v) => v + 1);
    } catch (err: any) {
      // Un délai dépassé n'est pas un refus : le coupon n'est pas invalide, le
      // serveur a simplement mis trop longtemps. Le dire évite qu'on retire des
      // paris en croyant que c'est le coupon qui pose problème.
      const message = isRequestTimeout(err)
        ? t("slip.lockTimeout")
        : (err?.message || t("slip.lockFailed"));
      setSubmitError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div
      className={`relative flex flex-col min-h-screen text-white max-w-[430px] md:max-w-5xl mx-auto w-full ${mode === "light" ? "bet-light" : "bet-dark"}`}
      style={{ background: mode === "light" ? "#D4FFEE" : "#0A0E0C" }}
    >
      {/* Bandeau en verre dépoli (`.rink-header-glass`, rink-theme.css) : on
          devine la maille du filet derrière, les onglets restent lisibles.
          Il a été opaque un temps — le verre ICY d'origine, trop clair,
          mangeait la rondelle ; c'est le voile sombre qui règle ça, pas la
          suppression du flou. Le fond n'est plus posé ici : seul le mode
          clair a besoin d'une teinte à lui (voir bet-theme.css). */}
      <header
        className="rink-header-glass sticky top-0 z-40 bet-ink-black"
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <div className="px-4 pt-3 pb-3 flex items-center justify-between">
          <div>
            <h1 className="text-white text-xl font-bold uppercase" style={{ fontFamily: "'Oswald', 'Arial Narrow', sans-serif" }}>
              Bet Slip
            </h1>
            <p className="text-[#8a9ea6] text-xs mt-0.5">
              {tab === "build"
                ? (legs.length === 0 ? "Build your prediction" : `${legs.length} leg${legs.length > 1 ? "s" : ""} · Combined probability`)
                : "Your locked predictions"}
            </p>
          </div>
          {tab === "build" && legs.length > 0 && (
            <button onClick={() => setShowClearConfirm(true)}
              className="tap-44 flex items-center gap-1.5 text-red-400 text-xs border border-red-400/30 rounded-xl px-3 py-1.5 active:bg-red-500/10 transition-colors">
              <Trash2 size={11} /> Clear
            </button>
          )}
        </div>

        {/* Commutateur — la rondelle patine d'un onglet à l'autre
            (`.puck-tabs`, rink-theme.css). `--puck-index` est la seule
            chose que le composant pilote ; la glisse est en CSS. */}
        <div
          className="puck-tabs mx-4 mb-3"
          style={{ "--puck-count": 2, "--puck-index": tab === "build" ? 0 : 1 } as React.CSSProperties}
        >
          <span className="puck-tabs-thumb" aria-hidden />
          {([["build", t("slip.build")], ["slips", t("slip.mySlips")]] as [PageTab, string][]).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`puck-tab${tab === key ? " is-active" : ""}`}
              aria-pressed={tab === key}
            >
              {label}
              {key === "slips" && pendingCount != null && pendingCount > 0 && (
                <span
                  className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[11px] font-bold leading-none tabular-nums"
                  style={{ background: "#86d1ea", color: "#072E49" }}
                  aria-label={t("slip.pendingCount", { n: pendingCount })}
                >
                  {pendingCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </header>

      {/* Build tab */}
      {tab === "build" && (
        <div className={`relative z-10 flex-1 px-4 overflow-y-auto bet-ink-black ${mode === "light" ? "bet-light" : "bet-dark"}`} style={{ paddingBottom: buildPaddingBottom }}>
          {legs.length > 0 && (
          <div className="flex flex-col items-center py-6">
            <ProbabilityGauge pct={combinedProbability ?? 0} size={180} />
            {legs.length > 1 && (
              <>
                <p className="text-[#4a6068] text-[11px] text-center mt-2 max-w-[240px]">
                  {combinedProbability == null
                    ? t("pred.unavailableParlay")
                    : `Combined probability all ${legs.length} predictions hit`}
                </p>
                {combinedProbability != null && (
                  <div className="mt-2 px-4 py-1.5 rounded-full icy-tile">
                    <span className="text-white font-bold text-sm font-mono">{odds(impliedDecimal(combinedProbability))}</span>
                    <span className="text-[#4a6068] text-[11px] ml-1.5">implied odds</span>
                  </div>
                )}
                {bookCombined != null && (
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-[#4a6068] text-[11px]">{t("slip.bookCombined")}</span>
                    <BookPricePill price={bookCombined} size="md" />
                  </div>
                )}
              </>
            )}
            {legs.length === 1 && (
              <>
                <p className="text-[#4a6068] text-[11px] text-center mt-2">{t("slip.individualProb")}</p>
                {combinedProbability != null && (
                  <div className="mt-2 px-4 py-1.5 rounded-full icy-tile">
                    <span className="text-white font-bold text-sm font-mono">{odds(impliedDecimal(combinedProbability))}</span>
                    <span className="text-[#4a6068] text-[11px] ml-1.5">implied odds</span>
                  </div>
                )}
              </>
            )}
          </div>
          )}

          {/* Juste sous la jauge et AVANT les cartes : c'est là qu'on lit le
              chiffre, donc là qu'il faut dire ce qui l'a produit. */}
          {legs.length > 0 && <SlipNotices analysis={slipAnalysis} />}

          {legs.length === 0 ? (
            <EmptySlip onBrowse={() => navigate("/stats")} />
          ) : (
            <div className="mb-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-white text-sm font-medium">{t("slip.predictions")}</p>
                <button onClick={() => setShowSheet(true)}
                  className="tap-44 flex items-center gap-1 text-[#90C9F0] text-xs bg-[#90C9F0]/10 border border-[#90C9F0]/25 rounded-full px-3 py-1.5 active:scale-95 transition-transform">
                  <Plus size={10} /> {t("slip.add")}
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {legs.map((leg, i) => (
                  <LegCard key={leg.id} leg={leg} index={i} onRemove={() => removeLeg(leg.id)}
                    bookPrice={legPrices[leg.id]?.price} />
                ))}
              </div>
            </div>
          )}

          {legs.length > 0 && (
            <div className="icy-card rounded-2xl p-4">
              <div className="flex items-start gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-[#90C9F0]/10 border border-[#90C9F0]/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Lightbulb size={13} className="text-[#90C9F0]" />
                </div>
                <div>
                  <p className="text-white text-xs font-medium mb-1">{t("slip.howProbTitle")}</p>
                  <p className="text-[#8a9ea6] text-[11px] leading-relaxed">
                    {t("slip.howProbBody")}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* My Slips tab */}
      {tab === "slips" && (
        <div className={`relative z-10 flex-1 px-4 overflow-y-auto bet-ink-black ${mode === "light" ? "bet-light" : "bet-dark"}`}
          style={{ paddingBottom: "calc(112px + env(safe-area-inset-bottom, 0px))" }}>
          <MySlipsTab user={user} onPendingCount={setPendingCount} />
        </div>
      )}

      {/* Lock CTA — only on build tab */}
      {tab === "build" && (
        <LockSlipCTA
          legs={legs}
          combinedProbability={combinedProbability}
          onAdd={() => setShowSheet(true)}
          onLock={handleLock}
          isSubmitting={isSubmitting}
          error={submitError}
          panelRef={ctaRef}
        />
      )}

      {/* Success overlay */}
      {submitResult && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center px-6 bg-black/80">
          <div className="icy-card bet-ink-black rounded-3xl p-8 text-center max-w-[300px] w-full">
            <div className="text-5xl mb-4">✅</div>
            <p className="text-white font-bold text-lg mb-2">Slip Locked!</p>
            {submitResult.message && (
              <p className="text-[#92A08A] text-sm mb-6">{submitResult.message}</p>
            )}
            {/* Verrouiller un pari mène au pari, pas à l'accueil.
                Avant : « Back to Home ». On venait de poser un ticket et
                l'écran renvoyait à la page d'accueil — il fallait revenir ici
                puis changer d'onglet pour voir ce qu'on venait de verrouiller.
                Le bouton bascule maintenant sur l'onglet des paris en cours,
                où le ticket apparaît en tête de liste. */}
            <button
              onClick={() => { setSubmitResult(null); setTab("slips"); }}
              className="w-full py-3 rounded-2xl font-bold text-sm"
              style={{ background: "#86d1ea", color: "#072E49" }}
            >
              {t("slip.seeActive")}
            </button>
          </div>
        </div>
      )}

      {/* Confirmation avant de vider le coupon. Le bouton « Clear » posait
          `showClearConfirm` sans que rien ne le lise : le clic ne faisait rien. */}
      <ConfirmDialog
        open={showClearConfirm}
        title={t("slip.clearTitle")}
        description={t("slip.clearBody")}
        confirmLabel={t("slip.clearConfirm")}
        onConfirm={() => { clearSlip(); setShowClearConfirm(false); }}
        onCancel={() => setShowClearConfirm(false)}
      />

      {/* Market selector sheet */}
      {showSheet && (
        <MarketSelectorSheet onClose={() => setShowSheet(false)} />
      )}

      <BottomNav />
    </div>
  );
}
