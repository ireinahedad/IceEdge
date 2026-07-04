-- ============================================================
--  Migration 011 — Subscriptions (Free / Pro)
-- ============================================================
-- A single active subscription per user. Users with no row are treated as
-- 'free'. Stripe columns are optional — the schema works without a payment
-- provider (e.g. dev activation), and is ready to plug Stripe in later.

DO $$ BEGIN
  CREATE TYPE billing_plan AS ENUM ('free', 'pro');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  -- Mirrors Stripe subscription statuses (plus 'active' for dev activation).
  CREATE TYPE sub_status AS ENUM ('active', 'trialing', 'past_due', 'canceled', 'incomplete');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id                UUID          PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan                   billing_plan  NOT NULL DEFAULT 'free',
  status                 sub_status    NOT NULL DEFAULT 'active',
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  current_period_end     TIMESTAMPTZ,          -- when the paid period lapses (NULL = no expiry)
  cancel_at_period_end   BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer
  ON subscriptions (stripe_customer_id);
