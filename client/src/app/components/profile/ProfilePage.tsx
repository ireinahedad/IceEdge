import { useState, useEffect, useRef } from "react";
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
  CalibrationCard,
  TIER_CONFIG,
} from "./ProfileComponents";

type Tab = "overview" | "settings";

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

function UserAvatar({
  avatarUrl,
  avatar,
  size = "lg",
  onClick,
  uploading,
}: {
  avatarUrl?: string | null;
  avatar?: string;
  size?: "sm" | "lg";
  onClick?: () => void;
  uploading?: boolean;
}) {
  const dim = size === "lg" ? "w-16 h-16 text-3xl" : "w-8 h-8 text-base";
  const clickable = !!onClick;

  const inner = avatarUrl ? (
    <img
      src={avatarUrl}
      alt="avatar"
      className={`${dim} rounded-2xl object-cover border border-white/20`}
    />
  ) : (
    <div className={`${dim} rounded-2xl bg-white/5 backdrop-blur-md border border-white/20 flex items-center justify-center`}>
      {avatar ?? "👤"}
    </div>
  );

  if (!clickable) return inner;

  return (
    <div className="relative cursor-pointer" onClick={onClick}>
      {inner}
      <div className="absolute inset-0 rounded-2xl bg-black/40 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity">
        {uploading
          ? <div className="w-4 h-4 border-2 border-white/60 border-t-white rounded-full animate-spin" />
          : <span className="text-white text-lg">📷</span>
        }
      </div>
    </div>
  );
}

