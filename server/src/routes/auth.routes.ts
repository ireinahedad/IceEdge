import { Router, Request, Response } from 'express';
import * as AuthService from '../services/auth.service';
import { authenticate } from '../middleware/auth.middleware';
import { passwordResetLimiter } from '../middleware/rateLimit.middleware';
import { validateBody } from '../middleware/validate.middleware';
import { logger } from '../logger';
import {
  registerSchema, loginSchema, verifyEmailSchema, resendVerificationSchema,
  forgotPasswordSchema, resetPasswordSchema,
} from '../validation/schemas';
import {
  RegisterBody, LoginBody, RefreshBody, AuthTokens,
  VerifyEmailBody, ResendVerificationBody,
  ForgotPasswordBody, ResetPasswordBody,
} from '../types/user.type';

const router = Router();

// ── Refresh-token cookie ──────────────────────────────────────────────────────
// The refresh token lives in an httpOnly cookie (inaccessible to JS → XSS-safe).
// Scoped to /api/auth so it's only sent on auth endpoints.

const REFRESH_COOKIE = 'ice_refresh';
const IS_PROD = process.env.NODE_ENV === 'production';

// Cross-site deployment (front on Vercel, API on Railway → different sites):
// the refresh cookie must be SameSite=None so it is sent on cross-site fetches.
// SameSite=None requires Secure. In local dev (same-site localhost) Lax + no
// Secure keeps things working over http.
const COOKIE_SAMESITE: 'none' | 'lax' = IS_PROD ? 'none' : 'lax';

// maxAgeSeconds must match the refresh token's TTL so the browser drops the
// cookie exactly when the token expires (7d normal, 30d "remember me").
function setRefreshCookie(res: Response, token: string, maxAgeSeconds: number): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure:   IS_PROD,
    sameSite: COOKIE_SAMESITE,
    path:     '/api/auth',
    maxAge:   maxAgeSeconds * 1000,
  });
}

function clearRefreshCookie(res: Response): void {
  // Options (secure/sameSite/path) must match setRefreshCookie or the browser
  // won't clear the cookie.
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure:   IS_PROD,
    sameSite: COOKIE_SAMESITE,
    path:     '/api/auth',
  });
}

/** Strip the refresh token (+ its TTL) from the JSON body — it travels via
 *  the httpOnly cookie only. */
function publicTokens(tokens: AuthTokens): Omit<AuthTokens, 'refresh_token' | 'refresh_expires_in'> {
  const { refresh_token: _rt, refresh_expires_in: _re, ...rest } = tokens;
  return rest;
}

// ── Native mode (PRE_IOS_PLAN.md R3.1) ────────────────────────────────────────
// A WKWebView runs on a `capacitor://localhost` origin. To the API that is a
// cross-site request, and WKWebView's tracking prevention drops the
// SameSite=None cookie set above — so a native client would be silently logged
// out every 15 minutes, when the access token expires, with no way to recover.
// Native therefore needs the refresh token in hand.
//
// Opt-in, per request, via `X-Client: native`. Without that header nothing
// changes: the browser path is exactly the code that ran before this existed.

/** http(s) — the scheme every browser origin uses. */
const BROWSER_ORIGIN = /^https?:\/\//i;

/**
 * Is this request allowed to use native mode?
 *
 * The Origin guard is the point of this function. `X-Client` is a request
 * header and a browser can set it, so without the guard an XSS on arakice.com
 * could ask /auth/refresh for native mode and read the refresh token straight
 * out of the JSON body. The httpOnly cookie exists precisely so that JS can never do that;
 * handing the same token to any caller that asks would give the whole guarantee
 * away.
 *
 * Browsers send `Origin` on every POST — including same-origin ones — and it is
 * always http(s). A native shell sends `capacitor://localhost`, `ionic://…`,
 * `file://` or no Origin at all. Matching on the *scheme* rather than on the
 * CORS allow-list is deliberate: Phase 3 will have to add the Capacitor origin
 * to CORS_ORIGIN, and an allow-list check would then demote native back to the
 * cookie path — the exact bug this mode exists to avoid.
 */
