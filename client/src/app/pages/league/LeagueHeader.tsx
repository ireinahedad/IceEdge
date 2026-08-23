// components/league/LeagueHeader.tsx

import { useSport } from "../../context/SportContext";
import { useI18n } from "../../i18n";
import "../../components/rink-theme.css";

type Tab = "leaderboard" | "chat";

export function LeagueHeader({
  tab,
  setTab,
  totalUnread = 0,
}: {
  tab: Tab;
  setTab: (tab: Tab) => void;
  totalUnread?: number;
}) {
  const { theme } = useSport();
  const { t, lang } = useI18n();
  const accent = theme.accent;

  const tabs = [
    { key: "chat",        label: lang === "fr" ? "Chat" : "Chat" },
    { key: "leaderboard", label: t("league.rankings") },
  ];

  return (
    <header className="bg-[#0A0E0C]/80 backdrop-blur-md sticky top-0 z-40" style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}>
      <div className="rink-boards" aria-hidden />
      <div className="px-4 pt-3 pb-3 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-white text-xl font-bold uppercase" style={{ fontFamily: "'Oswald', 'Arial Narrow', sans-serif" }}>{t("nav.league")}</h1>
            {/* Sport badge */}
            {[theme.sportIcon, theme.sportLabel].filter(Boolean).length > 0 && (
              <span
                className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                style={{ backgroundColor: `${accent}1a`, color: accent }}
              >
                {[theme.sportIcon, theme.sportLabel].filter(Boolean).join(" ")}
              </span>
            )}
          </div>
          <p className="text-white/50 text-xs">{lang === "fr" ? "Classement et chat" : "Rankings & community"}</p>
        </div>
      </div>

      <div className="mx-4 mb-3 flex gap-1 bg-white/5 rounded-xl p-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key as Tab)}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all relative"
            style={
              tab === t.key
                ? { background: "#90C9F0", color: "#072E49" }
                : { color: "#92A08A" }
            }
          >
            <span>{t.label}</span>
            {t.key === "chat" && totalUnread > 0 && tab !== "chat" && (
              <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[8px] font-bold w-3.5 h-3.5 rounded-full flex items-center justify-center">
                {totalUnread > 9 ? "9+" : totalUnread}
              </span>
            )}
          </button>
        ))}
      </div>
    </header>
  );
}
