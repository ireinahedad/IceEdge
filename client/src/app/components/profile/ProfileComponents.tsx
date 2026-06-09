import { useState } from "react";
import type {
  UserBettingStats,
  BetRecord,
  UserBadge,
  UserProfile,
} from "./../../types/user";

// ─── Tier config ──────────────────────────────────────────────────────────────

export const TIER_CONFIG = {
  rookie: {
    label: "Rookie",
    color: "#bfc8cc",
    bg: "bg-[#bfc8cc]/10  border-[#bfc8cc]/30",
    icon: "🏒",
  },
  analyst: {
    label: "Analyst",
    color: "#86d1ea",
    bg: "bg-[#86d1ea]/10  border-[#86d1ea]/30",
    icon: "📊",
  },
  sharp: {
    label: "Sharp",
    color: "#4ade80",
    bg: "bg-green-500/10   border-green-500/30",
    icon: "🎯",
  },
  legend: {
    label: "Legend",
    color: "#facc15",
    bg: "bg-yellow-500/10  border-yellow-500/30",
    icon: "👑",
  },
} as const;

const BADGE_TIER_COLOR = {
  bronze: {
    ring: "border-amber-700/60",
    bg: "bg-amber-900/20",
    text: "text-amber-500",
  },
  silver: {
    ring: "border-slate-400/60",
    bg: "bg-slate-700/20",
    text: "text-slate-300",
  },
  gold: {
    ring: "border-yellow-400/60",
    bg: "bg-yellow-900/20",
    text: "text-yellow-400",
  },
  platinum: {
    ring: "border-[#86d1ea]/60",
    bg: "bg-[#86d1ea]/10",
    text: "text-[#86d1ea]",
  },
} as const;

// ─── Stat pill ────────────────────────────────────────────────────────────────

export function StatPill({
  label,
  value,
  sub,
  color = "#86d1ea",
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="bg-white/5 backdrop-blur-md border border-white/20 rounded-2xl p-3 flex flex-col items-center gap-0.5">
      <span className="text-white text-base font-bold" style={{ color }}>
        {value}
      </span>
      <span className="text-white/70 text-[9px] uppercase tracking-wider text-center">
        {label}
      </span>
      {sub && <span className="text-white/70 text-[9px]">{sub}</span>}
    </div>
  );
}

// ─── Performance score ring ───────────────────────────────────────────────────

export function ScoreRing({
  score,
  tier,
}: {
  score: number;
  tier: UserProfile["tier"];
}) {
  const pct = (score / 1000) * 100;
  const size = 120;
  const radius = (size - 16) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - pct / 100);
  const { color, label } = TIER_CONFIG[tier];

  return (
    <div
      className="relative flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        style={{ transform: "rotate(-90deg)" }}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="white"
          strokeOpacity={0.1}
          strokeWidth={8}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={8}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 1s ease" }}
        />
      </svg>

      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-white text-2xl font-bold">
          {score}
        </span>
        <span
          className="text-[8px] uppercase tracking-widest"
          style={{ color }}
        >
          {label}
        </span>
      </div>
    </div>
  );
}

// ─── Monthly hit-rate sparkline ───────────────────────────────────────────────

