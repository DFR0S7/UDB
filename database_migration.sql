-- =====================================================
-- Dynasty Bot — Full Database Migration
-- =====================================================
-- Safe to run on a fresh DB or an existing one.
-- All statements are idempotent (IF NOT EXISTS / DO blocks).
--
-- Tables:
--   config           — Per-server bot settings & feature flags
--   meta             — Season/phase/week tracking per server
--   teams            — Teams per server (per-guild, not global)
--   team_assignments — Which coach has which team per server
--   job_offers       — Active pending job offers per user
--   results          — Game results per server
--   records          — Win/loss records per team per season
--   coach_streams    — Registered stream handles per coach
--
-- Removed from old schema:
--   news_feed        — Press releases feature removed entirely
-- =====================================================


-- =====================================================
-- 1. CONFIG
-- Per-server bot settings. One row per guild.
-- Bot auto-creates a row with defaults on join.
-- Admin runs /setup to configure properly.
-- =====================================================
CREATE TABLE IF NOT EXISTS config (
  id                            SERIAL PRIMARY KEY,
  guild_id                      TEXT UNIQUE NOT NULL,

  -- League identity
  league_name                   TEXT    DEFAULT 'Dynasty League',
  league_abbreviation           TEXT    DEFAULT '',
  league_type                   TEXT    DEFAULT 'new',        -- 'new' | 'established'

  -- Setup state
  setup_complete                BOOLEAN DEFAULT FALSE,

  -- Channel names (bot looks up by name, not ID)
  channel_news_feed             TEXT    DEFAULT 'news-feed',
  channel_advance_tracker       TEXT    DEFAULT 'advance-tracker',
  channel_team_lists            TEXT    DEFAULT 'team-lists',
  channel_signed_coaches        TEXT    DEFAULT 'signed-coaches',
  channel_streaming             TEXT    DEFAULT 'streaming',

  -- Role names
  role_head_coach               TEXT    DEFAULT 'head coach',
  role_head_coach_id            TEXT,

  -- Feature flags — all OFF by default, enabled during /setup
  feature_game_result           BOOLEAN DEFAULT FALSE,
  feature_any_game_result       BOOLEAN DEFAULT FALSE,
  feature_ranking               BOOLEAN DEFAULT FALSE,
  feature_ranking_all_time      BOOLEAN DEFAULT FALSE,
  feature_game_results_reminder BOOLEAN DEFAULT FALSE,
  feature_job_offers            BOOLEAN DEFAULT FALSE,
  feature_assign_team           BOOLEAN DEFAULT FALSE,
  feature_reset_team            BOOLEAN DEFAULT FALSE,
  feature_list_teams            BOOLEAN DEFAULT FALSE,
  feature_move_coach            BOOLEAN DEFAULT FALSE,
  feature_advance               BOOLEAN DEFAULT FALSE,
  feature_season_advance        BOOLEAN DEFAULT FALSE,   -- retained for DB compatibility
  feature_stream_autopost       BOOLEAN DEFAULT FALSE,
  feature_streaming_list        BOOLEAN DEFAULT FALSE,

  -- Job offer settings
  star_rating_for_offers        NUMERIC DEFAULT 2.5,
  star_rating_max_for_offers    NUMERIC,                 -- NULL = no cap
  job_offers_count              INTEGER DEFAULT 3,
  job_offers_expiry_hours       INTEGER DEFAULT 48,

  -- Advance settings
  advance_intervals             TEXT    DEFAULT '[24, 48]',  -- JSON array of hours

  -- Stream reminder
  stream_reminder_minutes       INTEGER DEFAULT 45,

  -- Embed colors (hex strings e.g. '0x1e90ff')
  embed_color_primary           TEXT    DEFAULT '0x1e90ff',
  embed_color_win               TEXT    DEFAULT '0x00ff00',
  embed_color_loss              TEXT    DEFAULT '0xff0000',

  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_config_guild_id ON config(guild_id);
ALTER TABLE config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "config_all" ON config;
CREATE POLICY "config_all" ON config FOR ALL USING (true) WITH CHECK (true);

-- Migrate existing config table columns
DO $$
BEGIN
  -- Rename old flags → new names
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='config' AND column_name='feature_stream_reminders') THEN
    ALTER TABLE config RENAME COLUMN feature_stream_reminders TO feature_game_results_reminder;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='config' AND column_name='feature_advance_system') THEN
    ALTER TABLE config RENAME COLUMN feature_advance_system TO feature_advance;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='config' AND column_name='feature_rankings') THEN
    ALTER TABLE config RENAME COLUMN feature_rankings TO feature_ranking;
  END IF;

  -- Split feature_streaming → two separate flags
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='config' AND column_name='feature_streaming') THEN
    UPDATE config SET
      feature_stream_autopost = feature_streaming,
      feature_streaming_list  = feature_streaming;
    ALTER TABLE config DROP COLUMN feature_streaming;
  END IF;

  -- Drop removed columns
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='config' AND column_name='feature_press_releases') THEN
    ALTER TABLE config DROP COLUMN feature_press_releases;
  END IF;
