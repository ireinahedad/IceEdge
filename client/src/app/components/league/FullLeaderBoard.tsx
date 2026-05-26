// components/league/leaderboard/FullLeaderboard.tsx

import { useState } from "react";
import { TIER_CONFIG } from "../profile/ProfileComponents";
import type { LeaderboardEntry, UserProfile } from "../../types/user";

// ─── User profile modal ───────────────────────────────────────────────────────

function UserProfileModal({ entry, onClose }: {
  entry: LeaderboardEntry;
  onClose: () => void;
}) {
  const tc = TIER_CONFIG[entry.tier];
  const medal = entry.rank === 1 ? "🥇" : entry.rank === 2 ? "🥈" : entry.rank === 3 ? "🥉" : null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-[430px] bg-[#0f1416]/95 backdrop-blur-xl border-t border-white/10 rounded-t-3xl p-6 pb-10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-5" />

        <div className="flex items-center gap-4 mb-5">
          <div className="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-3xl">
            {entry.avatar}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white font-bold text-base">{entry.displayName}</p>
            <p className="text-white/50 text-xs">@{entry.username}</p>
            <span
              className={`inline-block mt-1 text-[10px] px-2 py-0.5 rounded-full border ${tc.bg}`}
              style={{ color: tc.color }}
            >
              {tc.icon} {tc.label}
            </span>
          </div>
          {medal && (
            <div className="text-center flex-shrink-0">
              <p className="text-2xl">{medal}</p>
              <p className="text-white/40 text-[9px]">Rank #{entry.rank}</p>
            </div>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2 mb-4">
          <div className="bg-white/5 border border-white/10 rounded-xl p-3 text-center">
            <p className="text-[#86d1ea] text-base font-bold">{entry.performanceScore}</p>
            <p className="text-white/50 text-[9px] uppercase tracking-wider">Score</p>
          </div>
          <div className="bg-white/5 border border-white/10 rounded-xl p-3 text-center">
            <p className="text-green-400 text-base font-bold">{entry.hitRate}%</p>
            <p className="text-white/50 text-[9px] uppercase tracking-wider">Hit Rate</p>
          </div>
          <div className="bg-white/5 border border-white/10 rounded-xl p-3 text-center">
            <p className="text-white text-base font-bold">{entry.totalBets}</p>
            <p className="text-white/50 text-[9px] uppercase tracking-wider">Bets</p>
          </div>
        </div>

        <button
          onClick={onClose}
          className="w-full py-3 rounded-2xl border border-white/10 text-white/60 text-sm"
        >
          Close
        </button>
      </div>
    </div>
  );
}

// ─── Full leaderboard ─────────────────────────────────────────────────────────

type LeaderboardFilter = "score" | "hitrate" | "volume";

export function FullLeaderboard({ entries }: { entries: LeaderboardEntry[] }) {
  const [filter, setFilter] = useState<LeaderboardFilter>("score");
  const [tierFilter, setTierFilter] = useState<UserProfile["tier"] | "all">("all");
  const [selectedUser, setSelectedUser] = useState<LeaderboardEntry | null>(null);

  const sorted = [...entries]
    .filter((e) => tierFilter === "all" || e.tier === tierFilter)
    .sort((a, b) => {
      if (filter === "score") return b.performanceScore - a.performanceScore;
      if (filter === "hitrate") return b.hitRate - a.hitRate;
      return b.totalBets - a.totalBets;
    })
    .map((e, i) => ({ ...e, displayRank: i + 1 }));

  const podium = sorted.slice(0, 3);

  const filterButtons: { key: LeaderboardFilter; label: string }[] = [
    { key: "score", label: "Score" },
    { key: "hitrate", label: "Hit Rate" },
    { key: "volume", label: "Volume" },
  ];

  const tierButtons: { key: UserProfile["tier"] | "all"; label: string }[] = [
    { key: "all", label: "All" },
    { key: "legend", label: "👑 Legend" },
    { key: "sharp", label: "🎯 Sharp" },
    { key: "analyst", label: "📊 Analyst" },
    { key: "rookie", label: "🏒 Rookie" },
  ];

  return (
    <>
      <div className="flex flex-col gap-3">
        {/* Sort filters */}
        <div className="flex gap-1">
          {filterButtons.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`flex-1 py-1.5 rounded-xl border text-[10px] font-medium transition-all ${
                filter === f.key
                  ? "bg-[#86d1ea] text-[#0f1416] border-[#86d1ea] font-bold"
                  : "bg-white/5 backdrop-blur-md border-white/10 text-white"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Tier filter pills */}
        <div className="flex gap-1.5 overflow-x-auto pb-0.5 scrollbar-hide">
          {tierButtons.map((t) => (
            <button
              key={t.key}
              onClick={() => setTierFilter(t.key)}
              className={`flex-shrink-0 px-2.5 py-1 rounded-full text-[9px] border transition-all ${
                tierFilter === t.key
                  ? "bg-white/10 text-white border-[#86d1ea]"
                  : "text-white/50 border-white/10"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Podium — only when score sort + no tier filter */}
        {filter === "score" && tierFilter === "all" && podium.length >= 3 && (
          <div className="bg-white/5 backdrop-blur-md border border-white/10 rounded-2xl p-4">
            <p className="text-white/40 text-[10px] uppercase tracking-widest text-center mb-4">
              This Season's Podium
            </p>
            <div className="flex items-end justify-center gap-4">
              {/* 2nd */}
              <button
                onClick={() => setSelectedUser(podium[1])}
                className="flex flex-col items-center gap-1.5 active:scale-95 transition-transform"
              >
                <span className="text-2xl">{podium[1].avatar}</span>
                <div className="text-center">
                  <p className="text-white text-[10px] font-bold">{podium[1].displayName}</p>
                  <p className="text-[#86d1ea] text-[10px]">{podium[1].performanceScore}</p>
                </div>
                <div className="w-16 bg-white/10 rounded-t-lg flex items-center justify-center" style={{ height: 44 }}>
                  <span className="text-lg">🥈</span>
                </div>
              </button>

              {/* 1st */}
              <button
                onClick={() => setSelectedUser(podium[0])}
                className="flex flex-col items-center gap-1.5 active:scale-95 transition-transform"
              >
                <span className="text-3xl">{podium[0].avatar}</span>
                <div className="text-center">
                  <p className="text-white text-xs font-bold">{podium[0].displayName}</p>
                  <p className="text-yellow-400 text-[10px] font-bold">{podium[0].performanceScore}</p>
                </div>
                <div className="w-16 bg-white/10 rounded-t-lg flex items-center justify-center" style={{ height: 60 }}>
                  <span className="text-xl">🥇</span>
                </div>
              </button>

              {/* 3rd */}
              <button
                onClick={() => setSelectedUser(podium[2])}
                className="flex flex-col items-center gap-1.5 active:scale-95 transition-transform"
              >
                <span className="text-2xl">{podium[2].avatar}</span>
                <div className="text-center">
                  <p className="text-white text-[10px] font-bold">{podium[2].displayName}</p>
                  <p className="text-amber-600 text-[10px]">{podium[2].performanceScore}</p>
                </div>
                <div className="w-16 bg-white/10 rounded-t-lg flex items-center justify-center" style={{ height: 32 }}>
                  <span className="text-lg">🥉</span>
                </div>
              </button>
            </div>
            <p className="text-white/30 text-[9px] text-center mt-3">Tap a player to view their profile</p>
          </div>
        )}

        {/* Full list */}
        <div className="bg-white/5 backdrop-blur-md border border-white/10 rounded-2xl overflow-hidden">
          <div className="flex items-center px-4 py-2 border-b border-white/8">
            <span className="text-white/40 text-[9px] uppercase tracking-wider w-8">#</span>
            <span className="text-white/40 text-[9px] uppercase tracking-wider flex-1">Player</span>
            <span className="text-white/40 text-[9px] uppercase tracking-wider w-14 text-right">
              {filter === "score" ? "Score" : filter === "hitrate" ? "HR%" : "Bets"}
            </span>
          </div>

          {sorted.map((entry) => {
            const tc = TIER_CONFIG[entry.tier];
            const rankIcon =
              entry.displayRank === 1 ? "🥇" :
              entry.displayRank === 2 ? "🥈" :
              entry.displayRank === 3 ? "🥉" : null;
            const mainValue =
              filter === "score" ? entry.performanceScore :
              filter === "hitrate" ? `${entry.hitRate}%` :
              entry.totalBets;

            return (
              <button
                key={entry.userId}
                onClick={() => setSelectedUser(entry)}
                className={`w-full flex items-center gap-3 px-4 py-3 border-b border-white/5 last:border-0 text-left active:bg-white/5 transition-colors ${
                  entry.isCurrentUser ? "bg-[#86d1ea]/5" : ""
                }`}
              >
                <div className="w-8 flex-shrink-0">
                  {rankIcon
                    ? <span className="text-sm">{rankIcon}</span>
                    : <span className="text-white/40 text-[10px] font-bold">{entry.displayRank}</span>
                  }
                </div>

                <span className="text-lg flex-shrink-0">{entry.avatar}</span>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-xs font-medium truncate ${entry.isCurrentUser ? "text-[#86d1ea]" : "text-white"}`}>
                      {entry.displayName}
                    </span>
                    {entry.isCurrentUser && (
                      <span className="text-[8px] text-[#86d1ea] border border-[#86d1ea]/40 rounded-full px-1 flex-shrink-0">
                        you
                      </span>
                    )}
                  </div>
                  <span className={`text-[8px] px-1.5 py-0.5 rounded-full border ${tc.bg}`} style={{ color: tc.color }}>
                    {tc.icon} {tc.label}
                  </span>
                </div>

                <div className="w-14 text-right flex-shrink-0">
                  <span className={`text-xs font-bold ${entry.isCurrentUser ? "text-[#86d1ea]" : "text-white"}`}>
                    {mainValue}
                  </span>
                  {filter === "score" && (
                    <p className="text-white/40 text-[9px]">{entry.hitRate}% HR</p>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {selectedUser && (
        <UserProfileModal entry={selectedUser} onClose={() => setSelectedUser(null)} />
      )}
    </>
  );
}