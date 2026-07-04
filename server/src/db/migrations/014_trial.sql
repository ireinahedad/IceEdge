-- ============================================================
--  Migration 014 — 7-day free trial flag
-- ============================================================
-- Tracks whether a user has already consumed their one-time free trial, so a
-- trial can't be started twice.

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS trial_used BOOLEAN NOT NULL DEFAULT FALSE;
