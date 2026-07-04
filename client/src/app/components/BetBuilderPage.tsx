import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { TrendingUp, Plus, X, Lightbulb, Lock, Share2, ChevronRight, CheckCircle, Clock, History, Trophy, AlertCircle, RefreshCw, Trash2 } from "lucide-react";
import { useBet } from "../context/BetContext";
import { useAuth } from "../context/AuthContext";
import { MarketSelectorSheet } from "./MarketSelectorSheet";
import { BottomNav } from "./BottomNav";
import type { BetLeg } from "../types/bet";
import { submitSlip, getMySlips, settleMySlips } from "../services/slipApiService";
import type { BetSlip } from "../services/slipApiService";
import { useSport } from "../context/SportContext";
import { openBet365 } from "../services/affiliateService";
import { useI18n } from "../i18n";
import "./bet-theme.css";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toOddsLabel(pct: number): string {
  const p = Math.max(5, Math.min(95, pct)) / 100;
  return p >= 0.5
    ? `-${Math.round((p / (1 - p)) * 100)}`
    : `+${Math.round(((1 - p) / p) * 100)}`;
}

// ─── Probability gauge ────────────────────────────────────────────────────────

function ProbabilityGauge({ pct, size = 180 }: { pct: number; size?: number }) {
  const { t } = useI18n();
  const [displayed, setDisplayed] = useState(0);
  const radius = (size - 24) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - displayed / 100);

  const color =
    pct >= 65 ? "#22ff00" :
    pct >= 45 ? "#90C9F0" :
    pct >= 25 ? "#facc15" : "#f87171";

  useEffect(() => {
    setDisplayed(0);
    let current = 0;
    const target = Math.min(pct, 100);
    const step = () => {
      current = Math.min(current + 1.5, target);
      setDisplayed(Math.round(current));
      if (current < target) requestAnimationFrame(step);
    };
    const t = setTimeout(() => requestAnimationFrame(step), 80);
    return () => clearTimeout(t);
  }, [pct]);

  const label =
    pct === 0 ? t("slip.gaugeAddLegs") :
    pct >= 65 ? t("slip.gaugeStrong") :
    pct >= 45 ? t("slip.gaugeModerate") :
    pct >= 25 ? t("slip.gaugeRisky") : t("slip.gaugeLongShot");

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#131A12" strokeWidth={14} />
        {pct > 0 && (
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none"
            stroke={color} strokeWidth={14} strokeLinecap="round"
            strokeDasharray={circumference} strokeDashoffset={offset}
            style={{ transition: "stroke-dashoffset 0.04s linear, stroke 0.4s ease" }}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {pct > 0 ? (
          <>
            <span className="text-white text-4xl font-bold">{displayed}<span className="text-2xl">%</span></span>
            <span className="text-xs mt-0.5 font-medium" style={{ color }}>{label}</span>
          </>
        ) : (
          <>
            <span className="text-[#1B2419] text-4xl font-bold">--</span>
            <span className="text-[#4a6068] text-[10px] mt-1 text-center px-4 leading-snug">{t("slip.addToSee")}</span>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Single leg card (builder) ────────────────────────────────────────────────

function LegCard({ leg, index, onRemove }: { leg: BetLeg; index: number; onRemove: () => void }) {
  const { sport } = useSport();
  const { t } = useI18n();
  const barColor =
    leg.probability >= 65 ? "#22ff00" :
    leg.probability >= 50 ? "#90C9F0" :
    leg.probability >= 35 ? "#facc15" : "#f87171";

  return (
    <div className="icy-card rounded-2xl p-4">
      <div className="flex items-start gap-3">
        <div className="flex flex-col items-center gap-1.5 flex-shrink-0">
          <div className="w-7 h-7 rounded-full bg-[#90C9F0]/10 border border-[#90C9F0]/25 flex items-center justify-center text-[10px] font-bold text-[#90C9F0]">
            {index + 1}
          </div>
          {leg.subjectLogo?.startsWith("http")
            ? <img src={leg.subjectLogo} alt="" className="w-6 h-6 object-contain" />
            : <span className="text-base">{leg.subjectLogo}</span>}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-white text-xs font-bold">{leg.subjectName}</p>
          <p className="text-[#90C9F0] text-[10px] font-medium">{leg.marketLabel}</p>
          <p className="text-[#8a9ea6] text-[10px] mt-0.5 leading-relaxed">{leg.selection}</p>
          {leg.gameInfo && <p className="text-[#4a6068] text-[9px] mt-0.5">{leg.gameInfo}</p>}
          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1 bg-[#0A0E0C] rounded-full h-1.5">
              <div className="h-1.5 rounded-full transition-all duration-500"
                style={{ width: `${leg.probability}%`, backgroundColor: barColor }} />
            </div>
            <span className="text-xs font-bold flex-shrink-0" style={{ color: barColor }}>{leg.probability}%</span>
            <span className="text-[10px] text-[#4a6068] flex-shrink-0 font-mono">{toOddsLabel(leg.probability)}</span>
          </div>
          <button
            onClick={() => openBet365(sport === "tennis" ? "/#/IP/B13" : "/#/IP/B18")}
            className="mt-2 inline-flex items-center gap-1.5 bg-[#126e51] hover:bg-[#0f5c44] text-[#ffd700] text-[10px] font-bold px-2.5 py-1.5 rounded-lg transition-colors"
            title="Open Bet365 to place this bet"
          >
            <span className="bg-[#ffd700] text-[#126e51] rounded px-1 py-0.5 text-[8px] font-black leading-none">b365</span>
            {t("slip.placeBet365")}
          </button>
        </div>
        <button onClick={onRemove}
          className="w-7 h-7 rounded-full icy-tile flex items-center justify-center text-[#8a9ea6] flex-shrink-0 active:bg-red-500/20 active:text-red-400 active:border-red-400/30 transition-colors">
          <X size={10} />
        </button>
      </div>
    </div>
  );
}

// ─── Empty builder state ──────────────────────────────────────────────────────

function EmptySlip({ onAdd }: { onAdd: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center justify-center py-10 gap-4">
      <div className="w-20 h-20 rounded-full icy-card flex items-center justify-center">
        <div className="w-8 h-8 rounded-full bg-[#90C9F0]/15 border border-[#90C9F0]/30 flex items-center justify-center">
          <div className="w-3 h-3 rounded-full bg-[#90C9F0]/60" />
        </div>
      </div>
      <div className="text-center">
        <p className="text-white font-bold mb-1" style={{ fontFamily: "'Merriweather', Georgia, serif" }}>
          {t("slip.empty")}
        </p>
        <p className="text-[#8a9ea6] text-xs leading-relaxed max-w-[220px]">
          {t("slip.emptyHint")}
        </p>
      </div>
      <button onClick={onAdd}
        className="bg-[#22ff00] text-[#072E49] font-bold px-6 py-3 rounded-2xl text-sm flex items-center gap-2 active:scale-95 transition-transform">
        <Plus size={14} /> {t("slip.browse")}
      </button>
    </div>
  );
}

// ─── Combined probability waterfall ──────────────────────────────────────────

function CombinedBreakdown({ legs }: { legs: BetLeg[] }) {
  if (legs.length <= 1) return null;
  return (
    <div className="icy-card rounded-2xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <TrendingUp size={12} className="text-[#90C9F0]" />
        <p className="text-[#8a9ea6] text-[10px] uppercase tracking-wider">Probability Breakdown</p>
      </div>
      <div className="flex flex-col gap-2">
        {legs.map((leg, i) => {
          const runningPct =
            Math.round(legs.slice(0, i + 1).reduce((acc, l) => acc * (l.probability / 100), 1) * 1000) / 10;
          return (
            <div key={leg.id} className="flex items-center gap-3">
              <span className="text-[#4a6068] text-[10px] w-4 flex-shrink-0">{i + 1}</span>
              <div className="flex-1">
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-white text-[10px] truncate max-w-[150px]">
                    {leg.selectionShort || leg.selection.slice(0, 22)}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-[#8a9ea6] text-[10px]">{leg.probability}%</span>
                    <span className="text-[#90C9F0] text-[10px] font-bold">to {runningPct}%</span>
                  </div>
                </div>
                <div className="w-full bg-[#0A0E0C] rounded-full h-1">
                  <div className="h-1 rounded-full bg-[#90C9F0]"
                    style={{ width: `${runningPct}%`, transition: "width 0.5s ease" }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Lock CTA ─────────────────────────────────────────────────────────────────

function LockSlipCTA({
  legs, combinedProbability, onAdd, onLock, isSubmitting,
}: {
  legs: BetLeg[]; combinedProbability: number;
  onAdd: () => void; onLock: () => void; isSubmitting: boolean;
}) {
  const { t } = useI18n();
  if (legs.length === 0) return null;
  const color =
    combinedProbability >= 65 ? "#22ff00" :
    combinedProbability >= 45 ? "#90C9F0" :
    combinedProbability >= 25 ? "#facc15" : "#f87171";

  return (
    <div className="fixed bottom-[68px] left-1/2 -translate-x-1/2 max-w-[430px] md:max-w-5xl w-full px-4 z-40">
      <div className="icy-card bet-ink-black rounded-2xl p-3 shadow-xl shadow-black/40">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center"
              style={{ backgroundColor: `${color}15`, border: `1px solid ${color}30` }}>
              <Lock size={13} style={{ color }} />
            </div>
            <div>
              <p className="text-white text-xs font-bold">{t("slip.legsReady", { n: legs.length })}</p>
              <p className="text-[#4a6068] text-[10px]">{t("slip.signinRequired")}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[10px] text-[#8a9ea6]">{t("slip.combined")}</p>
            <p className="text-lg font-black" style={{ color }}>{combinedProbability}%</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={onAdd} disabled={isSubmitting}
            className="flex items-center justify-center gap-1.5 flex-1 py-3 rounded-xl icy-tile text-[#90C9F0] text-xs font-bold active:scale-[0.97] transition-transform disabled:opacity-40">
            <Plus size={13} /> {t("slip.addLeg")}
          </button>
          <button onClick={onLock} disabled={isSubmitting}
            className="flex items-center justify-center gap-2 flex-[2] py-3 rounded-xl text-[#072E49] text-sm font-bold active:scale-[0.97] transition-transform disabled:opacity-60"
            style={{ backgroundColor: color }}>
            {isSubmitting ? (
              <>
                <div className="w-4 h-4 rounded-full border-2 border-[#0A0E0C]/40 border-t-[#0A0E0C] animate-spin" />
                {t("slip.submitting")}
              </>
            ) : (
              <>
                <Share2 size={14} />
                {t("slip.lockSlip")}
                <ChevronRight size={14} className="ml-auto" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Slip card (My Slips) ─────────────────────────────────────────────────────

function SlipCard({ slip }: { slip: BetSlip }) {
  const { t } = useI18n();
  const isPending = slip.outcome === "pending";
  const isWin = slip.outcome === "win";
  const date = new Date(slip.placedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const time = new Date(slip.placedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  const outcomeColor = isPending ? "#8a9ea6" : isWin ? "#22ff00" : "#f87171";
  const outcomeBg    = isPending ? "bg-white/5 border-white/10" : isWin ? "bg-green-500/10 border-green-500/20" : "bg-red-500/10 border-red-500/20";
  const outcomeLabel = isPending ? t("slip.pending") : isWin ? t("slip.won") : t("slip.lost");
  const OutcomeIcon  = isPending ? Clock : isWin ? Trophy : AlertCircle;

  const combinedColor =
    (slip.combinedProbability ?? 0) >= 65 ? "#22ff00" :
    (slip.combinedProbability ?? 0) >= 45 ? "#90C9F0" :
    (slip.combinedProbability ?? 0) >= 25 ? "#facc15" : "#f87171";

  return (
    <div className={`icy-card rounded-2xl overflow-hidden transition-all ${
      isPending ? "" : isWin ? "ring-1 ring-green-500/40" : "ring-1 ring-red-500/40"
    }`}>
      {/* Header row */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-bold ${outcomeBg}`}
            style={{ color: outcomeColor }}>
            <OutcomeIcon size={10} />
            {outcomeLabel}
          </div>
          {slip.isParlay && (
            <span className="text-[9px] font-medium px-2 py-0.5 rounded-full bg-[#90C9F0]/10 text-[#90C9F0] border border-[#90C9F0]/20">
              {slip.legCount}-leg parlay
            </span>
          )}
          {!slip.isParlay && (
            <span className="text-[9px] text-[#4a6068]">Single</span>
          )}
        </div>
        <div className="text-right">
          <p className="text-[10px] text-[#4a6068]">{date} · {time}</p>
          {slip.combinedProbability != null && (
            <p className="text-sm font-black" style={{ color: combinedColor }}>
              {slip.combinedProbability}%
            </p>
          )}
        </div>
      </div>

      {/* Legs */}
      <div className="px-4 pb-3 flex flex-col gap-1.5">
        {(slip.legs as any[]).map((leg, i) => (
          <div key={i} className="flex items-center gap-2 py-1.5 border-t border-white/[0.05] first:border-0">
            {leg.subjectLogo?.startsWith("http")
              ? <img src={leg.subjectLogo} alt="" className="w-5 h-5 object-contain flex-shrink-0" />
              : <span className="text-sm flex-shrink-0">{leg.subjectLogo}</span>}
            <div className="flex-1 min-w-0">
              <p className="text-white text-[11px] font-medium truncate">{leg.subjectName}</p>
              <p className="text-[#8a9ea6] text-[9px] truncate">{leg.selection ?? leg.marketType}</p>
            </div>
            <span className="text-[10px] font-bold flex-shrink-0" style={{ color: combinedColor }}>
              {leg.probability}%
            </span>
          </div>
        ))}
      </div>

      {/* XP awarded / deducted */}
      {slip.xpAwarded > 0 && (
        <div className="mx-4 mb-3 flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
          <Trophy size={11} className="text-yellow-400" />
          <span className="text-yellow-400 text-[10px] font-bold">+{slip.xpAwarded} {t("slip.xpEarned")}</span>
        </div>
      )}
      {slip.xpAwarded < 0 && (
        <div className="mx-4 mb-3 flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-red-500/10 border border-red-500/20">
          <AlertCircle size={11} className="text-red-400" />
          <span className="text-red-400 text-[10px] font-bold">{slip.xpAwarded} XP</span>
        </div>
      )}

      {/* Pending: results are settled automatically */}
      {isPending && (
        <div className="mx-4 mb-3 flex items-center gap-1.5 px-3 py-1.5 rounded-xl icy-tile">
          <Clock size={11} className="text-[#8a9ea6]" />
          <span className="text-[#8a9ea6] text-[10px]">{t("slip.autoSettle")}</span>
        </div>
      )}
    </div>
  );
}

// ─── My Slips tab ─────────────────────────────────────────────────────────────

function MySlipsTab({ user }: { user: any }) {
  const { t } = useI18n();
  const [slips, setSlips] = useState<BetSlip[]>([]);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const data = await getMySlips(100);
      setSlips(data);
    } catch (err: any) {
      setError(err.message ?? "Could not load slips");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { load(); }, [load]);

  // Ask the server to settle pending slips against real NHL results
  async function handleCheckResults() {
    setResolving("all");
    try {
      const summary = await settleMySlips();
      if (summary.settled > 0) {
        setError(`TIER_UP:${summary.settled} slip${summary.settled > 1 ? "s" : ""} settled — ${summary.wins} won, ${summary.losses} lost`);
        setTimeout(() => setError(null), 4000);
        await load();
      } else {
        setError("TIER_UP:No finished games yet — check back later");
        setTimeout(() => setError(null), 3000);
      }
    } catch (err: any) {
      setError(err.message ?? "Failed to check results");
      setTimeout(() => setError(null), 3000);
    } finally {
      setResolving(null);
    }
  }

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4 px-6 text-center">
        <div className="w-16 h-16 rounded-full bg-[#90C9F0]/10 border border-[#90C9F0]/20 flex items-center justify-center">
          <Lock size={22} className="text-[#90C9F0]" />
        </div>
        <div>
          <p className="text-white font-bold text-sm" style={{ fontFamily: "'Merriweather', Georgia, serif" }}>{t("slip.signin")}</p>
          <p className="text-[#8a9ea6] text-xs mt-1 leading-relaxed">{t("slip.signinHint")}</p>
        </div>
      </div>
    );
  }

  const pending = slips.filter((s) => s.outcome === "pending");
  const resolved = slips.filter((s) => s.outcome !== "pending");

  return (
    <div className="flex flex-col gap-4 pb-32 pt-3">
      {/* Tier-up / error banner */}
      {error && (
        <div className={`rounded-2xl px-4 py-3 flex items-center gap-3 ${
          error.startsWith("TIER_UP:")
            ? "bg-yellow-500/10 border border-yellow-500/25"
            : "bg-red-500/10 border border-red-500/25"
        }`}>
          {error.startsWith("TIER_UP:") ? (
            <Trophy size={14} className="text-yellow-400 flex-shrink-0" />
          ) : (
            <AlertCircle size={14} className="text-red-400 flex-shrink-0" />
          )}
          <p className={`text-xs font-medium ${error.startsWith("TIER_UP:") ? "text-yellow-300" : "text-red-300"}`}>
            {error.replace("TIER_UP:", "")}
          </p>
        </div>
      )}

      {loading ? (
        <div className="flex flex-col gap-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-28 icy-tile rounded-2xl animate-pulse" />
          ))}
        </div>
      ) : slips.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
          <div className="w-16 h-16 rounded-full icy-card flex items-center justify-center">
            <History size={22} className="text-[#4a6068]" />
          </div>
          <div>
            <p className="text-white font-bold text-sm" style={{ fontFamily: "'Merriweather', Georgia, serif" }}>{t("slip.noSlips")}</p>
            <p className="text-[#8a9ea6] text-xs mt-1">{t("slip.noSlipsHint")}</p>
          </div>
        </div>
      ) : (
        <>
          {/* Active / pending */}
          {pending.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#90C9F0] animate-pulse" />
                  <p className="text-[#8a9ea6] text-[10px] uppercase tracking-wider font-medium">{t("slip.active")} · {pending.length}</p>
                </div>
                <button
                  onClick={handleCheckResults}
                  disabled={resolving === "all"}
                  className="flex items-center gap-1.5 text-[#90C9F0] text-[10px] font-bold border border-[#90C9F0]/30 bg-[#90C9F0]/10 px-2.5 py-1 rounded-lg active:scale-95 transition-all disabled:opacity-50"
                >
                  <RefreshCw size={11} className={resolving === "all" ? "animate-spin" : ""} />
                  {t("slip.checkResults")}
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {pending.map((s) => (
                  <SlipCard key={s.id} slip={s} />
                ))}
              </div>
            </div>
          )}

          {/* History */}
          {resolved.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <History size={12} className="text-[#4a6068]" />
                <p className="text-[#8a9ea6] text-[10px] uppercase tracking-wider font-medium">{t("slip.history")} · {resolved.length}</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {resolved.map((s) => (
                  <SlipCard key={s.id} slip={s} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

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
        marketType:  l.marketType,
        subjectId:   l.subjectId,
        subjectName: l.subjectName,
        subjectLogo: l.subjectLogo,
        selection:   l.selection,
        line:        l.line,
        probability: l.probability,
        oddsLabel:   toOddsLabel(l.probability),
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
      className="flex flex-col min-h-screen text-white max-w-[430px] md:max-w-5xl mx-auto w-full"
      style={{ background: mode === "light" ? "#D4FFEE" : "#2A507B" }}
    >

      {/* Header */}
      <header
        className="px-4 pt-12 pb-3 backdrop-blur-md sticky top-0 z-40 bet-ink-black"
        style={{
          background: "linear-gradient(160deg, rgba(220,245,255,0.22), rgba(150,205,240,0.12) 45%, rgba(235,250,255,0.20))",
          WebkitBackdropFilter: "blur(16px)",
          borderBottom: "1px solid rgba(255,255,255,0.4)",
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-white text-xl font-bold" style={{ fontFamily: "'Merriweather', Georgia, serif" }}>
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
        <div className="flex gap-1 bg-white/5 rounded-xl p-1 border border-white/20">
          {([["build", t("slip.build")], ["slips", t("slip.mySlips")]] as [PageTab, string][]).map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)}
              className={`flex-1 py-1.5 rounded-lg text-[11px] font-medium transition-all ${
                tab === key ? "bg-[#22ff00] text-[#072E49] font-bold" : "text-white/60"
              }`}>
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

          {legs.length > 1 && (
            <div className="mb-4"><CombinedBreakdown legs={legs} /></div>
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
              onClick={() => { clearLegs(); navigate("/"); }}
              className="w-full py-3 rounded-2xl font-bold text-sm"
              style={{ background: "#22ff00", color: "#072E49" }}
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
