// @node-rs/bcrypt, NOT bcryptjs: bcryptjs is pure JavaScript and runs on the
// event loop, so a single cost-12 hash freezes the whole process for ~1-2 s on a
// shared vCPU — a burst of signups times out every other request. The native
// binding runs off-thread. Same `$2a$`/`$2b$` output, so existing hashes verify
// unchanged.
import { hash as bcryptHash, verify as bcryptVerify } from '@node-rs/bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { pool } from '../db/connection';
import { logger } from '../logger';
import { sendVerificationCode, sendPasswordResetCode } from './email.service';
import {
  UserRow, UserPublic, RegisterBody, LoginBody,
  AuthTokens, AuthResponse, JwtPayload, RefreshTokenRow,
  PendingVerificationResponse,
} from '../types/user.type';

// Cost 11 ≈ half the CPU of cost 12, still above the OWASP floor (10).
const SALT_ROUNDS       = 11;
const ACCESS_TOKEN_TTL  = '15m';
// Short session (no "remember me"): 7 days. Persistent session: 30 days.
// Both overridable via env (seconds).
const REFRESH_TOKEN_TTL          = Number(process.env.REFRESH_TOKEN_TTL)          || 60 * 60 * 24 * 7;
const REFRESH_TOKEN_TTL_REMEMBER = Number(process.env.REFRESH_TOKEN_TTL_REMEMBER) || 60 * 60 * 24 * 30;

// Email verification
const CODE_TTL_MS      = 15 * 60 * 1000; // 15 minutes
const MAX_CODE_ATTEMPTS = 5;
// Dev escape hatch: when true, accounts are created already-verified and login
// is never blocked (no email needed). Keep this FALSE in production.
const VERIFICATION_DISABLED = process.env.EMAIL_VERIFICATION_DISABLED === 'true';

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) throw new Error('JWT_SECRET env variable is required');

// Any object that can run a query — the shared pool OR a transaction client.
// Lets helpers participate in a caller's BEGIN/COMMIT when a client is passed.
// Deliberately a loose call signature so both `Pool` and `PoolClient` satisfy it
// (their overloaded query() types don't assign cleanly to Pick<PoolClient,…>).
type Db = { query: (text: string, params?: any[]) => Promise<any> };

// ---- Helpers ---------------------------------------------------------------

export function toPublicUser(row: UserRow): UserPublic {
  const { password_hash: _ph, ...rest } = row;
  return rest;
}

/** Hash a password for storage. Shared with user.service so the cost lives in
 *  exactly one place. */
export function hashPassword(plain: string): Promise<string> {
  return bcryptHash(plain, SALT_ROUNDS);
}

/** Constant-time password check against a stored bcrypt hash. */
export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcryptVerify(plain, hash);
}

/** Runs a side effect (email, webhook…) outside the request path. The caller
 *  responds immediately; a failure here is logged, never thrown into the void.
 *  Used for verification/reset emails: a blocking HTTP call to Resend inside the
 *  request adds its full latency to every signup for no benefit to the client,
 *  which only learns "check your inbox" either way. */
function fireAndForget(work: Promise<unknown>, context: string): void {
  void work.catch((err: any) => {
    logger.error({ err: err?.message ?? err }, `[auth] ${context} failed`);
  });
}

/** Hash a refresh token for storage/lookup. The DB never holds the raw secret,
 *  so a DB read (leak, backup, SQL injection elsewhere) can't yield a usable
 *  session token. SHA-256 is appropriate here: the token is 64 random bytes of
 *  high entropy, so it isn't brute-forceable and needs no slow KDF/salt. */
function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Hash a one-time 6-digit code. Salted SHA-256, not bcrypt: a slow KDF buys
 *  nothing here — the code has ~10^6 of entropy and lives 15 minutes, so what
 *  stops guessing is MAX_CODE_ATTEMPTS + expiry, not the hash cost. Meanwhile a
 *  cost-12 bcrypt costs ~1 s of blocking CPU on every signup. Same reasoning as
 *  hashToken() above; the salt keeps the 10^6 possible digests un-precomputable.
 *  Format: `sha256$<salt>$<digest>`. */
function hashCode(code: string): string {
  const salt   = crypto.randomBytes(16).toString('hex');
  const digest = crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');
  return `sha256$${salt}$${digest}`;
}

/** Verifies a code against a stored hash. Self-describing format → codes issued
 *  by the previous bcrypt path (at most 15 min of them, in flight at deploy
 *  time) keep working, so no migration and no user locked out. */
