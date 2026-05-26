import { Router, Request, Response } from 'express';
import * as AuthService from '../services/auth.service';
import { authenticate } from '../middleware/auth.middleware';
import { RegisterBody, LoginBody, RefreshBody } from '../types/user.type';

const router = Router();

// POST /auth/register
router.post('/register', async (req: Request<{}, {}, RegisterBody>, res: Response) => {
  try {
    const { email, username, password, first_name, last_name } = req.body;
    if (!email || !username || !password)
      return res.status(400).json({ error: 'email, username and password are required' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const result = await AuthService.register({ email, username, password, first_name, last_name });
    return res.status(201).json(result);
  } catch (err: any) { return res.status(err.status ?? 500).json({ error: err.message }); }
});

// POST /auth/login
router.post('/login', async (req: Request<{}, {}, LoginBody>, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'email and password are required' });
    const result = await AuthService.login({ email, password });
    return res.status(200).json(result);
  } catch (err: any) { return res.status(err.status ?? 500).json({ error: err.message }); }
});

// POST /auth/refresh
router.post('/refresh', async (req: Request<{}, {}, RefreshBody>, res: Response) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'refresh_token is required' });
    const tokens = await AuthService.refreshTokens(refresh_token);
    return res.status(200).json(tokens);
  } catch (err: any) { return res.status(err.status ?? 500).json({ error: err.message }); }
});

// POST /auth/logout
router.post('/logout', authenticate, async (req: Request<{}, {}, RefreshBody>, res: Response) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'refresh_token is required' });
    await AuthService.logout(refresh_token);
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

    const params = new URLSearchParams({
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
    });

    return res.redirect(`${clientUrl}/auth/callback?${params}`);
  } catch (err: any) {
    console.error('[Google OAuth]', err.message);
    return res.redirect(`${clientUrl}/login?error=google_failed`);
  }
});

export default router;