export function HitRateChart({
  stats,
}: {
  stats: UserBettingStats;
}) {
  const months = stats.monthlyStats;
  const max = Math.max(...months.map((m) => m.hitRate));
  const min = Math.min(...months.map((m) => m.hitRate)) - 5;
  const H = 56;
  const W = 280;
  const step = W / (months.length - 1);

  const pts = months.map((m, i) => {
    const x = i * step;
    const y =
      H - ((m.hitRate - min) / (max - min)) * H;
    return `${x},${y}`;
  });

  const area = `M${pts.join(" L")} L${
    (months.length - 1) * step
  },${H} L0,${H} Z`;

  const line = `M${pts.join(" L")}`;

  return (
    <div className="bg-white/5 backdrop-blur-md border border-white/20 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-white text-xs font-medium">
          Hit Rate Trend
        </p>
        <span className="text-[#86d1ea] text-xs font-bold">
          {stats.hitRate}% season avg
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height: H }}
      >
        <defs>
          <linearGradient
            id="chartFill"
            x1="0"
            y1="0"
            x2="0"
            y2="1"
          >
            <stop
              offset="0%"
              stopColor="#86d1ea"
              stopOpacity="0.3"
            />
            <stop
              offset="100%"
              stopColor="#86d1ea"
              stopOpacity="0"
            />
          </linearGradient>
        </defs>

        <path d={area} fill="url(#chartFill)" />
        <path
          d={line}
          fill="none"
          stroke="#86d1ea"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {months.map((m, i) => (
          <circle
            key={i}
            cx={i * step}
            cy={
              H -
              ((m.hitRate - min) / (max - min)) * H
            }
            r="3"
            fill="#86d1ea"
          />
        ))}
      </svg>

      <div className="flex justify-between mt-2">
        {months.map((m, i) => (
          <span key={i} className="text-white/70 text-[9px]">
            {m.month}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Market breakdown bars ────────────────────────────────────────────────────

export function MarketBreakdown({
  stats,
}: {
  stats: UserBettingStats;
}) {
  return (
    <div className="bg-white/5 backdrop-blur-md border border-white/20 rounded-2xl p-4">
      <p className="text-white text-xs font-medium mb-3">
        Performance by Market
      </p>

      <div className="flex flex-col gap-2.5">
        {stats.marketBreakdown.map((m) => (
          <div key={m.marketType}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-white/70 text-[10px]">
                {m.label}
              </span>

              <div className="flex items-center gap-2">
                <span className="text-white/70 text-[9px]">
                  {m.bets} bets
                </span>
                <span className="text-white text-[10px] font-bold">
                  {m.hitRate}%
                </span>
              </div>
            </div>

            <div className="w-full bg-white/5 rounded-full h-1.5">
              <div
                className="h-1.5 rounded-full transition-all duration-700"
                style={{
                  width: `${m.hitRate}%`,
                  backgroundColor:
                    m.hitRate >= 70
                      ? "#4ade80"
                      : m.hitRate >= 60
                      ? "#86d1ea"
                      : "#facc15",
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Badge grid ───────────────────────────────────────────────────────────────

export function BadgeGrid({
  badges,
}: {
  badges: UserBadge[];
}) {
  const [selected, setSelected] =
    useState<UserBadge | null>(null);

  return (
    <div className="bg-white/5 backdrop-blur-md border border-white/20 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-white text-xs font-medium">
          Badges
        </p>
        <span className="text-white/70 text-[10px]">
          {badges.length} earned
        </span>
      </div>

      <div className="grid grid-cols-4 gap-2">
        {badges.map((badge) => {
          const tc = BADGE_TIER_COLOR[badge.tier];

          return (
            <button
              key={badge.id}
              onClick={() =>
                setSelected(
                  selected?.id === badge.id
                    ? null
                    : badge
                )
              }
              className={`flex flex-col items-center gap-1 p-2 rounded-xl border transition-all ${tc.bg} ${tc.ring}`}
            >
              <span className="text-2xl">
                {badge.icon}
              </span>

              <span
                className={`text-[8px] text-center leading-tight font-medium ${tc.text}`}
              >
                {badge.label}
              </span>
            </button>
          );
        })}
      </div>

      {selected &&
        (() => {
          const tc = BADGE_TIER_COLOR[selected.tier];

          return (
            <div
              className={`mt-3 rounded-xl border p-3 bg-white/5 backdrop-blur-md ${tc.ring}`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xl">
                  {selected.icon}
                </span>
                <span
                  className={`text-xs font-bold ${tc.text}`}
                >
                  {selected.label}
                </span>
                <span
                  className={`ml-auto text-[9px] uppercase tracking-wider ${tc.text}`}
                >
                  {selected.tier}
                </span>
              </div>

              <p className="text-white/70 text-[10px] leading-relaxed">
                {selected.description}
              </p>

              <p className="text-white/70 text-[9px] mt-1">
                Earned{" "}
                {new Date(
                  selected.earnedAt
                ).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </p>
            </div>
          );
        })()}
    </div>
  );
}

// ─── Bet history list ─────────────────────────────────────────────────────────

type FilterType = "all" | "win" | "loss" | "pending";

export function BetHistoryList({
  bets,
}: {
  bets: BetRecord[];
}) {
  const [filter, setFilter] =
    useState<FilterType>("all");

  const filtered =
    filter === "all"
      ? bets
      : bets.filter((b) => b.outcome === filter);

  const outcomeStyle = {
    win: {
      dot: "bg-green-500",
      badge:
        "bg-green-500/15 text-green-400 border-green-500/30",
      label: "WIN",
    },
    loss: {
      dot: "bg-red-400",
      badge:
        "bg-red-500/15 text-red-400 border-red-500/30",
      label: "LOSS",
    },
    pending: {
      dot: "bg-yellow-400 animate-pulse",
      badge:
        "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
      label: "LIVE",
    },
  };

  const filters: { key: FilterType; label: string }[] = [
    { key: "all", label: "All" },
    { key: "win", label: "Wins" },
    { key: "loss", label: "Losses" },
    { key: "pending", label: "Live" },
  ];

  return (
    <div className="bg-white/5 backdrop-blur-md border border-white/20 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-white text-xs font-medium">
          Bet History
        </p>

        <div className="flex gap-1">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`text-[9px] px-2 py-1 rounded-full border transition-colors ${
                filter === f.key
                  ? "bg-[#86d1ea] text-[#0a1014] border-[#86d1ea] font-bold"
                  : "text-white/70 border-white/20"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {filtered.length === 0 && (
          <p className="text-white/70 text-xs text-center py-4">
            No bets found
          </p>
        )}

        {filtered.map((bet) => {
          const os = outcomeStyle[bet.outcome];

          return (
            <div
              key={bet.id}
              className="flex items-center gap-3 py-2 border-b border-white/20 last:border-0"
            >
              <div className="relative flex-shrink-0">
                <span className="text-xl">
                  {bet.subjectLogo}
                </span>
                <span
                  className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ${os.dot}`}
                />
              </div>

              <div className="flex-1 min-w-0">
                <p className="text-white text-[10px] font-medium truncate">
                  {bet.selection}
                </p>
                <p className="text-white/70 text-[9px]">
                  {bet.gameInfo}
                </p>
                {bet.isParlay && (
                  <span className="text-[#86d1ea] text-[9px]">
                    Parlay · {bet.parlayLegs} legs
                  </span>
                )}
              </div>

              <div className="flex flex-col items-end gap-1 flex-shrink-0">
                <span
                  className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${os.badge}`}
                >
                  {os.label}
                </span>
                <span className="text-white/70 text-[9px]">
                  {bet.probability}% model
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Calibration indicator ────────────────────────────────────────────────────

export function CalibrationCard({
  stats,
}: {
  stats: UserBettingStats;
}) {
  const score = stats.calibrationScore;
  const color =
    score >= 80
      ? "#4ade80"
      : score >= 65
      ? "#86d1ea"
      : "#facc15";

  const label =
    score >= 80
      ? "Well Calibrated"
      : score >= 65
      ? "Decent"
      : "Needs Work";

  const desc =
    score >= 80
      ? "Your picks align closely with model probabilities — a sign of sharp judgment."
      : score >= 65
      ? "Your hit rate roughly matches model predictions with some variance."
      : "Your selections often diverge from model predictions. Try sticking to higher-confidence picks.";

  return (
    <div className="bg-white/5 backdrop-blur-md border border-white/20 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-white text-xs font-medium">
          Model Calibration
        </p>
        <span className="text-xs font-bold" style={{ color }}>
          {score}/100 · {label}
        </span>
      </div>

      <div className="w-full bg-white/5 rounded-full h-2 mb-2">
        <div
          className="h-2 rounded-full transition-all duration-700"
          style={{
            width: `${score}%`,
            backgroundColor: color,
          }}
        />
      </div>

      <p className="text-white/70 text-[10px] leading-relaxed">
        {desc}
      </p>

      <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/20">
        <div className="text-center">
          <p className="text-white text-xs font-bold">
            {stats.avgProbability}%
          </p>
          <p className="text-white/70 text-[9px]">
            Avg model prob
          </p>
        </div>

        <div className="text-center">
          <p className="text-white text-xs font-bold">
            {stats.hitRate}%
          </p>
          <p className="text-white/70 text-[9px]">
            Actual hit rate
          </p>
        </div>

        <div className="text-center">
          <p className="text-white text-xs font-bold">
            {Math.abs(
              stats.hitRate - stats.avgProbability
            ).toFixed(1)}
            %
          </p>
          <p className="text-white/70 text-[9px]">
            Delta
          </p>
        </div>
      </div>
    </div>
  );
}