import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { BottomNav } from "../BottomNav";
import { useAuth } from "../../context/AuthContext";
import { profileApiService } from "./../../services/userService";
import type { UserProfile, UserBettingStats, BetRecord } from "./../../types/user";
import {
  StatPill,
  ScoreRing,
  HitRateChart,
  MarketBreakdown,
  BadgeGrid,
  BetHistoryList,
  CalibrationCard,
  TIER_CONFIG,
} from "./ProfileComponents";

type Tab = "overview" | "history";

function Skeleton({ className }: { className: string }) {
  return (
    <div className={`bg-white/5 backdrop-blur-md border border-white/20 rounded-xl animate-pulse ${className}`} />
  );
}

function StreakBadge({ streak }: { streak: number }) {
  if (streak === 0) return null;
  const isWin = streak > 0;
  const abs = Math.abs(streak);
  return (
    <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-bold ${
      isWin
        ? "bg-green-500/15 border-green-500/30 text-green-400"
        : "bg-red-500/15 border-red-500/30 text-red-400"
    }`}>
      <span>{abs} {isWin ? "W" : "L"} streak</span>
    </div>
  );
}

function UserAvatar({ avatarUrl, avatar, size = "lg" }: { avatarUrl?: string | null; avatar?: string; size?: "sm" | "lg" }) {
  const dim = size === "lg" ? "w-16 h-16 text-3xl" : "w-8 h-8 text-base";
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt="avatar"
        className={`${dim} rounded-2xl object-cover border border-white/20`}
      />
    );
  }
  return (
    <div className={`${dim} rounded-2xl bg-white/5 backdrop-blur-md border border-white/20 flex items-center justify-center`}>
      {avatar ?? "👤"}
    </div>
  );
}

function ProfileHeader({ profile, stats, avatarUrl }: { profile: UserProfile; stats: UserBettingStats; avatarUrl?: string | null }) {
  const tc = TIER_CONFIG[profile.tier];
  return (
    <div className="bg-white/5 backdrop-blur-md border border-white/20 rounded-2xl p-5">
      <div className="flex items-center gap-4 mb-4">
        <div className="relative">
          <UserAvatar avatarUrl={avatarUrl} avatar={profile.avatar} size="lg" />
          {profile.favoriteTeam && (
            <div className="absolute -bottom-1.5 -right-1.5 bg-[#86d1ea] text-[#0a1014] text-[8px] font-bold px-1.5 py-0.5 rounded-full">
              {profile.favoriteTeam}
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-white font-bold text-base leading-tight">{profile.displayName}</p>
          <p className="text-white/70 text-xs">@{profile.username}</p>
          <div className="mt-1.5 flex items-center gap-2 flex-wrap">
            <span
              className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${tc.bg}`}
              style={{ color: tc.color }}
            >
              {tc.icon} {tc.label}
            </span>
            <StreakBadge streak={stats.currentStreak} />
          </div>
        </div>

        <ScoreRing score={profile.performanceScore} tier={profile.tier} />
      </div>

      {profile.bio && (
        <p className="text-white/70 text-[10px] leading-relaxed mb-4 border-t border-white/20 pt-3">
          {profile.bio}
        </p>
      )}

      <div className="grid grid-cols-4 gap-2">
        <StatPill label="Hit Rate" value={`${stats.hitRate}%`} color={stats.hitRate >= 65 ? "#4ade80" : "#86d1ea"} />
        <StatPill label="Bets" value={`${stats.totalBets}`} color="#86d1ea" />
        <StatPill label="W - L" value={`${stats.wins}-${stats.losses}`} color="#bfc8cc" />
        <StatPill label="Best Streak" value={`${stats.longestWinStreak}W`} color="#facc15" />
      </div>
    </div>
  );
}

function OverviewTab({ profile, stats }: { profile: UserProfile; stats: UserBettingStats }) {
  const total = stats.parlayRecord.wins + stats.parlayRecord.losses;
  return (
    <div className="flex flex-col gap-3">
      <div className="bg-white/5 backdrop-blur-md border border-white/20 rounded-2xl p-4">
        <p className="text-white text-xs font-medium mb-3">Parlay Record</p>
        <div className="flex items-center gap-4">
          <div className="flex-1 text-center">
            <p className="text-green-400 text-xl font-bold">{stats.parlayRecord.wins}</p>
            <p className="text-white/70 text-[9px]">Parlay Wins</p>
          </div>
          <div className="w-px h-10 bg-white/10" />
          <div className="flex-1 text-center">
            <p className="text-red-400 text-xl font-bold">{stats.parlayRecord.losses}</p>
            <p className="text-white/70 text-[9px]">Parlay Losses</p>
          </div>
          <div className="w-px h-10 bg-white/10" />
          <div className="flex-1 text-center">
            <p className="text-[#86d1ea] text-xl font-bold">
              {total > 0 ? Math.round((stats.parlayRecord.wins / total) * 100) : 0}%
            </p>
            <p className="text-white/70 text-[9px]">Parlay Rate</p>
          </div>
        </div>
      </div>
      <HitRateChart stats={stats} />
      <CalibrationCard stats={stats} />
      <MarketBreakdown stats={stats} />
      <BadgeGrid badges={profile.badges} />
      <div className="flex items-center justify-center gap-2 py-2">
        <span className="text-white/70 text-[10px]">
          IceEdge member since{" "}
          {new Date(profile.joinedAt).toLocaleDateString("en-US", { month: "long", year: "numeric" })}
        </span>
      </div>
    </div>
  );
}

