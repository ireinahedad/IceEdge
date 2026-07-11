import { useEffect, useRef, useState } from "react";
import { IceedgeLogo } from "../../components/brand/IceedgeLogo";
import { useSport, SPORT_THEMES, type Sport } from "../../context/SportContext";

// ─── Sport Selector ────────────────────────────────────────────────────────────

export function SportSelector() {
  const { sport, setSport, theme } = useSport();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handleClick(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2.5 select-none">
        {/* ARAKICE logo mark */}
        <IceedgeLogo size={38} wordmark={false} />
        {/* Brand name + sport label */}
        <div className="flex flex-col leading-none gap-0.5">
          <span
            className="tracking-[0.14em] uppercase text-sm font-bold text-white"
            style={{ fontFamily: "'Oswald', 'Arial Narrow', sans-serif", letterSpacing: "0.12em" }}
          >
            ARAKICE
          </span>
          <span className="text-[10px] tracking-wider" style={{ color: theme.accent, opacity: 0.85 }}>
            {theme.sportLabel}
          </span>
        </div>
        <span className="text-xs" style={{ color: theme.accent }}>▾</span>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-2 icy-card rounded-2xl overflow-hidden z-50 min-w-[168px] shadow-xl shadow-black/50">
          {(Object.keys(SPORT_THEMES) as Sport[]).map((s) => {
            const t = SPORT_THEMES[s]; const active = sport === s;
            return (
              <button key={s} onClick={() => { setSport(s); setOpen(false); }}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${active ? "bg-white/5" : "hover:bg-white/5"}`}>
                <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${t.accent}20`, border: `1.5px solid ${t.accent}50` }}>
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: t.accent }} />
                </div>
                <span className="text-white text-sm flex-1">{t.sportLabel}</span>
                {active && <span className="text-xs font-bold" style={{ color: t.accent }}>✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
