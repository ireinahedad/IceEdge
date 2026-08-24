/**
 * ProfilePage.tsx — coquille de la page Profil.
 *
 * Ce fichier faisait 866 lignes ; il a été découpé le 2026-08-10 sans toucher
 * une ligne de code — seuls les imports et les `export` ont été ajoutés.
 *
 *   ProfileParts.tsx   ToggleSwitch, InputBox, DotLoader, Skeleton, UserAvatar,
 *                      MiniStat, ProfileHeader, OverviewTab
 *   SettingsTab.tsx    l'onglet Paramètres en entier
 *
 * ⚠️ `SettingsTab` reste à ~450 lignes de code dans un seul composant. Ce n'est
 * pas un oubli : il porte une vingtaine de `useState` partagés par toutes ses
 * sections (photo, drapeaux, confidentialité, abonnement, clé OpenAI…). Les
 * séparer voudrait dire faire descendre ces états en props — un vrai
 * refactoring, pas un déplacement de lignes. À faire seulement avec des tests
 * devant soi.
 *
 * `ProfilePage` reste le seul export public : `routes.tsx` est inchangé.
 */

import { useState, useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { BottomNav } from "../../components/BottomNav";
import { useAuth } from "../../context/AuthContext";
import { profileApiService } from "./../../services/userService";
import { applyServerFamilyWeights } from "./../../services/ruleWeightsService";
import type { UserProfile, UserBettingStats } from "./../../types/user";
import { useI18n } from "../../i18n";
import "./profile-settings.css";
import { OverviewTab, ProfileHeader, Skeleton, Tab } from "./ProfileParts";
import { SettingsTab } from "./SettingsTab";
import "../../components/rink-theme.css";


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
      // Le profil porte la pondération des règles du compte : l'appliquer ici
      // évite que la première carte de règles redemande la même information
      // (cf. `ensureFamilyWeightsHydrated`).
      applyServerFamilyWeights(p.ruleWeights);
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
      <div className="sticky top-0 z-40 profile-ink-black"
        style={{
          background: "linear-gradient(160deg, rgba(220,245,255,0.22), rgba(150,205,240,0.12) 45%, rgba(235,250,255,0.20))",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          paddingTop: "env(safe-area-inset-top, 0px)",
        }}>
        <div className="rink-boards" aria-hidden />
        <div className="px-4 pt-3 pb-3 flex items-center justify-between">
          <h1 className="text-white text-lg font-bold uppercase" style={{ fontFamily: "'Oswald', 'Arial Narrow', sans-serif" }}>{t("profile.title")}</h1>
          <div className="flex items-center gap-2">
            <button onClick={() => navigate("/support")} className="text-white/40 text-xs border border-white/10 px-3 py-1.5 rounded-xl">{t("legal.support")}</button>
            <button onClick={logout} className="text-white/40 text-xs border border-white/10 px-3 py-1.5 rounded-xl">{t("profile.signout")}</button>
          </div>
        </div>

        {!loading && profile && (
          <div className="flex gap-1 mx-4 mb-3 bg-white/5 rounded-xl p-1">
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