async function verifyCodeHash(code: string, stored: string): Promise<boolean> {
  if (stored.startsWith('$2')) return bcryptVerify(code, stored);

  const [scheme, salt, digest] = stored.split('$');
  if (scheme !== 'sha256' || !salt || !digest) return false;

  const expected = crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');
  if (expected.length !== digest.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(digest, 'hex'));
}

function signAccessToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, jwtSecret!, { expiresIn: ACCESS_TOKEN_TTL });
}

async function createRefreshToken(userId: string, remember: boolean): Promise<{ token: string; ttl: number }> {
  const ttl       = remember ? REFRESH_TOKEN_TTL_REMEMBER : REFRESH_TOKEN_TTL;
  const token     = crypto.randomBytes(64).toString('hex');
  const expiresAt = new Date(Date.now() + ttl * 1000);
  // Store only the hash — the raw token is returned to the caller (→ cookie) but
  // never persisted. See hashToken() for why SHA-256 (not bcrypt) is used here.
  await pool.query(
    'INSERT INTO refresh_tokens (user_id, token, expires_at, remember) VALUES ($1, $2, $3, $4)',
    [userId, hashToken(token), expiresAt, remember],
  );
  return { token, ttl };
}

async function issueTokens(user: UserRow, remember = false): Promise<AuthTokens> {
  const access_token  = signAccessToken({ sub: user.id, email: user.email, role: user.role });
  const { token: refresh_token, ttl } = await createRefreshToken(user.id, remember);
  return { access_token, refresh_token, expires_in: 15 * 60, refresh_expires_in: ttl };
}