function ProfileHeader({
  profile,
  stats,
  onAvatarClick,
  avatarUploading,
}: {
  profile: UserProfile;
  stats: UserBettingStats;
  onAvatarClick?: () => void;
  avatarUploading?: boolean;
}) {
  const tc = TIER_CONFIG[profile.tier as keyof typeof TIER_CONFIG] ?? TIER_CONFIG.rookie;
  return (
    <div className="bg-white/5 backdrop-blur-md border border-white/20 rounded-2xl p-5">
      <div className="flex items-center gap-4 mb-4">
        <div className="relative">
          <UserAvatar
            avatarUrl={profile.avatarUrl}
            avatar={profile.avatar}
            size="lg"
            onClick={onAvatarClick}
            uploading={avatarUploading}
          />
          {profile.favoriteTeam && (
            <div className="absolute -bottom-1.5 -right-1.5 bg-[#86d1ea] text-[#0A0E0C] text-[8px] font-bold px-1.5 py-0.5 rounded-full pointer-events-none">
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

// ── Settings Tab ──────────────────────────────────────────────────────────────

function SettingsTab({
  profile,
  onSaved,
  onAvatarClick,
  avatarUploading,
}: {
  profile: UserProfile;
  onSaved: (updated: UserProfile) => void;
  onAvatarClick: () => void;
  avatarUploading: boolean;
}) {
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [bio, setBio] = useState(profile.bio ?? "");
  const [favoriteTeam, setFavoriteTeam] = useState(profile.favoriteTeam ?? "");
  const [isPublic, setIsPublic] = useState(profile.isPublic);
  const [openaiKey, setOpenaiKey] = useState(profile.openaiApiKey ?? "");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setSaveMsg(null);
    try {
      const updated = await profileApiService.updateProfile({
        displayName: displayName.trim() || undefined,
        bio: bio.trim() || undefined,
        favoriteTeam: favoriteTeam.trim() || undefined,
        isPublic,
        openaiApiKey: openaiKey.trim() || null,
      });
      onSaved(updated);
      setSaveMsg("Saved!");
    } catch (err: any) {
      setSaveMsg(err.message ?? "Failed to save");
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(null), 2500);
    }
  }

  const inputCls =
    "w-full bg-white/5 border border-white/20 rounded-xl px-3 py-2.5 text-white text-xs placeholder-white/30 focus:outline-none focus:border-[#86d1ea]/50 transition-all";

  return (
    <div className="flex flex-col gap-4">
      {/* Avatar */}
      <div className="bg-white/5 backdrop-blur-md border border-white/20 rounded-2xl p-4">
        <p className="text-white text-xs font-medium mb-3">Profile Photo</p>
        <div className="flex items-center gap-4">
          <UserAvatar
            avatarUrl={profile.avatarUrl}
            avatar={profile.avatar}
            size="lg"
            onClick={onAvatarClick}
            uploading={avatarUploading}
          />
          <div className="flex-1">
            <button
              onClick={onAvatarClick}
              disabled={avatarUploading}
              className="w-full py-2 rounded-xl bg-[#86d1ea]/10 border border-[#86d1ea]/30 text-[#86d1ea] text-xs font-medium hover:bg-[#86d1ea]/20 transition-all disabled:opacity-50"
            >
              {avatarUploading ? "Uploading…" : "Change photo"}
            </button>
            <p className="text-white/40 text-[9px] mt-1.5 text-center">JPG, PNG or WebP · max 2 MB</p>
          </div>
        </div>
      </div>

      {/* Profile info */}
      <div className="bg-white/5 backdrop-blur-md border border-white/20 rounded-2xl p-4 flex flex-col gap-3">
        <p className="text-white text-xs font-medium">Profile Info</p>

        <div>
          <label className="text-white/50 text-[9px] uppercase tracking-wider mb-1 block">Display Name</label>
          <input
            className={inputCls}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your display name"
            maxLength={40}
          />
        </div>

        <div>
          <label className="text-white/50 text-[9px] uppercase tracking-wider mb-1 block">Bio</label>
          <textarea
            className={`${inputCls} resize-none h-20`}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="Tell others about your betting style…"
            maxLength={200}
          />
          <p className="text-white/30 text-[9px] text-right">{bio.length}/200</p>
        </div>

        <div>
          <label className="text-white/50 text-[9px] uppercase tracking-wider mb-1 block">Favorite Team</label>
          <input
            className={inputCls}
            value={favoriteTeam}
            onChange={(e) => setFavoriteTeam(e.target.value)}
            placeholder="e.g. MTL, TOR, BOS"
            maxLength={20}
          />
        </div>

        <div className="flex items-center justify-between py-1">
          <label className="text-white/70 text-xs">Public Profile</label>
          <button
            onClick={() => setIsPublic((v) => !v)}
            className={`relative w-10 h-5.5 rounded-full transition-colors ${isPublic ? "bg-[#86d1ea]" : "bg-white/10"}`}
            style={{ height: 22, width: 40 }}
          >
            <span
              className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all"
              style={{ left: isPublic ? "calc(100% - 18px)" : 2 }}
            />
          </button>
        </div>
      </div>

      {/* AI Settings */}
      <div className="bg-white/5 backdrop-blur-md border border-white/20 rounded-2xl p-4 flex flex-col gap-3">
        <p className="text-white text-xs font-medium">AI Settings</p>
        <p className="text-white/50 text-[10px]">
          Enter your OpenAI API key to use the Ask LLM feature. Your key is stored securely and used only for your requests.{" "}
          <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-[#86d1ea] underline">
            Get a key →
          </a>
        </p>

        <div>
          <label className="text-white/50 text-[9px] uppercase tracking-wider mb-1 block">OpenAI API Key</label>
          <div className="relative">
            <input
              className={inputCls}
              type={showKey ? "text" : "password"}
              value={openaiKey}
              onChange={(e) => setOpenaiKey(e.target.value)}
              placeholder="sk-proj-..."
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 text-[10px]"
            >
              {showKey ? "Hide" : "Show"}
            </button>
          </div>
        </div>

        {openaiKey && (
          <button
            onClick={() => setOpenaiKey("")}
            className="text-red-400 text-[10px] self-start hover:text-red-300"
          >
            Remove key
          </button>
        )}
      </div>

      {/* Save */}
      <button
        onClick={handleSave}
        disabled={saving}
        className="w-full py-3 rounded-2xl font-bold text-sm transition-all disabled:opacity-50"
        style={{ background: "#86d1ea", color: "#0A0E0C" }}
      >
        {saving ? "Saving…" : "Save Changes"}
      </button>

      {saveMsg && (
        <p className={`text-center text-xs font-medium ${saveMsg === "Saved!" ? "text-green-400" : "text-red-400"}`}>
          {saveMsg}
        </p>
      )}
    </div>
  );
}

// ── ProfilePage ───────────────────────────────────────────────────────────────

export function ProfilePage() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [stats, setStats] = useState<UserBettingStats | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!user) { navigate("/login?returnTo=/profile", { replace: true }); return; }
    Promise.all([
      profileApiService.getProfile(),
      profileApiService.getBettingStats(),
    ]).then(([p, s]) => {
      setProfile(p);
      setStats(s);
    }).catch((e) => {
      setError(e.message ?? "Could not load profile");
    }).finally(() => setLoading(false));
  }, [user]);

  async function handleAvatarClick() {
    fileInputRef.current?.click();
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarUploading(true);
    try {
      const url = await profileApiService.uploadAvatar(file);
      setProfile((p) => p ? { ...p, avatarUrl: url } : p);
    } catch (err: any) {
      alert(err.message ?? "Upload failed");
    } finally {
      setAvatarUploading(false);
      e.target.value = "";
    }
  }

  if (!user) return null;

  return (
    <div className="flex flex-col min-h-screen pb-24" style={{ background: "#0A0E0C" }}>
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />

      {/* Header */}
      <div className="sticky top-0 z-40 px-4 pt-12 pb-3"
        style={{ background: "rgba(10,14,12,0.92)", backdropFilter: "blur(16px)", borderBottom: "1px solid #283323" }}>
        <div className="flex items-center justify-between">
          <h1 className="text-white text-lg font-bold">Profile</h1>
          <button onClick={logout} className="text-white/40 text-xs border border-white/10 px-3 py-1.5 rounded-xl">Sign Out</button>
        </div>

        {!loading && profile && (
          <div className="flex gap-1 mt-3 bg-white/5 rounded-xl p-1">
            {(["overview", "settings"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className="flex-1 py-2 rounded-lg text-xs font-semibold transition-all"
                style={tab === t ? { background: "#86d1ea", color: "#0A0E0C" } : { color: "#92A08A" }}
              >
                {t === "overview" ? "Overview" : "Settings"}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {loading ? (
          <div className="flex flex-col gap-3">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}
          </div>
        ) : error ? (
          <div className="text-center py-16">
            <p className="text-red-400 text-sm">{error}</p>
          </div>
        ) : profile && stats ? (
          <div className="flex flex-col gap-4">
            <ProfileHeader profile={profile} stats={stats} onAvatarClick={handleAvatarClick} avatarUploading={avatarUploading} />
            {tab === "overview" ? (
              <OverviewTab profile={profile} stats={stats} />
            ) : (
              <SettingsTab profile={profile} onSaved={setProfile} onAvatarClick={handleAvatarClick} avatarUploading={avatarUploading} />
            )}
          </div>
        ) : null}
      </div>

      <BottomNav />
    </div>
  );
}
