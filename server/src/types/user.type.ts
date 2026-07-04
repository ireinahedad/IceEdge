// ============================================================
//  User Service — TypeScript Types
// ============================================================

// -------------------------------------------------------
//  Domain types (match DB columns)
// -------------------------------------------------------

export type UserRole = 'admin' | 'user';

/** Full user row as stored in the DB (never send password_hash to client) */
export interface UserRow {
  id: string;
  email: string;
  username: string;
  password_hash: string;
  first_name: string | null;
  last_name: string | null;
  role: UserRole;
  is_active: boolean;
  email_verified: boolean;
  google_id?: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Safe public representation — no sensitive fields */
export interface UserPublic {
  id: string;
  email: string;
  username: string;
  first_name: string | null;
  last_name: string | null;
  role: UserRole;
  is_active: boolean;
  email_verified: boolean;
  created_at: Date;
  updated_at: Date;
}

// -------------------------------------------------------
//  Auth request / response bodies
// -------------------------------------------------------

export interface RegisterBody {
  email: string;
  username: string;
  password: string;
  first_name?: string;
  last_name?: string;
}

export interface LoginBody {
  email: string;
  password: string;
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
}

export interface AuthResponse {
  user: UserPublic;
  tokens: AuthTokens;
}

/** Returned by /register — account created but not yet verified (no tokens). */
export interface PendingVerificationResponse {
  pending: true;
  email: string;
}

export interface VerifyEmailBody {
  email: string;
  code: string;
}

export interface ResendVerificationBody {
  email: string;
}

export interface ForgotPasswordBody {
  email: string;
}

export interface ResetPasswordBody {
  email: string;
  code: string;
  new_password: string;
}

export interface RefreshBody {
  refresh_token: string;
}

// -------------------------------------------------------
//  User CRUD request bodies
// -------------------------------------------------------

export interface UpdateUserBody {
  email?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_active?: boolean;
}

export interface UpdatePasswordBody {
  current_password: string;
  new_password: string;
}

// -------------------------------------------------------
//  JWT payload
// -------------------------------------------------------

export interface JwtPayload {
  sub: string;    // user id
  email: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}

// -------------------------------------------------------
//  Refresh token row
// -------------------------------------------------------

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  token: string;
  expires_at: Date;
  revoked: boolean;
  created_at: Date;
}

// -------------------------------------------------------
//  Express augmentation — attach user to req
// -------------------------------------------------------

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}