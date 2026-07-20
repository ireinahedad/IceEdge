-- 019_chat_pagination_index.sql
-- M7 — Composite index for chat history pagination.
-- Room history is fetched ordered by time (room_id = $1 ORDER BY sent_at DESC).
-- The existing idx_chat_messages_room (room_id only) forces an in-memory sort
-- that degrades as message volume grows. This composite index lets Postgres
-- satisfy both the filter and the ordering from the index directly.
CREATE INDEX IF NOT EXISTS idx_chat_messages_room_sent
  ON chat_messages (room_id, sent_at DESC);
