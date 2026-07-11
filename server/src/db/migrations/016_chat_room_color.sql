-- 016_chat_room_color.sql
-- Lets a room creator pick an accent color for their salon. Stored as a
-- hex string (#RRGGBB). NULL → the UI falls back to the default accent.
ALTER TABLE chat_rooms
  ADD COLUMN IF NOT EXISTS color VARCHAR(9);
