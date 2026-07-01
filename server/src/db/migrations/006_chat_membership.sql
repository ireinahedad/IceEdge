-- Migration 006: Public/private chats, membership, roles, pins, join codes
-- Safe to re-run (IF NOT EXISTS everywhere).
-- Run with: psql -h localhost -p 5432 -U postgres -d IceedgeDB -f src/db/migrations/006_chat_membership.sql

ALTER TABLE chat_rooms
  ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS join_code  VARCHAR(10) UNIQUE,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Per-user membership: role (admin/member) + personal pin
CREATE TABLE IF NOT EXISTS chat_room_members (
  room_id   VARCHAR(50) NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  user_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      VARCHAR(10) NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  pinned    BOOLEAN     NOT NULL DEFAULT FALSE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_room_members_user ON chat_room_members(user_id);

-- Backfill join codes for existing rooms
UPDATE chat_rooms
SET join_code = UPPER(SUBSTRING(MD5(id || RANDOM()::text) FROM 1 FOR 6))
WHERE join_code IS NULL;