function isNativeClient(req: Request): boolean {
  if (req.get('x-client') !== 'native') return false;
  const origin = req.get('origin');
  if (origin && BROWSER_ORIGIN.test(origin)) return false;
  return true;
}

/**
 * Hand the session to the client the way that client can actually keep it:
 * httpOnly cookie for browsers, refresh token in the body for native.
 *
 * Rotation, revocation and hashing are untouched (R3.2) — `refreshTokens()`
 * still revokes the old token, `refresh_tokens` still stores hashes. Native
 * gets the same guarantees, not weaker ones.
 */
function sendTokens(req: Request, res: Response, tokens: AuthTokens) {
  // The body now depends on a request header. Caches must not mix the two.
  res.vary('X-Client');

  if (isNativeClient(req)) return tokens;

  setRefreshCookie(res, tokens.refresh_token, tokens.refresh_expires_in);
  return publicTokens(tokens);
}

// POST /auth/register — creates an unverified account and emails a 6-digit code.
// No tokens are returned; the client must call /auth/verify-email next.
router.post('/register', validateBody(registerSchema), async (req: Request<{}, {}, RegisterBody>, res: Response) => {
  try {
    const { email, username, password, first_name, last_name } = req.body;
    if (!email || !username || !password)
      return res.status(400).json({ error: 'email, username and password are required' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const result = await AuthService.register({ email, username, password, first_name, last_name });
    if ('pending' in result) {
      return res.status(201).json(result); // { pending: true, email } — must verify
    }
    // Verification bypassed → logged in immediately.
    return res.status(201).json({ user: result.user, tokens: sendTokens(req, res, result.tokens) });
  } catch (err: any) { return res.status(err.status ?? 500).json({ error: err.message }); }
});

// POST /auth/verify-email — confirms the code, then logs the user in.
router.post('/verify-email', validateBody(verifyEmailSchema), async (req: Request<{}, {}, VerifyEmailBody>, res: Response) => {
  try {
    const { email, code } = req.body;
    if (!email || !code)
      return res.status(400).json({ error: 'email and code are required' });
    const result = await AuthService.verifyEmail(email, code);
    return res.status(200).json({ user: result.user, tokens: sendTokens(req, res, result.tokens) });
  } catch (err: any) { return res.status(err.status ?? 500).json({ error: err.message }); }
});

// POST /auth/resend-verification — sends a fresh code (always 200 to avoid enumeration).
router.post('/resend-verification', passwordResetLimiter, validateBody(resendVerificationSchema), async (req: Request<{}, {}, ResendVerificationBody>, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    await AuthService.resendVerification(email);
    return res.status(200).json({ ok: true });
  } catch (err: any) { return res.status(err.status ?? 500).json({ error: err.message }); }
});

// POST /auth/forgot-password — emails a reset code (always 200 to avoid enumeration).
router.post('/forgot-password', passwordResetLimiter, validateBody(forgotPasswordSchema), async (req: Request<{}, {}, ForgotPasswordBody>, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    await AuthService.forgotPassword(email);
    return res.status(200).json({ ok: true });
  } catch (err: any) { return res.status(err.status ?? 500).json({ error: err.message }); }
});

