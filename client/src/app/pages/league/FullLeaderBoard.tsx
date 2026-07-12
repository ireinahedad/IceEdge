// components/league/leaderboard/FullLeaderboard.tsx

import { useEffect, useState } from "react";
import { FrozenName } from "../../components/brand/FrozenName";
import { ProLock } from "../../components/ProLock";
import { profileApiService } from "../../services/userService";
import { useSubscription } from "../../context/SubscriptionContext";
import { useAuth } from "../../context/AuthContext";
import { useI18n } from "../../i18n";
import type { LeaderboardEntry } from "../../types/user";

// Initials fallback shown when a user has no photo avatar (no emoji avatars).
function initials(name: string): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

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
  const { isPro } = useSubscription();
  const { user } = useAuth();
  const isSelf = user?.id === entry.userId;
  const canViewBets = isPro || isSelf;   // viewing others' bets is Pro-only
  const medal = entry.rank === 1 ? "🥇" : entry.rank === 2 ? "🥈" : entry.rank === 3 ? "🥉" : null;
  const [slips, setSlips] = useState<PublicSlip[] | "private" | "loading">("loading");

  useEffect(() => {
    if (!canViewBets) return;            // don't fetch — Pro lock is shown instead
    setSlips("loading");
    profileApiService.getUserSlips(entry.userId)
      .then((s) => setSlips(s as PublicSlip[]))
      .catch(() => setSlips("private"));
  }, [entry.userId, canViewBets]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-[430px] max-h-[80vh] overflow-y-auto icy-card rounded-t-3xl p-6 pb-10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-5" />

        <div className="flex items-center gap-4 mb-5">
          <div className="w-16 h-16 rounded-2xl icy-tile flex items-center justify-center text-xl font-bold text-white/80 overflow-hidden">
            {entry.avatarUrl
              ? <img src={entry.avatarUrl} alt="" className="w-full h-full object-cover" />
              : initials(entry.displayName)}
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
          <div className="icy-tile rounded-xl p-3 text-center">
            <p className="text-[#90C9F0] text-base font-bold">{entry.performanceScore}</p>
            <p className="text-white/50 text-[9px] uppercase tracking-wider">{t("league.score")}</p>
          </div>
          <div className="icy-tile rounded-xl p-3 text-center">
            <p className="text-base font-bold" style={{ color: "#22ff00" }}>{entry.hitRate}%</p>
            <p className="text-white/50 text-[9px] uppercase tracking-wider">{t("league.hitRate")}</p>
          </div>
          <div className="icy-tile rounded-xl p-3 text-center">
            <p className="text-white text-base font-bold">{entry.totalBets}</p>
            <p className="text-white/50 text-[9px] uppercase tracking-wider">{t("league.bets")}</p>
          </div>
        </div>

        {/* Recent slips — viewing another player's bets is a Pro feature */}
        <div className="mb-4">
          <p className="text-white/40 text-[9px] uppercase tracking-widest mb-2">{t("league.recentSlips")}</p>
          {!canViewBets ? (
            <ProLock locked title={t("league.othersProTitle")} description={t("league.othersProDesc")}>
              <div className="flex flex-col gap-2">
                {[1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-2.5 icy-tile rounded-xl px-3 py-2.5">
                    <span className="w-2 h-2 rounded-full bg-white/30" />
                    <div className="flex-1">
                      <div className="h-2.5 w-24 bg-white/20 rounded mb-1.5" />
                      <div className="h-2 w-16 bg-white/10 rounded" />
                    </div>
                    <span className="text-[10px] font-bold text-white/30">••</span>
                  </div>
                ))}
              </div>
            </ProLock>
          ) : (<>
          {slips === "loading" && (
            <div className="flex flex-col gap-2">
              {[1, 2].map((i) => <div key={i} className="h-12 bg-white/5 rounded-xl animate-pulse" />)}
            </div>
          )}
          {slips === "private" && (
            <div className="icy-tile rounded-xl px-3 py-3 text-center">
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
                  <div key={s.id} className="flex items-center gap-2.5 icy-tile rounded-xl px-3 py-2.5">
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
          </>)}
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

  // Medal tier by rank: 1–3 gold, 4–10 silver, 11–50 bronze
  const medalFor = (rank: number): string | null =>
    rank <= 3 ? "🥇" : rank <= 10 ? "🥈" : rank <= 50 ? "🥉" : null;

  // Show the top 50 — but keep every match visible while searching
  const visibleRows = q ? sorted : sorted.slice(0, 50);

  const filterButtons: { key: LeaderboardFilter; label: string }[] = [
    { key: "score", label: t("league.score") },
    { key: "hitrate", label: t("league.hitRate") },
    { key: "volume", label: t("league.volume") },
  ];

  return (
    <>
      <div className="flex flex-col gap-3 w-full">
        {/* Sort filters */}
        <div className="flex gap-1">
          {filterButtons.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`flex-1 py-1.5 rounded-xl border text-[10px] font-medium transition-all ${
                filter === f.key
                  ? "bg-[#22ff00] text-[#072E49] border-[#22ff00] font-bold"
                  : "icy-tile text-white"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Player search */}
        <div className="icy-card rounded-2xl flex items-center gap-2 px-3 py-2.5">
          <span className="text-white/40 text-sm">🔎</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("league.searchPlayer")}
            className="flex-1 bg-transparent text-white text-xs outline-none placeholder-white/30"
          />
          {searching && <span className="w-3 h-3 rounded-full border border-[#90C9F0]/40 border-t-[#90C9F0] animate-spin flex-shrink-0" />}
          {search && !searching && <button onClick={() => setSearch("")} className="text-white/50 text-xs">✕</button>}
        </div>

        {/* Podium — only when score sort + no search */}
        {filter === "score" && !q && podium.length >= 3 && (
          <div className="icy-card rounded-2xl p-4">
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
                  : <span className="w-8 h-8 rounded-full bg-white/10 border border-white/20 flex items-center justify-center text-[11px] font-bold text-white/80">{initials(podium[1].displayName)}</span>}
                <div className="text-center">
                  <FrozenName name={podium[1].displayName} score={podium[1].performanceScore} size={11} />
                  <p className="text-[#90C9F0] text-[10px] mt-2">{podium[1].performanceScore}</p>
                </div>
                <div className="w-16 icy-tile rounded-t-lg flex items-center justify-center" style={{ height: 44 }}>
                  <span className="text-lg">🥇</span>
                </div>
              </button>

              {/* 1st */}
              <button
                onClick={() => setSelectedUser(podium[0])}
                className="flex flex-col items-center gap-1.5 active:scale-95 transition-transform"
              >
                <span className="text-xl leading-none -mb-1">👑</span>
                {podium[0].avatarUrl
                  ? <img src={podium[0].avatarUrl} alt="" className="w-10 h-10 rounded-full object-cover border border-white/20" />
                  : <span className="w-10 h-10 rounded-full bg-white/10 border border-white/20 flex items-center justify-center text-sm font-bold text-white/80">{initials(podium[0].displayName)}</span>}
                <div className="text-center">
                  <FrozenName name={podium[0].displayName} score={podium[0].performanceScore} size={13} />
                  <p className="text-yellow-400 text-[10px] font-bold mt-2">{podium[0].performanceScore}</p>
                </div>
                <div className="w-16 icy-tile rounded-t-lg flex items-center justify-center" style={{ height: 60 }}>
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
                  : <span className="w-8 h-8 rounded-full bg-white/10 border border-white/20 flex items-center justify-center text-[11px] font-bold text-white/80">{initials(podium[2].displayName)}</span>}
                <div className="text-center">
                  <FrozenName name={podium[2].displayName} score={podium[2].performanceScore} size={11} />
                  <p className="text-amber-600 text-[10px] mt-2">{podium[2].performanceScore}</p>
                </div>
                <div className="w-16 icy-tile rounded-t-lg flex items-center justify-center" style={{ height: 32 }}>
                  <span className="text-lg">🥇</span>
                </div>
              </button>
            </div>
            <p className="text-white/30 text-[9px] text-center mt-3">{t("league.podiumTap")}</p>
          </div>
        )}

        {/* Full list */}
        <div className="icy-card rounded-2xl overflow-hidden">
          <div className="flex items-center px-4 py-2 border-b border-white/20">
            <span className="text-white/40 text-[9px] uppercase tracking-wider w-8">#</span>
            <span className="text-white/40 text-[9px] uppercase tracking-wider flex-1">{t("league.player")}</span>
            <span className="text-white/40 text-[9px] uppercase tracking-wider w-14 text-right">
              {filter === "score" ? t("league.score") : filter === "hitrate" ? "HR%" : "Bets"}
            </span>
          </div>

          {visibleRows.map((entry) => {
            const medal = medalFor(entry.displayRank);
            const showCrown = entry.displayRank === 1 || entry.isCurrentUser;
            const mainValue =
              filter === "score" ? entry.performanceScore :
              filter === "hitrate" ? `${entry.hitRate}%` :
              entry.totalBets;

            return (
              <button
                key={entry.userId}
                onClick={() => setSelectedUser(entry)}
                className={`w-full flex items-center gap-3 px-4 py-3 border-b border-white/10 last:border-0 text-left active:bg-white/5 transition-colors ${
                  entry.isCurrentUser ? "bg-[#90C9F0]/10" : ""
                }`}
              >
                <div className="w-8 flex-shrink-0 flex flex-col items-center justify-center leading-none">
                  {medal && <span className="text-sm">{medal}</span>}
                  <span className="text-white/40 text-[9px] font-bold mt-0.5">{entry.displayRank}</span>
                </div>

                {entry.avatarUrl
                  ? <img src={entry.avatarUrl} alt="" className="w-7 h-7 rounded-full object-cover border border-white/20 flex-shrink-0" />
                  : <span className="w-7 h-7 rounded-full bg-white/10 border border-white/20 flex items-center justify-center text-[10px] font-bold text-white/80 flex-shrink-0">{initials(entry.displayName)}</span>}

                <div className="flex-1 min-w-0 py-1">
                  <div className="flex items-center gap-1.5">
                    {showCrown && <span className="text-sm flex-shrink-0">👑</span>}
                    <FrozenName name={entry.displayName} score={entry.performanceScore} size={12} />
                    {entry.isCurrentUser && (
                      <span className="text-[8px] text-[#90C9F0] border border-[#90C9F0]/40 rounded-full px-1 flex-shrink-0">
                        {t("league.you")}
                      </span>
                    )}
                  </div>
                </div>

                <div className="w-14 text-right flex-shrink-0">
                  <span className={`text-xs font-bold ${entry.isCurrentUser ? "text-[#90C9F0]" : "text-white"}`}>
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