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
// L'avatar est stocké en base64 dans Postgres (user_profiles.avatar_url) et
// renvoyé dans les payloads du chat et du leaderboard : chaque octet accepté ici
// se paye en stockage Neon ET en egress, à chaque lecture. Le client produit
// désormais un 256×256 WebP (~20 ko, ~27 ko une fois en base64) — le plafond de
// 400 000 caractères (~300 ko binaire) est une marge de sécurité, pas une cible.
// Il est volontairement plus bas que la limite de body de la route (600 ko) pour
// qu'un dépassement renvoie un 400 explicite plutôt qu'un 413 opaque.
export const avatarSchema = z.object({
  avatarDataUrl: z.string()
    .startsWith('data:image/', 'avatarDataUrl must be an image data URI')
    .max(400_000, 'Image too large — please choose a smaller one'),
});

// `user_profiles.rule_weights` (migration 017) est un JSONB écrit tel quel depuis
// le corps d'un PATCH : sans borne, un compte peut y ranger un objet arbitraire,
// facturé en stockage Neon et relu à chaque `GET /users/me`.
//
// La forme réelle est celle du store client : famille → { idFacteur → poids }.
// Les familles sont les 8 de `factorModel.ts` (match, totals, period, margin, ot,
// player_off, player_phys, goalie) et les ids de facteurs sont alphanumériques ;
// les plafonds ci-dessous laissent de la marge sans rendre le champ extensible
// (16 × 32 clés bornées ≈ 25 ko au pire).
// Les clés `__proto__` / `__defineGetter__`… traversent `z.record` comme des clés
// propres : elles sont refusées ici plutôt que stockées, pour qu'aucun objet relu
// plus tard ne porte de nom réservé.
const factorKey = z.string().regex(/^(?!__)[A-Za-z0-9_]{1,40}$/, 'invalid factor id');

export const ruleWeightsSchema = z
  .record(
    z.string().regex(/^(?!__)[a-z0-9_]{1,32}$/, 'invalid factor family'),
    z
      .record(factorKey, z.number().finite().min(0).max(100))
      .refine((m) => Object.keys(m).length <= 32, 'too many factors in a family'),
  )
  .refine((m) => Object.keys(m).length <= 16, 'too many factor families');

export type RuleWeightsMap = z.infer<typeof ruleWeightsSchema>;