END $$;

-- Add any columns that may be missing on existing installs
ALTER TABLE config ADD COLUMN IF NOT EXISTS league_type                   TEXT    DEFAULT 'new';
ALTER TABLE config ADD COLUMN IF NOT EXISTS setup_complete                BOOLEAN DEFAULT FALSE;
ALTER TABLE config ADD COLUMN IF NOT EXISTS feature_game_result           BOOLEAN DEFAULT FALSE;
ALTER TABLE config ADD COLUMN IF NOT EXISTS feature_any_game_result       BOOLEAN DEFAULT FALSE;
ALTER TABLE config ADD COLUMN IF NOT EXISTS feature_ranking               BOOLEAN DEFAULT FALSE;
ALTER TABLE config ADD COLUMN IF NOT EXISTS feature_ranking_all_time      BOOLEAN DEFAULT FALSE;
ALTER TABLE config ADD COLUMN IF NOT EXISTS feature_game_results_reminder BOOLEAN DEFAULT FALSE;
ALTER TABLE config ADD COLUMN IF NOT EXISTS feature_assign_team           BOOLEAN DEFAULT FALSE;
ALTER TABLE config ADD COLUMN IF NOT EXISTS feature_reset_team            BOOLEAN DEFAULT FALSE;
ALTER TABLE config ADD COLUMN IF NOT EXISTS feature_list_teams            BOOLEAN DEFAULT FALSE;
ALTER TABLE config ADD COLUMN IF NOT EXISTS feature_move_coach            BOOLEAN DEFAULT FALSE;
ALTER TABLE config ADD COLUMN IF NOT EXISTS feature_advance               BOOLEAN DEFAULT FALSE;
ALTER TABLE config ADD COLUMN IF NOT EXISTS feature_season_advance        BOOLEAN DEFAULT FALSE;
ALTER TABLE config ADD COLUMN IF NOT EXISTS feature_stream_autopost       BOOLEAN DEFAULT FALSE;
ALTER TABLE config ADD COLUMN IF NOT EXISTS feature_streaming_list        BOOLEAN DEFAULT FALSE;
ALTER TABLE config ADD COLUMN IF NOT EXISTS star_rating_max_for_offers    NUMERIC;
ALTER TABLE config ADD COLUMN IF NOT EXISTS role_head_coach_id            TEXT;
ALTER TABLE config ADD COLUMN IF NOT EXISTS stream_reminder_minutes       INTEGER DEFAULT 45;
ALTER TABLE config ADD COLUMN IF NOT EXISTS advance_intervals             TEXT    DEFAULT '[24, 48]';
ALTER TABLE config ADD COLUMN IF NOT EXISTS embed_color_primary           TEXT    DEFAULT '0x1e90ff';
ALTER TABLE config ADD COLUMN IF NOT EXISTS embed_color_win               TEXT    DEFAULT '0x00ff00';
ALTER TABLE config ADD COLUMN IF NOT EXISTS embed_color_loss              TEXT    DEFAULT '0xff0000';


