# 🏈 Universal Dynasty League Bot
A Discord bot for managing college football dynasty leagues. Built for multi-server support with database-driven configuration — one bot instance can run multiple leagues independently.

---

## 📁 Project Structure

```
dynasty-bot-universal/
├── index.js                 # Main bot file — all commands and logic
├── package.json             # Dependencies
├── database_migration.sql   # Run once in Supabase to create all tables
├── .env.example             # Copy to .env and fill in your credentials
├── .gitignore               # Keeps .env and node_modules out of Git
└── README.md                # This file
```

---

## ✅ Prerequisites

- [Node.js 18+](https://nodejs.org/)
- [Discord Developer Account](https://discord.com/developers/applications) — to create your bot
- [Supabase Account](https://supabase.com) — free tier is fine
- [Render Account](https://render.com) — free tier is fine for hosting

---

## 🚀 Setup Guide

### Step 1 — Create Your Discord Bot
1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** → give it a name
3. Go to **Bot** → click **Add Bot**
4. Under **Privileged Gateway Intents** enable:
   - ✅ Server Members Intent
   - ✅ Message Content Intent
5. Copy your **Bot Token** — you'll need it for `.env`
6. Go to **General Information** and copy your **Application ID** (this is your `CLIENT_ID`)

### Step 2 — Invite the Bot to Your Server
1. Go to **OAuth2 → URL Generator**
2. Select scopes: `bot` + `applications.commands`
3. Select bot permissions:
   - Manage Roles
   - Read Messages / View Channels
   - Send Messages
   - Embed Links
   - Read Message History
4. Copy the generated URL and open it in your browser to invite the bot

### Step 3 — Set Up Supabase
1. Create a new project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor → New Query**
3. Open `database_migration.sql` and paste the entire contents
4. Click **Run** — no values need replacing, the bot handles server setup automatically
5. The verification query at the bottom will show all 7 tables — confirm they exist
7. Go to **Settings → API** and copy your **Project URL** and **anon public key**

### Step 4 — Configure Environment
```bash
cp .env.example .env
```
Open `.env` and fill in:
```env
DISCORD_TOKEN=        # From Step 1
CLIENT_ID=            # From Step 1
SUPABASE_URL=         # From Step 3
SUPABASE_KEY=         # From Step 3
PORT=3000
SELF_PING_URL=        # Leave blank for now, fill in after Render deploy
```

### Step 5 — Install & Run Locally
```bash
npm install
node index.js
```
You should see:
```
[bot] Logged in as YourBot#1234
[commands] Registered 16 commands.
[bot] Ready! Serving 1 guild(s).
```

### Step 6 — Deploy to Render
1. Push your project to a GitHub repository (make sure `.env` is in `.gitignore`)
2. Go to [dashboard.render.com](https://dashboard.render.com) → **New → Web Service**
3. Connect your GitHub repository
4. Configure:
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node index.js`
   - **Plan:** Free
5. Add all your `.env` values under **Environment Variables**
6. Click **Create Web Service** and wait for deploy
7. Copy your Render app URL (e.g. `https://dynasty-bot.onrender.com`) and add it as `SELF_PING_URL` in Render's environment variables — this keeps the free instance from spinning down

### Step 7 — First-Time Discord Setup
Run `/setup` in your Discord server and follow the prompts to configure your league name, features, and settings.

---

## ⚙️ Configuration

All settings are stored per-server in the `config` table. Use `/config edit` to change individual values without redeploying.

| Setting | Default | Description |
|---|---|---|
| `league_name` | Dynasty League | Your league's display name |
| `channel_news_feed` | news-feed | Where game results and announcements post |
| `channel_advance_tracker` | advance-tracker | Where advance notices post |
| `channel_team_lists` | team-lists | Where `/listteams` posts |
| `channel_signed_coaches` | signed-coaches | Where signing announcements post |
| `channel_streaming` | streaming | Where stream links are monitored |
| `role_head_coach` | head coach | Role assigned to coaches |
| `star_rating_for_offers` | 2.5 | Minimum star rating for job offers |
| `job_offers_count` | 3 | Number of offers per user |
| `job_offers_expiry_hours` | 48 | Hours before job offers expire |
| `stream_reminder_minutes` | 45 | Minutes before stream reminder fires |
| `advance_intervals` | [24, 48] | Available advance intervals in hours |
| `embed_color_primary` | 0x1e90ff | Primary embed color |
| `embed_color_win` | 0x00ff00 | Win result color |
| `embed_color_loss` | 0xff0000 | Loss result color |

**Example:**
```
/config edit setting:job_offers_expiry_hours value:24
```

---

## 📋 Commands

### User Commands
| Command | Description |
|---|---|
| `/joboffers` | Get a set of locked coaching job offers. Offers are exclusive — no two users get the same school. Cannot be refreshed until they expire. |
| `/game-result` | Submit your game score. Auto-updates records and posts to the news feed. |
| `/press-release` | Post an announcement to the news feed channel. |
| `/ranking` | View current season standings. |
| `/ranking-all-time` | View all-time win/loss leaderboard with win percentage. |

### Admin Commands
| Command | Description |
|---|---|
| `/setup` | Interactive first-time configuration wizard. |
| `/config view` | View all current settings for this server. |
| `/config features` | Toggle features on/off via dropdown menu. |
| `/config edit` | Change a single config value by name. |
| `/config reload` | Refresh config from database without redeploying. |
| `/assign-team` | Assign a user to a team and give them the Head Coach role. |
| `/resetteam` | Remove a user from their team and strip the role. |
| `/listteams` | Post a taken/available team list to the team-lists channel. |
| `/advance` | Announce the next week deadline with ET/CT/MT/PT times. |
| `/season-advance` | Roll over to a new season. |
| `/move-coach` | Transfer a coach from one team to another. |
| `/any-game-result` | Manually enter a result for any two teams. |

### Automatic
| Feature | Description |
|---|---|
| Stream reminders | Detects YouTube/Twitch links posted in the streaming channel and pings the user after the configured delay. |
| Job offer expiry | Every 30 minutes, checks for expired offers, notifies users via DM, and releases teams back into the pool. |

---

## 🗄️ Database Tables

| Table | Purpose |
|---|---|
| `config` | One row per server — all bot settings |
| `teams` | All teams per server, with coach assignment |
| `results` | Every game result submitted |
| `records` | Win/loss record per team per season |
| `meta` | Current season and week per server |
| `news_feed` | Press release history |
| `job_offers` | Active locked job offers with expiry |

Every table is scoped by `guild_id` so multiple servers share the same database with zero interference.

---

## 🔧 Adding a Second Server

1. Invite the bot to the new server using the same invite URL from setup
2. The bot automatically creates a default config and meta row the moment it joins
3. The server owner gets a welcome DM with next steps
4. Run `/setup` in the new server to customize the league settings

No manual SQL required.

---

## 🔄 Migrating Data from a Previous Bot

If you have existing season data to bring over:
1. Export your old tables from Supabase as CSV (Table Editor → CSV button)
2. Add a `guild_id` column to the CSV matching your server ID
3. Make sure `team_id` values in `records` and `results` match the IDs in your new `teams` table
4. Import via Supabase Table Editor → Insert → Import CSV

---

## 🆘 Troubleshooting

**Bot shows offline**
- Check Render logs for startup errors
- Verify all environment variables are set in Render

**"No config found for guild"**
- Confirm your `guild_id` in the `config` table matches your Discord server ID exactly
- Run `/config reload` to force a refresh

**Commands not appearing in Discord**
- Make sure the bot was invited with the `applications.commands` scope
- Wait up to 1 hour for global commands to propagate, or check Render logs for registration errors

**Feature not working**
- Run `/config view` to confirm the feature is enabled
- Verify the channel name in config matches the actual Discord channel name

**Job offers not generating**
- Check that teams exist in the `teams` table with `guild_id` set and `user_id` as NULL
- Verify teams have a `star_rating` at or above `star_rating_for_offers` in config

---

## 📦 Dependencies

```json
"discord.js": "^14.14.1"
"@supabase/supabase-js": "^2.39.0"
"dotenv": "^16.3.1"
```

---

## 🗺️ Roadmap

- [ ] Auto-posting streams via platform RSS or API
- [ ] Web dashboard for configuration
- [ ] Playoff bracket generator
- [ ] Season recap generator
- [ ] Player/recruit tracking
- [ ] Automated database backups

---

**Version:** 2.0.0 (Universal)
