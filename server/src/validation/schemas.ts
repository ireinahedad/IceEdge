/**
 * schemas.ts — zod validation schemas for request bodies (H3).
 * Bounds every field so oversized/malformed input is rejected at the boundary.
 * Kept intentionally close to the existing hand-rolled checks so behaviour and
 * error messages don't change, only coverage and consistency.
 */

import { z } from 'zod';

const email    = z.string().trim().toLowerCase().email().max(255);
const password = z.string().min(8, 'Password must be at least 8 characters').max(200);
const code     = z.string().trim().regex(/^\d{6}$/, 'code must be 6 digits');

// ── Auth ──────────────────────────────────────────────────────────────────────
export const registerSchema = z.object({
  email,
  username:   z.string().trim().min(3).max(100).regex(/^[a-zA-Z0-9_.-]+$/, 'username has invalid characters'),
  password,
  first_name: z.string().trim().max(100).optional(),
  last_name:  z.string().trim().max(100).optional(),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(200),
  remember: z.boolean().optional(),
});

export const verifyEmailSchema      = z.object({ email, code });
export const resendVerificationSchema = z.object({ email });
export const forgotPasswordSchema   = z.object({ email });
export const resetPasswordSchema    = z.object({ email, code, new_password: password });

// ── Slips ─────────────────────────────────────────────────────────────────────
// Leg shape varies (hockey/tennis/props); keep it permissive but bounded so a
// caller can't submit an unbounded or non-object legs payload.
export const slipSubmitSchema = z.object({
  legs: z.array(z.record(z.any())).min(1, 'legs array is required').max(30, 'too many legs'),
  sport: z.string().trim().max(20).optional(),
  // Stored/consumed as a percentage (see xpForOutcome, clamps 1..99). Accept the
  // full 0..100 range plus null so existing clients aren't rejected.
  combinedProbability: z.number().min(0).max(100).nullable().optional(),
});

// ── Profile ─────────────────────────────────────────────────────────────────
export const avatarSchema = z.object({
  avatarDataUrl: z.string()
    .startsWith('data:image/', 'avatarDataUrl must be an image data URI')
    .max(2_800_000, 'Image too large (max ~2 MB)'),
});
