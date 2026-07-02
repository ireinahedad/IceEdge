import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { BottomNav } from "../BottomNav";
import { useAuth } from "../../context/AuthContext";
import { profileApiService } from "./../../services/userService";
import type { UserProfile, UserBettingStats, BetRecord } from "./../../types/user";
import {
  ScoreRing,
  HitRateChart,
  MarketBreakdown,
  CalibrationCard,
} from "./ProfileComponents";
import { FrozenName } from "../brand/FrozenName";
import { useI18n } from "../../i18n";
import "./profile-settings.css";

// ── Uiverse-styled settings helpers ────────────────────────────────────────

/** Toggle switch (Uiverse .switch/.slider) */
function ToggleSwitch({
  checked,
  onChange,
  fontSize,
}: {
  checked: boolean;
  onChange: () => void;
  fontSize?: number;
}) {
  return (
    <label className="switch flex-shrink-0" style={fontSize ? { fontSize } : undefined}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span className="slider" />
    </label>
  );
}

/** Floating-label input (Uiverse .inputbox) */
function InputBox({
  label,
  value,
  onChange,
  placeholder,
  maxLength,
  type = "text",
  textarea = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  type?: string;
  textarea?: boolean;
}) {
  const fieldCls =
    "w-full bg-black/20 border border-white/15 rounded-lg px-2.5 py-2 text-[#86d1ea] text-[11px] font-semibold placeholder-white/25 outline-none focus:border-[#86d1ea]/60 transition-colors";
  return (
    <div>
      <label className="block text-white/50 text-[9px] uppercase tracking-wider mb-1">{label}</label>
      {textarea ? (
        <textarea
          className={`${fieldCls} resize-none h-14`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={maxLength}
          placeholder={placeholder}
        />
      ) : (
        <input
          className={fieldCls}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={maxLength}
          placeholder={placeholder}
        />
      )}
    </div>
  );
}

/** Animated loader (Uiverse .loader) */
function DotLoader() {
  return (
    <div className="loader">
      {[0, 1, 2, 3, 4].map((i) => (
        <div className="circle" key={i}>
          <div className="dot" />
          <div className="outline" />
        </div>
      ))}
    </div>
  );
}

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

/** Compact stat square used beside the name */
function MiniStat({ label, value, color = "#86d1ea" }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-white/5 border border-white/15 rounded-lg px-2 py-1.5 flex flex-col items-center justify-center min-w-[52px]">
      <span className="text-sm font-bold leading-none" style={{ color }}>{value}</span>
      <span className="text-white/60 text-[8px] uppercase tracking-wide mt-1 text-center leading-none">{label}</span>
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
  return (
    <div className="backdrop-blur-md border border-white/20 rounded-2xl p-5" style={{ background: "#1d3355" }}>
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
          <FrozenName name={profile.displayName} score={profile.performanceScore} size={16} />
          <div className="mt-1.5 flex items-center gap-2 flex-wrap">
            <p className="text-white/70 text-xs">@{profile.username}</p>
            <MiniStat label="Hit Rate" value={`${stats.hitRate}%`} color={stats.hitRate >= 65 ? "#4ade80" : "#86d1ea"} />
            <MiniStat label="Bets" value={`${stats.totalBets}`} color="#86d1ea" />
            <MiniStat label="W - L" value={`${stats.wins}-${stats.losses}`} color="#bfc8cc" />
            <MiniStat label="Best" value={`${stats.longestWinStreak}W`} color="#facc15" />
          </div>
          <div className="mt-1.5 flex items-center gap-2 flex-wrap">
            <StreakBadge streak={stats.currentStreak} />
          </div>
        </div>

        <ScoreRing score={profile.performanceScore} tier={profile.tier} />
      </div>

      {profile.bio && (
        <p className="text-white/70 text-[10px] leading-relaxed border-t border-white/20 pt-3">
          {profile.bio}
        </p>
      )}
    </div>
  );
}

function OverviewTab({ profile, stats }: { profile: UserProfile; stats: UserBettingStats }) {
  const { t, lang } = useI18n();
  const total = stats.parlayRecord.wins + stats.parlayRecord.losses;
  return (
    <div className="flex flex-col gap-3">
      <div className="self-start bg-white/5 backdrop-blur-md border border-white/20 rounded-2xl p-3">
        <p className="text-white text-[10px] font-medium mb-2">{t("profile.parlayRecord")}</p>
        <div className="flex gap-1.5">
          <MiniStat label={t("profile.parlayWins")} value={`${stats.parlayRecord.wins}`} color="#4ade80" />
          <MiniStat label={t("profile.parlayLosses")} value={`${stats.parlayRecord.losses}`} color="#f87171" />
          <MiniStat label={t("profile.parlayRate")} value={`${total > 0 ? Math.round((stats.parlayRecord.wins / total) * 100) : 0}%`} color="#86d1ea" />
        </div>
      </div>
      <HitRateChart stats={stats} />
      <CalibrationCard stats={stats} />
      <MarketBreakdown stats={stats} />
      <div className="flex items-center justify-center gap-2 py-2">
        <span className="text-white/70 text-[10px]">
          {t("profile.memberSince", { date: new Date(profile.joinedAt).toLocaleDateString(lang === "fr" ? "fr-CA" : "en-US", { month: "long", year: "numeric" }) })}
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
  const { t, lang, setLang } = useI18n();
  const [username, setUsername] = useState(profile.username);
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [pickingEmoji, setPickingEmoji] = useState(false);
  const [bio, setBio] = useState(profile.bio ?? "");
  const [favoriteTeam, setFavoriteTeam] = useState(profile.favoriteTeam ?? "");
  const [isPublic, setIsPublic] = useState(profile.isPublic);
  const [showSlips, setShowSlips] = useState(profile.showSlips ?? false);
  const [openaiKey, setOpenaiKey] = useState(profile.openaiApiKey ?? "");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setSaveMsg(null);
    try {
      const newUsername = username.trim().toLowerCase();
      const updated = await profileApiService.updateProfile({
        ...(newUsername !== profile.username ? { username: newUsername } : {}),
        displayName: displayName.trim() || undefined,
        bio: bio.trim() || undefined,
        favoriteTeam: favoriteTeam.trim() || undefined,
        isPublic,
        showSlips,
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

  // Ice & hockey themed avatars users can pick instead of a photo
  const ICE_AVATARS = [
    "🥅", "🏒", "⛸️", "🥌", "🪖", "🧤",
    "❄️", "🧊", "🏔️", "⛰️", "🌨️", "💧",
    "🛡️", "💎", "🪨", "⚔️", "🔥", "☀️",
  ];

  async function handlePickEmoji(emoji: string) {
    setPickingEmoji(true);
    setSaveMsg(null);
    try {
      // Setting an emoji avatar clears the photo
      const updated = await profileApiService.updateProfile({ avatar: emoji, avatarUrl: null });
      onSaved(updated);
      setSaveMsg("Saved!");
    } catch (err: any) {
      setSaveMsg(err.message ?? "Failed to save");
    } finally {
      setPickingEmoji(false);
      setTimeout(() => setSaveMsg(null), 2500);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Language */}
      <div className="self-start inline-flex items-center gap-2 bg-white/5 backdrop-blur-md border border-white/20 rounded-lg px-2.5 py-1.5">
        <span className="text-[11px]">🌐</span>
        <span className={`text-[10px] font-bold transition-colors ${lang === "en" ? "text-[#86d1ea]" : "text-white/40"}`}>EN</span>
        <ToggleSwitch checked={lang === "fr"} onChange={() => setLang(lang === "fr" ? "en" : "fr")} fontSize={11} />
        <span className={`text-[10px] font-bold transition-colors ${lang === "fr" ? "text-[#86d1ea]" : "text-white/40"}`}>FR</span>
      </div>

      {/* Avatar */}
      <div className="bg-white/5 backdrop-blur-md border border-white/20 rounded-2xl p-4">
        <p className="text-white text-xs font-medium mb-3">{t("profile.photo")}</p>
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
              className="self-start px-3 py-1.5 rounded-lg bg-[#86d1ea]/10 border border-[#86d1ea]/30 text-[#86d1ea] text-[10px] font-medium hover:bg-[#86d1ea]/20 transition-all disabled:opacity-50"
            >
              {avatarUploading ? t("profile.uploading") : t("profile.changePhoto")}
            </button>
            <p className="text-white/40 text-[9px] mt-1.5 text-center">{t("profile.photoHint")}</p>
          </div>
        </div>

        {/* Or pick an ice avatar */}
        <p className="text-white/50 text-[9px] uppercase tracking-wider mt-4 mb-2">{t("profile.iceAvatar")}</p>
        <div className="grid grid-cols-12 gap-1">
          {ICE_AVATARS.map((e) => {
            const active = !profile.avatarUrl && profile.avatar === e;
            return (
              <button
                key={e}
                onClick={() => handlePickEmoji(e)}
                disabled={pickingEmoji}
                className={`aspect-square rounded-md flex items-center justify-center text-[11px] border transition-all active:scale-95 disabled:opacity-50 ${
                  active
                    ? "border-[#86d1ea] bg-[#86d1ea]/15"
                    : "border-white/10 bg-white/5 hover:bg-white/10"
                }`}
              >
                {e}
              </button>
            );
          })}
        </div>
      </div>

      {/* Profile info */}
      <div className="bg-white/5 backdrop-blur-md border border-white/20 rounded-2xl p-4 flex flex-col gap-3">
        <p className="text-white text-xs font-medium">{t("profile.info")}</p>

        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          <div>
            <InputBox
              label={t("profile.username")}
              placeholder={t("profile.username")}
              value={username}
              onChange={(v) => setUsername(v.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
              maxLength={20}
            />
            <p className="text-white/30 text-[9px] mt-1">{t("profile.usernameHint")}</p>
          </div>

          <InputBox
            label={t("profile.displayName")}
            placeholder={t("profile.displayName")}
            value={displayName}
            onChange={setDisplayName}
            maxLength={40}
          />

          <InputBox
            label={t("profile.favTeam")}
            placeholder={t("profile.favTeam")}
            value={favoriteTeam}
            onChange={setFavoriteTeam}
            maxLength={20}
          />
        </div>

        <div>
          <InputBox
            label={t("profile.bio")}
            placeholder={t("profile.bio")}
            value={bio}
            onChange={setBio}
            maxLength={200}
            textarea
          />
          <p className="text-white/30 text-[9px] text-right">{bio.length}/200</p>
        </div>

        <div className="flex items-center gap-3 py-1">
          <label className="text-white/70 text-xs">{t("profile.public")}</label>
          <ToggleSwitch checked={isPublic} onChange={() => setIsPublic((v) => !v)} fontSize={12} />
        </div>

        <div className="flex items-center gap-3 py-1">
          <div>
            <label className="text-white/70 text-xs">{t("profile.showSlips")}</label>
            <p className="text-white/40 text-[9px] mt-0.5">{t("profile.showSlipsHint")}</p>
          </div>
          <ToggleSwitch checked={showSlips} onChange={() => setShowSlips((v) => !v)} fontSize={12} />
        </div>
      </div>

      {/* AI Settings */}
      <div className="bg-white/5 backdrop-blur-md border border-white/20 rounded-2xl p-4 flex flex-col gap-3">
        <p className="text-white text-xs font-medium">{t("profile.aiSettings")}</p>
        <p className="text-white/50 text-[10px]">
          {t("profile.aiSettingsDesc")}{" "}
          <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-[#86d1ea] underline">
            {t("profile.getKey")}
          </a>
        </p>

        <div>
          <label className="block text-white/50 text-[9px] uppercase tracking-wider mb-1">{t("profile.openaiKey")}</label>
          <div className="relative">
            <input
              type={showKey ? "text" : "password"}
              value={openaiKey}
              onChange={(e) => setOpenaiKey(e.target.value)}
              placeholder="sk-proj-..."
              className="w-full bg-black/20 border border-white/15 rounded-lg pl-2.5 pr-12 py-2 text-[#86d1ea] text-[11px] font-semibold placeholder-white/25 outline-none focus:border-[#86d1ea]/60 transition-colors"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#86d1ea] text-[10px]"
            >
              {showKey ? t("profile.hide") : t("profile.show")}
            </button>
          </div>
        </div>

        {openaiKey && (
          <button
            onClick={() => setOpenaiKey("")}
            className="text-red-400 text-[10px] self-start hover:text-red-300"
          >
            {t("profile.removeKey")}
          </button>
        )}
      </div>

      {/* Save */}
      {saving ? (
        <div className="w-full flex items-center justify-center py-3">
          <DotLoader />
        </div>
      ) : (
        <button
          onClick={handleSave}
          className="self-center px-8 py-2 rounded-xl font-bold text-xs transition-all"
          style={{ background: "#86d1ea", color: "#0A0E0C" }}
        >
          {t("common.save")}
        </button>
      )}

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
  const { t } = useI18n();
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
          <h1 className="text-white text-lg font-bold">{t("profile.title")}</h1>
          <button onClick={logout} className="text-white/40 text-xs border border-white/10 px-3 py-1.5 rounded-xl">{t("profile.signout")}</button>
        </div>

        {!loading && profile && (
          <div className="flex gap-1 mt-3 bg-white/5 rounded-xl p-1">
            {(["overview", "settings"] as Tab[]).map((tabKey) => (
              <button
                key={tabKey}
                onClick={() => setTab(tabKey)}
                className="flex-1 py-2 rounded-lg text-xs font-semibold transition-all"
                style={tab === tabKey ? { background: "#86d1ea", color: "#0A0E0C" } : { color: "#92A08A" }}
              >
                {tabKey === "overview" ? t("profile.overview") : t("profile.settings")}
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
