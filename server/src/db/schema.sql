-- ============================================================
--  IceEdge — Full PostgreSQL Schema
--  Compatible with PostgreSQL 10+
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -------------------------------------------------------
--  ENUMs
-- -------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'user');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE game_status AS ENUM ('scheduled', 'live', 'final');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE bet_outcome AS ENUM ('win', 'loss', 'pending');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE user_tier AS ENUM ('rookie', 'analyst', 'sharp', 'legend');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE billing_plan AS ENUM ('free', 'pro');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE sub_status AS ENUM ('active', 'trialing', 'past_due', 'canceled', 'incomplete');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
--  AUTH TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  email         VARCHAR(255)  NOT NULL UNIQUE,
  username      VARCHAR(100)  NOT NULL UNIQUE,
  password_hash TEXT,
  first_name    VARCHAR(100),
  last_name     VARCHAR(100),
  google_id     TEXT          UNIQUE,
  avatar_url    TEXT,
  role          user_role     NOT NULL DEFAULT 'user',
  is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
  email_verified BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_verification_codes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT        NOT NULL,
  purpose     TEXT        NOT NULL DEFAULT 'email_verify',  -- 'email_verify' | 'password_reset'
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed    BOOLEAN     NOT NULL DEFAULT FALSE,
  attempts    INT         NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evc_user_active
  ON email_verification_codes (user_id)
  WHERE consumed = FALSE;

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT        NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked     BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
--  NHL TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS nhl_teams (
  id            SERIAL      PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  abbreviation  VARCHAR(5)   NOT NULL UNIQUE,
  city          VARCHAR(100),
  conference    VARCHAR(20),
  division      VARCHAR(30),
  logo_url      TEXT,
  color         VARCHAR(10),
  emoji         VARCHAR(10)
);

CREATE TABLE IF NOT EXISTS nhl_team_stats (
  id                      SERIAL        PRIMARY KEY,
  team_id                 INT           NOT NULL REFERENCES nhl_teams(id) ON DELETE CASCADE,
  season                  VARCHAR(10)   NOT NULL DEFAULT '20252026',
  games_played            INT           DEFAULT 0,
  wins                    INT           DEFAULT 0,
  losses                  INT           DEFAULT 0,
  ot_losses               INT           DEFAULT 0,
  points                  INT           DEFAULT 0,
  goals_for               INT           DEFAULT 0,
  goals_against           INT           DEFAULT 0,
  goals_for_per_game      NUMERIC(5,2)  DEFAULT 0,
  goals_against_per_game  NUMERIC(5,2)  DEFAULT 0,
  power_play_pct          NUMERIC(5,2)  DEFAULT 0,
  penalty_kill_pct        NUMERIC(5,2)  DEFAULT 0,
  shots_for_per_game      NUMERIC(5,2)  DEFAULT 0,
  shots_against_per_game  NUMERIC(5,2)  DEFAULT 0,
  faceoff_win_pct         NUMERIC(5,2)  DEFAULT 0,
  home_record             VARCHAR(15),
  away_record             VARCHAR(15),
  last10                  VARCHAR(10),
  streak                  VARCHAR(10),
  win_pct                 NUMERIC(5,2)  DEFAULT 0,
  UNIQUE(team_id, season)
);

CREATE TABLE IF NOT EXISTS nhl_games (
  id              VARCHAR(20)  PRIMARY KEY,
  game_date       DATE         NOT NULL,
  start_time      VARCHAR(20),
  status          game_status  NOT NULL DEFAULT 'scheduled',
  period          INT,
  clock           VARCHAR(10),
  home_team_id    INT          REFERENCES nhl_teams(id),
  away_team_id    INT          REFERENCES nhl_teams(id),
  home_score      INT          DEFAULT 0,
  away_score      INT          DEFAULT 0,
  venue           VARCHAR(100),
  game_type       VARCHAR(20)  DEFAULT 'regular',
  home_odds       INT,
  away_odds       INT,
  over_under      NUMERIC(4,1),
  home_win_pct    INT,
  away_win_pct    INT
);

CREATE TABLE IF NOT EXISTS nhl_players (
  id              INT          PRIMARY KEY,
  first_name      VARCHAR(50),
  last_name       VARCHAR(50),
  full_name       VARCHAR(100) NOT NULL,
  team_id         INT          REFERENCES nhl_teams(id),
  position        VARCHAR(5),
  jersey_number   INT,
  image_url       TEXT
);

CREATE TABLE IF NOT EXISTS nhl_player_stats (
  id                SERIAL        PRIMARY KEY,
  player_id         INT           NOT NULL REFERENCES nhl_players(id) ON DELETE CASCADE,
  season            VARCHAR(10)   NOT NULL DEFAULT '20252026',
  games_played      INT           DEFAULT 0,
  goals             INT           DEFAULT 0,
  assists           INT           DEFAULT 0,
  points            INT           DEFAULT 0,
  plus_minus        INT           DEFAULT 0,
  shots             INT           DEFAULT 0,
  shooting_pct      NUMERIC(5,2)  DEFAULT 0,
  pp_goals          INT           DEFAULT 0,
  pp_points         INT           DEFAULT 0,
  sh_goals          INT           DEFAULT 0,
  penalty_minutes   INT           DEFAULT 0,
  blocked_shots     INT           DEFAULT 0,
  hits              INT           DEFAULT 0,
  time_on_ice       NUMERIC(5,2)  DEFAULT 0,
  faceoff_win_pct   NUMERIC(5,2),
  last_five         INT[]         DEFAULT '{}',
  win_impact        INT           DEFAULT 0,
  UNIQUE(player_id, season)
);

