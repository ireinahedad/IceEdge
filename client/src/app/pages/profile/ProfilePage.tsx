import { useState, useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { BottomNav } from "../../components/BottomNav";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useAuth } from "../../context/AuthContext";
import { useSubscription } from "../../context/SubscriptionContext";
import { apiCancelSubscription } from "../../services/subscriptionService";
import { profileApiService } from "./../../services/userService";
import { enableValueBetPush, disableValueBetPush } from "./../../services/pushService";
import type { UserProfile, UserBettingStats, BetRecord } from "./../../types/user";
import {
  ScoreRing,
  HitRateChart,
  MarketBreakdown,
  CalibrationCard,
} from "./ProfileComponents";
import { FrozenName } from "../../components/brand/FrozenName";
import { InjuriesAdminCard } from "../../components/InjuriesAdminCard";
import { useI18n } from "../../i18n";
import { useBookmaker } from "../../context/BookmakerContext";
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
function MiniStat({ label, value, color, className, onClick }: { label: string; value: string; color?: string; className?: string; onClick?: () => void }) {
  const cls = `icy-tile rounded-lg px-2 py-1.5 flex flex-col items-center justify-center min-w-[52px] ${className ?? ""} ${onClick ? "cursor-pointer active:scale-95 transition-transform" : ""}`;
  const inner = (
    <>
      <span className={`text-sm font-bold leading-none ${color ? "" : "text-white"}`} style={color ? { color } : undefined}>{value}</span>
      <span className="text-white/60 text-[8px] uppercase tracking-wide mt-1 text-center leading-none">{label}</span>
    </>
  );
  return onClick
    ? <button type="button" onClick={onClick} className={cls}>{inner}</button>
    : <div className={cls}>{inner}</div>;
}

