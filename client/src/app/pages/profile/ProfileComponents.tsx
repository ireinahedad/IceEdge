import type { UserBettingStats } from "./../../types/user";
import { useI18n } from "../../i18n";

// ─── Performance score ring ───────────────────────────────────────────────────

export function ScoreRing({ score }: { score: number }) {
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
          className="text-[11px] uppercase tracking-widest"
          style={{ color: "#86d1ea" }}
        >
          XP
        </span>
      </div>
    </div>
  );
}

// ─── Monthly hit-rate sparkline ───────────────────────────────────────────────

const CHART_H = 56;
const CHART_W = 280;

/**
 * Courbe du taux de réussite mensuel.
 *
 * ⚠️ DEUX CAS QUI CASSAIENT CE COMPOSANT, et qui ne sont pas théoriques : ils
 * sont l'état NORMAL d'un compte neuf. Tant que les statistiques sortaient
 * d'une table vide, personne ne les voyait.
 *
 *   0 mois — `Math.max(...[])` vaut `-Infinity`, `min` vaut `Infinity`, chaque
 *            `y` part en `NaN` et le `step` se calcule sur `length - 1 = -1`.
 *            Le `<path>` reçoit `d="MNaN,NaN"`, que le navigateur ignore en
 *            silence : une carte vide, aucune erreur en console.
 *   1 mois — `step = W / 0 = Infinity`. Même silence.
 *
 * D'où la sortie anticipée ci-dessous, et le `span` pour le point unique : un
 * seul mois n'est pas une tendance, on l'affiche comme une valeur.
 */
export function HitRateChart({
  stats,
}: {
  stats: UserBettingStats;
}) {
  const { t } = useI18n();
  const months = stats.monthlyStats;

  const header = (
    <div className="flex items-center justify-between mb-3">
      <p className="text-white text-xs font-medium">
        {t("profile.hitRateTrend")}
      </p>
      <span className="text-[#90C9F0] text-xs font-bold">
        {stats.hitRate}% season avg
      </span>
    </div>
  );

  if (months.length === 0) {
    return (
      <div className="icy-card rounded-2xl p-4">
        {header}
        <p className="text-white/40 text-[11px] leading-relaxed">
          {t("profile.noTrendYet")}
        </p>
      </div>
    );
  }

  // Échelle verticale. Le `- 5` garde une amplitude non nulle quand tous les
  // mois affichent le même taux : sans lui, `(hitRate - min) / (max - min)`
  // diviserait par zéro sur une courbe parfaitement plate.
  const max  = Math.max(...months.map((m) => m.hitRate));
  const min  = Math.min(...months.map((m) => m.hitRate)) - 5;
  const span = max - min || 1;

  // Un seul mois : pas de segment à tracer, on pose le point au centre.
  const step = months.length > 1 ? CHART_W / (months.length - 1) : 0;
  const xAt  = (i: number) => (months.length > 1 ? i * step : CHART_W / 2);
  const yAt  = (hitRate: number) => CHART_H - ((hitRate - min) / span) * CHART_H;

  const pts  = months.map((m, i) => `${xAt(i)},${yAt(m.hitRate)}`);
  const line = `M${pts.join(" L")}`;
  const area = `${line} L${xAt(months.length - 1)},${CHART_H} L${xAt(0)},${CHART_H} Z`;

  return (
    <div className="icy-card rounded-2xl p-4">
      {header}

      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="w-full"
        style={{ height: CHART_H }}
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

        {months.length > 1 && (
          <>
            <path d={area} fill="url(#chartFill)" />
            <path
              d={line}
              fill="none"
              stroke="#90C9F0"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        )}

        {months.map((m, i) => (
          <circle
            key={i}
            cx={xAt(i)}
            cy={yAt(m.hitRate)}
            r="3"
            fill="#90C9F0"
          />
        ))}
      </svg>

      <div className={`flex mt-2 ${months.length > 1 ? "justify-between" : "justify-center"}`}>
        {months.map((m, i) => (
          <span key={i} className="text-white/70 text-[11px]">
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

      {stats.marketBreakdown.length === 0 && (
        <p className="text-white/40 text-[11px] leading-relaxed">
          {t("profile.noMarketYet")}
        </p>
      )}

      <div className="flex flex-col gap-2.5">
        {stats.marketBreakdown.map((m) => (
          <div key={m.marketType}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-white/70 text-[11px]">
                {m.label}
              </span>

              <div className="flex items-center gap-2">
                <span className="text-white/70 text-[11px]">
                  {m.bets} bets
                </span>
                <span className="text-white text-[11px] font-bold">
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
