-- Migration 005: Add openai_api_key to user_profiles
-- Run with:
--   psql -h localhost -p 5432 -U postgres -d IceedgeDB -f src/db/migrations/005_openai_key.sql

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS openai_api_key TEXT;
