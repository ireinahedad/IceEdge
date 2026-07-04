-- ============================================================
--  Migration 013 — Web Push subscriptions
-- ============================================================
-- Stores browser Push API subscriptions so the server can send value-bet
-- notifications. One browser/device = one row (keyed by endpoint).

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT        NOT NULL UNIQUE,
  p256dh      TEXT        NOT NULL,   -- client public key
  auth        TEXT        NOT NULL,   -- client auth secret
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions (user_id);