// POST /auth/reset-password — validates the code and sets a new password.
router.post('/reset-password', validateBody(resetPasswordSchema), async (req: Request<{}, {}, ResetPasswordBody>, res: Response) => {
  try {
    const { email, code, new_password } = req.body;
    if (!email || !code || !new_password)
      return res.status(400).json({ error: 'email, code and new_password are required' });
    if (new_password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    await AuthService.resetPassword(email, code, new_password);
    return res.status(200).json({ ok: true });
  } catch (err: any) { return res.status(err.status ?? 500).json({ error: err.message }); }
});

// POST /auth/login
router.post('/login', validateBody(loginSchema), async (req: Request<{}, {}, LoginBody>, res: Response) => {
  try {
    const { email, password, remember } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'email and password are required' });
    const result = await AuthService.login({ email, password, remember });
    return res.status(200).json({ user: result.user, tokens: sendTokens(req, res, result.tokens) });
  } catch (err: any) {
    // Surface the "not verified" case so the client can prompt for the code.
    if (err.code === 'EMAIL_NOT_VERIFIED') {
      return res.status(403).json({ error: err.message, code: err.code, email: err.email });
    }
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

// POST /auth/refresh — the httpOnly cookie for browsers, `{ refresh_token }`
// in the body for native clients (R3.1). The body was already accepted here.
router.post('/refresh', async (req: Request<{}, {}, RefreshBody>, res: Response) => {
  try {
    const raw = req.cookies?.[REFRESH_COOKIE] || req.body?.refresh_token;
    if (!raw) return res.status(400).json({ error: 'refresh token is required' });
    const tokens = await AuthService.refreshTokens(raw); // rotates: old token revoked
    return res.status(200).json(sendTokens(req, res, tokens));
  } catch (err: any) {
    clearRefreshCookie(res);
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

// POST /auth/logout
router.post('/logout', authenticate, async (req: Request<{}, {}, RefreshBody>, res: Response) => {
  try {
    const raw = req.cookies?.[REFRESH_COOKIE] || req.body?.refresh_token;
    if (raw) await AuthService.logout(raw); // revoke in DB
    clearRefreshCookie(res);
    return res.status(204).send();
  } catch (err: any) { return res.status(err.status ?? 500).json({ error: err.message }); }
});

// POST /auth/logout-all — revoke every refresh token for the current user
// (sign out from all devices).
router.post('/logout-all', authenticate, async (req: Request, res: Response) => {
  try {
    await AuthService.logoutAll(req.user!.sub);
    clearRefreshCookie(res); // also drop this device's cookie
    return res.status(204).send();
  } catch (err: any) { return res.status(err.status ?? 500).json({ error: err.message }); }
});

// GET /auth/me
router.get('/me', authenticate, (req: Request, res: Response) => {
  res.json({ user: req.user });
});

// --- Google OAuth -----------------------------------------------------------

// GET /auth/google  — redirect user to Google consent screen
router.get('/google', (_req: Request, res: Response) => {
  const clientId    = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/auth/google/callback';

  if (!clientId) {
    return res.status(503).json({ error: 'Google OAuth is not configured (missing GOOGLE_CLIENT_ID)' });
  }

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         'openid email profile',
    access_type:   'online',
    prompt:        'select_account',
  });

  return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// GET /auth/google/callback  — Google redirects here with ?code=...
router.get('/google/callback', async (req: Request, res: Response) => {
  const clientUrl   = process.env.CLIENT_URL  || 'http://localhost:5173';
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/auth/google/callback';

  const { code, error } = req.query as { code?: string; error?: string };

  if (error || !code) {
    return res.redirect(`${clientUrl}/login?error=google_denied`);
  }

  try {
    const googleUser = await AuthService.exchangeGoogleCode(code, redirectUri);
    const { tokens } = await AuthService.loginWithGoogle(googleUser);

    // Refresh token → httpOnly cookie; only the short-lived access token
    // transits in the redirect URL.
    //
    // No native branch here on purpose (PRE_IOS_PLAN.md R3.1 lists one): this is
    // a browser redirect, not a fetch, so there is no request header to opt in
    // with — and R2 removed Google Sign-In from the iOS build entirely
    // (Guideline 4.8), so nothing native ever reaches this handler.
    setRefreshCookie(res, tokens.refresh_token, tokens.refresh_expires_in);
    const params = new URLSearchParams({ access_token: tokens.access_token });

    return res.redirect(`${clientUrl}/auth/callback?${params}`);
  } catch (err: any) {
    logger.error({ err: err.message }, '[Google OAuth]');
    return res.redirect(`${clientUrl}/login?error=google_failed`);
  }
});

export default router;
