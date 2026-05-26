import { useState, useEffect } from "react";
import { useBet } from "../context/BetContext";
import { MarketSelectorSheet } from "./MarketSelectorSheet";
import { BottomNav } from "./BottomNav";
import type { BetLeg } from "../types/bet";

// ─── Circular probability gauge ───────────────────────────────────────────────
function ProbabilityGauge({ pct, size = 180 }: { pct: number; size?: number }) {
  const [displayed, setDisplayed] = useState(0);
  const radius = (size - 24) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - displayed / 100);

  const color =
    pct >= 65 ? "#4ade80" :
    pct >= 45 ? "#86d1ea" :
    pct >= 25 ? "#facc15" :
    "#f87171";

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
    pct === 0 ? "Add legs" :
    pct >= 65 ? "Strong" :
    pct >= 45 ? "Moderate" :
    pct >= 25 ? "Risky" : "Long Shot";

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      {/* Background track */}
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#1e2d32" strokeWidth={14} />
        {pct > 0 && (
          <circle
            cx={size / 2} cy={size / 2} r={radius} fill="none"
            stroke={color} strokeWidth={14} strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            style={{ transition: "stroke-dashoffset 0.04s linear, stroke 0.4s ease" }}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {pct > 0 ? (
          <>
            <span className="text-white text-4xl font-bold">{displayed}<span className="text-2xl">%</span></span>
            <span className="text-xs mt-0.5" style={{ color }}>{label}</span>
          </>
        ) : (
          <>
            <span className="text-[#1e2d32] text-4xl font-bold">—</span>
            <span className="text-[#bfc8cc] text-[10px] mt-1 text-center px-4">Add predictions<br/>to see probability</span>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Single leg card ──────────────────────────────────────────────────────────
function LegCard({ leg, index, onRemove }: { leg: BetLeg; index: number; onRemove: () => void }) {
  const color =
    leg.probability >= 65 ? "text-green-400" :
    leg.probability >= 50 ? "text-[#86d1ea]" :
    leg.probability >= 35 ? "text-yellow-400" : "text-red-400";

  const barColor =
    leg.probability >= 65 ? "#4ade80" :
    leg.probability >= 50 ? "#86d1ea" :
    leg.probability >= 35 ? "#facc15" : "#f87171";

  return (
    <div className="bg-[#141c1f] border border-[#1e2d32] rounded-2xl p-4">
      <div className="flex items-start gap-3">
        {/* Index + logo */}
        <div className="flex flex-col items-center gap-1 flex-shrink-0">
          <div className="w-7 h-7 rounded-full bg-[#1e2d32] flex items-center justify-center text-[10px] font-bold text-[#86d1ea]">
            {index + 1}
          </div>
          <span className="text-lg">{leg.subjectLogo}</span>
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <p className="text-white text-xs font-bold">{leg.subjectName}</p>
          <p className="text-[#86d1ea] text-[10px] font-medium">{leg.marketLabel}</p>
          <p className="text-[#bfc8cc] text-[10px] mt-0.5 leading-relaxed">{leg.selection}</p>
          {leg.gameInfo && (
            <p className="text-[#bfc8cc] text-[9px] mt-0.5">{leg.gameInfo}</p>
          )}

          {/* Probability bar */}
          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1 bg-[#0f1416] rounded-full h-1.5">
              <div
                className="h-1.5 rounded-full transition-all duration-500"
                style={{ width: `${leg.probability}%`, backgroundColor: barColor }}
              />
            </div>
            <span className={`text-xs font-bold flex-shrink-0 ${color}`}>
              {leg.probability}%
            </span>
          </div>
        </div>

        {/* Remove */}
        <button
          onClick={onRemove}
          className="w-7 h-7 rounded-full bg-[#1e2d32] flex items-center justify-center text-[#bfc8cc] flex-shrink-0 text-xs active:bg-red-500/20 active:text-red-400 transition-colors"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────
function EmptySlip({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 gap-4">
      <div className="w-20 h-20 rounded-full bg-[#141c1f] border border-[#1e2d32] flex items-center justify-center text-4xl">
        🏒
      </div>
      <div className="text-center">
        <p className="text-white font-bold mb-1">No predictions yet</p>
        <p className="text-[#bfc8cc] text-xs leading-relaxed max-w-[220px]">
          Add predictions from the Stats page or tap the button below to browse all markets
        </p>
      </div>
      <button
        onClick={onAdd}
        className="bg-[#86d1ea] text-[#0f1416] font-bold px-6 py-3 rounded-2xl text-sm"
      >
        + Browse Markets
      </button>
    </div>
  );
}

// ─── Leg breakdown mini chart ─────────────────────────────────────────────────
function CombinedBreakdown({ legs }: { legs: BetLeg[] }) {
  if (legs.length <= 1) return null;

  return (
    <div className="bg-[#141c1f] border border-[#1e2d32] rounded-2xl p-4">
      <p className="text-[#bfc8cc] text-[10px] uppercase tracking-wider mb-3">Probability Breakdown</p>
      <div className="flex flex-col gap-2">
        {legs.map((leg, i) => {
          const runningPct =
            Math.round(
              legs.slice(0, i + 1).reduce((acc, l) => acc * (l.probability / 100), 1) * 1000
            ) / 10;
          return (
            <div key={leg.id} className="flex items-center gap-3">
              <span className="text-[#bfc8cc] text-[10px] w-4 flex-shrink-0">{i + 1}</span>
              <div className="flex-1">
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-white text-[10px] truncate max-w-[150px]">{leg.selectionShort || leg.selection.slice(0, 22)}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[#bfc8cc] text-[10px]">{leg.probability}%</span>
                    <span className="text-[#86d1ea] text-[10px] font-bold">→ {runningPct}%</span>
                  </div>
                </div>
                <div className="w-full bg-[#0f1416] rounded-full h-1">
                  <div
                    className="h-1 rounded-full bg-[#86d1ea]"
                    style={{ width: `${runningPct}%`, transition: "width 0.5s ease" }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export function BetBuilderPage() {
  const { legs, removeLeg, clearSlip, combinedProbability } = useBet();
  const [showSheet, setShowSheet] = useState(false);

  return (
    <div className="flex flex-col min-h-screen bg-[#0f1416] text-white max-w-[430px] mx-auto">
      {/* Header */}
      <header className="px-4 pt-12 pb-3 bg-[#0f1416] sticky top-0 z-40">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-white text-xl font-bold">Prediction Slip</h1>
            <p className="text-[#bfc8cc] text-xs">
              {legs.length === 0
                ? "No predictions added"
                : `${legs.length} leg${legs.length > 1 ? "s" : ""} · Combined probability`}
            </p>
          </div>
          {legs.length > 0 && (
            <button
              onClick={clearSlip}
              className="text-red-400 text-xs border border-red-400/30 rounded-xl px-3 py-1.5"
            >
              Clear All
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 px-4 pb-28 overflow-y-auto">
        {/* Gauge */}
        <div className="flex flex-col items-center py-6">
          <ProbabilityGauge pct={combinedProbability} size={180} />
          {legs.length > 1 && (
            <p className="text-[#bfc8cc] text-[10px] text-center mt-2 max-w-[240px]">
              Combined probability that all {legs.length} predictions are correct
            </p>
          )}
          {legs.length === 1 && (
            <p className="text-[#bfc8cc] text-[10px] text-center mt-2">
              Individual prediction probability
            </p>
          )}
        </div>

        {/* Breakdown */}
        {legs.length > 1 && (
          <div className="mb-4">
            <CombinedBreakdown legs={legs} />
          </div>
        )}

        {/* Leg list or empty */}
        {legs.length === 0 ? (
          <EmptySlip onAdd={() => setShowSheet(true)} />
        ) : (
          <div className="flex flex-col gap-2 mb-4">
            <div className="flex items-center justify-between mb-1">
              <p className="text-white text-sm font-medium">Your Predictions</p>
              <button
                onClick={() => setShowSheet(true)}
                className="flex items-center gap-1 text-[#86d1ea] text-xs bg-[#86d1ea]/10 border border-[#86d1ea]/30 rounded-full px-3 py-1.5"
              >
                <span>+</span> Add
              </button>
            </div>
            {legs.map((leg, i) => (
              <LegCard
                key={leg.id}
                leg={leg}
                index={i}
                onRemove={() => removeLeg(leg.id)}
              />
            ))}
          </div>
        )}

        {/* Tip box */}
        {legs.length > 0 && (
          <div className="bg-[#141c1f] border border-[#1e2d32] rounded-2xl p-4 mt-2">
            <div className="flex items-start gap-2">
              <span className="text-lg flex-shrink-0">💡</span>
              <div>
                <p className="text-white text-xs font-medium mb-1">How probability works</p>
                <p className="text-[#bfc8cc] text-[10px] leading-relaxed">
                  Each leg's individual probability is estimated by our ML model using season stats,
                  recent form, and matchup data. The combined probability assumes each leg is
                  independent: P = p₁ × p₂ × … × pₙ. Adding more legs increases complexity
                  but lowers combined probability. Connect your prediction server (
                  <span className="text-[#86d1ea]">VITE_PREDICTION_API_URL</span>
                  ) for real ML-powered estimates.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Floating add button (when legs exist) */}
      {legs.length > 0 && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 max-w-[430px] w-full px-4 z-40 pointer-events-none">
          <button
            onClick={() => setShowSheet(true)}
            className="w-full bg-[#86d1ea] text-[#0f1416] font-bold py-3.5 rounded-2xl text-sm shadow-lg pointer-events-auto"
          >
            + Add Prediction
          </button>
        </div>
      )}

      <BottomNav />

      {showSheet && (
        <MarketSelectorSheet onClose={() => setShowSheet(false)} />
      )}
    </div>
  );
}
