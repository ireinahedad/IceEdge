-- Restore drill fingerprint (BACKUP_DR.md §5). READ-ONLY.
-- Run it twice in the Neon SQL Editor: once on the restored branch, once on
-- the production branch. User data (users, bet_slips, chat_messages,
-- subscriptions, schema_migrations) must match up to the restore point:
-- production may have newer rows, never fewer. refresh_tokens and
-- email_verification_codes are purged by the cleanup job, so they can go
-- either way.

-- 1. Key checks (one row)
SELECT
  (SELECT count(*) FROM users)                                   AS users,
  (SELECT max(created_at) FROM users)                            AS last_signup,
  (SELECT count(*) FROM bet_slips)                               AS slips,
  (SELECT max(placed_at) FROM bet_slips)                         AS last_slip,
  (SELECT count(*) FROM user_bets)                               AS bets,
  (SELECT count(*) FROM chat_messages)                           AS chat_msgs,
  (SELECT max(sent_at) FROM chat_messages)                       AS last_chat,
  (SELECT count(*) FROM subscriptions WHERE plan <> 'free'
                                        AND status = 'active')   AS pro_active,
  (SELECT count(*) FROM schema_migrations)                       AS migrations,
  (SELECT max(filename) FROM schema_migrations
    WHERE filename <> 'schema.sql')                              AS last_migration,
  now()                                                          AS checked_at;

-- 2. Exact row count of every table
SELECT table_name,
       (xpath('/row/c/text()',
              query_to_xml(format('SELECT count(*) AS c FROM %I.%I',
                                  table_schema, table_name),
                           false, true, '')))[1]::text::bigint AS rows
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name;
