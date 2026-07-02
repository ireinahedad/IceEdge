// components/league/leaderboard/FullLeaderboard.tsx

import { useEffect, useState } from "react";
import { FrozenName } from "../brand/FrozenName";
import { profileApiService } from "../../services/userService";
import { useI18n } from "../../i18n";
import type { LeaderboardEntry } from "../../types/user";

// ─── User profile modal ───────────────────────────────────────────────────────

type PublicSlip = {
  id: string;
  placedAt: string;
  legs: { selection?: string; subjectName?: string; marketType?: string }[];
  legCount: number;
  isParlay: boolean;
  combinedProbability: number | null;
  outcome: "pending" | "win" | "loss";
};

function UserProfileModal({ entry, onClose }: {
  entry: LeaderboardEntry;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const medal = entry.rank === 1 ? "🥇" : entry.rank === 2 ? "🥈" : entry.rank === 3 ? "🥉" : null;
  const [slips, setSlips] = useState<PublicSlip[] | "private" | "loading">("loading");

  useEffect(() => {
    setSlips("loading");
    profileApiService.getUserSlips(entry.userId)
      .then((s) => setSlips(s as PublicSlip[]))
      .catch(() => setSlips("private"));
  }, [entry.userId]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-[430px] md:max-w-lg max-h-[80vh] overflow-y-auto bg-[#0f1416]/95 backdrop-blur-xl border-t border-white/10 rounded-t-3xl p-6 pb-10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-5" />

        <div className="flex items-center gap-4 mb-5">
          <div className="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-3xl overflow-hidden">
            {entry.avatarUrl
              ? <img src={entry.avatarUrl} alt="" className="w-full h-full object-cover" />
              : entry.avatar}
          </div>
          <div className="flex-1 min-w-0">
            <FrozenName name={entry.displayName} score={entry.performanceScore} size={15} />
            <p className="text-white/50 text-xs mt-2">@{entry.username}</p>
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
            <p className="text-white/50 text-[9px] uppercase tracking-wider">{t("league.score")}</p>
          </div>
          <div className="bg-white/5 border border-white/10 rounded-xl p-3 text-center">
            <p className="text-green-400 text-base font-bold">{entry.hitRate}%</p>
            <p className="text-white/50 text-[9px] uppercase tracking-wider">{t("league.hitRate")}</p>
          </div>
          <div className="bg-white/5 border border-white/10 rounded-xl p-3 text-center">
            <p className="text-white text-base font-bold">{entry.totalBets}</p>
            <p className="text-white/50 text-[9px] uppercase tracking-wider">{t("league.bets")}</p>
          </div>
        </div>

        {/* Recent slips (only if the player opted in) */}
        <div className="mb-4">
          <p className="text-white/40 text-[9px] uppercase tracking-widest mb-2">{t("league.recentSlips")}</p>
          {slips === "loading" && (
            <div className="flex flex-col gap-2">
              {[1, 2].map((i) => <div key={i} className="h-12 bg-white/5 rounded-xl animate-pulse" />)}
            </div>
          )}
          {slips === "private" && (
            <div className="bg-white/5 border border-white/10 rounded-xl px-3 py-3 text-center">
              <p className="text-white/50 text-[10px]">{t("league.slipsPrivate")}</p>
            </div>
          )}
          {Array.isArray(slips) && slips.length === 0 && (
            <p className="text-white/40 text-[10px] text-center py-3">{t("league.noSlips")}</p>
          )}
          {Array.isArray(slips) && slips.length > 0 && (
            <div className="flex flex-col gap-2">
              {slips.slice(0, 6).map((s) => {
                const color = s.outcome === "win" ? "#4ade80" : s.outcome === "loss" ? "#f87171" : "#8a9ea6";
                const label = s.outcome === "win" ? t("slip.won") : s.outcome === "loss" ? t("slip.lost") : t("slip.pending");
                const first = s.legs?.[0];
                const title = first?.selection ?? first?.subjectName ?? "Slip";
                return (
                  <div key={s.id} className="flex items-center gap-2.5 bg-white/5 border border-white/10 rounded-xl px-3 py-2.5">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-[11px] font-medium truncate">
                        {title}{s.legCount > 1 ? ` +${s.legCount - 1} legs` : ""}
                      </p>
                      <p className="text-white/40 text-[9px]">
                        {new Date(s.placedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        {s.isParlay ? " · parlay" : ""}
                        {s.combinedProbability != null ? ` · ${s.combinedProbability}%` : ""}
                      </p>
                    </div>
                    <span className="text-[10px] font-bold flex-shrink-0" style={{ color }}>{label}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <button
          onClick={onClose}
          className="w-full py-3 rounded-2xl border border-white/10 text-white/60 text-sm"
        >
          {t("common.close")}
        </button>
      </div>
    </div>
  );
}

// ─── Full leaderboard ─────────────────────────────────────────────────────────

type LeaderboardFilter = "score" | "hitrate" | "volume";

export function FullLeaderboard({ entries }: { entries: LeaderboardEntry[] }) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<LeaderboardFilter>("score");
  const [selectedUser, setSelectedUser] = useState<LeaderboardEntry | null>(null);
  const [search, setSearch] = useState("");
  const [remoteResults, setRemoteResults] = useState<LeaderboardEntry[]>([]);
  const [searching, setSearching] = useState(false);

  // Search players on the server (debounced) — finds anyone with a public
  // profile, even outside the top 20 leaderboard.
  useEffect(() => {
    const q = search.trim();
    setRemoteResults([]);
    if (q.length < 2) { setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(() => {
      profileApiService.searchUsers(q)
        .then(setRemoteResults)
        .catch(() => {})
        .finally(() => setSearching(false));
    }, 350);
    return () => clearTimeout(t);
  }, [search]);

  const q = search.trim().toLowerCase();
  const localFiltered = entries.filter(
    (e) => !q || e.displayName.toLowerCase().includes(q) || e.username.toLowerCase().includes(q),
  );
  const merged = q
    ? [...localFiltered, ...remoteResults.filter((r) => !localFiltered.some((l) => l.userId === r.userId))]
    : entries;

  const sorted = [...merged]
    .sort((a, b) => {
      if (filter === "score") return b.performanceScore - a.performanceScore;
      if (filter === "hitrate") return b.hitRate - a.hitRate;
      return b.totalBets - a.totalBets;
    })
    .map((e, i) => ({ ...e, displayRank: i + 1 }));

  const podium = sorted.slice(0, 3);

  const filterButtons: { key: LeaderboardFilter; label: string }[] = [
    { key: "score", label: t("league.score") },
    { key: "hitrate", label: t("league.hitRate") },
    { key: "volume", label: t("league.volume") },
  ];

  return (
    <>
      <div className="flex flex-col gap-3 w-full md:max-w-3xl md:mx-auto">
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

        {/* Player search */}
        <div className="bg-white/5 border border-white/10 rounded-2xl flex items-center gap-2 px-3 py-2.5">
          <span className="text-white/40 text-sm">🔎</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("league.searchPlayer")}
            className="flex-1 bg-transparent text-white text-xs outline-none placeholder-white/30"
          />
          {searching && <span className="w-3 h-3 rounded-full border border-[#86d1ea]/40 border-t-[#86d1ea] animate-spin flex-shrink-0" />}
          {search && !searching && <button onClick={() => setSearch("")} className="text-white/50 text-xs">✕</button>}
        </div>

        {/* Podium — only when score sort + no search */}
        {filter === "score" && !q && podium.length >= 3 && (
          <div className="bg-white/5 backdrop-blur-md border border-white/10 rounded-2xl p-4">
            <p className="text-white/40 text-[10px] uppercase tracking-widest text-center mb-4">
              {t("league.podium")}
            </p>
            <div className="flex items-end justify-center gap-4">
              {/* 2nd */}
              <button
                onClick={() => setSelectedUser(podium[1])}
                className="flex flex-col items-center gap-1.5 active:scale-95 transition-transform"
              >
                {podium[1].avatarUrl
                  ? <img src={podium[1].avatarUrl} alt="" className="w-8 h-8 rounded-full object-cover border border-white/20" />
                  : <span className="text-2xl">{podium[1].avatar}</span>}
                <div className="text-center">
                  <FrozenName name={podium[1].displayName} score={podium[1].performanceScore} size={11} />
                  <p className="text-[#86d1ea] text-[10px] mt-2">{podium[1].performanceScore}</p>
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
                {podium[0].avatarUrl
                  ? <img src={podium[0].avatarUrl} alt="" className="w-10 h-10 rounded-full object-cover border border-white/20" />
                  : <span className="text-3xl">{podium[0].avatar}</span>}
                <div className="text-center">
                  <FrozenName name={podium[0].displayName} score={podium[0].performanceScore} size={13} />
                  <p className="text-yellow-400 text-[10px] font-bold mt-2">{podium[0].performanceScore}</p>
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
                {podium[2].avatarUrl
                  ? <img src={podium[2].avatarUrl} alt="" className="w-8 h-8 rounded-full object-cover border border-white/20" />
                  : <span className="text-2xl">{podium[2].avatar}</span>}
                <div className="text-center">
                  <FrozenName name={podium[2].displayName} score={podium[2].performanceScore} size={11} />
                  <p className="text-amber-600 text-[10px] mt-2">{podium[2].performanceScore}</p>
                </div>
                <div className="w-16 bg-white/10 rounded-t-lg flex items-center justify-center" style={{ height: 32 }}>
                  <span className="text-lg">🥉</span>
                </div>
              </button>
            </div>
            <p className="text-white/30 text-[9px] text-center mt-3">{t("league.podiumTap")}</p>
          </div>
        )}

        {/* Full list */}
        <div className="bg-white/5 backdrop-blur-md border border-white/10 rounded-2xl overflow-hidden">
          <div className="flex items-center px-4 py-2 border-b border-white/8">
            <span className="text-white/40 text-[9px] uppercase tracking-wider w-8">#</span>
            <span className="text-white/40 text-[9px] uppercase tracking-wider flex-1">{t("league.player")}</span>
            <span className="text-white/40 text-[9px] uppercase tracking-wider w-14 text-right">
              {filter === "score" ? t("league.score") : filter === "hitrate" ? "HR%" : "Bets"}
            </span>
          </div>

          {sorted.map((entry) => {
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

                {entry.avatarUrl
                  ? <img src={entry.avatarUrl} alt="" className="w-7 h-7 rounded-full object-cover border border-white/20 flex-shrink-0" />
                  : <span className="text-lg flex-shrink-0">{entry.avatar}</span>}

                <div className="flex-1 min-w-0 py-1">
                  <div className="flex items-center gap-1.5">
                    <FrozenName name={entry.displayName} score={entry.performanceScore} size={12} />
                    {entry.isCurrentUser && (
                      <span className="text-[8px] text-[#86d1ea] border border-[#86d1ea]/40 rounded-full px-1 flex-shrink-0">
                        {t("league.you")}
                      </span>
                    )}
                  </div>
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