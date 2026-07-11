import { createContext } from "react";
import { useNavigate } from "react-router";
import { useI18n } from "../../i18n";

/** Context: when true, all BetOptions show their % without requiring a tap */
export const RevealAllCtx = createContext<boolean>(false);

/* ─── Form dots ────────────────────────────────── */
export function FormDots({ results }: { results: ("W" | "L" | "OT")[] }) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {results.map((r, i) => (
        <div key={i} className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold ${
          r === "W" ? "bg-green-500/20 text-green-400 border border-green-500/30" :
          r === "OT" ? "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30" :
          "bg-red-500/20 text-red-400 border border-red-500/30"
        }`}>{r}</div>
      ))}
    </div>
  );
}

export function FormLegend() {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-4 mt-3">
      <div className="flex items-center gap-1.5">
        <div className="w-3 h-3 rounded-full bg-green-500/40 border border-green-500/60" />
        <span className="text-[#bfc8cc] text-[10px]">{t("pred.win")}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="w-3 h-3 rounded-full bg-yellow-500/40 border border-yellow-500/60" />
        <span className="text-[#bfc8cc] text-[10px]">OT</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="w-3 h-3 rounded-full bg-red-500/40 border border-red-500/60" />
        <span className="text-[#bfc8cc] text-[10px]">{t("pred.loss")}</span>
      </div>
    </div>
  );
}

/** Single-subject recent form card (used for player & team). */
export function RecentFormCard({ title, results }: { title?: string; results: ("W" | "L" | "OT")[] }) {
  const { t } = useI18n();
  return (
    <div className="bg-[#131A12] border border-white/20 rounded-2xl p-4">
      <p className="text-white text-sm font-medium mb-3">{title ?? t("pred.recentForm")}</p>
      <FormDots results={results} />
      <FormLegend />
    </div>
  );
}

/** Two-team recent form card (used for a game — one row per team). */
export function GameRecentForm({ home, away, homeForm, awayForm }: {
  home: { abbr: string; logo: string }; away: { abbr: string; logo: string };
  homeForm: ("W" | "L" | "OT")[]; awayForm: ("W" | "L" | "OT")[];
}) {
  const { t } = useI18n();
  const Row = ({ team, form }: { team: { abbr: string; logo: string }; form: ("W" | "L" | "OT")[] }) => (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2 w-16 flex-shrink-0">
        <img src={team.logo} alt={team.abbr} className="w-6 h-6 object-contain" />
        <span className="text-white text-xs font-bold">{team.abbr}</span>
      </div>
      <FormDots results={form} />
    </div>
  );
  return (
    <div className="bg-[#131A12] border border-white/20 rounded-2xl p-4">
      <p className="text-white text-sm font-medium mb-3">{t("pred.recentForm")}</p>
      <div className="flex flex-col gap-3">
        <Row team={home} form={homeForm} />
        <Row team={away} form={awayForm} />
      </div>
      <FormLegend />
    </div>
  );
}

/* --- Recent-form generator --- */
/** Deterministic-ish recent form: `count` results biased by win probability `prob` (0..1). */
export function generateForm(count: number, prob: number): ("W" | "L" | "OT")[] {
  const p = Math.min(0.95, Math.max(0.05, prob));
  const out: ("W" | "L" | "OT")[] = [];
  for (let i = 0; i < count; i++) {
    const r = Math.random();
    if (r < p)                 out.push("W");
    else if (r < p + 0.12)     out.push("OT");
    else                       out.push("L");
  }
  return out;
}

/* --- Loading skeleton --- */
export function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {[1,2,3,4].map(i => <div key={i} className="h-20 bg-[#131A12] rounded-2xl animate-pulse" />)}
    </div>
  );
}

/* ─── Reveal-all toggle bar ────────────────────── */
export function PredictionsRevealBar({ revealAll, onToggle }: { revealAll: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-between px-1">
      <span className="text-[#4a6070] text-[10px] font-semibold uppercase tracking-wider">{t("pred.markets")}</span>
      <button
        onClick={onToggle}
        className="flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-semibold transition-all active:scale-95"
        style={revealAll
          ? { background: "#a78bfa22", color: "#a78bfa", border: "1px solid #a78bfa44" }
          : { background: "rgba(255,255,255,0.05)", color: "#8a9ea6", border: "1px solid rgba(255,255,255,0.08)" }}
      >
        {revealAll ? t("pred.hideAll") : t("pred.revealAll")}
      </button>
    </div>
  );
}

/* ─── Not found ────────────────────────────────── */
export function NotFound() {
  const navigate = useNavigate();
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center justify-center py-24 px-6 text-center">
      <p className="text-4xl mb-4">🏒</p>
      <p className="text-white font-bold text-lg mb-2">{t("pred.notFound")}</p>
      <p className="text-[#8a9ea6] text-sm mb-6">{t("pred.notExist")}</p>
      <button onClick={() => navigate(-1)} className="px-6 py-2 rounded-xl bg-[#86d1ea]/10 border border-[#86d1ea]/30 text-[#86d1ea] text-sm">{t("pred.goBack")}</button>
    </div>
  );
}
