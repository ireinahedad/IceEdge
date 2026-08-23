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

import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Plus, Lightbulb, Trash2 } from "lucide-react";
import { useBet } from "../context/BetContext";
import { useAuth } from "../context/AuthContext";
import { MarketSelectorSheet } from "../components/MarketSelectorSheet";
import { BottomNav } from "../components/BottomNav";
import { submitSlip } from "../services/slipApiService";
import { useSport } from "../context/SportContext";
import { useI18n } from "../i18n";
import "./bet-theme.css";
import { MySlipsTab } from "./bet/MySlipsTab";
import "../components/rink-theme.css";
import { EmptySlip, LegCard, LockSlipCTA, ProbabilityGauge, toOddsLabel } from "./bet/betParts";


// ─── Main page ─────────────────────────────────────────────────────────────────

type PageTab = "build" | "slips";

export function BetBuilderPage() {
  const { legs, removeLeg, clearSlip, combinedProbability } = useBet();
  const { user } = useAuth();
  const { sport } = useSport();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<PageTab>(searchParams.get("tab") === "slips" ? "slips" : "build");
  // Dark / light appearance — shared, persisted setting (set from the profile page)
  const [mode] = useState<"dark" | "light">(() => {
    try { return localStorage.getItem("iceedge_mode") === "light" ? "light" : "dark"; }
    catch { return "dark"; }
  });
  const [showSheet, setShowSheet] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{ slipId: string } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // Switch to My Slips after successful lock
  function handleSuccessDone() {
    setSubmitResult(null);
    setTab("slips");
  }

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
      const { slipId } = await submitSlip(slipLegs, sport, combinedProbability);
      setSubmitResult({ slipId });
      clearSlip();
    } catch (err: any) {
      setSubmitError(err.message ?? "Submission failed. Try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div
      className={`flex flex-col min-h-screen text-white max-w-[430px] md:max-w-5xl mx-auto w-full ${mode === "light" ? "bet-light" : "bet-dark"}`}
      style={{ background: mode === "light" ? "#D4FFEE" : "#0A0E0C" }}
    >

      {/* Header */}
      <header
        className="backdrop-blur-md sticky top-0 z-40 bet-ink-black"
        style={{
          background: "linear-gradient(160deg, rgba(220,245,255,0.22), rgba(150,205,240,0.12) 45%, rgba(235,250,255,0.20))",
          WebkitBackdropFilter: "blur(16px)",
          paddingTop: "env(safe-area-inset-top, 0px)",
        }}
      >
        <div className="rink-boards" aria-hidden />
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
              className="flex items-center gap-1.5 text-red-400 text-xs border border-red-400/30 rounded-xl px-3 py-1.5 active:bg-red-500/10 transition-colors">
              <Trash2 size={11} /> Clear
            </button>
          )}
        </div>

        {/* Tab switcher */}
        <div className="flex gap-1 mx-4 mb-3 bg-white/5 rounded-xl p-1">
          {([["build", t("slip.build")], ["slips", t("slip.mySlips")]] as [PageTab, string][]).map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)}
              className="flex-1 py-1.5 rounded-lg text-[11px] font-semibold transition-all"
              style={tab === key ? { background: "#90C9F0", color: "#072E49" } : { color: "#92A08A" }}>
              {label}
              {key === "slips" && user && tab !== "slips" && legs.length === 0 && (
                <span className="ml-1 text-[9px] opacity-60">history</span>
              )}
            </button>
          ))}
        </div>
      </header>

      {/* Build tab */}
      {tab === "build" && (
        <div className={`flex-1 px-4 overflow-y-auto bet-ink-black ${mode === "light" ? "bet-light" : "bet-dark"}`} style={{ paddingBottom: legs.length > 0 ? "160px" : "112px" }}>
          {legs.length > 0 && (
          <div className="flex flex-col items-center py-6">
            <ProbabilityGauge pct={combinedProbability} size={180} />
            {legs.length > 1 && (
              <>
                <p className="text-[#4a6068] text-[10px] text-center mt-2 max-w-[240px]">
                  Combined probability all {legs.length} predictions hit
                </p>
                <div className="mt-2 px-4 py-1.5 rounded-full icy-tile">
                  <span className="text-white font-bold text-sm font-mono">{toOddsLabel(combinedProbability)}</span>
                  <span className="text-[#4a6068] text-[10px] ml-1.5">implied odds</span>
                </div>
              </>
            )}
            {legs.length === 1 && (
              <>
                <p className="text-[#4a6068] text-[10px] text-center mt-2">{t("slip.individualProb")}</p>
                <div className="mt-2 px-4 py-1.5 rounded-full icy-tile">
                  <span className="text-white font-bold text-sm font-mono">{toOddsLabel(combinedProbability)}</span>
                  <span className="text-[#4a6068] text-[10px] ml-1.5">implied odds</span>
                </div>
              </>
            )}
          </div>
          )}

          {legs.length === 0 ? (
            <EmptySlip onAdd={() => setShowSheet(true)} />
          ) : (
            <div className="mb-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-white text-sm font-medium">{t("slip.predictions")}</p>
                <button onClick={() => setShowSheet(true)}
                  className="flex items-center gap-1 text-[#90C9F0] text-xs bg-[#90C9F0]/10 border border-[#90C9F0]/25 rounded-full px-3 py-1.5 active:scale-95 transition-transform">
                  <Plus size={10} /> {t("slip.add")}
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {legs.map((leg, i) => (
                  <LegCard key={leg.id} leg={leg} index={i} onRemove={() => removeLeg(leg.id)} />
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
                  <p className="text-[#8a9ea6] text-[10px] leading-relaxed">
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
        <div className={`flex-1 px-4 overflow-y-auto bet-ink-black ${mode === "light" ? "bet-light" : "bet-dark"}`}>
          <MySlipsTab user={user} />
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
        />
      )}

      {/* Success overlay */}
      {submitResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-6 bg-black/80">
          <div className="icy-card bet-ink-black rounded-3xl p-8 text-center max-w-[300px] w-full">
            <div className="text-5xl mb-4">✅</div>
            <p className="text-white font-bold text-lg mb-2">Slip Locked!</p>
            <p className="text-[#92A08A] text-sm mb-6">{submitResult.message}</p>
            <button
              onClick={() => { clearSlip(); navigate("/"); }}
              className="w-full py-3 rounded-2xl font-bold text-sm"
              style={{ background: "#86d1ea", color: "#072E49" }}
            >
              Back to Home
            </button>
          </div>
        </div>
      )}

      {/* Market selector sheet */}
      {showSheet && (
        <MarketSelectorSheet onClose={() => setShowSheet(false)} />
      )}

      <BottomNav />
    </div>
  );
}
