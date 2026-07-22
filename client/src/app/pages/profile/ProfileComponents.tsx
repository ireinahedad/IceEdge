import type { UserBettingStats, UserProfile } from "./../../types/user";
import { useI18n } from "../../i18n";

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
          stroke="#86d1ea"
          strokeWidth={8}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 1s ease" }}
        />
      </svg>

      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold" style={{ color: "#86d1ea" }}>
          {score}
        </span>
        <span
          className="text-[8px] uppercase tracking-widest"
          style={{ color: "#86d1ea" }}
        >
          XP
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
  const { t } = useI18n();
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
    <div className="icy-card rounded-2xl p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-white text-xs font-medium">
          {t("profile.hitRateTrend")}
        </p>
        <span className="text-[#90C9F0] text-xs font-bold">
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
              stopColor="#90C9F0"
              stopOpacity="0.3"
            />
            <stop
              offset="100%"
              stopColor="#90C9F0"
              stopOpacity="0"
            />
          </linearGradient>
        </defs>

        <path d={area} fill="url(#chartFill)" />
        <path
          d={line}
          fill="none"
          stroke="#90C9F0"
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
            fill="#90C9F0"
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
  const { t } = useI18n();
  return (
    <div className="icy-card rounded-2xl p-4">
      <p className="text-white text-xs font-medium mb-3">
        {t("profile.perfByMarket")}
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
                      ? "#86d1ea"
                      : m.hitRate >= 60
                      ? "#90C9F0"
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

// ─── Calibration indicator ────────────────────────────────────────────────────

export function CalibrationCard({
  stats,
}: {
  stats: UserBettingStats;
}) {
  const { t } = useI18n();
  const score = stats.calibrationScore;
  const color =
    score >= 80
      ? "#86d1ea"
      : score >= 65
      ? "#90C9F0"
      : "#facc15";

  const label =
    score >= 80
      ? t("profile.calWell")
      : score >= 65
      ? t("profile.calDecent")
      : t("profile.calNeedsWork");

  const desc =
    score >= 80
      ? t("profile.calDescHigh")
      : score >= 65
      ? t("profile.calDescMid")
      : t("profile.calDescLow");

  return (
    <div className="icy-card rounded-2xl p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-white text-xs font-medium">
          {t("profile.modelCalibration")}
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
             <span className="text-white/40 text-[9px]">{t("profile.calibration")}</span>
        <span className="text-xs font-bold" style={{ color }}>{score}/100</span>
      </div>
    </div>
  );
}
