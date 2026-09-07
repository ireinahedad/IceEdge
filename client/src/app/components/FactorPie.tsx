/**
 * FactorPie.tsx
 * Pie chart (donut) SVG autonome — aucune dépendance externe.
 * Réutilisé pour visualiser la décomposition des facteurs des règles
 * (dans /prediction) et la pondération (dans les paramètres).
 */

export interface PieSlice {
  label: string;
  value: number;   // magnitude relative (poids, ou contribution)
  color: string;
  sub?: string;    // info secondaire affichée dans la légende (ex. valeur du facteur)
}

export function FactorPie({
  slices,
  size = 132,
  thickness = 20,
  centerLabel,
  centerSub,
  hideLegend = false,
  vertical = false,
  reverse = false,
}: {
  slices: PieSlice[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerSub?: string;
  hideLegend?: boolean;
  vertical?: boolean;
  reverse?: boolean;
}) {
  const active = slices.filter((s) => s.value > 0);
  const total = active.reduce((s, x) => s + x.value, 0) || 1;
  const r = (size - thickness) / 2;
  const circ = 2 * Math.PI * r;

  let offset = 0;

  return (
    <div className={vertical ? "flex flex-col items-center gap-3" : reverse ? "flex flex-row-reverse items-center gap-4" : "flex items-center gap-4"}>
      <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke="rgba(255,255,255,0.06)"
              strokeWidth={thickness}
            />
            {active.map((s, i) => {
              const len = (s.value / total) * circ;
              const el = (
                <circle
                  key={i}
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={thickness}
                  strokeDasharray={`${len} ${circ - len}`}
                  strokeDashoffset={-offset}
                  strokeLinecap="butt"
                />
              );
              offset += len;
              return el;
            })}
          </g>
        </svg>
        {(centerLabel || centerSub) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            {centerLabel && <span className="text-white text-base font-black leading-none">{centerLabel}</span>}
            {centerSub && <span className="text-white/45 text-[11px] uppercase tracking-wider mt-0.5">{centerSub}</span>}
          </div>
        )}
      </div>

      {!hideLegend && (
      <div className={vertical ? "flex flex-col gap-1 w-full" : "flex flex-col gap-1 min-w-0 flex-1"}>
        {slices.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: s.color }} />
            <span className="text-white/80 text-[11px] flex-1 truncate">{s.label}</span>
            <span className="text-white/55 text-[11px] tabular-nums flex-shrink-0">
              {Math.round((Math.max(0, s.value) / total) * 100)}%
              {s.sub ? <span className="text-white/35"> · {s.sub}</span> : null}
            </span>
          </div>
        ))}
      </div>
      )}
    </div>
  );
}
