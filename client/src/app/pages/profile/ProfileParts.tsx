/**
 * ProfileParts.tsx
 *
 * Extrait de ProfilePage.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import type { UserProfile, UserBettingStats } from "./../../types/user";
import { ScoreRing, HitRateChart, MarketBreakdown } from "./ProfileComponents";
import { FrozenName } from "../../components/brand/FrozenName";
import { useI18n } from "../../i18n";


import { User as UserIcon, Camera } from "lucide-react";
// ── Uiverse-styled settings helpers ────────────────────────────────────────

/** Toggle switch (Uiverse .switch/.slider) */
export function ToggleSwitch({
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
export function InputBox({
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
      <label className="block text-white/50 text-[11px] uppercase tracking-wider mb-1">{label}</label>
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
export function DotLoader() {
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

export type Tab = "overview" | "settings";

export function Skeleton({ className }: { className: string }) {
  return (
    <div className={`bg-white/5 backdrop-blur-md border border-white/20 rounded-xl animate-pulse ${className}`} />
  );
}

export function UserAvatar({
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
      {avatar && avatar !== "👤" ? avatar : <UserIcon size={20} className="text-white/60" />}
    </div>
  );

  if (!clickable) return inner;

  return (
    <div className="relative cursor-pointer" onClick={onClick}>
      {inner}
      <div className="absolute inset-0 rounded-2xl bg-black/40 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity">
        {uploading
          ? <div className="w-4 h-4 border-2 border-white/60 border-t-white rounded-full animate-spin" />
          : <Camera size={18} className="text-white" />
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
      <span className="text-white/60 text-[11px] uppercase tracking-wide mt-1 text-center leading-none">{label}</span>
    </>
  );
  return onClick
    ? <button type="button" onClick={onClick} className={cls}>{inner}</button>
    : <div className={cls}>{inner}</div>;
}

export function ProfileHeader({
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
            <div className="absolute -bottom-1.5 -right-1.5 bg-[#90C9F0] text-[#072E49] text-[11px] font-bold px-1.5 py-0.5 rounded-full pointer-events-none">
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
        <p className="text-white/70 text-[11px] leading-relaxed border-t border-white/20 pt-3 mt-4">
          {profile.bio}
        </p>
      )}
    </div>
  );
}

export function OverviewTab({ profile, stats }: { profile: UserProfile; stats: UserBettingStats }) {
  const { t, lang } = useI18n();
  const total = stats.parlayRecord.wins + stats.parlayRecord.losses;
  return (
    <div className="flex flex-col gap-3">
      <div className="self-start icy-card rounded-2xl p-3">
        <p className="text-white text-[11px] font-medium mb-2">{t("profile.parlayRecord")}</p>
        <div className="flex gap-1.5">
          <MiniStat label={t("profile.parlayWins")} value={`${stats.parlayRecord.wins}`} color="#86d1ea" />
          <MiniStat label={t("profile.parlayLosses")} value={`${stats.parlayRecord.losses}`} color="#f87171" />
          <MiniStat label={t("profile.parlayRate")} value={`${total > 0 ? Math.round((stats.parlayRecord.wins / total) * 100) : 0}%`} color="#90C9F0" />
        </div>
      </div>
      <HitRateChart stats={stats} />
      <MarketBreakdown stats={stats} />
      <div className="flex items-center justify-center gap-2 py-2">
        <span className="text-white/70 text-[11px]">
          {t("profile.memberSince", { date: new Date(profile.joinedAt).toLocaleDateString(lang === "fr" ? "fr-CA" : "en-US", { month: "long", year: "numeric" }) })}
        </span>
      </div>
    </div>
  );
}