-- =====================================================
-- 2. META
-- Season/phase/week state per server. One row per guild.
-- =====================================================
CREATE TABLE IF NOT EXISTS meta (
  id                    SERIAL PRIMARY KEY,
  guild_id              TEXT UNIQUE NOT NULL,
  season                INTEGER     DEFAULT 1,
  week                  INTEGER     DEFAULT 1,
  current_phase         TEXT        DEFAULT 'preseason',
  current_sub_phase     INTEGER     DEFAULT 0,
  advance_hours         INTEGER,
  advance_deadline      TIMESTAMPTZ,
  next_advance_deadline TIMESTAMPTZ,
  last_advance_at       TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meta_guild ON meta(guild_id);
ALTER TABLE meta ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "meta_all" ON meta;
CREATE POLICY "meta_all" ON meta FOR ALL USING (true) WITH CHECK (true);

-- Add any missing meta columns on existing installs
ALTER TABLE meta ADD COLUMN IF NOT EXISTS current_phase         TEXT        DEFAULT 'preseason';
ALTER TABLE meta ADD COLUMN IF NOT EXISTS current_sub_phase     INTEGER     DEFAULT 0;
ALTER TABLE meta ADD COLUMN IF NOT EXISTS last_advance_at       TIMESTAMPTZ;
ALTER TABLE meta ADD COLUMN IF NOT EXISTS next_advance_deadline TIMESTAMPTZ;


-- =====================================================
-- 3. TEAMS
-- Per-server team roster. NOT global — each server
-- manages its own teams table independently.
-- Populate via Supabase dashboard or import script.
-- =====================================================
CREATE TABLE IF NOT EXISTS teams (
  id          SERIAL PRIMARY KEY,
  guild_id    TEXT    NOT NULL,
  team_name   TEXT    NOT NULL,
  conference  TEXT,
  star_rating NUMERIC,
  user_id     TEXT,             -- Discord user ID of assigned coach (NULL = available)
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (guild_id, team_name)
);

CREATE INDEX IF NOT EXISTS idx_teams_guild      ON teams(guild_id);
CREATE INDEX IF NOT EXISTS idx_teams_guild_name ON teams(guild_id, team_name);
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "teams_all" ON teams;
CREATE POLICY "teams_all" ON teams FOR ALL USING (true) WITH CHECK (true);

-- Migrate: old schema had teams as global (no guild_id).
-- If guild_id column is missing, add it.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS guild_id TEXT;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS user_id  TEXT;


-- =====================================================
-- 4. TEAM ASSIGNMENTS
-- Which coach is assigned to which team per server.
-- =====================================================
CREATE TABLE IF NOT EXISTS team_assignments (
  id         SERIAL PRIMARY KEY,
  guild_id   TEXT    NOT NULL,
  team_id    INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    TEXT    NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (team_id, guild_id)
);

CREATE INDEX IF NOT EXISTS idx_assignments_guild      ON team_assignments(guild_id);
CREATE INDEX IF NOT EXISTS idx_assignments_guild_user ON team_assignments(guild_id, user_id);
ALTER TABLE team_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "assignments_all" ON team_assignments;
CREATE POLICY "assignments_all" ON team_assignments FOR ALL USING (true) WITH CHECK (true);


-- =====================================================
-- 5. JOB OFFERS
-- Pending job offers locked for a specific user.
-- =====================================================
CREATE TABLE IF NOT EXISTS job_offers (
  id         SERIAL PRIMARY KEY,
  guild_id   TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  team_id    INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_offers_guild_user ON job_offers(guild_id, user_id);
CREATE INDEX IF NOT EXISTS idx_job_offers_expires    ON job_offers(expires_at);
ALTER TABLE job_offers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "job_offers_all" ON job_offers;
CREATE POLICY "job_offers_all" ON job_offers FOR ALL USING (true) WITH CHECK (true);

-- Migrate: old schema had UNIQUE(guild_id, team_id) which prevented
-- the same team from appearing in multiple users' offer sets.
-- Remove that constraint if it exists — job offer logic handles locking separately.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'job_offers'
      AND constraint_type = 'UNIQUE'
      AND constraint_name LIKE '%team_id%'
  ) THEN
    ALTER TABLE job_offers DROP CONSTRAINT IF EXISTS job_offers_guild_id_team_id_key;
  END IF;
END $$;


-- =====================================================
-- 6. RESULTS
-- Game results submitted by coaches.
-- =====================================================
CREATE TABLE IF NOT EXISTS results (
  id           SERIAL PRIMARY KEY,
  guild_id     TEXT    NOT NULL,
  season       INTEGER NOT NULL,
  week         INTEGER NOT NULL,
  team1_id     INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  team2_id     INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  score1       INTEGER NOT NULL,
  score2       INTEGER NOT NULL,
  submitted_by TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_results_guild        ON results(guild_id);
CREATE INDEX IF NOT EXISTS idx_results_guild_season ON results(guild_id, season);
ALTER TABLE results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "results_all" ON results;
CREATE POLICY "results_all" ON results FOR ALL USING (true) WITH CHECK (true);


-- =====================================================
-- 7. RECORDS
-- Cumulative win/loss/tie record per team per season.
-- =====================================================
CREATE TABLE IF NOT EXISTS records (
  id         SERIAL PRIMARY KEY,
  guild_id   TEXT    NOT NULL,
  team_id    INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  season     INTEGER NOT NULL,
  wins       INTEGER NOT NULL DEFAULT 0,
  losses     INTEGER NOT NULL DEFAULT 0,
  ties       INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (team_id, season, guild_id)
);

CREATE INDEX IF NOT EXISTS idx_records_guild        ON records(guild_id);
CREATE INDEX IF NOT EXISTS idx_records_guild_season ON records(guild_id, season);
ALTER TABLE records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "records_all" ON records;
CREATE POLICY "records_all" ON records FOR ALL USING (true) WITH CHECK (true);

-- Migrate: old schema had no ties column
ALTER TABLE records ADD COLUMN IF NOT EXISTS ties INTEGER NOT NULL DEFAULT 0;


-- =====================================================
-- 8. COACH STREAMS
-- Registered Twitch/YouTube handles per coach.
-- Note: stream_url column stores the handle only,
-- not a full URL (e.g. 'johndoe', not 'twitch.tv/johndoe').
-- Used by the bot to match Wamellow autopost stream links
-- back to the correct Discord user for game result reminders.
-- =====================================================
CREATE TABLE IF NOT EXISTS coach_streams (
  id         SERIAL PRIMARY KEY,
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  stream_url TEXT NOT NULL,   -- handle only, e.g. 'johndoe'
  platform   TEXT NOT NULL DEFAULT 'twitch',  -- 'twitch' | 'youtube'
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (guild_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_streams_guild ON coach_streams(guild_id);
ALTER TABLE coach_streams ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "streams_all" ON coach_streams;
CREATE POLICY "streams_all" ON coach_streams FOR ALL USING (true) WITH CHECK (true);


-- =====================================================
-- 9. REMOVED TABLES
-- news_feed — Press releases feature has been removed.
-- Drop it if it exists from old installs.
-- =====================================================
DROP TABLE IF EXISTS news_feed CASCADE;


-- =====================================================
-- 10. VERIFY
-- =====================================================
SELECT
  table_name,
  COUNT(*) AS column_count
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'config', 'meta', 'teams', 'team_assignments',
    'job_offers', 'results', 'records', 'coach_streams'
  )
GROUP BY table_name
ORDER BY table_name;
