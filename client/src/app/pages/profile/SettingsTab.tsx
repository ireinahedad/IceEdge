/**
 * SettingsTab.tsx
 *
 * Extrait de ProfilePage.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useAuth } from "../../context/AuthContext";
import { useSubscription } from "../../context/SubscriptionContext";
import { apiCancelSubscription } from "../../services/subscriptionService";
import { profileApiService } from "./../../services/userService";
import { enableValueBetPush, disableValueBetPush } from "./../../services/pushService";
import type { UserProfile } from "./../../types/user";
import { ManualEntryCard } from "../../components/ManualEntryCard";
import { useI18n } from "../../i18n";
import { useBookmaker } from "../../context/BookmakerContext";
import { useBlocks } from "../../context/BlockContext";
import { UserRow } from "../../components/UserIdentity";
import { features } from "../../platform";
import { DotLoader, InputBox, ToggleSwitch, UserAvatar } from "./ProfileParts";


// ── Settings Tab ──────────────────────────────────────────────────────────────

export function SettingsTab({
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

  // ── Utilisateurs bloqués (R4.3e) ────────────────────────────────────────
  // L'état vit dans BlockContext, partagé avec le chat : débloquer ici fait
  // réapparaître les messages là-bas sans rechargement.
  const { blocked, ensureLoaded, unblock, loading: blocksLoading, error: blocksError } = useBlocks();
  const [unblocking, setUnblocking] = useState<string | null>(null);
  useEffect(() => { ensureLoaded(); }, [ensureLoaded]);

  async function handleUnblock(userId: string, name: string) {
    setUnblocking(userId);
    try {
      await unblock(userId);
      toast.success(t("block.unblockDone", { name }));
    } catch (e: any) {
      toast.error(e?.message ?? t("block.unblockFailed"));
    } finally {
      setUnblocking(null);
    }
  }

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
  // La clé OpenAI est en écriture seule : le serveur ne renvoie que
  // `hasOpenaiKey`, jamais la clé (voir `profile.service.getProfileById`). Le
  // champ part donc toujours vide, et trois états décrivent l'intention de
  // l'utilisateur — sinon « champ vide » voudrait dire à la fois « je n'ai pas
  // de clé », « je n'y touche pas » et « efface-la ».
  const [keyStored,  setKeyStored]  = useState(profile.hasOpenaiKey ?? false);
  const [openaiKey,  setOpenaiKey]  = useState("");
  const [editingKey, setEditingKey] = useState(!(profile.hasOpenaiKey ?? false));
  const [removeKey,  setRemoveKey]  = useState(false);
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

      // ⚠️ La clé n'est envoyée QUE si l'utilisateur en a saisi une nouvelle ou
      // demandé son retrait. Le champ étant vide au chargement, l'inclure
      // systématiquement — ce que faisait `openaiApiKey: openaiKey.trim() || null` —
      // effacerait la clé enregistrée à chaque changement de bio.
      // `''` et non `null` pour l'effacement : côté serveur, `null` ne touche
      // pas à la colonne, précisément pour qu'un ancien bundle en cache — qui
      // envoyait `openaiApiKey: null` à chaque enregistrement — ne puisse pas
      // effacer la clé par accident pendant un déploiement.
      const keyPatch =
        removeKey          ? { openaiApiKey: '' } :
        openaiKey.trim()   ? { openaiApiKey: openaiKey.trim() } :
                             {};

      const updated = await profileApiService.updateProfile({
        ...(newUsername !== profile.username ? { username: newUsername } : {}),
        displayName: displayName.trim() || undefined,
        bio: bio.trim() || undefined,
        favoriteTeam: favoriteTeam.trim() || undefined,
        isPublic,
        showSlips,
        notifyValueBets: isPro ? notifyValueBets : false,
        valueBetMinEvPct: isPro ? minEvPct : 0,
        ...keyPatch,
      });
      onSaved(updated);

      // `onSaved` remonte le profil au parent, mais les `useState` ci-dessus ne
      // se réinitialisent pas sur un changement de prop : c'est ici qu'on
      // reflète ce qui vient d'être écrit.
      if (removeKey) { setKeyStored(false); setEditingKey(true); }
      else if (openaiKey.trim()) { setKeyStored(true); setEditingKey(false); }
      setOpenaiKey("");
      setRemoveKey(false);

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
          <span className={`text-[11px] font-bold transition-colors ${lang === "en" ? "text-[#90C9F0]" : "text-white/40"}`}>EN</span>
          <ToggleSwitch checked={lang === "fr"} onChange={() => setLang(lang === "fr" ? "en" : "fr")} fontSize={11} />
          <span className={`text-[11px] font-bold transition-colors ${lang === "fr" ? "text-[#90C9F0]" : "text-white/40"}`}>FR</span>
        </div>
        <div className="inline-flex items-center gap-2 icy-card rounded-lg px-2.5 py-1.5">
          <span className={`text-[11px] font-bold transition-colors ${mode === "dark" ? "text-[#90C9F0]" : "text-white/40"}`}>🌙 {t("profile.dark")}</span>
          <ToggleSwitch checked={mode === "light"} onChange={() => setMode(mode === "light" ? "dark" : "light")} fontSize={11} />
          <span className={`text-[11px] font-bold transition-colors ${mode === "light" ? "text-[#90C9F0]" : "text-white/40"}`}>{t("profile.light")} ☀️</span>
        </div>
      </div>

      {/* Sportsbook selector — which betting site the "Place bet" buttons open */}
      {/* APPLE_PLAN §4 — Guideline 5.3: nothing links out to a sportsbook on iOS,
          so there is no book to choose. */}
      {features.bookmakerLinks && (
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
                className={`text-[11px] font-bold px-2.5 py-1 rounded-lg border transition-colors ${
                  bookmakerId === b.id
                    ? "bg-[#90C9F0]/15 border-[#90C9F0]/40 text-[#90C9F0]"
                    : "border-white/15 text-white/50 active:bg-white/5"
                }`}
              >
                {b.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-white/35 mt-1.5">{t("profile.bookmakerHint")}</p>
        </div>
      )}

      {/* Avatar */}
      <div className="icy-card rounded-2xl p-4 flex flex-col gap-4">
        <p className="text-white text-xs font-medium">{t("profile.photo")}</p>

        {/* ── 1. Profile photo ── */}
        <div>
          <p className="text-white/50 text-[11px] uppercase tracking-wider mb-2">{t("profile.choosePhoto")}</p>
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
                className="px-3 py-1.5 rounded-lg bg-[#90C9F0]/10 border border-[#90C9F0]/30 text-[#90C9F0] text-[11px] font-medium hover:bg-[#90C9F0]/20 transition-all disabled:opacity-50"
              >
                {avatarUploading ? t("profile.uploading") : t("profile.changePhoto")}
              </button>
              <p className="text-white/40 text-[11px] mt-1.5">{t("profile.photoHint")}</p>
            </div>
          </div>
        </div>

        {/* ── 2. Flags (collapsible) ── */}
        <div className="border-t border-white/20 pt-3">
          <button
            onClick={() => setShowFlags((v) => !v)}
            className="w-full flex items-center justify-between text-left"
          >
            <span className="text-white/50 text-[11px] uppercase tracking-wider">{t("profile.chooseFlag")}</span>
            <span className="text-[#90C9F0] text-[11px]">{showFlags ? "▲" : "▼"}</span>
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
              <p className="text-white/40 text-[11px] mt-2">{t("profile.flagHint")}</p>
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
            <p className="text-white/30 text-[11px] mt-1">{t("profile.usernameHint")}</p>
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
          <p className="text-white/30 text-[11px] text-right">{bio.length}/200</p>
        </div>

        <div className="flex items-center gap-3 py-1">
          <label className="text-white/70 text-xs">{t("profile.public")}</label>
          <ToggleSwitch checked={isPublic} onChange={() => setIsPublic((v) => !v)} fontSize={12} />
        </div>

      </div>

      {/* Notifications — value bets (Pro only) */}
      {/* R6 — this whole card drives the Web Push API. iOS notifications go through
          APNs and get their own card when APPLE_PLAN R6 lands. */}
      {features.webPush && (
        <div className="icy-card rounded-2xl p-4 flex flex-col gap-3">
          <p className="text-white text-xs font-medium">{t("profile.notifications")}</p>

          <div className="flex items-center gap-3 py-1">
            <div className="flex-1">
              <label className={`text-xs ${isPro ? "text-white/70" : "text-white/40"}`}>{t("profile.notifyValueBets")}</label>
              <p className="text-white/40 text-[11px] mt-0.5">{t("profile.notifyValueBetsHint")}</p>
            </div>
            {isPro ? (
              <ToggleSwitch checked={notifyValueBets} onChange={handleToggleNotify} fontSize={12} />
            ) : (
              <button
                onClick={() => navigate("/pro")}
                className="px-3 py-1.5 rounded-lg text-[11px] font-bold flex-shrink-0"
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
                <p className="text-white/40 text-[11px] mt-0.5">{t("profile.minEvHint")}</p>
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
      )}

      {/* AI Settings */}
      {/* APPLE_PLAN R8 — bring-your-own OpenAI key sits in the 3.1.1 grey zone;
          hidden on iOS until that call is made. */}
      {features.byokOpenAI && (
        <div className="icy-card rounded-2xl p-4 flex flex-col gap-3">
          <p className="text-white text-xs font-medium">{t("profile.aiSettings")}</p>
          <p className="text-white/50 text-[11px]">
            {t("profile.aiSettingsDesc")}{" "}
            <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-[#90C9F0] underline">
              {t("profile.getKey")}
            </a>
          </p>

          {/* Trois affichages, un par intention : une clé est en place et on n'y
              touche pas · on va la retirer · on en saisit une. Le champ de
              saisie n'existe que dans le dernier cas, ce qui rend impossible
              l'envoi accidentel d'un champ vide. */}
          {keyStored && !editingKey && !removeKey ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[#90C9F0] text-[11px] font-semibold">
                🔒 {t("profile.keyStored")}
              </span>
              <p className="text-white/40 text-[11px] leading-relaxed">{t("profile.keyNotShown")}</p>
              <div className="flex items-center gap-4 mt-0.5">
                <button
                  type="button"
                  onClick={() => { setEditingKey(true); setShowKey(false); }}
                  className="text-[#90C9F0] text-[11px] font-semibold py-1"
                >
                  {t("profile.replaceKey")}
                </button>
                <button
                  type="button"
                  onClick={() => setRemoveKey(true)}
                  className="text-red-400 text-[11px] py-1 hover:text-red-300"
                >
                  {t("profile.removeKey")}
                </button>
              </div>
            </div>
          ) : removeKey ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-red-400 text-[11px]">{t("profile.keyPendingRemoval")}</span>
              <button
                type="button"
                onClick={() => setRemoveKey(false)}
                className="text-white/60 text-[11px] py-1"
              >
                {t("common.cancel")}
              </button>
            </div>
          ) : (
            <div>
              <label className="block text-white/50 text-[11px] uppercase tracking-wider mb-1">{t("profile.openaiKey")}</label>
              <div className="relative">
                <input
                  type={showKey ? "text" : "password"}
                  value={openaiKey}
                  onChange={(e) => setOpenaiKey(e.target.value)}
                  placeholder="sk-proj-..."
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className={`w-full bg-black/20 border border-white/40 rounded-lg pl-2.5 pr-12 py-2 text-[11px] font-semibold placeholder-white/25 outline-none focus:border-[#90C9F0]/60 transition-colors ${mode === "light" ? "text-[#072E49]" : "text-[#90C9F0]"}`}
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#90C9F0] text-[11px]"
                >
                  {showKey ? t("profile.hide") : t("profile.show")}
                </button>
              </div>
              {keyStored && (
                <button
                  type="button"
                  onClick={() => { setEditingKey(false); setOpenaiKey(""); }}
                  className="text-white/60 text-[11px] mt-2 py-1"
                >
                  {t("common.cancel")}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Saisie admin des blessures/alignement.
          (La pondération des règles est désormais dans chaque carte de règle, par type de pari.) */}
      <ManualEntryCard />

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

      {/* Subscription — visible sur un build sans chemin vers Pro UNIQUEMENT
          pour un abonné (souscrit sur le web, même compte) : il doit pouvoir
          lire son échéance et résilier. Résilier n'est pas un achat, et une
          carte « passe Pro » sans bouton ne dirait rien à personne. */}
      {(isPro || features.proUpgrade) && (
      <div className="icy-card rounded-2xl p-4 flex flex-col gap-2">
        <p className="text-white text-xs font-medium">{t("pro.subscription")}</p>
        {isPro ? (
          <>
            <p className="text-white/50 text-[11px]">
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
            <p className="text-white/50 text-[11px]">{t("pro.subtitle")}</p>
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
      )}

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
            <p className="text-white/40 text-[11px] mt-0.5">{t("profile.hideSlipsHint")}</p>
          </div>
          <ToggleSwitch checked={!showSlips} onChange={() => setShowSlips((v) => !v)} fontSize={12} />
        </div>
      </div>

      {/* Utilisateurs bloqués — R4.3e.
          Apple vérifie qu'un blocage est RÉVERSIBLE : il faut donc un endroit
          où l'on voit qui l'on a bloqué et où on le défait. La carte reste
          affichée même vide, sinon on ne peut pas vérifier qu'on n'a bloqué
          personne — une carte qui disparaît ressemble à une fonction cassée. */}
      <div className="icy-card rounded-2xl p-4 flex flex-col gap-2">
        <p className="text-white text-xs font-medium">{t("blocked.title")}</p>
        <p className="text-white/40 text-[11px]">{t("blocked.hint")}</p>
        {blocksError ? (
          <p className="text-red-400 text-[11px] mt-1">{t("blocked.loadFailed")}</p>
        ) : blocksLoading ? (
          <DotLoader />
        ) : blocked.length === 0 ? (
          <p className="text-white/40 text-[11px] mt-1">{t("blocked.empty")}</p>
        ) : (
          <div className="flex flex-col gap-1 mt-1">
            {blocked.map((b) => (
              <div key={b.id} className="py-1.5">
                <UserRow
                  user={{ userId: b.id, username: b.username, displayName: b.displayName, avatar: b.avatar, avatarUrl: b.avatarUrl }}
                  size="sm"
                  actions={
                    <button
                      onClick={() => handleUnblock(b.id, b.displayName || b.username)}
                      disabled={unblocking === b.id}
                      className="text-[#86d1ea] text-[11px] font-semibold border border-[#86d1ea]/30 rounded-lg px-2.5 py-1 disabled:opacity-50"
                    >
                      {unblocking === b.id ? "…" : t("blocked.unblock")}
                    </button>
                  }
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Security */}
      <div className="icy-card rounded-2xl p-4 flex flex-col gap-2">
        <p className="text-white text-xs font-medium">{t("profile.security")}</p>
        <p className="text-white/50 text-[11px]">{t("profile.signoutAllDesc")}</p>
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