function ProfileHeader({
  profile,
  stats,
  onAvatarClick,
  avatarUploading,
  onBetsClick,
}: {
  profile: UserProfile;
  stats: UserBettingStats;
  onAvatarClick?: () => void;
  avatarUploading?: boolean;
  onBetsClick?: () => void;
}) {
  return (
    <div className="icy-card rounded-2xl p-5">
      {/* Identity row — the logo/avatar always stays in the same column as the name */}
      <div className="flex items-center gap-4 mb-4">
        <div className="relative flex-shrink-0">
          <UserAvatar
            avatarUrl={profile.avatarUrl}
            avatar={profile.avatar}
            size="lg"
            onClick={onAvatarClick}
            uploading={avatarUploading}
          />
          {profile.favoriteTeam && (
            <div className="absolute -bottom-1.5 -right-1.5 bg-[#90C9F0] text-[#072E49] text-[8px] font-bold px-1.5 py-0.5 rounded-full pointer-events-none">
              {profile.favoriteTeam}
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <FrozenName name={profile.displayName} score={profile.performanceScore} size={16} />
          <p className="text-white/70 text-xs mt-1.5">@{profile.username}</p>
        </div>

        <ScoreRing score={profile.performanceScore} tier={profile.tier} />
      </div>

      {/* Stats — always laid out horizontally, whatever the viewport */}
      <div className="flex items-stretch gap-2">
        <MiniStat className="flex-1" label="Hit Rate" value={`${stats.hitRate}%`} />
        <MiniStat className="flex-1" label="Bets ›" value={`${stats.totalBets}`} onClick={onBetsClick} />
        <MiniStat className="flex-1" label="W - L" value={`${stats.wins}-${stats.losses}`} color={stats.wins > stats.losses ? "#86d1ea" : undefined} />
        <MiniStat className="flex-1" label="Best" value={`${stats.longestWinStreak}W`} />
      </div>

      {profile.bio && (
        <p className="text-white/70 text-[10px] leading-relaxed border-t border-white/20 pt-3 mt-4">
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
      <div className="self-start icy-card rounded-2xl p-3">
        <p className="text-white text-[10px] font-medium mb-2">{t("profile.parlayRecord")}</p>
        <div className="flex gap-1.5">
          <MiniStat label={t("profile.parlayWins")} value={`${stats.parlayRecord.wins}`} color="#86d1ea" />
          <MiniStat label={t("profile.parlayLosses")} value={`${stats.parlayRecord.losses}`} color="#f87171" />
          <MiniStat label={t("profile.parlayRate")} value={`${total > 0 ? Math.round((stats.parlayRecord.wins / total) * 100) : 0}%`} color="#90C9F0" />
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
  mode,
  setMode,
}: {
  profile: UserProfile;
  onSaved: (updated: UserProfile) => void;
  onAvatarClick: () => void;
  avatarUploading: boolean;
  mode: "dark" | "light";
  setMode: (m: "dark" | "light") => void;
}) {
  const { t, lang, setLang } = useI18n();
  const { isPro, status: subStatus, refresh: refreshSub } = useSubscription();
  const { bookmakerId, setBookmakerId, bookmakers } = useBookmaker();
  const { logoutAll } = useAuth();
  const navigate = useNavigate();
  const [signingOutAll, setSigningOutAll] = useState(false);
  const [cancelingSub, setCancelingSub] = useState(false);
  const [confirmCancelSub, setConfirmCancelSub] = useState(false);
  const [confirmLogoutAll, setConfirmLogoutAll] = useState(false);

  async function handleCancelSub() {
    setConfirmCancelSub(false);
    setCancelingSub(true);
    try {
      await apiCancelSubscription();
      await refreshSub();
      toast.success(t("pro.settingsCancel"));
    } catch (e: any) {
      toast.error(e?.message ?? t("login.error"));
    } finally {
      setCancelingSub(false);
    }
  }

  async function handleLogoutAll() {
    setConfirmLogoutAll(false);
    setSigningOutAll(true);
    try {
      await logoutAll();
      navigate("/login", { replace: true });
    } catch (e: any) {
      toast.error(e?.message ?? t("login.error"));
    } finally {
      setSigningOutAll(false);
    }
  }
  const [username, setUsername] = useState(profile.username);
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [pickingEmoji, setPickingEmoji] = useState(false);
  const [bio, setBio] = useState(profile.bio ?? "");
  const [favoriteTeam, setFavoriteTeam] = useState(profile.favoriteTeam ?? "");
  const [isPublic, setIsPublic] = useState(profile.isPublic);
  const [showSlips, setShowSlips] = useState(profile.showSlips ?? false);
  const [notifyValueBets, setNotifyValueBets] = useState(profile.notifyValueBets ?? false);
  const [minEvPct, setMinEvPct] = useState(profile.valueBetMinEvPct ?? 0);
  const [openaiKey, setOpenaiKey] = useState(profile.openaiApiKey ?? "");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [showFlags, setShowFlags] = useState(false);

  // Enabling requests notification permission + a push subscription; on success
  // the preference is persisted immediately.
  async function handleToggleNotify() {
    const next = !notifyValueBets;
    if (next) {
      const ok = await enableValueBetPush();
      if (!ok) { setSaveMsg(t("profile.notifyDenied")); setTimeout(() => setSaveMsg(null), 3000); return; }
    } else {
      await disableValueBetPush();
    }
    setNotifyValueBets(next);
    try { await profileApiService.updateProfile({ notifyValueBets: next }); } catch { /* keep UI state */ }
  }

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
        notifyValueBets: isPro ? notifyValueBets : false,
        valueBetMinEvPct: isPro ? minEvPct : 0,
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

  // Country flags a user can display next to their name in podium / chat.
  // Rendered as real images (Windows doesn't render flag emoji), stored as avatarUrl.
  const FLAG_CODES = [
    "ca", "us", "se", "fi", "ru", "cz",
    "sk", "ch", "de", "fr", "gb", "es",
    "it", "no", "dk", "at", "lv", "rs",
    "pl", "au", "jp", "nl", "be", "kz",
  ];
  const flagUrl = (code: string) => `https://flagcdn.com/w80/${code}.png`;

  async function handlePickFlag(code: string) {
    setPickingEmoji(true);
    setSaveMsg(null);
    try {
      const updated = await profileApiService.updateProfile({ avatarUrl: flagUrl(code) });
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
      {/* Language + appearance */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center gap-2 icy-card rounded-lg px-2.5 py-1.5">
          <span className="text-[11px]">🌐</span>
          <span className={`text-[10px] font-bold transition-colors ${lang === "en" ? "text-[#90C9F0]" : "text-white/40"}`}>EN</span>
          <ToggleSwitch checked={lang === "fr"} onChange={() => setLang(lang === "fr" ? "en" : "fr")} fontSize={11} />
          <span className={`text-[10px] font-bold transition-colors ${lang === "fr" ? "text-[#90C9F0]" : "text-white/40"}`}>FR</span>
        </div>
        <div className="inline-flex items-center gap-2 icy-card rounded-lg px-2.5 py-1.5">
          <span className={`text-[10px] font-bold transition-colors ${mode === "dark" ? "text-[#90C9F0]" : "text-white/40"}`}>🌙 {t("profile.dark")}</span>
          <ToggleSwitch checked={mode === "light"} onChange={() => setMode(mode === "light" ? "dark" : "light")} fontSize={11} />
          <span className={`text-[10px] font-bold transition-colors ${mode === "light" ? "text-[#90C9F0]" : "text-white/40"}`}>{t("profile.light")} ☀️</span>
        </div>
      </div>

      {/* Sportsbook selector — which betting site the "Place bet" buttons open */}
      <div className="icy-card rounded-lg px-3 py-2.5">
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="text-[11px]">🎯</span>
          <span className="text-[11px] font-bold text-white/80">{t("profile.bookmaker")}</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {bookmakers.map((b) => (
            <button
              key={b.id}
              onClick={() => setBookmakerId(b.id)}
              className={`text-[10px] font-bold px-2.5 py-1 rounded-lg border transition-colors ${
                bookmakerId === b.id
                  ? "bg-[#90C9F0]/15 border-[#90C9F0]/40 text-[#90C9F0]"
                  : "border-white/15 text-white/50 active:bg-white/5"
              }`}
            >
              {b.label}
            </button>
          ))}
        </div>
        <p className="text-[9px] text-white/35 mt-1.5">{t("profile.bookmakerHint")}</p>
      </div>

      {/* Avatar */}
      <div className="icy-card rounded-2xl p-4 flex flex-col gap-4">
        <p className="text-white text-xs font-medium">{t("profile.photo")}</p>

        {/* ── 1. Profile photo ── */}
        <div>
          <p className="text-white/50 text-[9px] uppercase tracking-wider mb-2">{t("profile.choosePhoto")}</p>
          <div className="flex items-center gap-4">
            <UserAvatar
              avatarUrl={profile.avatarUrl}
              avatar={profile.avatar}
              size="lg"
              onClick={onAvatarClick}
              uploading={avatarUploading}
            />
            <div className="flex-1 min-w-0">
              <button
                onClick={onAvatarClick}
                disabled={avatarUploading}
                className="px-3 py-1.5 rounded-lg bg-[#90C9F0]/10 border border-[#90C9F0]/30 text-[#90C9F0] text-[10px] font-medium hover:bg-[#90C9F0]/20 transition-all disabled:opacity-50"
              >
                {avatarUploading ? t("profile.uploading") : t("profile.changePhoto")}
              </button>
              <p className="text-white/40 text-[9px] mt-1.5">{t("profile.photoHint")}</p>
            </div>
          </div>
        </div>

        {/* ── 2. Flags (collapsible) ── */}
        <div className="border-t border-white/20 pt-3">
          <button
            onClick={() => setShowFlags((v) => !v)}
            className="w-full flex items-center justify-between text-left"
          >
            <span className="text-white/50 text-[9px] uppercase tracking-wider">{t("profile.chooseFlag")}</span>
            <span className="text-[#90C9F0] text-[10px]">{showFlags ? "▲" : "▼"}</span>
          </button>
          {showFlags && (
            <>
              <div className="grid grid-cols-6 sm:grid-cols-8 md:grid-cols-9 gap-2 mt-3">
                {FLAG_CODES.map((code) => {
                  const url = flagUrl(code);
                  const active = profile.avatarUrl === url;
                  return (
                    <button
                      key={code}
                      onClick={() => handlePickFlag(code)}
                      disabled={pickingEmoji}
                      className={`aspect-[4/3] rounded-lg overflow-hidden flex items-center justify-center border transition-all active:scale-95 disabled:opacity-50 ${
                        active
                          ? "border-[#90C9F0] ring-2 ring-[#90C9F0]/40"
                          : "border-white/40 bg-white/5 hover:bg-white/10"
                      }`}
                    >
                      <img src={url} alt={code} loading="lazy" className="w-full h-full object-contain" />
                    </button>
                  );
                })}
              </div>
              <p className="text-white/40 text-[9px] mt-2">{t("profile.flagHint")}</p>
            </>
          )}
        </div>
      </div>

      {/* Profile info */}
      <div className="icy-card rounded-2xl p-4 flex flex-col gap-3">
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

      </div>

      {/* Notifications — value bets (Pro only) */}
      <div className="icy-card rounded-2xl p-4 flex flex-col gap-3">
        <p className="text-white text-xs font-medium">{t("profile.notifications")}</p>

        <div className="flex items-center gap-3 py-1">
          <div className="flex-1">
            <label className={`text-xs ${isPro ? "text-white/70" : "text-white/40"}`}>{t("profile.notifyValueBets")}</label>
            <p className="text-white/40 text-[9px] mt-0.5">{t("profile.notifyValueBetsHint")}</p>
          </div>
          {isPro ? (
            <ToggleSwitch checked={notifyValueBets} onChange={handleToggleNotify} fontSize={12} />
          ) : (
            <button
              onClick={() => navigate("/pro")}
              className="px-3 py-1.5 rounded-lg text-[10px] font-bold flex-shrink-0"
              style={{ background: "#86d1ea", color: "#0A0E0C" }}
            >
              {t("pro.unlock")}
            </button>
          )}
        </div>

        {isPro && notifyValueBets && (
          <div className="flex items-center gap-3 py-1 border-t border-white/5 pt-3">
            <div className="flex-1">
              <label className="text-xs text-white/70">{t("profile.minEv")}</label>
              <p className="text-white/40 text-[9px] mt-0.5">{t("profile.minEvHint")}</p>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <input
                type="number"
                min={0}
                max={50}
                step={1}
                value={minEvPct}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value));
                  setMinEvPct(Number.isFinite(n) ? Math.min(50, Math.max(0, n)) : 0);
                }}
                className="w-14 bg-white/5 rounded-lg px-2 py-1.5 text-white text-xs text-right tabular-nums outline-none focus:bg-white/10"
              />
              <span className="text-white/50 text-xs">%</span>
            </div>
          </div>
        )}
      </div>

      {/* AI Settings */}
      <div className="icy-card rounded-2xl p-4 flex flex-col gap-3">
        <p className="text-white text-xs font-medium">{t("profile.aiSettings")}</p>
        <p className="text-white/50 text-[10px]">
          {t("profile.aiSettingsDesc")}{" "}
          <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-[#90C9F0] underline">
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
              className={`w-full bg-black/20 border border-white/40 rounded-lg pl-2.5 pr-12 py-2 text-[11px] font-semibold placeholder-white/25 outline-none focus:border-[#90C9F0]/60 transition-colors ${mode === "light" ? "text-[#072E49]" : "text-[#90C9F0]"}`}
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#90C9F0] text-[10px]"
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

      {/* Saisie admin des blessures/alignement.
          (La pondération des règles est désormais dans chaque carte de règle, par type de pari.) */}
      <InjuriesAdminCard />

      {/* Save */}
      {saving ? (
        <div className="w-full flex items-center justify-center py-3">
          <DotLoader />
        </div>
      ) : (
        <button
          onClick={handleSave}
          className="self-center px-8 py-2 rounded-xl font-bold text-xs transition-all"
          style={{ background: "#86d1ea", color: "#072E49" }}
        >
          {t("common.save")}
        </button>
      )}

      {saveMsg && (
        <p className={`text-center text-xs font-medium ${saveMsg === "Saved!" ? "text-green-400" : "text-red-400"}`}>
          {saveMsg}
        </p>
      )}

      {/* Subscription */}
      <div className="icy-card rounded-2xl p-4 flex flex-col gap-2">
        <p className="text-white text-xs font-medium">{t("pro.subscription")}</p>
        {isPro ? (
          <>
            <p className="text-white/50 text-[10px]">
              {subStatus?.cancelAtPeriodEnd
                ? `${t("pro.cancelScheduled")} ${subStatus.currentPeriodEnd ? new Date(subStatus.currentPeriodEnd).toLocaleDateString() : ""}`
                : subStatus?.currentPeriodEnd
                  ? `${t("pro.renews")} ${new Date(subStatus.currentPeriodEnd).toLocaleDateString()}`
                  : t("pro.isProBody")}
            </p>
            {!subStatus?.cancelAtPeriodEnd && (
              <button
                onClick={() => setConfirmCancelSub(true)}
                disabled={cancelingSub}
                className="self-start mt-1 text-red-400 text-[11px] font-semibold border border-red-400/30 rounded-lg px-3 py-1.5 hover:text-red-300 hover:border-red-300/50 transition-colors disabled:opacity-50"
              >
                {cancelingSub ? t("pro.canceling") : t("pro.settingsCancel")}
              </button>
            )}
          </>
        ) : (
          <>
            <p className="text-white/50 text-[10px]">{t("pro.subtitle")}</p>
            <button
              onClick={() => navigate("/pro")}
              className="self-start mt-1 text-[11px] font-bold rounded-lg px-3 py-1.5 transition-all"
              style={{ background: "#86d1ea", color: "#0A0E0C" }}
            >
              {t("pro.getPro")}
            </button>
          </>
        )}
      </div>

      {/* Confidentialité — retrait des coupons publics.
          Formulé à la NÉGATIVE et laissé décoché par défaut : la visibilité est
          l'état normal, se retirer est le geste délibéré. Volontairement séparé
          de « Profil public » (carte Infos), qui commande la présence dans la
          recherche et au classement — les lier reviendrait à faire payer la
          discrétion d'un rang, et un « choix » de ce genre n'en est pas un. */}
      <div className="icy-card rounded-2xl p-4 flex flex-col gap-2">
        <p className="text-white text-xs font-medium">{t("profile.privacy")}</p>
        <div className="flex items-center gap-3 py-1">
          <div className="flex-1">
            <label className="text-white/70 text-xs">{t("profile.hideSlips")}</label>
            <p className="text-white/40 text-[9px] mt-0.5">{t("profile.hideSlipsHint")}</p>
          </div>
          <ToggleSwitch checked={!showSlips} onChange={() => setShowSlips((v) => !v)} fontSize={12} />
        </div>
      </div>

      {/* Security */}
      <div className="icy-card rounded-2xl p-4 flex flex-col gap-2">
        <p className="text-white text-xs font-medium">{t("profile.security")}</p>
        <p className="text-white/50 text-[10px]">{t("profile.signoutAllDesc")}</p>
        <button
          onClick={() => setConfirmLogoutAll(true)}
          disabled={signingOutAll}
          className="self-start mt-1 text-red-400 text-[11px] font-semibold border border-red-400/30 rounded-lg px-3 py-1.5 hover:text-red-300 hover:border-red-300/50 transition-colors disabled:opacity-50"
        >
          {signingOutAll ? "..." : t("profile.signoutAll")}
        </button>
      </div>

      <ConfirmDialog
        open={confirmCancelSub}
        title={`${t("pro.settingsCancel")} ?`}
        onConfirm={handleCancelSub}
        onCancel={() => setConfirmCancelSub(false)}
      />
      <ConfirmDialog
        open={confirmLogoutAll}
        title={t("profile.signoutAllConfirm")}
        description={t("profile.signoutAllDesc")}
        onConfirm={handleLogoutAll}
        onCancel={() => setConfirmLogoutAll(false)}
      />
    </div>
  );
}

// ── ProfilePage ───────────────────────────────────────────────────────────────

export function ProfilePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, logout } = useAuth();
  const { t } = useI18n();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [stats, setStats] = useState<UserBettingStats | null>(null);
  const [tab, setTab] = useState<Tab>(searchParams.get("tab") === "settings" ? "settings" : "overview");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Scroll vers la section pondération quand on arrive depuis le bouton des règles.
  useEffect(() => {
    if (searchParams.get("focus") === "weights") {
      const t = setTimeout(() => {
        document.getElementById("rules-weights")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 300);
      return () => clearTimeout(t);
    }
  }, [searchParams]);

  // Dark / light appearance chosen by the user (persisted)
  const [mode, setModeState] = useState<"dark" | "light">(() => {
    try { return localStorage.getItem("iceedge_mode") === "light" ? "light" : "dark"; }
    catch { return "dark"; }
  });
  const setMode = (m: "dark" | "light") => {
    setModeState(m);
    try { localStorage.setItem("iceedge_mode", m); } catch { /* ignore */ }
  };

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
    <div className={`flex flex-col min-h-screen pb-24 max-w-[430px] md:max-w-5xl mx-auto w-full ${mode === "light" ? "profile-light" : "profile-dark"}`} style={{ background: mode === "light" ? "#D4FFEE" : "#0A0E0C" }}>
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />

      {/* Header */}
      <div className="sticky top-0 z-40 px-4 pt-12 pb-3 profile-ink-black"
        style={{
          background: "linear-gradient(160deg, rgba(220,245,255,0.22), rgba(150,205,240,0.12) 45%, rgba(235,250,255,0.20))",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          borderBottom: "1px solid rgba(255,255,255,0.4)",
        }}>
        <div className="flex items-center justify-between">
          <h1 className="text-white text-lg font-bold uppercase" style={{ fontFamily: "'Oswald', 'Arial Narrow', sans-serif" }}>{t("profile.title")}</h1>
          <div className="flex items-center gap-2">
            <button onClick={() => navigate("/support")} className="text-white/40 text-xs border border-white/10 px-3 py-1.5 rounded-xl">{t("legal.support")}</button>
            <button onClick={logout} className="text-white/40 text-xs border border-white/10 px-3 py-1.5 rounded-xl">{t("profile.signout")}</button>
          </div>
        </div>

        {!loading && profile && (
          <div className="flex gap-1 mt-3 bg-white/5 rounded-xl p-1">
            {(["overview", "settings"] as Tab[]).map((tabKey) => (
              <button
                key={tabKey}
                onClick={() => setTab(tabKey)}
                className="flex-1 py-2 rounded-lg text-xs font-semibold transition-all"
                style={tab === tabKey ? { background: "#90C9F0", color: "#072E49" } : { color: "#92A08A" }}
              >
                {tabKey === "overview" ? t("profile.overview") : t("profile.settings")}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={`flex-1 overflow-y-auto px-4 py-4 profile-ink-black ${mode === "light" ? "profile-light" : "profile-dark"}`}>
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
            <ProfileHeader profile={profile} stats={stats} onAvatarClick={handleAvatarClick} avatarUploading={avatarUploading} onBetsClick={() => navigate("/bet?tab=slips")} />
            {tab === "overview" ? (
              <OverviewTab profile={profile} stats={stats} />
            ) : (
              <SettingsTab profile={profile} onSaved={setProfile} onAvatarClick={handleAvatarClick} avatarUploading={avatarUploading} mode={mode} setMode={setMode} />
            )}
          </div>
        ) : null}
      </div>

      <BottomNav />
    </div>
  );
}
