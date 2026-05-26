import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { pool } from '../db/connection';
import {
  UserRow, UserPublic, RegisterBody, LoginBody,
  AuthTokens, AuthResponse, JwtPayload, RefreshTokenRow,
} from '../types/user.type';

const SALT_ROUNDS       = 12;
const ACCESS_TOKEN_TTL  = '15m';
const REFRESH_TOKEN_TTL = 60 * 60 * 24 * 7;

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) throw new Error('JWT_SECRET env variable is required');

// ---- Helpers ---------------------------------------------------------------

export function toPublicUser(row: UserRow): UserPublic {
  const { password_hash: _ph, ...rest } = row;
  return rest;
}

function signAccessToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, jwtSecret!, { expiresIn: ACCESS_TOKEN_TTL });
}

async function createRefreshToken(userId: string): Promise<string> {
  const token     = crypto.randomBytes(64).toString('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL * 1000);
  await pool.query(
    'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
    [userId, token, expiresAt],
  );
  return token;
}

async function issueTokens(user: UserRow): Promise<AuthTokens> {
  const access_token  = signAccessToken({ sub: user.id, email: user.email, role: user.role });
  const refresh_token = await createRefreshToken(user.id);
  return { access_token, refresh_token, expires_in: 15 * 60 };
}

// Creates a user_profiles row if one doesn't already exist for this user.
async function ensureUserProfile(userId: string, displayName: string, avatarUrl?: string | null) {
  await pool.query(
    `INSERT INTO user_profiles
       (user_id, display_name, avatar, tier, performance_score, is_public, joined_at)
     VALUES ($1, $2, '👤', 'rookie', 0, TRUE, NOW())
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, displayName],
  );
  // If an avatar_url was supplied (Google sign-in), store it on the users row too.
  if (avatarUrl) {
    await pool.query('UPDATE users SET avatar_url = $1 WHERE id = $2 AND avatar_url IS NULL', [avatarUrl, userId]);
  }
}

// ---- Register --------------------------------------------------------------

export async function register(body: RegisterBody): Promise<AuthResponse> {
  const { email, username, password, first_name = null, last_name = null } = body;

  const existing = await pool.query(
    'SELECT id FROM users WHERE email = $1 OR username = $2',
    [email.toLowerCase(), username.toLowerCase()],
  );
  if (existing.rowCount && existing.rowCount > 0) {
    throw Object.assign(new Error('Email or username already in use'), { status: 409 });
  }

  const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
  const { rows } = await pool.query<UserRow>(
    `INSERT INTO users (email, username, password_hash, first_name, last_name)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [email.toLowerCase(), username.toLowerCase(), password_hash, first_name, last_name],
  );

  const user = rows[0];
  const displayName = first_name ? first_name : username;
  await ensureUserProfile(user.id, displayName);

  const tokens = await issueTokens(user);
  return { user: toPublicUser(user), tokens };
}

// ---- Login -----------------------------------------------------------------

export async function login(body: LoginBody): Promise<AuthResponse> {
  const { email, password } = body;

  const { rows } = await pool.query<UserRow>(
    'SELECT * FROM users WHERE email = $1 AND is_active = TRUE',
    [email.toLowerCase()],
  );
  const user = rows[0];
  if (!user || !user.password_hash) {
    throw Object.assign(new Error('Invalid credentials'), { status: 401 });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    throw Object.assign(new Error('Invalid credentials'), { status: 401 });
  }

  // Ensure profile row exists (safety net for old accounts created before this fix)
  await ensureUserProfile(user.id, user.first_name ?? user.username);

  const tokens = await issueTokens(user);
  return { user: toPublicUser(user), tokens };
}

// ---- Google OAuth ----------------------------------------------------------

interface GoogleUserInfo {
  sub: string;
  email: string;
  name: string;
  picture: string;
  given_name?: string;
  family_name?: string;
}

export async function exchangeGoogleCode(code: string, redirectUri: string): Promise<GoogleUserInfo> {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw Object.assign(new Error('Google token exchange failed: ' + err), { status: 502 });
  }

  const { access_token } = await tokenRes.json() as { access_token: string };

  const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: 'Bearer ' + access_token },
  });
  if (!userRes.ok) {
    throw Object.assign(new Error('Failed to fetch Google user info'), { status: 502 });
  }

  return userRes.json() as Promise<GoogleUserInfo>;
}

export async function loginWithGoogle(googleUser: GoogleUserInfo): Promise<AuthResponse> {
  // 1. Look up by google_id
  let { rows } = await pool.query<UserRow>(
    'SELECT * FROM users WHERE google_id = $1 AND is_active = TRUE',
    [googleUser.sub],
  );
  let user = rows[0];

  if (!user) {
    // 2. Fall back to matching email (link accounts)
    const byEmail = await pool.query<UserRow>(
      'SELECT * FROM users WHERE email = $1 AND is_active = TRUE',
      [googleUser.email.toLowerCase()],
    );
    if (byEmail.rows[0]) {
      const updated = await pool.query<UserRow>(
        'UPDATE users SET google_id=$1, avatar_url=$2 WHERE id=$3 RETURNING *',
        [googleUser.sub, googleUser.picture, byEmail.rows[0].id],
      );
      user = updated.rows[0];
    } else {
      // 3. Create brand-new user
      const base     = googleUser.email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '');
      const username = base + '_' + crypto.randomBytes(3).toString('hex');
      const { rows: newRows } = await pool.query<UserRow>(
        `INSERT INTO users (email, username, google_id, avatar_url, first_name, last_name)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          googleUser.email.toLowerCase(),
          username,
          googleUser.sub,
          googleUser.picture,
          googleUser.given_name  ?? null,
          googleUser.family_name ?? null,
        ],
      );
      user = newRows[0];
    }
  }

  // Always ensure a user_profiles row exists
  const displayName = googleUser.given_name ?? googleUser.name ?? user.username;
  await ensureUserProfile(user.id, displayName, googleUser.picture);

  const tokens = await issueTokens(user);
  return { user: toPublicUser(user), tokens };
}

// ---- Refresh ---------------------------------------------------------------

export async function refreshTokens(rawToken: string): Promise<AuthTokens> {
  const { rows } = await pool.query<RefreshTokenRow>(
    'SELECT * FROM refresh_tokens WHERE token=$1 AND revoked=FALSE AND expires_at>NOW()',
    [rawToken],
  );
  const stored = rows[0];
  if (!stored) throw Object.assign(new Error('Invalid or expired refresh token'), { status: 401 });

  await pool.query('UPDATE refresh_tokens SET revoked=TRUE WHERE id=$1', [stored.id]);

  const { rows: userRows } = await pool.query<UserRow>(
    'SELECT * FROM users WHERE id=$1 AND is_active=TRUE',
    [stored.user_id],
  );
  const user = userRows[0];
  if (!user) throw Object.assign(new Error('User not found or inactive'), { status: 401 });

  return issueTokens(user);
}

// ---- Logout ----------------------------------------------------------------

export async function logout(rawToken: string): Promise<void> {
  await pool.query('UPDATE refresh_tokens SET revoked=TRUE WHERE token=$1', [rawToken]);
}

// ---- Verify token ----------------------------------------------------------

export function verifyAccessToken(token: string): JwtPayload {
  try {
    return jwt.verify(token, jwtSecret!) as JwtPayload;
  } catch {
    throw Object.assign(new Error('Invalid or expired access token'), { status: 401 });
  }
}
