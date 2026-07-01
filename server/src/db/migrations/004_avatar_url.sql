-- Migration 004: Add avatar_url to user_profiles (safe re-run with IF NOT EXISTS)
-- Run with:
--   psql -h localhost -p 5432 -U postgres -d IceedgeDB -f src/db/migrations/004_avatar_url.sql

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS avatar_url TEXT;
