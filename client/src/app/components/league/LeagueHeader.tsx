// components/league/LeagueHeader.tsx

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
  const tabs = [
    { key: "leaderboard", label: "Rankings", icon: "🏆" },
    { key: "chat",        label: "Community", icon: "💬" },
  ];

  return (
    <header className="px-4 pt-12 pb-3 bg-transparent sticky top-0 z-40 border-b border-white/10 backdrop-blur-sm">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h1 className="text-white text-xl font-bold">League</h1>
          <p className="text-white/50 text-xs">Rankings & community</p>
        </div>

        {tab === "chat" && (
          <div className="flex items-center gap-1.5 bg-green-500/10 border border-green-500/20 rounded-full px-2.5 py-1">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            <span className="text-green-400 text-[9px] font-medium">24 online</span>
          </div>
        )}
      </div>

      <div className="flex gap-1 bg-white/5 backdrop-blur-md rounded-xl p-1 border border-white/10">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key as Tab)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[10px] font-medium transition-all relative ${
              tab === t.key
                ? "bg-[#86d1ea] text-[#0f1416] font-bold"
                : "text-white/70"
            }`}
          >
            <span>{t.icon}</span>
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