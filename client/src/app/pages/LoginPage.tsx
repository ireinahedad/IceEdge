import { useState } from "react";
import { useNavigate, useLocation } from "react-router";
import { Eye, EyeOff } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { getGoogleLoginUrl, apiResendVerification, apiForgotPassword, apiResetPassword, EmailNotVerifiedError } from "../services/authService";
import { IceedgeLogo } from "../components/brand/IceedgeLogo";
import { AppButton } from "../components/AppButton";
import { useI18n } from "../i18n";

type Mode = "login" | "register";

const ACCENT        = "#86d1ea";
const ACCENT_BG     = "rgba(134,209,234,0.12)";
const ACCENT_BORDER = "rgba(134,209,234,0.3)";
const SURFACE       = "#131A12";
const BORDER        = "#283323";

export function LoginPage() {
  const navigate  = useNavigate();
  const location  = useLocation();
  const returnTo  = new URLSearchParams(location.search).get("returnTo") ?? "/";
  const { login, register, verifyEmail } = useAuth();
  const { t } = useI18n();

  const [mode,        setMode]        = useState<Mode>("login");
  const [step,        setStep]        = useState<"form" | "verify" | "forgot" | "reset">("form");
  const [email,       setEmail]       = useState("");
  const [username,    setUsername]    = useState("");
  const [firstName,   setFirstName]   = useState("");
  const [password,    setPassword]    = useState("");
  const [confirmPwd,  setConfirmPwd]  = useState("");
  const [showPwd,     setShowPwd]     = useState(false);
  const [remember,    setRemember]    = useState(true);
  const [newPassword, setNewPassword] = useState("");
  const [code,        setCode]        = useState("");
  const [error,       setError]       = useState<string | null>(null);
  const [notice,      setNotice]      = useState<string | null>(null);
  const [loading,     setLoading]     = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      if (mode === "login") {
        await login(email, password, remember);
        navigate(returnTo, { replace: true });
      } else {
        if (password !== confirmPwd) {
          setError(t("login.pwdMismatch"));
          setLoading(false);
          return;
        }
        const result = await register(email, username, password, firstName || undefined);
        if ('tokens' in result) {
          // Verification disabled on the server → logged in right away.
          navigate(returnTo, { replace: true });
        } else {
          // Account created — a confirmation code was emailed. Move to the code step.
          setStep("verify");
          setNotice(t("login.codeSent"));
        }
      }
    } catch (err: unknown) {
      // Login on an unverified account: server re-sent a code → go verify.
      if (err instanceof EmailNotVerifiedError) {
        setEmail(err.email);
        setStep("verify");
        setNotice(t("login.codeSent"));
      } else {
        setError(err instanceof Error ? err.message : t("login.error"));
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      await verifyEmail(email, code.trim());
      navigate(returnTo, { replace: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("login.error"));
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    setError(null);
    await apiResendVerification(email);
    setNotice(t("login.codeSent"));
  }

  // ── Password reset ──
  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      await apiForgotPassword(email);
      setStep("reset");
      setNotice(t("login.codeSent"));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("login.error"));
    } finally {
      setLoading(false);
    }
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      await apiResetPassword(email, code.trim(), newPassword);
      // Password changed — send the user back to the login form.
      setMode("login");
      setStep("form");
      setCode("");
      setPassword("");
      setNewPassword("");
      setNotice(t("login.resetDone"));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("login.error"));
    } finally {
      setLoading(false);
    }
  }

  async function handleResendReset() {
    setError(null);
    await apiForgotPassword(email);
    setNotice(t("login.codeSent"));
  }

  function backToForm() {
    setStep("form");
    setCode("");
    setNewPassword("");
    setError(null);
    setNotice(null);
  }

  function handleGoogleLogin() {
    window.location.href = getGoogleLoginUrl();
  }

  const inputCls = `w-full px-4 py-3 rounded-xl text-white text-sm placeholder-[#92A08A] focus:outline-none transition-all`;
  const inputStyle = { background: SURFACE, border: `1px solid ${BORDER}` };
  const inputFocusStyle = { borderColor: `${ACCENT}80`, background: ACCENT_BG };

  return (
    <div
      className="flex flex-col min-h-screen text-white max-w-[430px] mx-auto px-5 pt-16 pb-28"
      style={{ background: "#0A0E0C" }}
    >
      {/* Brand hero */}
      <div className="flex flex-col items-center mb-12">
        <button onClick={() => navigate("/")} aria-label="Accueil ArakIce">
          <IceedgeLogo size={72} wordmark={false} className="mb-5" />
        </button>
        <h1
          className="text-white text-2xl tracking-[0.16em] uppercase mb-1"
          style={{ fontFamily: "'Oswald', 'Arial Narrow', sans-serif", fontWeight: 600 }}
        >
          ArakIce
        </h1>

        <div className="mt-4 w-12 h-0.5 rounded-full" style={{ background: ACCENT, opacity: 0.5 }} />
      </div>

      {step === "form" ? (
      <>
      {/* Mode toggle */}
      <div className="flex gap-1 rounded-xl p-1 mb-6" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
        {(["login", "register"] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => { setMode(m); setError(null); setNotice(null); }}
            className="flex-1 py-2.5 rounded-lg text-xs font-semibold transition-all"
            style={mode === m
              ? { background: ACCENT, color: "#0A0E0C" }
              : { color: "#92A08A" }}
          >
            {m === "login" ? t("login.signin") : t("login.signup")}
          </button>
        ))}
      </div>

      {/* Google SSO */}
      <button
        onClick={handleGoogleLogin}
        className="w-full flex items-center justify-center gap-3 py-3 rounded-xl text-sm font-medium active:scale-[0.98] transition-all mb-4"
        style={{ background: SURFACE, border: `1px solid ${BORDER}`, color: "#F3F7F0" }}
      >
        <svg width="18" height="18" viewBox="0 0 48 48" fill="none">
          <path d="M47.5 24.5c0-1.6-.1-3.2-.4-4.7H24v8.9h13.2c-.6 3-2.3 5.5-4.9 7.2v6h7.9c4.6-4.3 7.3-10.6 7.3-17.4z" fill="#4285F4"/>
          <path d="M24 48c6.5 0 12-2.1 16-5.8l-7.9-6c-2.2 1.5-5 2.3-8.1 2.3-6.2 0-11.5-4.2-13.4-9.9H2.4v6.2C6.4 42.6 14.6 48 24 48z" fill="#34A853"/>
          <path d="M10.6 28.6A14.3 14.3 0 0 1 10 24c0-1.6.3-3.1.6-4.6v-6.2H2.4A23.9 23.9 0 0 0 0 24c0 3.9.9 7.5 2.4 10.8l8.2-6.2z" fill="#FBBC05"/>
          <path d="M24 9.5c3.5 0 6.6 1.2 9.1 3.5l6.8-6.8C35.9 2.1 30.5 0 24 0 14.6 0 6.4 5.4 2.4 13.2l8.2 6.2C12.5 13.7 17.8 9.5 24 9.5z" fill="#EA4335"/>
        </svg>
        {t("login.google")}
      </button>

      {/* Divider */}
      <div className="flex items-center gap-3 mb-4">
        <div className="flex-1 h-px" style={{ background: BORDER }} />
        <span className="text-[10px] uppercase tracking-widest" style={{ color: "#92A08A" }}>{t("login.or")}</span>
        <div className="flex-1 h-px" style={{ background: BORDER }} />
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <input type="email" placeholder={t("login.email")} value={email} onChange={(e) => setEmail(e.target.value)}
          required className={inputCls} style={inputStyle}
          onFocus={e => Object.assign(e.target.style, inputFocusStyle)}
          onBlur={e => Object.assign(e.target.style, { borderColor: BORDER, background: SURFACE })} />

        {mode === "register" && (
          <>
            <input type="text" placeholder={t("login.username")} value={username} onChange={(e) => setUsername(e.target.value)}
              required minLength={3} className={inputCls} style={inputStyle}
              onFocus={e => Object.assign(e.target.style, inputFocusStyle)}
              onBlur={e => Object.assign(e.target.style, { borderColor: BORDER, background: SURFACE })} />
            <input type="text" placeholder={t("login.firstName")} value={firstName} onChange={(e) => setFirstName(e.target.value)}
              className={inputCls} style={inputStyle}
              onFocus={e => Object.assign(e.target.style, inputFocusStyle)}
              onBlur={e => Object.assign(e.target.style, { borderColor: BORDER, background: SURFACE })} />
          </>
        )}

        <div className="relative">
          <input type={showPwd ? "text" : "password"} placeholder={t("login.password")} value={password} onChange={(e) => setPassword(e.target.value)}
            required minLength={8} className={`${inputCls} pr-11`} style={inputStyle}
            onFocus={e => Object.assign(e.target.style, inputFocusStyle)}
            onBlur={e => Object.assign(e.target.style, { borderColor: BORDER, background: SURFACE })} />
          <button type="button" onClick={() => setShowPwd(v => !v)}
            aria-label={showPwd ? "Hide password" : "Show password"}
            className="absolute right-3 top-1/2 -translate-y-1/2" style={{ color: "#92A08A" }}>
            {showPwd ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </div>

        {mode === "register" && (
          <input type={showPwd ? "text" : "password"} placeholder={t("login.confirmPassword")} value={confirmPwd} onChange={(e) => setConfirmPwd(e.target.value)}
            required minLength={8} className={inputCls} style={inputStyle}
            onFocus={e => Object.assign(e.target.style, inputFocusStyle)}
            onBlur={e => Object.assign(e.target.style, { borderColor: BORDER, background: SURFACE })} />
        )}

        {mode === "login" && (
          <label className="flex items-center gap-2 text-xs cursor-pointer select-none" style={{ color: "#92A08A" }}>
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)}
              className="h-4 w-4 rounded" style={{ accentColor: ACCENT }} />
            {t("login.remember")}
          </label>
        )}

        {notice && (
          <div className="text-xs text-center py-2 px-3 rounded-xl" style={{ color: ACCENT, background: ACCENT_BG, border: `1px solid ${ACCENT_BORDER}` }}>
            {notice}
          </div>
        )}
        {error && (
          <div className="text-red-400 text-xs text-center py-2 px-3 rounded-xl bg-red-500/10 border border-red-500/20">
            {error}
          </div>
        )}

        <AppButton type="submit" disabled={loading} loading={loading} fullWidth size="lg">
          {mode === "login" ? t("login.signin") : t("login.signup")}
        </AppButton>

        {mode === "login" && (
          <button type="button" onClick={() => { setStep("forgot"); setError(null); setNotice(null); }}
            className="text-xs mt-1" style={{ color: "#92A08A" }}>
            {t("login.forgot")}
          </button>
        )}
      </form>

      {/* App presentation for non-users */}
      <div className="mt-10">
        <p className="text-center text-white text-sm font-bold mb-1" style={{ fontFamily: "'Merriweather', Georgia, serif" }}>
          {t("login.introTitle")}
        </p>
        <p className="text-center text-[#92A08A] text-xs mb-5">{t("login.introSubtitle")}</p>
        <div className="flex flex-col gap-2.5">
          {[
            { title: t("login.feat1Title"), body: t("login.feat1Body") },
            { title: t("login.feat2Title"), body: t("login.feat2Body") },
            { title: t("login.feat3Title"), body: t("login.feat3Body") },
          ].map((f, i) => (
            <div key={i} className="flex items-start gap-3 rounded-xl px-3 py-2.5" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
              <div className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style={{ background: ACCENT }} />
              <div>
                <p className="text-white text-xs font-semibold">{f.title}</p>
                <p className="text-[#92A08A] text-[11px] leading-relaxed">{f.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
      </>
      ) : step === "verify" ? (
      /* ── Email verification step ─────────────────────────────── */
      <form onSubmit={handleVerify} className="flex flex-col gap-3">
        <p className="text-sm text-center mb-1" style={{ color: "#B7C4AD" }}>
          {t("login.verifyPrompt")}
        </p>
        <p className="text-xs text-center mb-2" style={{ color: ACCENT }}>{email}</p>

        <input
          type="text" inputMode="numeric" autoComplete="one-time-code"
          maxLength={6} placeholder="______"
          value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          required
          className={`${inputCls} text-center tracking-[0.5em] text-lg`}
          style={inputStyle}
          onFocus={e => Object.assign(e.target.style, inputFocusStyle)}
          onBlur={e => Object.assign(e.target.style, { borderColor: BORDER, background: SURFACE })} />

        {notice && (
          <div className="text-xs text-center py-2 px-3 rounded-xl" style={{ color: ACCENT, background: ACCENT_BG, border: `1px solid ${ACCENT_BORDER}` }}>
            {notice}
          </div>
        )}
        {error && (
          <div className="text-red-400 text-xs text-center py-2 px-3 rounded-xl bg-red-500/10 border border-red-500/20">
            {error}
          </div>
        )}

        <AppButton type="submit" disabled={loading || code.length < 6} loading={loading} fullWidth size="lg">
          {t("login.verifyBtn")}
        </AppButton>

        <div className="flex items-center justify-between text-xs mt-1">
          <button type="button" onClick={backToForm} style={{ color: "#92A08A" }}>
            {t("login.back")}
          </button>
          <button type="button" onClick={handleResend} style={{ color: ACCENT }}>
            {t("login.resend")}
          </button>
        </div>
      </form>
      ) : step === "forgot" ? (
      /* ── Forgot password: request a code ─────────────────────── */
      <form onSubmit={handleForgot} className="flex flex-col gap-3">
        <p className="text-sm text-center mb-2" style={{ color: "#B7C4AD" }}>
          {t("login.forgotPrompt")}
        </p>
        <input type="email" placeholder={t("login.email")} value={email} onChange={(e) => setEmail(e.target.value)}
          required className={inputCls} style={inputStyle}
          onFocus={e => Object.assign(e.target.style, inputFocusStyle)}
          onBlur={e => Object.assign(e.target.style, { borderColor: BORDER, background: SURFACE })} />

        {error && (
          <div className="text-red-400 text-xs text-center py-2 px-3 rounded-xl bg-red-500/10 border border-red-500/20">
            {error}
          </div>
        )}

        <AppButton type="submit" disabled={loading} loading={loading} fullWidth size="lg">
          {t("login.sendCode")}
        </AppButton>
        <button type="button" onClick={backToForm} className="text-xs mt-1" style={{ color: "#92A08A" }}>
          {t("login.back")}
        </button>
      </form>
      ) : (
      /* ── Reset password: code + new password ─────────────────── */
      <form onSubmit={handleReset} className="flex flex-col gap-3">
        <p className="text-sm text-center mb-1" style={{ color: "#B7C4AD" }}>
          {t("login.verifyPrompt")}
        </p>
        <p className="text-xs text-center mb-2" style={{ color: ACCENT }}>{email}</p>

        <input
          type="text" inputMode="numeric" autoComplete="one-time-code"
          maxLength={6} placeholder="______"
          value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          required
          className={`${inputCls} text-center tracking-[0.5em] text-lg`}
          style={inputStyle}
          onFocus={e => Object.assign(e.target.style, inputFocusStyle)}
          onBlur={e => Object.assign(e.target.style, { borderColor: BORDER, background: SURFACE })} />

        <input type="password" placeholder={t("login.newPassword")} value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
          required minLength={8} className={inputCls} style={inputStyle}
          onFocus={e => Object.assign(e.target.style, inputFocusStyle)}
          onBlur={e => Object.assign(e.target.style, { borderColor: BORDER, background: SURFACE })} />

        {notice && (
          <div className="text-xs text-center py-2 px-3 rounded-xl" style={{ color: ACCENT, background: ACCENT_BG, border: `1px solid ${ACCENT_BORDER}` }}>
            {notice}
          </div>
        )}
        {error && (
          <div className="text-red-400 text-xs text-center py-2 px-3 rounded-xl bg-red-500/10 border border-red-500/20">
            {error}
          </div>
        )}

        <AppButton type="submit" disabled={loading || code.length < 6 || newPassword.length < 8} loading={loading} fullWidth size="lg">
          {t("login.resetBtn")}
        </AppButton>

        <div className="flex items-center justify-between text-xs mt-1">
          <button type="button" onClick={backToForm} style={{ color: "#92A08A" }}>
            {t("login.back")}
          </button>
          <button type="button" onClick={handleResendReset} style={{ color: ACCENT }}>
            {t("login.resend")}
          </button>
        </div>
      </form>
      )}

      <p className="text-center text-[10px] tracking-wide mt-8" style={{ color: "#92A08A", opacity: 0.5 }}>
        {t("login.disclaimer")}
      </p>
      <div className="flex items-center justify-center gap-3 mt-3 text-[10px]" style={{ color: "#92A08A", opacity: 0.6 }}>
        <button onClick={() => navigate("/terms")} className="underline underline-offset-2">{t("legal.terms")}</button>
        <span>·</span>
        <button onClick={() => navigate("/privacy")} className="underline underline-offset-2">{t("legal.privacy")}</button>
        <span>·</span>
        <button onClick={() => navigate("/support")} className="underline underline-offset-2">{t("legal.support")}</button>
      </div>

      {/* SEO guides — plain <a> (full navigation) so crawlers reach the static
          prerendered marketing pages in /public, which React Router does not own. */}
      <nav
        aria-label="NHL prediction guides"
        className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 mt-3 text-[10px]"
        style={{ color: "#92A08A", opacity: 0.55 }}
      >
        <a href="/nhl-predictions-today" className="underline underline-offset-2">NHL Predictions Today</a>
        <span>·</span>
        <a href="/best-nhl-picks-today" className="underline underline-offset-2">Best NHL Picks</a>
        <span>·</span>
        <a href="/nhl-ai-predictions" className="underline underline-offset-2">AI Predictions</a>
        <span>·</span>
        <a href="/nhl-player-props" className="underline underline-offset-2">Player Props</a>
        <span>·</span>
        <a href="/nhl-matchups" className="underline underline-offset-2">Matchups</a>
        <span>·</span>
        <a href="/best-nhl-betting-software" className="underline underline-offset-2">Betting Software</a>
        <span>·</span>
        <a href="/about" className="underline underline-offset-2">About</a>
      </nav>
    </div>
  );
}
