import { useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../context/AuthContext";
import { getGoogleLoginUrl } from "../services/authService";

type Mode = "login" | "register";

export function LoginPage() {
  const navigate = useNavigate();
  const { login, register } = useAuth();

  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [firstName, setFirstName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === "login") {
        await login(email, password);
      } else {
        await register(email, username, password, firstName || undefined);
      }
      navigate("/profile", { replace: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  function handleGoogleLogin() {
    window.location.href = getGoogleLoginUrl();
  }

  return (
    <div className="flex flex-col min-h-screen bg-transparent text-white max-w-[430px] mx-auto px-5 pt-20 pb-10">

      {/* Logo / brand */}
      <div className="flex flex-col items-center mb-10">
        <div className="w-16 h-16 rounded-2xl bg-[#86d1ea]/15 border border-[#86d1ea]/30 flex items-center justify-center text-3xl mb-4">
          🏒
        </div>
        <h1 className="text-white text-2xl font-bold tracking-tight">IceEdge</h1>
        <p className="text-white/50 text-xs mt-1">NHL betting intelligence</p>
      </div>

      {/* Mode toggle */}
      <div className="flex gap-1 bg-white/5 border border-white/10 rounded-xl p-1 mb-6">
        {(["login", "register"] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => { setMode(m); setError(null); }}
            className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-all ${
              mode === m
                ? "bg-[#86d1ea] text-[#0f1416]"
                : "text-white/60"
            }`}
          >
            {m === "login" ? "Sign In" : "Create Account"}
          </button>
        ))}
      </div>

      {/* Google SSO */}
      <button
        onClick={handleGoogleLogin}
        className="w-full flex items-center justify-center gap-3 py-3 rounded-xl bg-white/5 border border-white/15 text-white text-sm font-medium hover:bg-white/10 active:scale-[0.98] transition-all mb-4"
      >
        <svg width="18" height="18" viewBox="0 0 48 48" fill="none">
          <path d="M47.5 24.5c0-1.6-.1-3.2-.4-4.7H24v8.9h13.2c-.6 3-2.3 5.5-4.9 7.2v6h7.9c4.6-4.3 7.3-10.6 7.3-17.4z" fill="#4285F4"/>
          <path d="M24 48c6.5 0 12-2.1 16-5.8l-7.9-6c-2.2 1.5-5 2.3-8.1 2.3-6.2 0-11.5-4.2-13.4-9.9H2.4v6.2C6.4 42.6 14.6 48 24 48z" fill="#34A853"/>
          <path d="M10.6 28.6A14.3 14.3 0 0 1 10 24c0-1.6.3-3.1.6-4.6v-6.2H2.4A23.9 23.9 0 0 0 0 24c0 3.9.9 7.5 2.4 10.8l8.2-6.2z" fill="#FBBC05"/>
          <path d="M24 9.5c3.5 0 6.6 1.2 9.1 3.5l6.8-6.8C35.9 2.1 30.5 0 24 0 14.6 0 6.4 5.4 2.4 13.2l8.2 6.2C12.5 13.7 17.8 9.5 24 9.5z" fill="#EA4335"/>
        </svg>
        Continue with Google
      </button>

      {/* Divider */}
      <div className="flex items-center gap-3 mb-4">
        <div className="flex-1 h-px bg-white/10" />
        <span className="text-white/30 text-[10px] uppercase tracking-widest">or</span>
        <div className="flex-1 h-px bg-white/10" />
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white text-sm placeholder-white/30 focus:outline-none focus:border-[#86d1ea]/50 focus:bg-white/8 transition-all"
        />

        {mode === "register" && (
          <>
            <input
              type="text"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              minLength={3}
              className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white text-sm placeholder-white/30 focus:outline-none focus:border-[#86d1ea]/50 focus:bg-white/8 transition-all"
            />
            <input
              type="text"
              placeholder="First name (optional)"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white text-sm placeholder-white/30 focus:outline-none focus:border-[#86d1ea]/50 focus:bg-white/8 transition-all"
            />
          </>
        )}

        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
          className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white text-sm placeholder-white/30 focus:outline-none focus:border-[#86d1ea]/50 focus:bg-white/8 transition-all"
        />

        {error && (
          <div className="px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full py-3 rounded-xl bg-[#86d1ea] text-[#0f1416] text-sm font-bold hover:bg-[#86d1ea]/90 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed mt-1"
        >
          {loading
            ? (mode === "login" ? "Signing in…" : "Creating account…")
            : (mode === "login" ? "Sign In" : "Create Account")}
        </button>
      </form>

      {/* Footer hint */}
      <p className="text-center text-white/30 text-[10px] mt-8">
        {mode === "login"
          ? "No account? Switch to Create Account above."
          : "Already have an account? Switch to Sign In above."}
      </p>
    </div>
  );
}
