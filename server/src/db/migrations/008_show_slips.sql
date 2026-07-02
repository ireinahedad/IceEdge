-- Migration 008: opt-in public slips
-- Users can choose to let other players see their bet slips.
-- Safe to re-run.
-- Run with: psql -h localhost -p 5432 -U postgres -d IceedgeDB -f src/db/migrations/008_show_slips.sql

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS show_slips BOOLEAN NOT NULL DEFAULT FALSE;
