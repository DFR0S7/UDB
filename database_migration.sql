-- =====================================================
-- Universal Dynasty Bot — Full Database Migration
-- =====================================================
-- Run this entire file in your Supabase SQL Editor.
-- Replace YOUR_DISCORD_SERVER_ID before running.
--
-- Tables created:
--   config      — Per-server bot settings
--   teams       — All teams per server
--   results     — Game results per server
--   records     — Win/loss records per team per season
--   meta        — Season/week tracking per server
--   news_feed   — Press releases per server
--   job_offers  — Active locked job offers per user
-- =====================================================


-- =====================================================
-- 1. CONFIG
-- =====================================================
CREATE TABLE IF NOT EXISTS config (
  id                        SERIAL PRIMARY KEY,
  guild_id                  TEXT UNIQUE NOT NULL,
  league_name               TEXT    DEFAULT 'Dynasty League',

  -- Feature Toggles
  feature_job_offers        BOOLEAN DEFAULT TRUE,
  feature_stream_reminders  BOOLEAN DEFAULT TRUE,
  feature_advance_system    BOOLEAN DEFAULT TRUE,
  feature_press_releases    BOOLEAN DEFAULT TRUE,
  feature_rankings          BOOLEAN DEFAULT TRUE,

  -- Channel Names
  channel_news_feed         TEXT    DEFAULT 'news-feed',
  channel_advance_tracker   TEXT    DEFAULT 'advance-tracker',
  channel_team_lists        TEXT    DEFAULT 'team-lists',
  channel_signed_coaches    TEXT    DEFAULT 'signed-coaches',
  channel_streaming         TEXT    DEFAULT 'streaming',

  -- Role Names
  role_head_coach           TEXT    DEFAULT 'head coach',
  role_head_coach_id        TEXT,

  -- Job Offer Settings
  star_rating_for_offers    DECIMAL DEFAULT 2.5,
  job_offers_count          INTEGER DEFAULT 3,
  job_offers_expiry_hours   INTEGER DEFAULT 48,

  -- Stream Settings
  stream_reminder_minutes   INTEGER DEFAULT 45,

  -- Advance Settings
  advance_intervals         TEXT    DEFAULT '[24, 48]',

  -- Branding
  embed_color_primary       TEXT    DEFAULT '0x1e90ff',
  embed_color_win           TEXT    DEFAULT '0x00ff00',
  embed_color_loss          TEXT    DEFAULT '0xff0000',

  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_config_guild_id ON config(guild_id);
ALTER TABLE config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "config_all" ON config FOR ALL USING (true) WITH CHECK (true);


-- =====================================================
-- 2. TEAMS
-- =====================================================
CREATE TABLE IF NOT EXISTS teams (
  id          SERIAL PRIMARY KEY,
  guild_id    TEXT    NOT NULL,
  team_name   TEXT    NOT NULL,
  conference  TEXT,
  star_rating DECIMAL,
  user_id     TEXT,           -- Discord user ID of assigned coach (NULL = available)
  created_at  TIMESTAMP DEFAULT NOW(),

  UNIQUE (guild_id, team_name)
);

CREATE INDEX IF NOT EXISTS idx_teams_guild      ON teams(guild_id);
CREATE INDEX IF NOT EXISTS idx_teams_guild_user ON teams(guild_id, user_id);
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY "teams_all" ON teams FOR ALL USING (true) WITH CHECK (true);


-- =====================================================
-- 3. RESULTS
-- =====================================================
CREATE TABLE IF NOT EXISTS results (
  id           SERIAL PRIMARY KEY,
  guild_id     TEXT    NOT NULL,
  season       INTEGER NOT NULL,
  week         INTEGER NOT NULL,
  team1_id     INTEGER REFERENCES teams(id),
  team2_id     INTEGER REFERENCES teams(id),
  score1       INTEGER NOT NULL,
  score2       INTEGER NOT NULL,
  submitted_by TEXT,           -- Discord user ID
  created_at   TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_results_guild        ON results(guild_id);
CREATE INDEX IF NOT EXISTS idx_results_guild_season ON results(guild_id, season);
ALTER TABLE results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "results_all" ON results FOR ALL USING (true) WITH CHECK (true);


-- =====================================================
-- 4. RECORDS
-- =====================================================
CREATE TABLE IF NOT EXISTS records (
  id         SERIAL PRIMARY KEY,
  guild_id   TEXT    NOT NULL,
  team_id    INTEGER REFERENCES teams(id),
  season     INTEGER NOT NULL,
  wins       INTEGER DEFAULT 0,
  losses     INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE (guild_id, team_id, season)
);

CREATE INDEX IF NOT EXISTS idx_records_guild        ON records(guild_id);
CREATE INDEX IF NOT EXISTS idx_records_guild_season ON records(guild_id, season);
ALTER TABLE records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "records_all" ON records FOR ALL USING (true) WITH CHECK (true);


-- =====================================================
-- 5. META
-- =====================================================
CREATE TABLE IF NOT EXISTS meta (
  id               SERIAL PRIMARY KEY,
  guild_id         TEXT    UNIQUE NOT NULL,
  season           INTEGER DEFAULT 1,
  week             INTEGER DEFAULT 1,
  advance_hours    INTEGER DEFAULT 24,
  advance_deadline TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meta_guild ON meta(guild_id);
ALTER TABLE meta ENABLE ROW LEVEL SECURITY;
CREATE POLICY "meta_all" ON meta FOR ALL USING (true) WITH CHECK (true);


-- =====================================================
-- 6. NEWS FEED
-- =====================================================
CREATE TABLE IF NOT EXISTS news_feed (
  id         SERIAL PRIMARY KEY,
  guild_id   TEXT NOT NULL,
  author_id  TEXT NOT NULL,
  team_name  TEXT,
  message    TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_news_feed_guild ON news_feed(guild_id);
ALTER TABLE news_feed ENABLE ROW LEVEL SECURITY;
CREATE POLICY "news_feed_all" ON news_feed FOR ALL USING (true) WITH CHECK (true);


-- =====================================================
-- 7. JOB OFFERS
-- =====================================================
CREATE TABLE IF NOT EXISTS job_offers (
  id         SERIAL PRIMARY KEY,
  guild_id   TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  team_id    INTEGER REFERENCES teams(id),
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),

  UNIQUE (guild_id, team_id)    -- Prevents same team offered to two users at once
);

CREATE INDEX IF NOT EXISTS idx_job_offers_guild_user ON job_offers(guild_id, user_id);
CREATE INDEX IF NOT EXISTS idx_job_offers_expires    ON job_offers(expires_at);
ALTER TABLE job_offers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "job_offers_all" ON job_offers FOR ALL USING (true) WITH CHECK (true);


-- =====================================================
-- 8. SERVER CONFIG
-- =====================================================
-- No manual insert needed!
-- When the bot is invited to a server it automatically
-- creates a default config and meta row for that guild.
-- Just run /setup in your Discord server after inviting the bot.
--
-- To add additional servers later, simply invite the bot
-- to the new server and it will handle the rest.


-- =====================================================
-- 9. VERIFICATION — should show all 7 tables with row counts
-- =====================================================
SELECT 'config'     AS table_name, COUNT(*) AS rows FROM config
UNION ALL
SELECT 'teams',     COUNT(*) FROM teams
UNION ALL
SELECT 'results',   COUNT(*) FROM results
UNION ALL
SELECT 'records',   COUNT(*) FROM records
UNION ALL
SELECT 'meta',      COUNT(*) FROM meta
UNION ALL
SELECT 'news_feed', COUNT(*) FROM news_feed
UNION ALL
SELECT 'job_offers',COUNT(*) FROM job_offers;