// Creates a user_profiles row if one doesn't already exist for this user.
// Accepts an optional executor so it can run inside a caller's transaction.
async function ensureUserProfile(userId: string, displayName: string, avatarUrl?: string | null, db: Db = pool) {
  await db.query(
    `INSERT INTO user_profiles
       (user_id, display_name, avatar, tier, performance_score, is_public, joined_at)
     VALUES ($1, $2, '👤', 'rookie', 0, TRUE, NOW())
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, displayName],
  );
  // If an avatar_url was supplied (Google sign-in), store it on the users row too.
  if (avatarUrl) {
    await db.query('UPDATE users SET avatar_url = $1 WHERE id = $2 AND avatar_url IS NULL', [avatarUrl, userId]);
  }
}

// ---- One-time codes (email verification + password reset) ------------------

type CodePurpose = 'email_verify' | 'password_reset';

/** Generates a fresh 6-digit code for a given purpose, stores its hash, and
 *  invalidates any earlier unused codes of the same purpose. Returns the
 *  plaintext code so the caller can email it. */
async function createCode(user: UserRow, purpose: CodePurpose): Promise<string> {
  await pool.query(
    'UPDATE email_verification_codes SET consumed = TRUE WHERE user_id = $1 AND purpose = $2 AND consumed = FALSE',
    [user.id, purpose],
  );

  const code      = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const code_hash = hashCode(code);
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  await pool.query(
    'INSERT INTO email_verification_codes (user_id, code_hash, expires_at, purpose) VALUES ($1, $2, $3, $4)',
    [user.id, code_hash, expiresAt, purpose],
  );

  return code;
}

/** Fetches the latest active code for a purpose and validates it against the
 *  supplied plaintext. Throws on any failure; on success consumes the code. */
async function consumeCode(userId: string, code: string, purpose: CodePurpose): Promise<void> {
  const { rows } = await pool.query(
    `SELECT * FROM email_verification_codes
     WHERE user_id = $1 AND purpose = $2 AND consumed = FALSE
     ORDER BY created_at DESC LIMIT 1`,
    [userId, purpose],
  );
  const record = rows[0];

  if (!record || new Date(record.expires_at) < new Date()) {
    throw Object.assign(new Error('Invalid or expired code'), { status: 400 });
  }
  if (record.attempts >= MAX_CODE_ATTEMPTS) {
    throw Object.assign(new Error('Too many attempts. Please request a new code.'), { status: 429 });
  }

  const valid = await verifyCodeHash(code, record.code_hash);
  if (!valid) {
    await pool.query('UPDATE email_verification_codes SET attempts = attempts + 1 WHERE id = $1', [record.id]);
    throw Object.assign(new Error('Invalid or expired code'), { status: 400 });
  }

  await pool.query('UPDATE email_verification_codes SET consumed = TRUE WHERE id = $1', [record.id]);
}

/** Generates a fresh email-confirmation code and sends it out of band.
 *  The code row is written synchronously — it must exist before we answer, or a
 *  fast user could verify against nothing. Only the SMTP round-trip is deferred:
 *  the client is told "check your inbox" either way, so waiting on Resend just
 *  adds its latency to every signup. Worst case (process killed mid-send) the
 *  user hits "resend". */
async function issueVerificationCode(user: UserRow): Promise<void> {
  const code = await createCode(user, 'email_verify');
  fireAndForget(sendVerificationCode(user.email, code, user.first_name), 'verification email');
}

// ---- Register --------------------------------------------------------------

export async function register(body: RegisterBody): Promise<PendingVerificationResponse | AuthResponse> {
  const { email, username, password, first_name = null, last_name = null } = body;

  const existing = await pool.query(
    'SELECT id FROM users WHERE email = $1 OR username = $2',
    [email.toLowerCase(), username.toLowerCase()],
  );
  if (existing.rowCount && existing.rowCount > 0) {
    throw Object.assign(new Error('Email or username already in use'), { status: 409 });
  }

  const password_hash = await hashPassword(password);

  // Create the user and its profile atomically: a crash between the two inserts
  // must not leave a user with no user_profiles row.
  const displayName = first_name ? first_name : username;
  const client = await pool.connect();
  let user: UserRow;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<UserRow>(
      `INSERT INTO users (email, username, password_hash, first_name, last_name, email_verified)
       VALUES ($1,$2,$3,$4,$5, FALSE) RETURNING *`,
      [email.toLowerCase(), username.toLowerCase(), password_hash, first_name, last_name],
    );
    user = rows[0];
    await ensureUserProfile(user.id, displayName, null, client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Dev bypass: mark verified and log in immediately (no email required).
  if (VERIFICATION_DISABLED) {
    const { rows: verified } = await pool.query<UserRow>(
      'UPDATE users SET email_verified = TRUE WHERE id = $1 RETURNING *',
      [user.id],
    );
    const tokens = await issueTokens(verified[0]);
    return { user: toPublicUser(verified[0]), tokens };
  }

  // Send the confirmation code — no tokens issued until the email is verified.
  await issueVerificationCode(user);

  return { pending: true, email: user.email };
}

// ---- Verify email ----------------------------------------------------------

export async function verifyEmail(email: string, code: string): Promise<AuthResponse> {
  const { rows: userRows } = await pool.query<UserRow>(
    'SELECT * FROM users WHERE email = $1 AND is_active = TRUE',
    [email.toLowerCase()],
  );
  const user = userRows[0];
  if (!user) throw Object.assign(new Error('Invalid or expired code'), { status: 400 });

  if (user.email_verified) {
    // Already verified — just log the user in.
    const tokens = await issueTokens(user);
    return { user: toPublicUser(user), tokens };
  }

  await consumeCode(user.id, code, 'email_verify');

  const { rows: updatedRows } = await pool.query<UserRow>(
    'UPDATE users SET email_verified = TRUE WHERE id = $1 RETURNING *',
    [user.id],
  );

  const tokens = await issueTokens(updatedRows[0]);
  return { user: toPublicUser(updatedRows[0]), tokens };
}

// ---- Resend verification code ---------------------------------------------

export async function resendVerification(email: string): Promise<void> {
  const { rows } = await pool.query<UserRow>(
    'SELECT * FROM users WHERE email = $1 AND is_active = TRUE',
    [email.toLowerCase()],
  );
  const user = rows[0];
  // Don't reveal whether the account exists / is already verified.
  if (!user || user.email_verified) return;

  await issueVerificationCode(user);
}

// ---- Forgot / reset password ----------------------------------------------

/** Emails a reset code. Always resolves silently (no account enumeration). */
export async function forgotPassword(email: string): Promise<void> {
  const { rows } = await pool.query<UserRow>(
    'SELECT * FROM users WHERE email = $1 AND is_active = TRUE',
    [email.toLowerCase()],
  );
  const user = rows[0];
  // Only password accounts can be reset (Google-only accounts have no password).
  if (!user || !user.password_hash) return;

  const code = await createCode(user, 'password_reset');
  // Out of band, like issueVerificationCode — and it keeps the response time
  // identical whether or not the account exists (no enumeration by timing).
  fireAndForget(sendPasswordResetCode(user.email, code, user.first_name), 'password reset email');
}

/** Validates the reset code and sets a new password. Revokes all sessions. */
export async function resetPassword(email: string, code: string, newPassword: string): Promise<void> {
  const { rows } = await pool.query<UserRow>(
    'SELECT * FROM users WHERE email = $1 AND is_active = TRUE',
    [email.toLowerCase()],
  );
  const user = rows[0];
  if (!user) throw Object.assign(new Error('Invalid or expired code'), { status: 400 });

  await consumeCode(user.id, code, 'password_reset');

  const password_hash = await hashPassword(newPassword);
  await pool.query(
    // Completing a reset also proves the user controls the inbox → verify email.
    'UPDATE users SET password_hash = $1, email_verified = TRUE WHERE id = $2',
    [password_hash, user.id],
  );

  // Invalidate every existing refresh token — force re-login everywhere.
  await pool.query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1', [user.id]);
}

// ---- Login -----------------------------------------------------------------

export async function login(body: LoginBody): Promise<AuthResponse> {
  const { email, password, remember = false } = body;

  const { rows } = await pool.query<UserRow>(
    'SELECT * FROM users WHERE email = $1 AND is_active = TRUE',
    [email.toLowerCase()],
  );
  const user = rows[0];
  if (!user || !user.password_hash) {
    throw Object.assign(new Error('Invalid credentials'), { status: 401 });
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    throw Object.assign(new Error('Invalid credentials'), { status: 401 });
  }

  // Block login until the email address has been confirmed (unless bypassed).
  if (!user.email_verified && !VERIFICATION_DISABLED) {
    // Re-issue a fresh code so the user can complete verification.
    await issueVerificationCode(user);
    throw Object.assign(
      new Error('Email not verified'),
      { status: 403, code: 'EMAIL_NOT_VERIFIED', email: user.email },
    );
  }

  // Ensure profile row exists (safety net for old accounts created before this fix)
  await ensureUserProfile(user.id, user.first_name ?? user.username);

  const tokens = await issueTokens(user, remember);
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
  // Resolve (or create/link) the account and guarantee its profile row inside a
  // single transaction — creating a user and its user_profiles row must be
  // atomic, and account-linking updates shouldn't half-apply either.
  const client = await pool.connect();
  let user: UserRow;
  try {
    await client.query('BEGIN');

    // 1. Look up by google_id
    const byGoogle = await client.query<UserRow>(
      'SELECT * FROM users WHERE google_id = $1 AND is_active = TRUE',
      [googleUser.sub],
    );
    user = byGoogle.rows[0];

    if (!user) {
      // 2. Fall back to matching email (link accounts)
      const byEmail = await client.query<UserRow>(
        'SELECT * FROM users WHERE email = $1 AND is_active = TRUE',
        [googleUser.email.toLowerCase()],
      );
      if (byEmail.rows[0]) {
        const updated = await client.query<UserRow>(
          'UPDATE users SET google_id=$1, avatar_url=$2, email_verified=TRUE WHERE id=$3 RETURNING *',
          [googleUser.sub, googleUser.picture, byEmail.rows[0].id],
        );
        user = updated.rows[0];
      } else {
        // 3. Create brand-new user
        const base     = googleUser.email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '');
        const username = base + '_' + crypto.randomBytes(3).toString('hex');
        const { rows: newRows } = await client.query<UserRow>(
          `INSERT INTO users (email, username, google_id, avatar_url, first_name, last_name, email_verified)
           VALUES ($1,$2,$3,$4,$5,$6, TRUE) RETURNING *`,
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
    await ensureUserProfile(user.id, displayName, googleUser.picture, client);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Google sign-in is treated as a persistent session by default.
  const tokens = await issueTokens(user, true);
  return { user: toPublicUser(user), tokens };
}

// ---- Refresh ---------------------------------------------------------------

export async function refreshTokens(rawToken: string): Promise<AuthTokens> {
  const { rows } = await pool.query<RefreshTokenRow>(
    'SELECT * FROM refresh_tokens WHERE token=$1 AND revoked=FALSE AND expires_at>NOW()',
    [hashToken(rawToken)],
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

  // Preserve the persistence choice across rotation.
  return issueTokens(user, stored.remember);
}

// ---- Logout ----------------------------------------------------------------

export async function logout(rawToken: string): Promise<void> {
  await pool.query('UPDATE refresh_tokens SET revoked=TRUE WHERE token=$1', [hashToken(rawToken)]);
}

/** Revoke every active refresh token for a user → signs them out on all
 *  devices. The 15-min access tokens still on other devices expire naturally. */
export async function logoutAll(userId: string): Promise<void> {
  await pool.query(
    'UPDATE refresh_tokens SET revoked=TRUE WHERE user_id=$1 AND revoked=FALSE',
    [userId],
  );
}

// ---- Verify token ----------------------------------------------------------

export function verifyAccessToken(token: string): JwtPayload {
  try {
    return jwt.verify(token, jwtSecret!) as JwtPayload;
  } catch {
    throw Object.assign(new Error('Invalid or expired access token'), { status: 401 });
  }
}