// ---- Not-logged-in gate ------------------------------------------------------

function NotLoggedIn() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col items-center justify-center flex-1 px-6 text-center gap-6">
      <div className="w-20 h-20 rounded-3xl bg-[#86d1ea]/10 border border-[#86d1ea]/20 flex items-center justify-center">
        <div className="w-8 h-8 rounded-full bg-[#86d1ea]/30 border border-[#86d1ea]/50" />
      </div>
      <div>
        <h2 className="text-white text-lg font-bold mb-1">Sign in to IceEdge</h2>
        <p className="text-white/50 text-xs leading-relaxed">
          Track your bets, climb the leaderboard, and build your betting profile.
        </p>
      </div>
      <button
        onClick={() => navigate("/login")}
        className="w-full max-w-xs py-3 rounded-xl bg-[#86d1ea] text-[#0a1014] text-sm font-bold hover:bg-[#86d1ea]/90 active:scale-[0.98] transition-all"
      >
        Sign In / Create Account
      </button>
    </div>
  );
}

// ---- Main page ---------------------------------------------------------------

export function ProfilePage() {
  const { user, logout, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  const [tab, setTab] = useState<Tab>("overview");
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [stats, setStats] = useState<UserBettingStats | null>(null);
  const [bets, setBets] = useState<BetRecord[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    Promise.all([
      profileApiService.getProfile(),
      profileApiService.getBettingStats(),
      profileApiService.getBetHistory(),
    ])
      .then(([p, s, b]) => { setProfile(p); setStats(s); setBets(b); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [user]);

  async function handleLogout() {
    await logout();
    navigate("/", { replace: true });
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "history",  label: "History"  },
  ];

  return (
    <div className="flex flex-col min-h-screen bg-transparent text-white max-w-[430px] mx-auto">
      <header className="px-4 pt-12 pb-3 bg-[#0a1014]/80 backdrop-blur-md sticky top-0 z-40 border-b border-white/[0.04]">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-white text-xl font-bold" style={{ fontFamily: "'Merriweather', Georgia, serif" }}>Profile</h1>
            <p className="text-white/70 text-xs">
              {user ? `@${profile?.username ?? user.email}` : "Sign in to get started"}
            </p>
          </div>

          {user && (
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/5 border border-white/20 text-white/60 text-[10px] hover:text-red-400 hover:border-red-500/30 transition-all"
            >
              <span>Sign out</span>
            </button>
          )}
        </div>

        {user && (
          <div className="flex gap-1 mt-3 bg-white/5 backdrop-blur-md border border-white/20 rounded-xl p-1">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-[10px] font-medium transition-all ${
                  tab === t.key
                    ? "bg-[#86d1ea] text-[#0a1014] font-bold"
                    : "text-white/70"
                }`}
              >
                <span>{t.label}</span>
              </button>
            ))}
          </div>
        )}
      </header>

      <div className="flex-1 px-4 pb-28 pt-4 overflow-y-auto flex flex-col">
        {authLoading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-44" />
            <Skeleton className="h-28" />
          </div>
        ) : !user ? (
          <NotLoggedIn />
        ) : loading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-44" />
            <Skeleton className="h-28" />
            <Skeleton className="h-36" />
            <Skeleton className="h-24" />
          </div>
        ) : profile && stats ? (
          <>
            <div className="mb-3">
              <ProfileHeader profile={profile} stats={stats} avatarUrl={user.avatar_url} />
            </div>
            {tab === "overview" && <OverviewTab profile={profile} stats={stats} />}
            {tab === "history"  && <BetHistoryList bets={bets} />}
          </>
        ) : (
          <div className="flex items-center justify-center flex-1">
            <p className="text-white/40 text-sm">Could not load profile data.</p>
          </div>
        )}
      </div>

      <BottomNav />
    </div>
  );
}
