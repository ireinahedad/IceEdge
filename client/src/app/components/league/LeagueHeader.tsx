// components/league/LeagueHeader.tsx

import { useSport } from "../../context/SportContext";
import { useI18n } from "../../i18n";

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
    { key: "leaderboard", label: t("league.rankings") },
    { key: "chat",        label: lang === "fr" ? "Communauté" : "Community" },
  ];

  return (
    <header className="px-4 pt-12 pb-3 bg-[#0A0E0C]/80 backdrop-blur-md sticky top-0 z-40 border-b border-white/[0.04]">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-white text-xl font-bold" style={{ fontFamily: "'Merriweather', Georgia, serif" }}>{lang === "fr" ? "Ligue" : "League"}</h1>
            {/* Sport badge */}
            <span
              className="text-[10px] px-2 py-0.5 rounded-full font-medium"
              style={{ backgroundColor: `${accent}1a`, color: accent }}
            >
              {theme.sportIcon} {theme.sportLabel}
            </span>
          </div>
          <p className="text-white/50 text-xs">{lang === "fr" ? "Classement et communauté" : "Rankings & community"}</p>
        </div>
      </div>

      <div className="flex gap-1 bg-[#072E49] backdrop-blur-md rounded-xl p-1 border border-white/60">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key as Tab)}
            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[10px] font-medium transition-all relative"
            style={
              tab === t.key
                ? { backgroundColor: "#22ff00", color: "#072E49", fontWeight: 700 }
                : { color: "rgba(255,255,255,0.7)" }
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
