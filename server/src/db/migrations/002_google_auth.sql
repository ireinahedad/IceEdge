-- Migration 002: Add Google OAuth support to users table
-- Run with: psql -h localhost -p 5432 -U postgres -d IceedgeDB -f src/db/migrations/002_google_auth.sql

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS google_id   TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS avatar_url  TEXT;

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS avatar_url  TEXT,
  ADD COLUMN IF NOT EXISTS bio         TEXT;