CREATE TABLE IF NOT EXISTS nhl_odds (
  id          SERIAL        PRIMARY KEY,
  game_id     VARCHAR(20)   REFERENCES nhl_games(id) ON DELETE CASCADE,
  bookmaker   VARCHAR(50),
  market      VARCHAR(30),
  selection   VARCHAR(50),
  odds        NUMERIC(8,2),
  created_at  TIMESTAMPTZ   DEFAULT NOW()
);

-- ============================================================
--  USER PROFILE & BETTING TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id           UUID         PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name      VARCHAR(100),
  avatar            VARCHAR(20),
  avatar_url        TEXT,
  favorite_team     VARCHAR(5),
  bio               TEXT,
  is_public         BOOLEAN      DEFAULT TRUE,
  tier              user_tier    DEFAULT 'rookie',
  performance_score INT          DEFAULT 0,
  xp                INT          NOT NULL DEFAULT 0,
  notify_value_bets BOOLEAN      NOT NULL DEFAULT FALSE,
  joined_at         DATE         DEFAULT CURRENT_DATE
);

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id                UUID          PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan                   billing_plan  NOT NULL DEFAULT 'free',
  status                 sub_status    NOT NULL DEFAULT 'active',
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  current_period_end     TIMESTAMPTZ,
  cancel_at_period_end   BOOLEAN       NOT NULL DEFAULT FALSE,
  trial_used             BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer
  ON subscriptions (stripe_customer_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT        NOT NULL UNIQUE,
  p256dh      TEXT        NOT NULL,
  auth        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions (user_id);

CREATE TABLE IF NOT EXISTS user_badges (
  id          SERIAL      PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_id    VARCHAR(50) NOT NULL,
  label       VARCHAR(100),
  description TEXT,
  icon        VARCHAR(20),
  earned_at   DATE,
  tier        VARCHAR(20),
  UNIQUE(user_id, badge_id)
);

CREATE TABLE IF NOT EXISTS user_bets (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  placed_at       TIMESTAMPTZ  DEFAULT NOW(),
  market_type     VARCHAR(50),
  market_label    VARCHAR(100),
  selection       TEXT,
  selection_short VARCHAR(50),
  subject_name    VARCHAR(100),
  subject_logo    VARCHAR(20),
  probability     INT,
  is_parlay       BOOLEAN      DEFAULT FALSE,
  parlay_legs     INT,
  outcome         bet_outcome  DEFAULT 'pending',
  game_info       VARCHAR(200)
);

-- ============================================================
--  CHAT TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS chat_rooms (
  id            VARCHAR(50)  PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  icon          VARCHAR(20),
  description   TEXT,
  is_live       BOOLEAN      DEFAULT FALSE,
  is_pinned     BOOLEAN      DEFAULT FALSE,
  member_count  INT          DEFAULT 0,
  created_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id                VARCHAR(50)  PRIMARY KEY,
  room_id           VARCHAR(50)  NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  user_id           UUID         REFERENCES users(id) ON DELETE SET NULL,
  username          VARCHAR(100),
  display_name      VARCHAR(100),
  avatar            VARCHAR(20),
  tier              VARCHAR(20),
  text              TEXT         NOT NULL,
  sent_at           TIMESTAMPTZ  DEFAULT NOW(),
  tag               VARCHAR(20),
  reply_to_username VARCHAR(100),
  reply_to_text     TEXT
);

CREATE TABLE IF NOT EXISTS chat_reactions (
  id          SERIAL      PRIMARY KEY,
  message_id  VARCHAR(50) NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  emoji       VARCHAR(20) NOT NULL,
  count       INT         DEFAULT 1,
  UNIQUE(message_id, emoji)
);

-- ============================================================
--  INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_users_email             ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username          ON users(username);
CREATE INDEX IF NOT EXISTS idx_refresh_user_id         ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_nhl_games_date          ON nhl_games(game_date);
CREATE INDEX IF NOT EXISTS idx_nhl_games_status        ON nhl_games(status);
CREATE INDEX IF NOT EXISTS idx_nhl_player_stats_player ON nhl_player_stats(player_id);
CREATE INDEX IF NOT EXISTS idx_nhl_team_stats_team     ON nhl_team_stats(team_id);
CREATE INDEX IF NOT EXISTS idx_user_bets_user          ON user_bets(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_room      ON chat_messages(room_id);
CREATE INDEX IF NOT EXISTS idx_chat_reactions_msg      ON chat_reactions(message_id);

-- ============================================================
--  TRIGGER: updated_at on users
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
