-- 044_widget_tokens.sql
-- Jetons du widget iOS « paris en cours » — APPLE_PLAN 4.2.
--
-- ── POURQUOI UN JETON À PART (2026-10-10) ──────────────────────────────────
--
-- Le widget tourne dans un process iOS séparé de l'app, réveillé par le système
-- toutes les 15–30 min. Il ne peut pas utiliser la session de l'app : le jeton
-- d'accès expire en 15 min, et faire tourner le refresh token depuis deux
-- process le ferait révoquer (rotation) et déconnecterait l'app.
--
-- Ce jeton-ci ne sert qu'à UNE route en lecture (`GET /api/widget/live-bets`) :
-- volé, il montre les paris en cours de quelqu'un, rien de plus. Seul son
-- SHA-256 est stocké. Révoqué à la déconnexion de l'app et par « déconnecter
-- tous les appareils » ; effacé avec le compte (ON DELETE CASCADE).

CREATE TABLE IF NOT EXISTS widget_tokens (
  token_hash    TEXT        PRIMARY KEY,
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_widget_tokens_user ON widget_tokens (user_id, created_at DESC);
