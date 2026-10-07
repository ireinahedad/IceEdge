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
import { readMode, writeMode, type AppearanceMode } from "../../appearance";
import { toast } from "sonner";
import "./profile-settings.css";
import { OverviewTab, ProfileHeader, Skeleton, Tab } from "./ProfileParts";
import { SettingsTab } from "./SettingsTab";
import "../../components/rink-theme.css";


// ── ProfilePage ───────────────────────────────────────────────────────────────

export function ProfilePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, logout, updateUser } = useAuth();
  const { t, lang } = useI18n();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [stats, setStats] = useState<UserBettingStats | null>(null);
  const [tab, setTab] = useState<Tab>(searchParams.get("tab") === "settings" ? "settings" : "overview");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Défilement vers une section précise des paramètres quand on arrive depuis
  // un raccourci : le bouton des règles (`focus=weights`) et, depuis
  // l'accueil, « Réglages des alertes » (`focus=notifications`).
  //
  // L'onglet est FORCÉ ici : arriver sur l'aperçu puis chercher à faire défiler
  // vers un élément qui n'est pas monté ne fait rien du tout, en silence.
  useEffect(() => {
    const target = { weights: "rules-weights", notifications: "notifications" }[
      searchParams.get("focus") ?? ""
    ];
    if (!target) return;
    setTab("settings");
    const timer = setTimeout(() => {
      document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchParams]);

  // Apparence sombre / claire. La lecture et l'écriture vivent dans
  // `appearance.ts` : tant que le mode clair y est désactivé, `mode` vaut
  // "dark" et les branches `profile-light` ci-dessous ne s'allument jamais —
  // elles restent en place pour le jour où le réglage revient.
  const [mode, setModeState] = useState<AppearanceMode>(readMode);
  const setMode = (m: AppearanceMode) => {
    setModeState(m);
    writeMode(m);
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
    // `user?.id` et non `user` : AuthContext remplace l'objet quand il enrichit
    // le profil, ce qui rejouait `getProfile` + `getBettingStats` (audit du
    // 2026-09-16). Un changement de compte, lui, recharge bien.
  }, [user?.id]);

  // La barre de navigation (et tout ce qui lit `useAuth().user`) garde sa
  // propre copie de la photo et du pseudo : sans ce relais, une nouvelle photo
  // ou un drapeau n'apparaissait nulle part ailleurs avant un rechargement.
  useEffect(() => {
    if (!profile) return;
    updateUser({ avatar_url: profile.avatarUrl ?? null, ...(profile.username ? { username: profile.username } : {}) });
  }, [profile?.avatarUrl, profile?.username, updateUser]);

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
      // `alert()` était le SEUL de l'app : dialogue système non traduit, qui
      // affiche le nom de domaine en titre en WKWebView et gèle le fil. Le
      // reste de l'app signale déjà ses échecs par `sonner`.
      toast.error(err.message ?? t("profile.avatarUploadFailed"));
    } finally {
      setAvatarUploading(false);
      e.target.value = "";
    }
  }

  if (!user) return null;

  return (
    <div className={`flex flex-col min-h-screen pb-[calc(6rem+env(safe-area-inset-bottom,0px))] max-w-[430px] md:max-w-5xl mx-auto w-full ${mode === "light" ? "profile-light" : "profile-dark"}`} style={{ background: mode === "light" ? "#D4FFEE" : "#0A0E0C" }}>
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />

      {/* Header — même bandeau que la page Ligue (`LeagueHeader`) : verre
          dépoli `.rink-header-glass`, titre Oswald éclairé, sous-titre, et le
          commutateur à rondelle `.puck-tabs` pour les onglets. */}
      <header
        className="rink-header-glass sticky top-0 z-40 profile-ink-black"
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <div className="px-4 pt-3 pb-3 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1
              className="text-white text-xl font-bold uppercase"
              style={{
                fontFamily: "'Oswald', 'Oswald Fallback', 'Arial Narrow', sans-serif",
                textShadow: "0 0 18px rgba(134,209,234,0.35)",
              }}
            >
              {t("profile.title")}
            </h1>
            <p className="text-white/50 text-xs truncate">
              {lang === "fr" ? "Statistiques et paramètres" : "Stats & settings"}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button onClick={() => navigate("/support")} className="text-white/40 text-xs border border-white/10 px-3 py-1.5 rounded-xl">{t("legal.support")}</button>
            <button onClick={logout} className="text-white/40 text-xs border border-white/10 px-3 py-1.5 rounded-xl">{t("profile.signout")}</button>
          </div>
        </div>

        {!loading && profile && (
          <div
            className="puck-tabs mx-4 mb-4"
            style={{ "--puck-count": 2, "--puck-index": tab === "overview" ? 0 : 1 } as React.CSSProperties}
          >
            <span className="puck-tabs-thumb" aria-hidden />
            {(["overview", "settings"] as Tab[]).map((tabKey) => (
              <button
                key={tabKey}
                onClick={() => setTab(tabKey)}
                className={`puck-tab${tab === tabKey ? " is-active" : ""}`}
                aria-pressed={tab === tabKey}
              >
                <span>{tabKey === "overview" ? t("profile.overview") : t("profile.settings")}</span>
              </button>
            ))}
          </div>
        )}
      </header>

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
