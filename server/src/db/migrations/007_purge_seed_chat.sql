-- Migration 007: Remove hardcoded/seeded chat data (fake rooms, users, messages)
-- The chat now contains only real user-generated content.
-- Safe to re-run.
-- Run with: psql -h localhost -p 5432 -U postgres -d IceedgeDB -f src/db/migrations/007_purge_seed_chat.sql

-- Seeded reactions & messages (attached to seeded rooms)
DELETE FROM chat_reactions
WHERE message_id IN (
  SELECT id FROM chat_messages
  WHERE room_id IN ('general', 'picks', 'analysis', 'live', 'playoffs', 'props')
);

DELETE FROM chat_messages
WHERE room_id IN ('general', 'picks', 'analysis', 'live', 'playoffs', 'props');

DELETE FROM chat_room_members
WHERE room_id IN ('general', 'picks', 'analysis', 'live', 'playoffs', 'props');

DELETE FROM chat_rooms
WHERE id IN ('general', 'picks', 'analysis', 'live', 'playoffs', 'props');

-- The legacy hardcoded member_count / is_pinned columns are no longer used:
-- member counts are computed from chat_room_members, pins are per-user.
