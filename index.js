// =====================================================
// Universal Dynasty League Bot - index.js
// Version: 2.1.0 (Universal Multi-Server)
// =====================================================

require('dotenv').config();
const http  = require('http');
const https = require('https');

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
  ChannelType,
  Events,
} = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// =====================================================
// ENVIRONMENT & CLIENTS
// =====================================================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;
const CLIENT_ID     = process.env.CLIENT_ID;
const PORT          = process.env.PORT || 3000;
const SELF_PING_URL = process.env.SELF_PING_URL || '';

if (!DISCORD_TOKEN || !SUPABASE_URL || !SUPABASE_KEY || !CLIENT_ID) {
  console.error('[boot] Missing required environment variables. Check DISCORD_TOKEN, SUPABASE_URL, SUPABASE_KEY, CLIENT_ID.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// =====================================================
// =====================================================
// PHASE CYCLE
// =====================================================
const PHASE_CYCLE = [
  { key: 'preseason',           name: 'Preseason',               subWeeks: 1,  format: ()    => 'Preseason' },
  { key: 'regular',             name: 'Regular Season',          subWeeks: 16, format: (sub) => `Week ${sub + 1}` },
  { key: 'conf_champ',          name: 'Conference Championship', subWeeks: 1,  format: ()    => 'Conference Championship' },
  { key: 'bowl',                name: 'Bowl Season',             subWeeks: 4,  format: (sub) => `Bowl Week ${sub + 1}` },
  { key: 'players_leaving',     name: 'Players Leaving',         subWeeks: 1,  format: ()    => 'Players Leaving' },
  { key: 'transfer_portal',     name: 'Transfer Portal',         subWeeks: 4,  format: (sub) => `Transfer Week ${sub + 1}` },
  { key: 'position_changes',    name: 'Position Changes',        subWeeks: 1,  format: ()    => 'Position Changes' },
  { key: 'training_results',    name: 'Training Results',        subWeeks: 1,  format: ()    => 'Training Results' },
  { key: 'encourage_transfers', name: 'Encourage Transfers',     subWeeks: 1,  format: ()    => 'Encourage Transfers' },
];

const getPhaseByKey = (key) => PHASE_CYCLE.find(p => p.key === key) || PHASE_CYCLE[0];

// Returns a human-readable label for the current phase + sub-week
function formatPhase(phaseKey, subPhase) {
  const phase = getPhaseByKey(phaseKey);
  return phase.format ? phase.format(subPhase) : phase.name;
}

const streamReminderTimers = new Map();

// =====================================================
// HEALTH SERVER (always on for Render)
// =====================================================
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Dynasty Bot OK');
}).listen(PORT, () => {
  console.log(`[server] HTTP server listening on port ${PORT}`);
});

// =====================================================
// SELF-PING (keep Render free tier alive)
// =====================================================
if (SELF_PING_URL) {
  setInterval(() => {
    const mod = SELF_PING_URL.startsWith('https') ? https : http;
    mod.get(SELF_PING_URL, () => {}).on('error', () => {});
  }, 14 * 60 * 1000);
  console.log(`[server] Self-ping enabled → ${SELF_PING_URL}`);
}

// =====================================================
// GLOBAL ERROR HANDLERS — keep process alive on errors
// =====================================================
process.on('unhandledRejection', (reason) => {
  console.error('[process] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[process] Uncaught Exception:', err);
});

client.on('error', (err) => {
  console.error('[discord] Client error:', err);
});

client.on('shardDisconnect', (event, shardId) => {
  console.warn(`[discord] Shard ${shardId} disconnected. Code: ${event.code}`);
});

client.on('shardReconnecting', (shardId) => {
  console.log(`[discord] Shard ${shardId} reconnecting...`);
});

client.on('shardResume', (shardId, replayed) => {
  console.log(`[discord] Shard ${shardId} resumed. Replayed ${replayed} events.`);
});

// =====================================================
// CONFIG CACHE (per guild)
// =====================================================
const guildConfigs = new Map();

// Single source of truth for default config values
const CONFIG_DEFAULTS = {
  league_name:               'Dynasty League',
  league_abbreviation:       '',
  feature_job_offers:        true,
  feature_stream_reminders:  true,
  feature_advance_system:    true,
  feature_press_releases:    true,
  feature_rankings:          true,
  channel_news_feed:         'news-feed',
  channel_advance_tracker:   'advance-tracker',
  channel_team_lists:        'team-lists',
  channel_signed_coaches:    'signed-coaches',
  channel_streaming:         'streaming',
  role_head_coach:           'head coach',
  role_head_coach_id:        null,
  star_rating_for_offers:    2.5,
  star_rating_max_for_offers: null,
  job_offers_count:          3,
  job_offers_expiry_hours:   48,
  stream_reminder_minutes:   45,
  advance_intervals:         '[24, 48]',
  embed_color_primary:       '0x1e90ff',
  embed_color_win:           '0x00ff00',
  embed_color_loss:          '0xff0000',
};

function parseConfig(data) {
  let intervals = [24, 48];
  try {
    const raw = (data.advance_intervals || '').trim();
    // Support both "[12, 24, 48]" (JSON) and "12,24,48" (plain CSV)
    const normalized = raw.startsWith('[') ? raw : `[${raw}]`;
    const parsed = JSON.parse(normalized);
    if (Array.isArray(parsed) && parsed.length > 0) {
      intervals = parsed.map(Number).filter(n => !isNaN(n));
    }
  } catch (_) {
    console.warn(`[config] Could not parse advance_intervals: "${data.advance_intervals}" — using default [24, 48]`);
  }
  console.log(`[config] advance_intervals for guild ${data.guild_id}: "${data.advance_intervals}" → parsed as [${intervals}]`);
  return {
    ...data,
    advance_intervals_parsed: intervals,
    embed_color_primary_int:  parseInt(data.embed_color_primary, 16) || 0x1e90ff,
    embed_color_win_int:      parseInt(data.embed_color_win, 16)     || 0x00ff00,
    embed_color_loss_int:     parseInt(data.embed_color_loss, 16)    || 0xff0000,
  };
}

async function loadGuildConfig(guildId) {
  const { data, error } = await supabase
    .from('config')
    .select('*')
    .eq('guild_id', guildId)
    .single();

  if (error || !data) {
    console.log(`[config] No config for guild ${guildId}, using defaults.`);
    const defaults = parseConfig({ ...CONFIG_DEFAULTS, guild_id: guildId,
      advance_intervals_parsed: [24, 48],
      embed_color_primary_int: 0x1e90ff,
      embed_color_win_int: 0x00ff00,
      embed_color_loss_int: 0xff0000,
    });
    guildConfigs.set(guildId, defaults);
    return defaults;
  }

  const parsed = parseConfig(data);
  guildConfigs.set(guildId, parsed);
  console.log(`[config] Loaded config for guild ${guildId}: ${data.league_name}`);
  return parsed;
}

async function getConfig(guildId) {
  return guildConfigs.get(guildId) || loadGuildConfig(guildId);
}

async function saveConfig(guildId, updates) {
  updates.updated_at = new Date().toISOString();
  const { error } = await supabase
    .from('config')
    .update(updates)
    .eq('guild_id', guildId);
  if (error) throw error;
  guildConfigs.delete(guildId);
  return loadGuildConfig(guildId);
}

async function createDefaultConfig(guildId, leagueName = 'Dynasty League') {
  const { error } = await supabase.from('config').upsert(
    { ...CONFIG_DEFAULTS, guild_id: guildId, league_name: leagueName },
    { onConflict: 'guild_id' }
  );
  if (error) throw error;
  guildConfigs.delete(guildId);
  return loadGuildConfig(guildId);
}

// =====================================================
// DISCORD HELPERS
// =====================================================
function findTextChannel(guild, name) {
  if (!name) return null;
  return guild.channels.cache.find(
    c => c.type === ChannelType.GuildText && c.name.toLowerCase() === name.toLowerCase()
  ) || null;
}

async function findOrCreateRole(guild, roleName) {
  let role = guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
  if (!role) {
    role = await guild.roles.create({ name: roleName, reason: 'Dynasty Bot auto-created role' });
  }
  return role;
}

function starRating(rating) {
  const full  = Math.floor(rating);
  const half  = (rating % 1) >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return '⭐'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);
}

// Post an embed to a channel, logging a warning if the channel isn't found
async function postToChannel(guild, channelName, payload) {
  const ch = findTextChannel(guild, channelName);
  if (!ch) {
    console.warn(`[post] Channel not found: "${channelName}"`);
    return null;
  }
  await ch.send(payload);
  return ch;
}

// =====================================================
// SUPABASE HELPERS
// =====================================================
async function getTeamByUser(userId, guildId) {
  const { data, error } = await supabase
    .from('team_assignments')
    .select('*, teams(*)')
    .eq('user_id', userId)
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error) {
    console.error(`[db] getTeamByUser(${userId}, ${guildId}) error:`, error.message);
    throw new Error(`Database error looking up your team: ${error.message}`);
  }
  if (!data) return null;
  if (!data.teams) {
    console.warn(`[db] getTeamByUser: assignment found but teams join returned null for user ${userId} — orphaned assignment row?`);
    return null;
  }
  return { ...data.teams, user_id: data.user_id, assignment_id: data.id };
}

async function getTeamByName(teamName, guildId) {
  // Use maybeSingle() so Supabase returns null instead of throwing on 0 rows
  const { data: team, error: teamErr } = await supabase
    .from('teams')
    .select('*')
    .ilike('team_name', teamName.trim())
    .maybeSingle();

  if (teamErr) {
    console.error(`[db] getTeamByName("${teamName}") teams query error:`, teamErr.message);
    throw new Error(`Database error looking up team "${teamName}": ${teamErr.message}`);
  }
  if (!team) return null;

  const { data: assignment, error: assignErr } = await supabase
    .from('team_assignments')
    .select('*')
    .eq('team_id', team.id)
    .eq('guild_id', guildId)
    .maybeSingle();

  if (assignErr) {
    console.error(`[db] getTeamByName("${teamName}") assignments query error:`, assignErr.message);
    // Non-fatal — team exists, just no assignment info
  }

  return { ...team, user_id: assignment?.user_id || null, assignment_id: assignment?.id || null };
}

async function getAllTeams(guildId) {
  const { data: teams, error: teamsErr } = await supabase
    .from('teams')
    .select('*')
    .order('team_name');

  if (teamsErr) {
    console.error(`[db] getAllTeams(${guildId}) teams query error:`, teamsErr.message);
    throw new Error(`Database error loading teams: ${teamsErr.message}`);
  }
  if (!teams || teams.length === 0) return [];

  const { data: assignments, error: assignErr } = await supabase
    .from('team_assignments')
    .select('*')
    .eq('guild_id', guildId);

  if (assignErr) {
    console.error(`[db] getAllTeams(${guildId}) assignments query error:`, assignErr.message);
    // Non-fatal — return teams with no assignment info
  }

  const assignMap = {};
  for (const a of (assignments || [])) assignMap[a.team_id] = a;

  return teams.map(t => ({
    ...t,
    user_id:       assignMap[t.id]?.user_id || null,
    assignment_id: assignMap[t.id]?.id      || null,
  }));
}

async function assignTeam(teamId, userId, guildId) {
  await supabase
    .from('team_assignments')
    .upsert({ team_id: teamId, user_id: userId, guild_id: guildId }, { onConflict: 'team_id,guild_id' });
}

async function unassignTeam(teamId, guildId) {
  await supabase
    .from('team_assignments')
    .delete()
    .eq('team_id', teamId)
    .eq('guild_id', guildId);
}

async function getMeta(guildId) {
  const { data } = await supabase.from('meta').select('*').eq('guild_id', guildId).single();
  return data || {
    season:               1,
    week:                 1,
    current_phase:        'preseason',
    current_sub_phase:    0,
    advance_hours:        24,
    advance_deadline:     null,
    last_advance_at:      null,
    next_advance_deadline: null,
  };
}

async function setMeta(guildId, updates) {
  await supabase.from('meta').upsert({ guild_id: guildId, ...updates }, { onConflict: 'guild_id' });
}

async function getRecord(teamId, season, guildId) {
  const { data } = await supabase
    .from('records')
    .select('*')
    .eq('team_id', teamId)
    .eq('season', season)
    .eq('guild_id', guildId)
    .single();
  return data || { wins: 0, losses: 0, team_id: teamId, season, guild_id: guildId };
}

async function upsertRecord(record) {
  await supabase.from('records').upsert(record, { onConflict: 'team_id,season,guild_id' });
}

// =====================================================
// COACH STREAM HELPERS
// =====================================================

async function setCoachStream(guildId, userId, streamUrl) {
  let platform = 'other';
  const urlLower = streamUrl.toLowerCase();

  if (urlLower.includes('twitch.tv'))       platform = 'twitch';
  else if (urlLower.includes('youtube.com') || urlLower.includes('youtu.be')) platform = 'youtube';
  else if (urlLower.includes('kick.com'))   platform = 'kick';
  else if (urlLower.includes('facebook.com/live')) platform = 'facebook';
  else if (urlLower.includes('tiktok.com')) platform = 'tiktok';

  const { error } = await supabase.from('coach_streams').upsert({
    guild_id: guildId,
    user_id: userId,
    stream_url: streamUrl.trim(),
    platform,
    updated_at: new Date().toISOString()
  }, { onConflict: 'guild_id,user_id' });

  if (error) throw error;
}

async function removeCoachStream(guildId, userId) {
  await supabase
    .from('coach_streams')
    .delete()
    .eq('guild_id', guildId)
    .eq('user_id', userId);
}

async function getAllStreamers(guildId) {
  const { data, error } = await supabase
    .from('coach_streams')
    .select('user_id, stream_url, platform')
    .eq('guild_id', guildId)
    .order('platform', { ascending: true });

  if (error) throw error;
  return data || [];
}
// =====================================================
// STREAM REMINDER TRACKING
// =====================================================
function scheduleStreamReminder(channel, userId, guildId, minutes) {
  const key = `${guildId}-${channel.id}-${userId}`;
  if (streamReminderTimers.has(key)) return;

  const timer = setTimeout(async () => {
    streamReminderTimers.delete(key);
    try {
      await channel.send(
        `<@${userId}> Friendly reminder! Please share your game results using the \`/game-result\` command 😊`
      );
      console.log(`[stream] Reminder sent to ${userId} in guild ${guildId}`);
    } catch (e) {
      console.error('[stream] Could not send reminder:', e.message);
    }
  }, minutes * 60 * 1000);

  streamReminderTimers.set(key, timer);
  console.log(`[stream] Scheduled ${minutes}min reminder for user ${userId} in guild ${guildId}`);
}

// =====================================================
// SLASH COMMANDS DEFINITION
// =====================================================
function buildCommands() {
  return [
    // ── User Commands ──────────────────────────────
    new SlashCommandBuilder()
      .setName('joboffers')
      .setDescription('Get coaching job offers based on your current team rating'),

    new SlashCommandBuilder()
      .setName('game-result')
      .setDescription('Submit your game result')
      .addStringOption(o => o.setName('opponent').setDescription('Opponent team name').setRequired(true).setAutocomplete(true))
      .addIntegerOption(o => o.setName('your-score').setDescription('Your score').setRequired(true))
      .addIntegerOption(o => o.setName('opponent-score').setDescription('Opponent score').setRequired(true))
      .addStringOption(o => o.setName('summary').setDescription('Optional game summary or highlights').setRequired(false).setMaxLength(500)),

    new SlashCommandBuilder()
      .setName('press-release')
      .setDescription('Post a press release announcement')
      .addStringOption(o => o.setName('message').setDescription('Your announcement').setRequired(true)),

    new SlashCommandBuilder()
      .setName('ranking')
      .setDescription('View current season standings'),

    new SlashCommandBuilder()
      .setName('ranking-all-time')
      .setDescription('View all-time win/loss rankings'),

    // ── Admin Commands ─────────────────────────────
    new SlashCommandBuilder()
      .setName('setup')
      .setDescription('Interactive bot configuration wizard (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
      .setName('config')
      .setDescription('Manage bot configuration (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand(sub => sub.setName('view').setDescription('View current configuration'))
      .addSubcommand(sub => sub.setName('features').setDescription('Toggle features on/off'))
      .addSubcommand(sub => sub.setName('reload').setDescription('Reload config from database'))
      .addSubcommand(sub =>
        sub.setName('edit')
          .setDescription('Edit a specific config value')
          .addStringOption(o => o.setName('setting').setDescription('Setting name').setRequired(true).setAutocomplete(true))
          .addStringOption(o => o.setName('value').setDescription('New value').setRequired(true).setAutocomplete(true))
      ),

    new SlashCommandBuilder()
      .setName('assign-team')
      .setDescription('Manually assign a team to a user (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(true))
      .addStringOption(o => o.setName('team').setDescription('Team name').setRequired(true).setAutocomplete(true))
      .addBooleanOption(o => o.setName('skip-announcement').setDescription('Skip signing announcement').setRequired(false)),

    new SlashCommandBuilder()
      .setName('resetteam')
      .setDescription('Remove a user from their team (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption(o => o.setName('user').setDescription('User to reset').setRequired(true)),

    new SlashCommandBuilder()
      .setName('listteams')
      .setDescription('Post the team availability list (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
      .setName('advance')
      .setDescription('Advance to next week (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption(o => o.setName('hours').setDescription('Deadline window for this week').setRequired(true).setAutocomplete(true)),

    new SlashCommandBuilder()
      .setName('season-advance')
      .setDescription('Advance to next season (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
      .setName('move-coach')
      .setDescription('Move a coach from one team to another (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption(o => o.setName('coach').setDescription('Coach to move').setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName('new-team').setDescription('Destination team').setRequired(true).setAutocomplete(true)),

    new SlashCommandBuilder()
      .setName('any-game-result')
      .setDescription('Enter a result for any two teams (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption(o => o.setName('team1').setDescription('First team name').setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName('team2').setDescription('Second team name').setRequired(true).setAutocomplete(true))
      .addIntegerOption(o => o.setName('score1').setDescription('Team 1 score').setRequired(true))
      .addIntegerOption(o => o.setName('score2').setDescription('Team 2 score').setRequired(true))
      .addIntegerOption(o => o.setName('week').setDescription('Week number (defaults to current week)').setRequired(false).setMinValue(1)),

    new SlashCommandBuilder()
      .setName('checkpermissions')
      .setDescription('Check if the bot has all required permissions (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
      .setName('set-stream')
      .setDescription('Set your personal streaming channel (Twitch/YouTube/etc)')
      .addStringOption(o => o.setName('url').setDescription('Your stream URL or username').setRequired(true)),

    new SlashCommandBuilder()
      .setName('list-streamers')
      .setDescription('Show all coaches and their streaming channels (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    
  ].map(cmd => cmd.toJSON());
}

// =====================================================
// REGISTER SLASH COMMANDS
// =====================================================
async function registerCommands() {
  const rest     = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const commands = buildCommands();
  try {
    console.log('[commands] Registering global slash commands...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log(`[commands] Registered ${commands.length} commands.`);
  } catch (err) {
    console.error('[commands] Registration failed:', err);
  }
}

// =====================================================
// COMMAND HANDLERS
// =====================================================

// /setup ──────────────────────────────────────────────
async function handleSetup(interaction) {
  const guildId = interaction.guildId;
  const userId  = interaction.user.id;
  const guild   = interaction.guild;

  // Acknowledge immediately — DM creation can take >3 seconds
  await interaction.reply({ content: '📬 Check your DMs — setup wizard is waiting!', flags: 64 });

  let dm;
  try {
    dm = await interaction.user.createDM();
  } catch {
    return interaction.followUp({
      content: "❌ **Setup Failed — DMs Blocked**\nI couldn't send you a DM. To fix this:\n1. Right-click the server → **Privacy Settings**\n2. Enable **Direct Messages**\n3. Run `/setup` again",
      flags: 64,
    });
  }

  await dm.send("👋 **Dynasty Bot Setup Wizard**\nAnswer each question in this DM. You have 2 minutes per step.");

  // ── Setup Helpers ─────────────────────────────────────────────────────────

  const TIMEOUT_MSG = '⏰ Setup timed out. Run `/setup` in your server again to restart.';

  const ask = async (question) => {
    await dm.send(question);
    try {
      const col = await dm.awaitMessages({ filter: m => m.author.id === userId && !m.author.bot, max: 1, time: 120000, errors: ['time'] });
      return col.first().content.trim();
    } catch {
      await dm.send(TIMEOUT_MSG);
      return null;
    }
  };

  const askWithDefault = async (question, defaultVal) => {
    const answer = await ask(question);
    if (answer === null) return null;
    return answer.toLowerCase() === 'default' ? String(defaultVal) : answer;
  };

  const askButtons = async (question, buttons) => {
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(
        buttons.slice(i, i + 5).map(b =>
          new ButtonBuilder()
            .setCustomId(`setup_${b.id}`)
            .setLabel(b.label)
            .setStyle(b.style || ButtonStyle.Primary)
        )
      ));
    }
    const msg = await dm.send({ content: question, components: rows });
    try {
      const btnInt = await msg.awaitMessageComponent({ filter: i => i.user.id === userId, time: 120000 });
      await btnInt.update({ components: [] });
      return btnInt.customId.replace('setup_', '');
    } catch {
      await dm.send(TIMEOUT_MSG);
      return null;
    }
  };

  const askMultiButtons = async (question, options) => {
    const selected = new Set();

    const buildRows = () => {
      const rows = [];
      for (let i = 0; i < options.length; i += 4) {
        rows.push(new ActionRowBuilder().addComponents(
          options.slice(i, i + 4).map(o =>
            new ButtonBuilder()
              .setCustomId(`msel_${o.id}`)
              .setLabel((selected.has(o.id) ? '✅ ' : '') + o.label)
              .setStyle(selected.has(o.id) ? ButtonStyle.Success : ButtonStyle.Secondary)
          )
        ));
      }
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('msel_ALL').setLabel('Select All').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('msel_DONE').setLabel('✔ Done').setStyle(ButtonStyle.Success),
      ));
      return rows;
    };

    const msg = await dm.send({ content: question, components: buildRows() });

    return new Promise((resolve) => {
      const collector = msg.createMessageComponentCollector({ filter: i => i.user.id === userId, time: 120000 });

      collector.on('collect', async (btnInt) => {
        const id = btnInt.customId.replace('msel_', '');
        if (id === 'DONE') {
          collector.stop('done');
          await btnInt.update({ components: [] });
          resolve([...selected]);
        } else if (id === 'ALL') {
          options.forEach(o => selected.add(o.id));
          await btnInt.update({ components: buildRows() });
        } else {
          selected.has(id) ? selected.delete(id) : selected.add(id);
          await btnInt.update({ components: buildRows() });
        }
      });

      collector.on('end', (_, reason) => {
        if (reason !== 'done') {
          dm.send(TIMEOUT_MSG);
          resolve(null);
        }
      });
    });
  };

  const pickFromList = async (question, items, idPrefix, labelFn) => {
    if (items.length === 0) return null;
    if (items.length <= 25) {
      const rows = [];
      for (let i = 0; i < items.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(
          items.slice(i, i + 5).map(item =>
            new ButtonBuilder()
              .setCustomId(`${idPrefix}_${item.id}`)
              .setLabel(labelFn(item))
              .setStyle(ButtonStyle.Secondary)
          )
        ));
      }
      const msg = await dm.send({ content: question, components: rows });
      try {
        const btnInt = await msg.awaitMessageComponent({ filter: i => i.user.id === userId, time: 120000 });
        await btnInt.update({ components: [] });
        return items.find(item => item.id === btnInt.customId.replace(`${idPrefix}_`, ''));
      } catch {
        await dm.send(TIMEOUT_MSG);
        return null;
      }
    } else {
      // Numbered text fallback for >25 items
      const lines = items.map((item, i) => `\`${i + 1}\` — ${labelFn(item)}`).join('\n');
      await dm.send(`${question}\n\n${lines}`);
      try {
        const col = await dm.awaitMessages({ filter: m => m.author.id === userId && !m.author.bot, max: 1, time: 120000, errors: ['time'] });
        const idx = parseInt(col.first().content.trim()) - 1;
        if (isNaN(idx) || idx < 0 || idx >= items.length) {
          await dm.send('❌ Invalid selection. Run `/setup` again to restart.');
          return null;
        }
        return items[idx];
      } catch {
        await dm.send(TIMEOUT_MSG);
        return null;
      }
    }
  };

  const pickChannel = (question, channels) => pickFromList(question, channels, 'ch', c => '#' + c.name);
  const pickRole    = (question, roles)    => pickFromList(question, roles,    'role', r => '@' + r.name);

  // ── Fetch guild resources ─────────────────────────────────────────────────
  const textChannels = [...guild.channels.cache
    .filter(c => c.type === ChannelType.GuildText)
    .sort((a, b) => a.name.localeCompare(b.name))
    .values()];

  const roles = [...guild.roles.cache
    .filter(r => !r.managed && r.name !== '@everyone')
    .sort((a, b) => b.position - a.position)
    .values()];

  // ── League Info ───────────────────────────────────────────────────────────
  const leagueName = await ask('**[League 1/2]** What is your league name?\nExample: CMR Dynasty');
  if (!leagueName) return;

  const leagueAbbr = await ask('**[League 2/2]** What is your league abbreviation or keyword?\nExample: CMR');
  if (!leagueAbbr) return;

  // ── Feature Selection ─────────────────────────────────────────────────────
  const featureOptions = [
    { label: 'Job Offers',       id: 'job_offers' },
    { label: 'Stream Reminders', id: 'stream_reminders' },
    { label: 'Advance System',   id: 'advance_system' },
    { label: 'Press Releases',   id: 'press_releases' },
    { label: 'Rankings',         id: 'rankings' },
  ];

  const selectedFeatures = await askMultiButtons(
    '**— Feature Selection —**\nToggle features on/off then click ✔ Done. Click **Select All** to enable everything.',
    featureOptions
  );
  if (!selectedFeatures) return;

  const features = {
    feature_job_offers:       selectedFeatures.includes('job_offers'),
    feature_stream_reminders: selectedFeatures.includes('stream_reminders'),
    feature_advance_system:   selectedFeatures.includes('advance_system'),
    feature_press_releases:   selectedFeatures.includes('press_releases'),
    feature_rankings:         selectedFeatures.includes('rankings'),
  };

  // ── Channel Setup (only for enabled features) ─────────────────────────────
  const channelConfig = {
    channel_news_feed:       'news-feed',
    channel_signed_coaches:  'signed-coaches',
    channel_team_lists:      'team-lists',
    channel_advance_tracker: 'advance-tracker',
    channel_streaming:       'streaming',
  };

  const needsNewsFeed  = features.feature_press_releases || features.feature_rankings;
  const needsSigned    = features.feature_job_offers;
  const needsTeamList  = features.feature_job_offers;
  const needsAdvance   = features.feature_advance_system;
  const needsStreaming = features.feature_stream_reminders;

  if (needsNewsFeed || needsSigned || needsTeamList || needsAdvance || needsStreaming) {
    await dm.send('**— Channel Setup —**\nSelect the channel for each feature you enabled.');

    if (needsNewsFeed) {
      const ch = await pickChannel('📰 **News Feed** — Where should game results and weekly summary post?', textChannels);
      if (!ch) return;
      channelConfig.channel_news_feed = ch.name;
    }
    if (needsSigned) {
      const ch = await pickChannel('✍️ **Signed Coaches** — Where should coach signing announcements post?', textChannels);
      if (!ch) return;
      channelConfig.channel_signed_coaches = ch.name;
    }
    if (needsTeamList) {
      const ch = await pickChannel('📋 **Team Lists** — Where should the available teams list post?', textChannels);
      if (!ch) return;
      channelConfig.channel_team_lists = ch.name;
    }
    if (needsAdvance) {
      const ch = await pickChannel('⏱️ **Advance Tracker** — Where should advance deadline notices post?', textChannels);
      if (!ch) return;
      channelConfig.channel_advance_tracker = ch.name;
    }
    if (needsStreaming) {
      const ch = await pickChannel('🎮 **Streaming** — Which channel should the bot monitor for stream links?', textChannels);
      if (!ch) return;
      channelConfig.channel_streaming = ch.name;
    }
  }

  // ── Role Setup ────────────────────────────────────────────────────────────
  let headCoachRoleName = 'head coach';
  let headCoachRoleId   = null;

  if (roles.length > 0) {
    const role = await pickRole('**— Role Setup —**\nWhich role should be assigned to head coaches?', roles);
    if (!role) return;
    headCoachRoleName = role.name;
    headCoachRoleId   = role.id;
  } else {
    await dm.send('⚠️ No roles found. The bot will create a "head coach" role automatically when the first coach is assigned.');
  }

  // ── Job Offers Config ─────────────────────────────────────────────────────
  let jobOffersConfig = { star_rating_for_offers: 2.5, star_rating_max_for_offers: null, job_offers_count: 3, job_offers_expiry_hours: 24 };

  if (features.feature_job_offers) {
    await dm.send('**— Job Offers Setup —**\nAnswer the next 4 questions to configure job offers.');

    const starMin = await askWithDefault('**[Job Offers 1/4]** Minimum star rating for job offers? (1.0 – 5.0)\nDefault: 2.5', '2.5');
    if (!starMin) return;

    const starMax = await askWithDefault('**[Job Offers 2/4]** Maximum star rating? Type none for no cap.\nDefault: none', 'none');
    if (!starMax) return;

    const offersCount = await askWithDefault('**[Job Offers 3/4]** How many offers should each user receive?\nDefault: 3', '3');
    if (!offersCount) return;

    const offersExpiry = await askWithDefault('**[Job Offers 4/4]** How many hours should offers last before expiring? (1–24)\nDefault: 24', '24');
    if (!offersExpiry) return;

    jobOffersConfig = {
      star_rating_for_offers:     parseFloat(starMin) || 2.5,
      star_rating_max_for_offers: starMax.toLowerCase() === 'none' ? null : (parseFloat(starMax) || null),
      job_offers_count:           parseInt(offersCount) || 3,
      job_offers_expiry_hours:    Math.min(24, Math.max(1, parseInt(offersExpiry) || 24)),
    };
  }

  // ── Stream Reminders Config ───────────────────────────────────────────────
  let streamConfig = { stream_reminder_minutes: 45 };

  if (features.feature_stream_reminders) {
    const mins = await askWithDefault(
      '**— Stream Reminders Setup —**\nHow many minutes after a stream link is posted should the bot send a reminder?\nDefault: 45', '45'
    );
    if (!mins) return;
    streamConfig = { stream_reminder_minutes: parseInt(mins) || 45 };
  }

  // ── Advance System Config ─────────────────────────────────────────────────
  let advanceConfig = { advance_intervals: '[24, 48]' };

  if (features.feature_advance_system) {
    const intervals = await askWithDefault(
      '**— Advance System Setup —**\nWhat advance intervals (hours) should be available? Enter as a JSON array.\nExample: [24, 48] or [12, 24, 48]\nDefault: [24, 48]', '[24, 48]'
    );
    if (!intervals) return;
    advanceConfig = { advance_intervals: intervals };
  }

  // ── Save Config ───────────────────────────────────────────────────────────
  try {
    await createDefaultConfig(guildId, leagueName);
    await saveConfig(guildId, {
      league_name:         leagueName,
      league_abbreviation: leagueAbbr,
      ...channelConfig,
      role_head_coach:     headCoachRoleName,
      role_head_coach_id:  headCoachRoleId,
      ...features,
      ...jobOffersConfig,
      ...streamConfig,
      ...advanceConfig,
    });

    // ── Summary Embed ─────────────────────────────────────────────────────
    const summaryFields = [
      { name: 'League Name',      value: leagueName,  inline: true },
      { name: 'Abbreviation',     value: leagueAbbr,  inline: true },
      { name: '\u200b',           value: '\u200b',     inline: true },
      { name: 'Job Offers',       value: features.feature_job_offers       ? '✅' : '❌', inline: true },
      { name: 'Stream Reminders', value: features.feature_stream_reminders ? '✅' : '❌', inline: true },
      { name: 'Advance System',   value: features.feature_advance_system   ? '✅' : '❌', inline: true },
      { name: 'Press Releases',   value: features.feature_press_releases   ? '✅' : '❌', inline: true },
      { name: 'Rankings',         value: features.feature_rankings         ? '✅' : '❌', inline: true },
      { name: '\u200b',           value: '\u200b',     inline: true },
    ];

    if (needsNewsFeed)  summaryFields.push({ name: 'News Feed',       value: '#' + channelConfig.channel_news_feed,       inline: true });
    if (needsSigned)    summaryFields.push({ name: 'Signed Coaches',  value: '#' + channelConfig.channel_signed_coaches,  inline: true });
    if (needsTeamList)  summaryFields.push({ name: 'Team Lists',      value: '#' + channelConfig.channel_team_lists,      inline: true });
    if (needsAdvance)   summaryFields.push({ name: 'Advance Tracker', value: '#' + channelConfig.channel_advance_tracker, inline: true });
    if (needsStreaming) summaryFields.push({ name: 'Streaming',        value: '#' + channelConfig.channel_streaming,       inline: true });
    summaryFields.push({ name: 'Head Coach Role', value: '@' + headCoachRoleName, inline: true });
    summaryFields.push({ name: '\u200b', value: '\u200b', inline: true });

    if (features.feature_job_offers) {
      summaryFields.push(
        { name: 'Min Star Rating', value: jobOffersConfig.star_rating_for_offers + ' stars',                                              inline: true },
        { name: 'Max Star Rating', value: jobOffersConfig.star_rating_max_for_offers ? jobOffersConfig.star_rating_max_for_offers + ' stars' : 'No cap', inline: true },
        { name: 'Offers Per User', value: String(jobOffersConfig.job_offers_count),                                                       inline: true },
        { name: 'Offer Expiry',    value: jobOffersConfig.job_offers_expiry_hours + ' hrs',                                               inline: true },
      );
    }
    if (features.feature_stream_reminders) summaryFields.push({ name: 'Stream Reminder',  value: streamConfig.stream_reminder_minutes + ' min',  inline: true });
    if (features.feature_advance_system)   summaryFields.push({ name: 'Advance Intervals', value: advanceConfig.advance_intervals,                 inline: true });

    const embed = new EmbedBuilder()
      .setTitle('✅ Setup Complete!')
      .setColor(0x00ff00)
      .setDescription('Your league is configured! Use `/config view` to review or `/config edit` to change anything.')
      .addFields(summaryFields);

    await dm.send({ embeds: [embed] });
  } catch (err) {
    console.error('[setup] Error saving config:', err);
    await dm.send(`❌ Setup failed: ${err.message}`);
  }
}

// /set-stream
async function handleSetStream(interaction) {
  await interaction.deferReply({ flags: 64 });

  const url = interaction.options.getString('url', true).trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return interaction.editReply('❌ Please provide a valid URL starting with http:// or https://');
  }

  try {
    await setCoachStream(interaction.guildId, interaction.user.id, url);
    await interaction.editReply(`✅ Your streaming link has been saved:\n${url}`);
  } catch (err) {
    console.error('[set-stream] Error:', err);
    await interaction.editReply('❌ Failed to save stream link. Please try again later.');
  }
}

async function handleListStreamers(interaction) {
  await interaction.deferReply({ flags: 64 });

  let streamers;
  try {
    streamers = await getAllStreamers(interaction.guildId);
  } catch (err) {
    return interaction.editReply(`❌ **Database Error**\nCouldn't load streamers: ${err.message}`);
  }

  if (streamers.length === 0) {
    return interaction.editReply('No coaches have set a streaming link yet.');
  }

  // Use cached members only — no serial API calls
  const rows = streamers.map(entry => {
    const member = interaction.guild.members.cache.get(entry.user_id);
    const name   = member?.displayName ?? `Unknown (${entry.user_id})`;
    return { name, url: entry.stream_url };
  });

  // Align columns: pad coach names to the longest name width
  const maxLen = Math.max(...rows.map(r => r.name.length));
  const tableLines = rows.map(r => `${r.name.padEnd(maxLen)}  ${r.url}`);
  const header     = `${'Coach'.padEnd(maxLen)}  URL`;
  const divider    = `${'-'.repeat(maxLen)}  ${'-'.repeat(40)}`;
  const table      = [header, divider, ...tableLines].join('\n');

  // Discord has a 2000 char message limit — split if needed
  const block = '```\n' + table + '\n```';
  if (block.length <= 2000) {
    await interaction.editReply({ content: `**Streamers (${rows.length})**\n${block}` });
  } else {
    // Split into chunks
    await interaction.editReply({ content: `**Streamers (${rows.length})** — copy the table below:` });
    let chunk = '```\n' + header + '\n' + divider + '\n';
    for (const line of tableLines) {
      if ((chunk + line + '\n```').length > 2000) {
        await interaction.followUp({ content: chunk + '```', flags: 64 });
        chunk = '```\n';
      }
      chunk += line + '\n';
    }
    if (chunk !== '```\n') await interaction.followUp({ content: chunk + '```', flags: 64 });
  }
}

// /config view ────────────────────────────────────────
async function handleConfigView(interaction) {
  await interaction.deferReply({ flags: 64 });
  const config = await getConfig(interaction.guildId);
  const embed = new EmbedBuilder()
    .setTitle(`⚙️ ${config.league_name} — Bot Configuration`)
    .setColor(config.embed_color_primary_int || 0x1e90ff)
    .addFields(
      { name: '📌 League',       value: config.league_name,                     inline: true },
      { name: '🔤 Abbreviation', value: config.league_abbreviation || 'Not set', inline: true },
      { name: '🆔 Guild ID',     value: config.guild_id,                         inline: true },
      { name: '\u200b',          value: '\u200b',                                 inline: true },
      { name: '🔧 Features', value:
        `Job Offers: ${config.feature_job_offers ? '✅' : '❌'}\n` +
        `Stream Reminders: ${config.feature_stream_reminders ? '✅' : '❌'}\n` +
        `Advance System: ${config.feature_advance_system ? '✅' : '❌'}\n` +
        `Press Releases: ${config.feature_press_releases ? '✅' : '❌'}\n` +
        `Rankings: ${config.feature_rankings ? '✅' : '❌'}`,
        inline: true },
      { name: '📺 Channels', value:
        `News Feed: \`${config.channel_news_feed}\`\n` +
        `Advance Tracker: \`${config.channel_advance_tracker}\`\n` +
        `Team Lists: \`${config.channel_team_lists}\`\n` +
        `Signed Coaches: \`${config.channel_signed_coaches}\`\n` +
        `Streaming: \`${config.channel_streaming}\``,
        inline: true },
      { name: '🎮 Settings', value:
        `Min Star Rating: \`${config.star_rating_for_offers}\`\n` +
        `Max Star Rating: \`${config.star_rating_max_for_offers || 'No cap'}\`\n` +
        `Job Offers Count: \`${config.job_offers_count}\`\n` +
        `Offers Expire: \`${config.job_offers_expiry_hours}hrs\`\n` +
        `Stream Reminder: \`${config.stream_reminder_minutes} min\`\n` +
        `Advance Intervals: \`${config.advance_intervals}\``,
        inline: true },
    );
  await interaction.editReply({ embeds: [embed] });
}

// /config features ────────────────────────────────────
async function handleConfigFeatures(interaction) {
  await interaction.deferReply({ flags: 64 });
  const config = await getConfig(interaction.guildId);
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`features-toggle-${interaction.guildId}`)
      .setPlaceholder('Select features to toggle...')
      .setMinValues(0)
      .setMaxValues(5)
      .addOptions([
        { label: 'Job Offers',       value: 'feature_job_offers',       description: 'Enable/disable job offer system',    default: config.feature_job_offers },
        { label: 'Stream Reminders', value: 'feature_stream_reminders', description: 'Enable/disable stream reminders',    default: config.feature_stream_reminders },
        { label: 'Advance System',   value: 'feature_advance_system',   description: 'Enable/disable advance system',      default: config.feature_advance_system },
        { label: 'Press Releases',   value: 'feature_press_releases',   description: 'Enable/disable press releases',      default: config.feature_press_releases },
        { label: 'Rankings',         value: 'feature_rankings',         description: 'Enable/disable rankings',            default: config.feature_rankings },
      ])
  );
  await interaction.editReply({
    content: '**Feature Toggles** — Select the features you want **ENABLED** (deselect to disable):',
    components: [row],
  });
}

// /config edit ────────────────────────────────────────
async function handleConfigEdit(interaction) {
  await interaction.deferReply({ flags: 64 });
  const setting = interaction.options.getString('setting');
  const value   = interaction.options.getString('value');
  const allowed = [
    'league_name', 'league_abbreviation', 'channel_news_feed', 'channel_advance_tracker',
    'channel_team_lists', 'channel_signed_coaches', 'channel_streaming', 'role_head_coach',
    'star_rating_for_offers', 'star_rating_max_for_offers', 'job_offers_count',
    'job_offers_expiry_hours', 'stream_reminder_minutes', 'advance_intervals',
    'embed_color_primary', 'embed_color_win', 'embed_color_loss',
  ];
  if (!allowed.includes(setting)) {
    return interaction.editReply({ content: `❌ **Unknown Setting: \`${setting}\`**\nUse the autocomplete dropdown when typing the setting name, or run \`/config view\` to see all available settings.` });
  }
  try {
    await saveConfig(interaction.guildId, { [setting]: value });
    await interaction.editReply({ content: `✅ Updated **${setting}** to \`${value}\`` });
  } catch (err) {
    await interaction.editReply({ content: `❌ **Failed to Save Setting**\nDatabase error: ${err.message}\n\nTry running \`/config reload\` then attempt the edit again. If this keeps happening, check your Supabase connection.` });
  }
}

// /config reload ──────────────────────────────────────
async function handleConfigReload(interaction) {
  await interaction.deferReply({ flags: 64 });
  guildConfigs.delete(interaction.guildId);
  const config = await loadGuildConfig(interaction.guildId);
  await interaction.editReply({ content: `✅ Config reloaded for **${config.league_name}**!` });
}

// /joboffers ──────────────────────────────────────────
async function handleJobOffers(interaction) {
  const guildId = interaction.guildId;
  const userId  = interaction.user.id;
  await interaction.deferReply({ flags: 64 });
  const config  = await getConfig(guildId);

  if (!config.feature_job_offers) {
    return interaction.editReply({ content: '❌ **Job Offers Disabled**\nThis feature is turned off. An admin can enable it with `/config features`.' });
  }

  const currentTeam = await getTeamByUser(userId, guildId);
  if (currentTeam) {
    return interaction.editReply({
      content: `❌ **Already Assigned**\nYou are already the head coach of **${currentTeam.team_name}**. Job offers are only available to coaches without a team.\n\nIf this is a mistake, ask an admin to run \`/resetteam\` to remove your current assignment.`,
    });
  }

  const now = new Date();

  // Check for existing active offers and resend
  const { data: existingOffers } = await supabase
    .from('job_offers')
    .select('*, teams(team_name, star_rating, conference)')
    .eq('guild_id', guildId)
    .eq('user_id', userId)
    .gt('expires_at', now.toISOString());

  if (existingOffers && existingOffers.length > 0) {
    return sendOffersAsDM(interaction, existingOffers, config, guildId, true);
  }

  // Find locked (in other users' active offers) and already-assigned teams
  const { data: lockedRows }    = await supabase.from('job_offers').select('team_id').eq('guild_id', guildId).gt('expires_at', now.toISOString());
  const { data: assignedRows }  = await supabase.from('team_assignments').select('team_id').eq('guild_id', guildId);

  const locked    = (lockedRows    || []).map(r => r.team_id);
  const assigned  = (assignedRows  || []).map(r => r.team_id);

  let query = supabase
    .from('teams')
    .select('*')
    .gte('star_rating', config.star_rating_for_offers)
    .order('star_rating', { ascending: false })
    .limit(50);

  if (config.star_rating_max_for_offers) {
    query = query.lte('star_rating', config.star_rating_max_for_offers);
  }

  const { data: availableJobs } = await query;
  const pool = (availableJobs || []).filter(t => !assigned.includes(t.id) && !locked.includes(t.id));

  if (pool.length === 0) {
    return interaction.editReply({
      content: `❌ **No Available Teams**\nThere are no unassigned teams with a **${config.star_rating_for_offers}⭐ or higher** rating right now.\n\nPossible reasons:\n• All eligible teams are taken\n• All eligible teams are locked in active offers\n• The star rating range in config is too narrow\n\nAn admin can adjust the range with \`/config edit\`.`,
    });
  }

  const picks      = pool.sort(() => Math.random() - 0.5).slice(0, config.job_offers_count);
  const expiresAt  = new Date(now.getTime() + (config.job_offers_expiry_hours || 48) * 60 * 60 * 1000);

  await supabase.from('job_offers').insert(
    picks.map(t => ({ guild_id: guildId, user_id: userId, team_id: t.id, expires_at: expiresAt.toISOString() }))
  );

  const shaped = picks.map(t => ({ teams: t, expires_at: expiresAt.toISOString(), team_id: t.id }));
  await sendOffersAsDM(interaction, shaped, config, guildId, false);
}

async function sendOffersAsDM(interaction, offers, config, guildId, isExisting) {
  const expiresAt = new Date(offers[0].expires_at);
  const hoursLeft = Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60));

  const embed = new EmbedBuilder()
    .setTitle('📋 Your Job Offers')
    .setColor(config.embed_color_primary_int)
    .setDescription(
      isExisting
        ? `You already have active offers. They expire in **${hoursLeft} hour(s)**. Click a button below to accept one.`
        : `Here are your **${offers.length}** offer(s). They expire in **${hoursLeft} hours**. Click a button below to accept one.`
    )
    .addFields(offers.map((o, i) => ({
      name:  `${i + 1}. ${o.teams.team_name}`,
      value: `Rating: ${starRating(o.teams.star_rating || 0)} (${o.teams.star_rating || '?'}⭐)\nConference: ${o.teams.conference || 'Unknown'}`,
      inline: false,
    })))
    .setFooter({ text: 'Offers cannot be refreshed until they expire.' });

  const rows = [];
  for (let i = 0; i < offers.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(
      offers.slice(i, i + 5).map((o, j) =>
        new ButtonBuilder()
          .setCustomId(`accept-offer_${guildId}_${offers[i + j].team_id}`)
          .setLabel(`Accept: ${o.teams.team_name}`)
          .setStyle(ButtonStyle.Primary)
      )
    ));
  }

  try {
    const dm = await interaction.user.createDM();
    await dm.send({ embeds: [embed], components: rows });
    await interaction.editReply({ content: '📬 Your job offers have been sent to your DMs!' });
  } catch {
    await interaction.editReply({ embeds: [embed], components: rows });
  }
}

async function handleAcceptOffer(interaction) {
  const [, guildId, teamIdStr] = interaction.customId.split('_');
  const teamId = parseInt(teamIdStr);
  const userId = interaction.user.id;

  await interaction.deferUpdate();

  const { data: offer } = await supabase
    .from('job_offers')
    .select('*, teams(*)')
    .eq('guild_id', guildId)
    .eq('user_id', userId)
    .eq('team_id', teamId)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (!offer) {
    return interaction.editReply({ content: '❌ **Offer No Longer Available**\nThis offer has either expired or the team was taken by someone else.\n\nRun `/joboffers` in your server to request a fresh set of offers.', components: [], embeds: [] });
  }

  const { data: existing } = await supabase
    .from('team_assignments')
    .select('user_id')
    .eq('guild_id', guildId)
    .eq('team_id', teamId)
    .single();

  if (existing) {
    return interaction.editReply({ content: `❌ **Team Just Taken**\n**${offer.teams.team_name}** was claimed by another coach moments before you accepted.\n\nRun \`/joboffers\` in your server to get a new set of offers.`, components: [], embeds: [] });
  }

  await assignTeam(teamId, userId, guildId);
  await supabase.from('job_offers').delete().eq('guild_id', guildId).eq('user_id', userId);

  const config = await getConfig(guildId);
  const guild  = client.guilds.cache.get(guildId);

  if (guild) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) {
      const hcRole = await findOrCreateRole(guild, config.role_head_coach);
      try {
        await member.roles.add(hcRole);
      } catch (roleErr) {
        console.error('[roles] Failed to assign head coach role on offer accept:', roleErr.message);
        // Notify in news feed — team assignment still succeeded
        const newsChannel = findTextChannel(guild, config.channel_news_feed);
        if (newsChannel) newsChannel.send({ content: `⚠️ <@${userId}> accepted **${offer.teams.team_name}** but I couldn't assign the **${config.role_head_coach}** role. Check that my role is above it in Server Settings → Roles, or run \`/checkpermissions\`.` });
      }
      if (!config.role_head_coach_id) await saveConfig(guildId, { role_head_coach_id: hcRole.id });
    }
  }

  const successEmbed = new EmbedBuilder()
    .setTitle('✅ Offer Accepted!')
    .setColor(0x00ff00)
    .setDescription(`You are now the Head Coach of **${offer.teams.team_name}**! Welcome to the league.`)
    .addFields(
      { name: 'Team',       value: offer.teams.team_name,               inline: true },
      { name: 'Conference', value: offer.teams.conference || 'Unknown',  inline: true },
      { name: 'Rating',     value: `${starRating(offer.teams.star_rating || 0)} (${offer.teams.star_rating || '?'}⭐)`, inline: true },
    );

  await interaction.editReply({ embeds: [successEmbed], components: [] });

  if (guild) {
    const signingEmbed = new EmbedBuilder()
      .setTitle(`✍️ Coach Signed — ${offer.teams.team_name}`)
      .setColor(config.embed_color_primary_int)
      .setDescription(`<@${userId}> has accepted the head coaching position at **${offer.teams.team_name}**!`)
      .addFields(
        { name: 'Coach',      value: `<@${userId}>`,                     inline: true },
        { name: 'Team',       value: offer.teams.team_name,              inline: true },
        { name: 'Conference', value: offer.teams.conference || 'Unknown', inline: true },
      )
      .setTimestamp();

    const target = findTextChannel(guild, config.channel_signed_coaches) || findTextChannel(guild, config.channel_news_feed);
    if (target) await target.send({ embeds: [signingEmbed] });
  }
}

async function expireJobOffers() {
  const now = new Date().toISOString();
  const { data: expired } = await supabase.from('job_offers').select('*, teams(team_name)').lt('expires_at', now);
  if (!expired || expired.length === 0) return;

  const byUser = {};
  for (const offer of expired) {
    const key = `${offer.guild_id}:${offer.user_id}`;
    if (!byUser[key]) byUser[key] = { guild_id: offer.guild_id, user_id: offer.user_id, teams: [] };
    byUser[key].teams.push(offer.teams?.team_name || 'Unknown');
  }

  for (const { guild_id, user_id, teams } of Object.values(byUser)) {
    try {
      const guild  = client.guilds.cache.get(guild_id);
      if (!guild) continue;
      const config = await getConfig(guild_id);
      const member = await guild.members.fetch(user_id).catch(() => null);
      if (!member) continue;

      const embed = new EmbedBuilder()
        .setTitle('⏰ Job Offers Expired')
        .setColor(0xff9900)
        .setDescription(
          `Your job offers have expired and the following teams are back in the pool:\n\n` +
          teams.map(t => `• **${t}**`).join('\n') +
          `\n\nRun \`/joboffers\` to request a new set.`
        );

      await member.send({ embeds: [embed] }).catch(() => {
        const newsChannel = findTextChannel(guild, config.channel_news_feed);
        if (newsChannel) newsChannel.send({ content: `<@${user_id}>`, embeds: [embed] });
      });
    } catch (err) {
      console.error('[expireJobOffers] Error:', err.message);
    }
  }

  await supabase.from('job_offers').delete().lt('expires_at', now);
  console.log(`[expireJobOffers] Removed ${expired.length} expired offer(s).`);
}

// /game-result ────────────────────────────────────────
async function handleGameResult(interaction) {
  await interaction.deferReply();
  const guildId      = interaction.guildId;
  const config       = await getConfig(guildId);
  const meta         = await getMeta(guildId);
  const opponentName = interaction.options.getString('opponent');
  const yourScore    = interaction.options.getInteger('your-score');
  const oppScore     = interaction.options.getInteger('opponent-score');
  const summary      = interaction.options.getString('summary') || null;
  const userId       = interaction.user.id;

  let yourTeam, oppTeam;
  try {
    yourTeam = await getTeamByUser(userId, guildId);
  } catch (err) {
    return interaction.editReply({ content: `❌ **Database Error**\nCouldn't load your team: ${err.message}\n\nTry again in a moment. If this persists, check your Supabase connection.` });
  }
  if (!yourTeam) {
    return interaction.editReply({ content: "❌ **No Team Assigned**\nYou don't have a team yet. Use `/joboffers` to receive coaching offers, or ask an admin to assign you a team with `/assign-team`." });
  }

  try {
    oppTeam = await getTeamByName(opponentName, guildId);
  } catch (err) {
    return interaction.editReply({ content: `❌ **Database Error**\nCouldn't look up opponent "${opponentName}": ${err.message}` });
  }
  if (!oppTeam) {
    return interaction.editReply({ content: `❌ **Opponent Not Found: \`${opponentName}\`**\nNo team with that name exists in the database. Make sure you selected from the autocomplete dropdown — partial or misspelled names won't match.` });
  }

  const won  = yourScore > oppScore;
  const tied = yourScore === oppScore;

  const yourRecord = await getRecord(yourTeam.id, meta.season, guildId);
  const oppRecord  = await getRecord(oppTeam.id,  meta.season, guildId);

  if (won) {
    yourRecord.wins++;  oppRecord.losses++;
  } else if (!tied) {
    yourRecord.losses++; oppRecord.wins++;
  }

  await upsertRecord({ ...yourRecord, team_id: yourTeam.id, season: meta.season, guild_id: guildId });
  await upsertRecord({ ...oppRecord,  team_id: oppTeam.id,  season: meta.season, guild_id: guildId });

  await supabase.from('results').insert({
    guild_id: guildId, season: meta.season, week: meta.week,
    team1_id: yourTeam.id, team2_id: oppTeam.id,
    score1: yourScore, score2: oppScore, submitted_by: userId,
  });

  const result = tied ? 'TIE' : (won ? 'WIN' : 'LOSS');
  const color  = tied ? 0xffa500 : (won ? config.embed_color_win_int : config.embed_color_loss_int);

  const embed = new EmbedBuilder()
    .setTitle(`🏈 Game Result — Season ${meta.season} Week ${meta.week}`)
    .setColor(color)
    .setDescription(`**${yourTeam.team_name}** vs **${oppTeam.team_name}**`)
    .addFields(
      { name: yourTeam.team_name,              value: `${yourScore}`,                              inline: true },
      { name: result,                           value: '—',                                         inline: true },
      { name: oppTeam.team_name,               value: `${oppScore}`,                               inline: true },
      { name: `${yourTeam.team_name} Record`,  value: `${yourRecord.wins}-${yourRecord.losses}`,   inline: true },
      { name: `${oppTeam.team_name} Record`,   value: `${oppRecord.wins}-${oppRecord.losses}`,     inline: true },
    )
    .setFooter({ text: `Submitted by ${interaction.user.displayName}` });

  if (summary) embed.addFields({ name: '📝 Game Summary', value: summary, inline: false });

  await interaction.editReply({ embeds: [embed] });

  const newsChannel = findTextChannel(interaction.guild, config.channel_news_feed);
  if (newsChannel && newsChannel.id !== interaction.channelId) {
    await newsChannel.send({ embeds: [embed] });
  }
}
// Inside handleGameResult, right after successful insert into 'results'
for (const [key, timer] of streamReminderTimers.entries()) {
  if (key.startsWith(`${guildId}-`) && key.endsWith(`-${userId}`)) {
    clearTimeout(timer);
    streamReminderTimers.delete(key);
    console.log(`[stream] Cancelled reminder for ${userId} after submitting result`);
  }
}

// /any-game-result ────────────────────────────────────
async function handleAnyGameResult(interaction) {
  await interaction.deferReply();
  const guildId   = interaction.guildId;
  const config    = await getConfig(guildId);
  const meta      = await getMeta(guildId);
  const team1Name = interaction.options.getString('team1');
  const team2Name = interaction.options.getString('team2');
  const score1    = interaction.options.getInteger('score1');
  const score2    = interaction.options.getInteger('score2');
  const weekInput = interaction.options.getInteger('week');
  const week      = weekInput || meta.week;

  if (weekInput && (weekInput < 1 || weekInput > meta.week)) {
    return interaction.editReply({
      content: `❌ **Invalid Week**\nWeek **${weekInput}** is out of range. The current season is on Week **${meta.week}** — enter a week between 1 and ${meta.week}.`,
    });
  }

  let team1, team2;
  try { team1 = await getTeamByName(team1Name, guildId); }
  catch (err) { return interaction.editReply({ content: `❌ **Database Error**\nCouldn't look up "${team1Name}": ${err.message}` }); }
  try { team2 = await getTeamByName(team2Name, guildId); }
  catch (err) { return interaction.editReply({ content: `❌ **Database Error**\nCouldn't look up "${team2Name}": ${err.message}` }); }

  if (!team1) return interaction.editReply({ content: `❌ **Team Not Found: \`${team1Name}\`**\nNo team with that name exists in the database. Use the autocomplete dropdown to select teams.` });
  if (!team2) return interaction.editReply({ content: `❌ **Team Not Found: \`${team2Name}\`**\nNo team with that name exists in the database. Use the autocomplete dropdown to select teams.` });

  const record1 = await getRecord(team1.id, meta.season, guildId);
  const record2 = await getRecord(team2.id, meta.season, guildId);

  if      (score1 > score2) { record1.wins++;  record2.losses++; }
  else if (score2 > score1) { record2.wins++;  record1.losses++; }

  await upsertRecord({ ...record1, team_id: team1.id, season: meta.season, guild_id: guildId });
  await upsertRecord({ ...record2, team_id: team2.id, season: meta.season, guild_id: guildId });

  await supabase.from('results').insert({
    guild_id: guildId, season: meta.season, week,
    team1_id: team1.id, team2_id: team2.id,
    score1, score2, submitted_by: interaction.user.id,
  });

  const won1  = score1 > score2;
  const tied  = score1 === score2;
  const color = tied ? 0xffa500 : (won1 ? config.embed_color_win_int : config.embed_color_loss_int);

  const embed = new EmbedBuilder()
    .setTitle(`🏈 Game Result Entered — S${meta.season} W${week}`)
    .setColor(color)
    .addFields(
      { name: team1.team_name,              value: `${score1}`,                          inline: true },
      { name: tied ? 'TIE' : (won1 ? 'WIN' : 'LOSS'), value: '—',                       inline: true },
      { name: team2.team_name,              value: `${score2}`,                          inline: true },
      { name: `${team1.team_name} Record`,  value: `${record1.wins}-${record1.losses}`,  inline: true },
      { name: `${team2.team_name} Record`,  value: `${record2.wins}-${record2.losses}`,  inline: true },
    )
    .setFooter({ text: `Entered by ${interaction.user.displayName} (admin)${weekInput && weekInput !== meta.week ? ` · Backfilled to Week ${week}` : ''}` });

  await interaction.editReply({ embeds: [embed] });

  const newsChannel = findTextChannel(interaction.guild, config.channel_news_feed);
  if (newsChannel && newsChannel.id !== interaction.channelId) {
    await newsChannel.send({ embeds: [embed] });
  }
}

// /press-release ──────────────────────────────────────
async function handlePressRelease(interaction) {
  await interaction.deferReply({ flags: 64 });
  const config = await getConfig(interaction.guildId);
  if (!config.feature_press_releases) {
    return interaction.editReply({ content: '❌ **Press Releases Disabled**\nThis feature is turned off. An admin can enable it with `/config features`.' });
  }

  const message  = interaction.options.getString('message');
  const userTeam = await getTeamByUser(interaction.user.id, interaction.guildId);
  const teamName = userTeam ? userTeam.team_name : interaction.user.displayName;

  const newsChannel = findTextChannel(interaction.guild, config.channel_news_feed);
  if (!newsChannel) {
    return interaction.editReply({ content: `❌ **News Feed Channel Not Found**\nThe configured channel \`#${config.channel_news_feed}\` doesn't exist in this server.\n\nAn admin can fix this with \`/config edit\` → **News Feed Channel**, or run \`/checkpermissions\` to audit all channels.` });
  }

  const embed = new EmbedBuilder()
    .setTitle(`📰 Press Release — ${teamName}`)
    .setColor(config.embed_color_primary_int)
    .setDescription(message)
    .setFooter({ text: `Posted by ${interaction.user.displayName}` })
    .setTimestamp();

  await newsChannel.send({ embeds: [embed] });
  await supabase.from('news_feed').insert({
    guild_id: interaction.guildId, author_id: interaction.user.id, team_name: teamName, message,
  });
  await interaction.editReply({ content: '✅ Press release posted!' });
}

// /ranking ────────────────────────────────────────────
async function handleRanking(interaction) {
  await interaction.deferReply({ flags: 64 });
  const config = await getConfig(interaction.guildId);
  if (!config.feature_rankings) {
    return interaction.editReply({ content: '❌ **Rankings Disabled**\nThis feature is turned off. An admin can enable it with `/config features`.' });
  }

  const meta = await getMeta(interaction.guildId);
  const { data: records } = await supabase
    .from('records')
    .select('*, teams(team_name)')
    .eq('guild_id', interaction.guildId)
    .eq('season', meta.season)
    .order('wins', { ascending: false });

  if (!records || records.length === 0) {
    return interaction.editReply({ content: '❌ **No Records Yet**\nNo game results have been submitted for this season. Records will appear here once coaches start submitting results with `/game-result`.' });
  }

  const lines = records.map((r, i) =>
    `**${i + 1}.** ${r.teams?.team_name || `Team ${r.team_id}`} — ${r.wins}W - ${r.losses}L`
  );

  const embed = new EmbedBuilder()
    .setTitle(`🏆 Season ${meta.season} Standings`)
    .setColor(config.embed_color_primary_int)
    .setDescription(lines.join('\n'))
    .setTimestamp();

  const newsChannel = findTextChannel(interaction.guild, config.channel_news_feed);
  if (newsChannel && newsChannel.id !== interaction.channelId) {
    await newsChannel.send({ embeds: [embed] });
    await interaction.editReply({ content: `✅ Standings posted in ${newsChannel}!` });
  } else {
    await interaction.editReply({ embeds: [embed] });
  }
}

// /ranking-all-time ───────────────────────────────────
async function handleRankingAllTime(interaction) {
  await interaction.deferReply({ flags: 64 });
  const config = await getConfig(interaction.guildId);

  const { data: records } = await supabase
    .from('records')
    .select('team_id, wins, losses, teams(team_name)')
    .eq('guild_id', interaction.guildId);

  if (!records || records.length === 0) {
    return interaction.editReply({ content: '❌ **No Records Found**\nNo game results exist yet. Records will appear here once coaches submit results with `/game-result`.' });
  }

  const totals = {};
  for (const r of records) {
    const name = r.teams?.team_name || r.team_id;
    if (!totals[name]) totals[name] = { wins: 0, losses: 0 };
    totals[name].wins   += r.wins   || 0;
    totals[name].losses += r.losses || 0;
  }

  const lines = Object.entries(totals)
    .sort((a, b) => b[1].wins - a[1].wins)
    .map(([name, rec], i) => {
      const pct = (rec.wins + rec.losses) > 0
        ? ((rec.wins / (rec.wins + rec.losses)) * 100).toFixed(1) : '0.0';
      return `**${i + 1}.** ${name} — ${rec.wins}W - ${rec.losses}L (${pct}%)`;
    });

  const embed = new EmbedBuilder()
    .setTitle('🏆 All-Time Rankings')
    .setColor(config.embed_color_primary_int)
    .setDescription(lines.join('\n'))
    .setTimestamp();

  const newsChannel = findTextChannel(interaction.guild, config.channel_news_feed);
  if (newsChannel && newsChannel.id !== interaction.channelId) {
    await newsChannel.send({ embeds: [embed] });
    await interaction.editReply({ content: `✅ All-time rankings posted in ${newsChannel}!` });
  } else {
    await interaction.editReply({ embeds: [embed] });
  }
}

// /assign-team ────────────────────────────────────────
async function handleAssignTeam(interaction) {
  const guildId  = interaction.guildId;
  const config   = await getConfig(guildId);
  const guild    = interaction.guild;
  const user     = interaction.options.getUser('user');
  const teamName = interaction.options.getString('team');
  const skipAnn  = interaction.options.getBoolean('skip-announcement') || false;

  await interaction.deferReply();

  let team;
  try { team = await getTeamByName(teamName, guildId); }
  catch (err) { return interaction.editReply(`❌ **Database Error**\nCouldn't look up team "${teamName}": ${err.message}`); }
  if (!team) return interaction.editReply(`❌ **Team Not Found: \`${teamName}\`**\nThis team doesn't exist in the global teams database. Make sure you selected from the autocomplete dropdown.\n\nIf the team is missing entirely, it may need to be added to the Supabase \`teams\` table.`);

  if (team.user_id && team.user_id !== user.id) {
    const currentCoach = await guild.members.fetch(team.user_id).catch(() => null);
    return interaction.editReply(`❌ **Team Already Assigned**\n**${team.team_name}** is currently coached by **${currentCoach ? currentCoach.displayName : 'another coach'}** in this league.\n\nTo reassign this team, first run \`/resetteam\` on the current coach, then try \`/assign-team\` again.`);
  }

  const oldTeam = await getTeamByUser(user.id, guildId);
  if (oldTeam) await unassignTeam(oldTeam.id, guildId);

  await assignTeam(team.id, user.id, guildId);

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (member) {
    const hcRole = await findOrCreateRole(guild, config.role_head_coach);
    try {
      if (!member.roles.cache.has(hcRole.id)) await member.roles.add(hcRole);
    } catch (roleErr) {
      console.error('[roles] Failed to assign head coach role on assign-team:', roleErr.message);
      await interaction.followUp({ content: `⚠️ Team assigned, but I couldn't add the **${config.role_head_coach}** role to <@${user.id}>. Check that my role is above it in **Server Settings → Roles**, or run \`/checkpermissions\`.`, flags: 64 });
    }
    if (!config.role_head_coach_id) await saveConfig(guildId, { role_head_coach_id: hcRole.id });
  }

  const embed = new EmbedBuilder()
    .setTitle(`✍️ Coach Signed — ${team.team_name}`)
    .setColor(config.embed_color_primary_int)
    .setDescription(`<@${user.id}> has been assigned to **${team.team_name}**!`)
    .addFields(
      { name: 'Coach', value: `<@${user.id}>`, inline: true },
      { name: 'Team',  value: team.team_name,  inline: true },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });

  if (!skipAnn) {
    const target = findTextChannel(guild, config.channel_signed_coaches) || findTextChannel(guild, config.channel_news_feed);
    if (target && target.id !== interaction.channelId) await target.send({ embeds: [embed] });
  }
}

// /resetteam ──────────────────────────────────────────
async function handleResetTeam(interaction) {
  await interaction.deferReply();
  const guildId = interaction.guildId;
  const config  = await getConfig(guildId);
  const user    = interaction.options.getUser('user');

  const team = await getTeamByUser(user.id, guildId);
  if (!team) {
    return interaction.editReply({ content: `❌ **No Team Found**\n<@${user.id}> doesn't have a team assigned in this league. Nothing to reset.` });
  }

  await unassignTeam(team.id, guildId);

  await removeCoachStream(guildId, user.id).catch(err => {
  console.warn('[reset] Failed to remove stream link:', err.message);
});
  
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  let roleWarning = '';
  if (member && config.role_head_coach_id) {
    try {
      await member.roles.remove(config.role_head_coach_id);
    } catch (roleErr) {
      console.error('[roles] Failed to remove head coach role on resetteam:', roleErr.message);
      roleWarning = `\n⚠️ Couldn't remove the **${config.role_head_coach}** role — check bot role hierarchy in **Server Settings → Roles**.`;
    }
  }

  const signedChannel = findTextChannel(interaction.guild, config.channel_signed_coaches);
  const newsChannel   = findTextChannel(interaction.guild, config.channel_news_feed);
  const announceTarget = signedChannel || newsChannel;

  const releaseEmbed = new EmbedBuilder()
    .setTitle(`🚪 Coach Released — ${team.team_name}`)
    .setColor(0xff4444)
    .setDescription(`<@${user.id}> has been released from **${team.team_name}**.`)
    .addFields(
      { name: 'Coach', value: `<@${user.id}>`, inline: true },
      { name: 'Team',  value: team.team_name,   inline: true },
    )
    .setTimestamp();

  if (announceTarget) await announceTarget.send({ embeds: [releaseEmbed] }).catch(() => {});

  await interaction.editReply({ content: `✅ <@${user.id}> has been removed from **${team.team_name}**.${roleWarning}` });
  
}

// /listteams ──────────────────────────────────────────
async function handleListTeams(interaction) {
  const guildId = interaction.guildId;
  const config  = await getConfig(guildId);
  await interaction.deferReply({ flags: 64 });

  let allTeams;
  try {
    allTeams = await getAllTeams(guildId);
  } catch (err) {
    return interaction.editReply(`❌ **Database Error**\nCouldn't load teams: ${err.message}\n\nCheck your Supabase connection and ensure the \`teams\` table exists and has data.`);
  }

  const minRating = config.star_rating_for_offers     || 0;
  const maxRating = config.star_rating_max_for_offers || 999;

  // Always show taken teams; only show available teams within the configured range
  const teams = allTeams.filter(t => t.user_id || (parseFloat(t.star_rating) >= minRating && parseFloat(t.star_rating) <= maxRating));

  // Group by conference
  const confMap = {};
  for (const t of teams) {
    const conf = t.conference || 'Independent';
    if (!confMap[conf]) confMap[conf] = [];
    confMap[conf].push(t);
  }

  const fields = [];
  for (const [conf, confTeams] of Object.entries(confMap).sort()) {
    const lines = confTeams
      .sort((a, b) => (b.star_rating || 0) - (a.star_rating || 0))
      .map(t => t.user_id
        ? `🏈 **${t.team_name}** — <@${t.user_id}> (${t.star_rating || '?'}⭐)`
        : `🟢 **${t.team_name}** — Available (${t.star_rating || '?'}⭐)`
      );

    for (let i = 0; i < lines.length; i += 15) {
      fields.push({
        name:  i === 0 ? `__${conf}__` : `__${conf} (cont.)__`,
        value: lines.slice(i, i + 15).join('\n'),
        inline: false,
      });
    }
  }

  if (fields.length === 0) {
    return interaction.editReply('No teams found. Make sure teams are loaded in the database.');
  }

  const taken = teams.filter(t => t.user_id).length;
  const avail = teams.filter(t => !t.user_id).length;

  const embeds = [];
  for (let i = 0; i < fields.length; i += 25) {
    const embed = new EmbedBuilder()
      .setColor(config.embed_color_primary_int)
      .addFields(fields.slice(i, i + 25));

    if (i === 0) {
      embed
        .setTitle(`📋 ${config.league_name} — Team List`)
        .setDescription(
          `**${taken}** coaches signed · **${avail}** teams available\n` +
          `Showing teams rated **${minRating}⭐${maxRating < 999 ? ' – ' + maxRating + '⭐' : '+'}**`
        )
        .setTimestamp();
    }
    embeds.push(embed);
  }

  const listsChannel = findTextChannel(interaction.guild, config.channel_team_lists);
  const target       = listsChannel || interaction.channel;

  const botMember = interaction.guild.members.cache.get(client.user.id);
  const perms     = target.permissionsFor(botMember);

  if (!perms?.has('SendMessages')) {
    return interaction.editReply(`❌ **Missing Channel Permissions**\nI don't have permission to post in ${target}.\n\n**Required permissions in that channel:**\n• Send Messages\n• Embed Links\n• Read Message History\n• Manage Messages (for cleanup)\n\nFix this in **Server Settings → Roles** or the channel's **Edit Channel → Permissions**, then try again. Run \`/checkpermissions\` for a full audit.`);
  }

  if (perms.has('ManageMessages')) {
    try {
      const messages = await target.messages.fetch({ limit: 100 });
      for (const m of messages.filter(m => m.author.id === client.user.id).values()) {
        await m.delete().catch(() => {});
      }
    } catch { /* ignore */ }
  }

  for (const embed of embeds) await target.send({ embeds: [embed] });

  await interaction.editReply(
    listsChannel && listsChannel.id !== interaction.channelId
      ? `✅ Team list posted in ${listsChannel}!`
      : '✅ Team list posted!'
  );
}

// /advance helpers ────────────────────────────────────
async function postWeeklyRecap(guild, guildId, config, meta) {
  const newsChannel = findTextChannel(guild, config.channel_news_feed);
  if (!newsChannel) return;

  const { data: results } = await supabase
    .from('results')
    .select('*, team1:teams!results_team1_id_fkey(team_name), team2:teams!results_team2_id_fkey(team_name)')
    .eq('guild_id', guildId)
    .eq('season', meta.season)
    .eq('week', meta.week)
    .order('created_at', { ascending: true });

  if (!results || results.length === 0) return;

  const lines = results.map(r => {
    const t1     = r.team1?.team_name || 'Team 1';
    const t2     = r.team2?.team_name || 'Team 2';
    const trophy = r.score1 !== r.score2 ? '🏆' : '🤝';
    return `${trophy} **${t1}** ${r.score1} — ${r.score2} **${t2}**`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`📋 Week ${meta.week} Recap — ${config.league_name}`)
    .setColor(config.embed_color_primary_int)
    .setDescription(`Season **${meta.season}** · Week **${meta.week}** · **${results.length}** game${results.length !== 1 ? 's' : ''} played`)
    .setTimestamp();

  for (let i = 0; i < lines.length; i += 15) {
    embed.addFields({
      name:   lines.length > 15 ? `Results (${Math.floor(i / 15) + 1})` : 'Results',
      value:  lines.slice(i, i + 15).join('\n'),
      inline: false,
    });
  }

  await newsChannel.send({ embeds: [embed] });
}

// /advance ────────────────────────────────────────────
async function handleAdvance(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guildId = interaction.guildId;
  guildConfigs.delete(guildId);
  const config = await loadGuildConfig(guildId);

  if (!config.feature_advance_system) {
    return interaction.editReply({ content: '❌ **Advance System Disabled**\nThis feature is turned off. An admin can enable it with `/config features`.' });
  }

  const hoursStr = interaction.options.getString('hours');
  const hours = parseInt(hoursStr);
  const intervals = config.advance_intervals_parsed || [24, 48];
  if (isNaN(hours) || !intervals.includes(hours)) {
    return interaction.editReply({
      content:
        `❌ **Invalid Option: \`${hoursStr}\`**\n` +
        `Please select one of the available options from the dropdown.\n` +
        `Configured intervals: ${intervals.map(h => h + 'h').join(', ')}`,
    });
  }

  const meta = await getMeta(guildId);

  // ── Advance phase/sub-phase ───────────────────────────────────────────
  const currentPhase = meta.current_phase     || 'preseason';
  const currentSub   = meta.current_sub_phase  || 0;
  const phaseDef     = getPhaseByKey(currentPhase);

  let newPhase  = currentPhase;
  let newSub    = currentSub + 1;
  let newSeason = meta.season || 1;

  if (newSub >= phaseDef.subWeeks) {
    const idx     = PHASE_CYCLE.findIndex(p => p.key === currentPhase);
    const nextIdx = (idx + 1) % PHASE_CYCLE.length;
    newPhase      = PHASE_CYCLE[nextIdx].key;
    newSub        = 0;
    if (newPhase === 'preseason') newSeason = newSeason + 1;
  }

  const phaseLabel = formatPhase(newPhase, newSub);
  const deadline   = new Date(Date.now() + hours * 60 * 60 * 1000);

  const formatTZ = (date, tz) =>
    date.toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

  // Mention @head-coach role on public announcement if it exists, else @everyone
  const headCoachRoleName = (config.role_head_coach || 'head coach').trim();
  const headCoachRole     = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === headCoachRoleName.toLowerCase());
  const mention           = headCoachRole ? `<@&${headCoachRole.id}> ` : '@everyone ';

  const embed = new EmbedBuilder()
    .setTitle(`⏭️ Advance — ${phaseLabel} (Season ${newSeason})`)
    .setColor(config.embed_color_primary_int)
    .setDescription(`The league is advancing to **${phaseLabel}**!\nAll tasks must be completed within **${hours} hours**.`)
    .addFields({
      name: '🕐 Deadline',
      value:
        `🌴 ET: **${formatTZ(deadline, 'America/New_York')}**\n` +
        `🌵 CT: **${formatTZ(deadline, 'America/Chicago')}**\n` +
        `🏔️ MT: **${formatTZ(deadline, 'America/Denver')}**\n` +
        `🌊 PT: **${formatTZ(deadline, 'America/Los_Angeles')}**`,
      inline: false,
    })
    .setTimestamp();

  // Only post weekly game recap during regular season.
  // Skip if news-feed and advance-tracker are the same channel — would duplicate.
  if (currentPhase === 'regular') {
    const recapNewsChannel    = findTextChannel(interaction.guild, config.channel_news_feed);
    const recapAdvanceChannel = findTextChannel(interaction.guild, config.channel_advance_tracker);
    const sameChannel = recapNewsChannel && recapAdvanceChannel && recapNewsChannel.id === recapAdvanceChannel.id;
    if (!sameChannel) await postWeeklyRecap(interaction.guild, guildId, config, meta);
  }

  await setMeta(guildId, {
    season:                newSeason,
    week:                  newPhase === 'regular' ? newSub + 1 : meta.week,
    current_phase:         newPhase,
    current_sub_phase:     newSub,
    advance_hours:         hours,
    advance_deadline:      deadline.toISOString(),
    last_advance_at:       new Date().toISOString(),
    next_advance_deadline: deadline.toISOString(),
  });

  const advanceChannel = findTextChannel(interaction.guild, config.channel_advance_tracker);
  if (advanceChannel) {
    await advanceChannel.send({ content: mention, embeds: [embed] });
    await interaction.editReply({ content: `✅ Advance posted in ${advanceChannel}!` });
  } else {
    await interaction.editReply({ content: mention, embeds: [embed] });
  }
}
// /season-advance ─────────────────────────────────────
async function handleSeasonAdvance(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guildId = interaction.guildId;
  const config = await getConfig(guildId);
  const meta = await getMeta(guildId);

  const newSeason = meta.season + 1;

  await setMeta(guildId, {
    season:               newSeason,
    week:                 1,
    current_phase:        'preseason',
    current_sub_phase:    0,
    advance_deadline:     null,
    last_advance_at:      new Date().toISOString(),
    next_advance_deadline: null,
  });

  const embed = new EmbedBuilder()
    .setTitle(`🏆 Season ${newSeason} Has Begun!`)
    .setColor(config.embed_color_primary_int)
    .setDescription(`Season **${meta.season}** is over! Welcome to **Season ${newSeason}**!\nAll records reset. Good luck!`)
    .setTimestamp();

  const advanceChannel = findTextChannel(interaction.guild, config.channel_advance_tracker);
  if (advanceChannel) {
    const hcRoleName  = (config.role_head_coach || 'head coach').trim();
    const hcRole      = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === hcRoleName.toLowerCase());
    const seasonMention = hcRole ? `<@&${hcRole.id}> ` : '@everyone ';

    await advanceChannel.send({ content: seasonMention, embeds: [embed] });
    await interaction.editReply({ content: `✅ Season advance posted in ${advanceChannel}!` });
  } else {
    await interaction.editReply({ embeds: [embed] });
  }

  // Also post to news-feed (optional but recommended)
  const newsChannel = findTextChannel(interaction.guild, config.channel_news_feed);
  if (newsChannel && newsChannel.id !== advanceChannel?.id) {
    await newsChannel.send({ embeds: [embed] });
  }
}
// /move-coach ─────────────────────────────────────────
async function handleMoveCoach(interaction) {
  const guildId     = interaction.guildId;
  const config      = await getConfig(guildId);
  const coachId     = interaction.options.getString('coach');
  const newTeamName = interaction.options.getString('new-team');

  await interaction.deferReply();

  const user = await interaction.guild.members.fetch(coachId).then(m => m.user).catch(() => null);
  if (!user) return interaction.editReply('❌ **Coach Not Found**\nThis user couldn\'t be fetched from the server. They may have left.\n\nIf they\'re still in the server, try running `/move-coach` again and selecting from the autocomplete list.');

  let currentTeam, newTeam;
  try { currentTeam = await getTeamByUser(user.id, guildId); }
  catch (err) { return interaction.editReply(`❌ **Database Error**\nCouldn't load current team for this coach: ${err.message}`); }
  try { newTeam = await getTeamByName(newTeamName, guildId); }
  catch (err) { return interaction.editReply(`❌ **Database Error**\nCouldn't look up destination team "${newTeamName}": ${err.message}`); }

  if (!newTeam) return interaction.editReply(`❌ **Team Not Found: \`${newTeamName}\`**\nThis team doesn't exist in the database. Use the autocomplete dropdown to select a valid destination team.`);
  if (newTeam.user_id && newTeam.user_id !== user.id) {
    return interaction.editReply(`❌ **Team Already Occupied**\n**${newTeam.team_name}** is currently assigned to another coach in this league.\n\nTo move this coach there, first run \`/resetteam\` on the current coach of that team, then try again.`);
  }

  if (currentTeam) await unassignTeam(currentTeam.id, guildId);
  await assignTeam(newTeam.id, user.id, guildId);

  const embed = new EmbedBuilder()
    .setTitle('🔄 Coach Moved')
    .setColor(config.embed_color_primary_int)
    .setDescription(`<@${user.id}> has moved to **${newTeam.team_name}**.`)
    .addFields(
      { name: 'From', value: currentTeam ? currentTeam.team_name : 'No previous team', inline: true },
      { name: 'To',   value: newTeam.team_name,                                         inline: true },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });

  // Post to signed-coaches (preferred) or news-feed
  const signedChannel = findTextChannel(interaction.guild, config.channel_signed_coaches);
  const newsChannel   = findTextChannel(interaction.guild, config.channel_news_feed);
  const announceTarget = signedChannel || newsChannel;
  if (announceTarget && announceTarget.id !== interaction.channelId) {
    await announceTarget.send({ embeds: [embed] });
  }
}

// /checkpermissions ───────────────────────────────────
async function handleCheckPermissions(interaction) {
  const guildId   = interaction.guildId;
  const guild     = interaction.guild;
  const config    = await getConfig(guildId);
  const botMember = guild.members.cache.get(client.user.id) || await guild.members.fetch(client.user.id);

  await interaction.deferReply({ flags: 64 });

  const REQUIRED = ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory'];

  const channelChecks = [
    { key: 'channel_news_feed',       label: 'News Feed',       needsManage: false },
    { key: 'channel_signed_coaches',  label: 'Signed Coaches',  needsManage: false },
    { key: 'channel_team_lists',      label: 'Team Lists',      needsManage: true  },
    { key: 'channel_advance_tracker', label: 'Advance Tracker', needsManage: false },
    { key: 'channel_streaming',       label: 'Streaming',       needsManage: false },
  ];

  const lines  = ['**📺 Channel Permissions**'];
  let allGood  = true;

  for (const check of channelChecks) {
    const chName  = config[check.key];
    if (!chName) { lines.push(`⬜ **${check.label}** — not configured`); continue; }

    const channel = findTextChannel(guild, chName);
    if (!channel) { lines.push(`❌ **${check.label}** — \`#${chName}\` not found`); allGood = false; continue; }

    const perms   = channel.permissionsFor(botMember);
    const missing = REQUIRED.filter(f => !perms.has(f));
    if (check.needsManage && !perms.has('ManageMessages')) missing.push('ManageMessages');

    if (missing.length) {
      lines.push(`❌ **${check.label}** (#${channel.name}) — missing: ${missing.join(', ')}`);
      allGood = false;
    } else {
      lines.push(`✅ **${check.label}** (#${channel.name})`);
    }
  }

  lines.push('', '**🔧 Server Permissions**');
  const guildPerms = botMember.permissions;
  if (guildPerms.has('ManageRoles'))     lines.push('✅ **Manage Roles**');
  else { lines.push('❌ **Manage Roles** — required to assign head coach role'); allGood = false; }
  lines.push(guildPerms.has('ManageNicknames') ? '✅ **Manage Nicknames**' : '⬜ **Manage Nicknames** (optional)');

  lines.push('', '**👑 Role Hierarchy**');
  const hcRole  = guild.roles.cache.find(r => r.name === config.role_head_coach);
  const botRole = botMember.roles.highest;

  if (!hcRole) {
    lines.push(`⬜ Head coach role \`${config.role_head_coach}\` not found — will be created on first assignment`);
  } else if (botRole.position <= hcRole.position) {
    lines.push(`❌ Bot role **${botRole.name}** is below **${hcRole.name}** — move the bot role higher in Server Settings → Roles`);
    allGood = false;
  } else {
    lines.push(`✅ Bot role **${botRole.name}** is above **${hcRole.name}**`);
  }

  const embed = new EmbedBuilder()
    .setTitle(allGood ? '✅ All Permissions OK' : '⚠️ Permission Issues Found')
    .setColor(allGood ? 0x00ff00 : 0xff4444)
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Fix any ❌ items in channel/server settings, then run this again.' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// =====================================================
// AUTOCOMPLETE HANDLER
// =====================================================
async function handleAutocomplete(interaction) {
  const { commandName, guildId } = interaction;
  const focused = interaction.options.getFocused(true);
  const query   = focused.value.toLowerCase();
  let choices   = [];

  try {

  if (commandName === 'assign-team' || commandName === 'any-game-result') {
    const { data: teams, error } = await supabase
      .from('teams')
      .select('id, team_name, conference, star_rating')
      .ilike('team_name', `%${query}%`)
      .order('team_name')
      .limit(25);

    if (error) console.error('[autocomplete] teams query error:', error.message);
    choices = (teams || []).map(t => ({
      name:  `${t.team_name}${t.conference ? ' · ' + t.conference : ''}${t.star_rating ? ' · ' + t.star_rating + '⭐' : ''}`,
      value: t.team_name,
    }));

  } else if (commandName === 'move-coach') {
    if (focused.name === 'coach') {
      const { data: assignments, error } = await supabase
        .from('team_assignments')
        .select('user_id, teams(team_name)')
        .eq('guild_id', guildId);

      if (error) {
        console.error('[autocomplete] move-coach assignments error:', error.message);
      } else {
        // Bulk fetch all members at once instead of one-by-one in a loop
        const guild = client.guilds.cache.get(guildId);
        if (guild) {
          // Filter by query first using cached members, fall back to fetching unknowns
          for (const a of (assignments || [])) {
            const cached = guild.members.cache.get(a.user_id);
            const displayName = cached?.displayName;
            if (!displayName) continue; // skip uncached members — avoids serial API calls
            if (!displayName.toLowerCase().includes(query)) continue;
            choices.push({ name: `${displayName} — ${a.teams?.team_name || 'Unknown'}`, value: a.user_id });
            if (choices.length >= 25) break;
          }
        }
      }

    } else if (focused.name === 'new-team') {
      const { data: teams, error } = await supabase
        .from('teams')
        .select('id, team_name, conference, star_rating')
        .ilike('team_name', `%${query}%`)
        .order('team_name')
        .limit(25);

      if (error) console.error('[autocomplete] move-coach new-team error:', error.message);
      choices = (teams || []).map(t => ({
        name:  `${t.team_name}${t.conference ? ' · ' + t.conference : ''}${t.star_rating ? ' · ' + t.star_rating + '⭐' : ''}`,
        value: t.team_name,
      }));
    }

  } else if (commandName === 'game-result') {
    // Get user's team_id directly (no join) then query teams table same as assign-team
    const { data: assignment } = await supabase
      .from('team_assignments')
      .select('team_id')
      .eq('user_id', interaction.user.id)
      .eq('guild_id', guildId)
      .maybeSingle();

    const userTeamId = assignment?.team_id || null;

    const { data: teams, error } = await supabase
      .from('teams')
      .select('id, team_name, conference, star_rating')
      .ilike('team_name', `%${query}%`)
      .order('team_name')
      .limit(25);

    if (error) console.error('[autocomplete] game-result teams error:', error.message);
    choices = (teams || [])
      .filter(t => t.id !== userTeamId)
      .map(t => ({
        name:  `${t.team_name}${t.conference ? ' · ' + t.conference : ''}${t.star_rating ? ' · ' + t.star_rating + '⭐' : ''}`,
        value: t.team_name,
      }));

  } else if (commandName === 'resetteam') {
    // Get assigned team_ids first (no join), then look up teams directly
    const { data: assignments, error: aErr } = await supabase
      .from('team_assignments')
      .select('team_id')
      .eq('guild_id', guildId);

    if (aErr) console.error('[autocomplete] resetteam assignments error:', aErr.message);

    const assignedIds = (assignments || []).map(a => a.team_id);
    if (assignedIds.length > 0) {
      const { data: teams, error: tErr } = await supabase
        .from('teams')
        .select('id, team_name, conference, star_rating')
        .in('id', assignedIds)
        .ilike('team_name', `%${query}%`)
        .order('team_name')
        .limit(25);

      if (tErr) console.error('[autocomplete] resetteam teams error:', tErr.message);
      choices = (teams || []).map(t => ({
        name:  `${t.team_name}${t.conference ? ' · ' + t.conference : ''}${t.star_rating ? ' · ' + t.star_rating + '⭐' : ''}`,
        value: t.team_name,
      }));
    }

  } else if (commandName === 'advance') {
    // Always load fresh config so intervals reflect latest settings
    guildConfigs.delete(guildId);
    const advConfig  = await loadGuildConfig(guildId);
    const intervals  = advConfig.advance_intervals_parsed || [24, 48];
    choices = intervals
      .filter(h => String(h).includes(query))
      .map(h => ({ name: `${h} Hours`, value: String(h) }));

  } else if (commandName === 'config' && focused.name === 'setting') {
    const allSettings = [
      { label: 'League Name',             key: 'league_name',                hint: 'League display name' },
      { label: 'League Abbreviation',     key: 'league_abbreviation',        hint: 'Short name for stream detection' },
      { label: 'News Feed Channel',       key: 'channel_news_feed',          hint: 'Channel for results & announcements' },
      { label: 'Advance Tracker Channel', key: 'channel_advance_tracker',    hint: 'Channel for advance notices' },
      { label: 'Team Lists Channel',      key: 'channel_team_lists',         hint: 'Channel for team availability list' },
      { label: 'Signed Coaches Channel',  key: 'channel_signed_coaches',     hint: 'Channel for signing announcements' },
      { label: 'Streaming Channel',       key: 'channel_streaming',          hint: 'Channel to monitor for stream links' },
      { label: 'Head Coach Role',         key: 'role_head_coach',            hint: 'Role assigned to coaches' },
      { label: 'Min Star Rating',         key: 'star_rating_for_offers',     hint: 'Minimum star rating for job offers' },
      { label: 'Max Star Rating',         key: 'star_rating_max_for_offers', hint: 'Maximum star rating for job offers' },
      { label: 'Offers Per User',         key: 'job_offers_count',           hint: 'Number of offers per user' },
      { label: 'Offer Expiry Hours',      key: 'job_offers_expiry_hours',    hint: 'Hours before offers expire (1–24)' },
      { label: 'Stream Reminder Minutes', key: 'stream_reminder_minutes',    hint: 'Minutes before stream reminder fires' },
      { label: 'Advance Intervals',       key: 'advance_intervals',          hint: 'Available advance intervals e.g. [24,48]' },
      { label: 'Primary Embed Color',     key: 'embed_color_primary',        hint: 'Primary embed color hex e.g. 0x1e90ff' },
      { label: 'Win Embed Color',         key: 'embed_color_win',            hint: 'Win result embed color hex' },
      { label: 'Loss Embed Color',        key: 'embed_color_loss',           hint: 'Loss result embed color hex' },
    ];
    choices = allSettings
      .filter(s => s.label.toLowerCase().includes(query) || s.key.includes(query) || s.hint.toLowerCase().includes(query))
      .slice(0, 25)
      .map(s => ({ name: `${s.label} — ${s.hint}`, value: s.key }));

  } else if (commandName === 'config' && focused.name === 'value') {
    const setting = interaction.options.getString('setting') || '';
    const guild   = client.guilds.cache.get(guildId);

    if (setting.startsWith('channel_') && guild) {
      choices = [...guild.channels.cache
        .filter(c => c.type === ChannelType.GuildText && c.name.toLowerCase().includes(query))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(c => ({ name: `#${c.name}`, value: c.name }))
      ].slice(0, 25);

    } else if (setting === 'role_head_coach' && guild) {
      choices = [...guild.roles.cache
        .filter(r => !r.managed && r.name !== '@everyone' && r.name.toLowerCase().includes(query))
        .sort((a, b) => b.position - a.position)
        .map(r => ({ name: `@${r.name}`, value: r.name }))
      ].slice(0, 25);

    } else if (setting === 'star_rating_for_offers' || setting === 'star_rating_max_for_offers') {
      choices = ['1.0','1.5','2.0','2.5','3.0','3.5','4.0','4.5','5.0']
        .filter(v => v.includes(query)).map(v => ({ name: `${v} stars`, value: v }));

    } else if (setting === 'job_offers_expiry_hours') {
      choices = ['1','2','4','6','8','12','16','24']
        .filter(v => v.includes(query)).map(v => ({ name: `${v} hours`, value: v }));

    } else if (setting === 'job_offers_count') {
      choices = ['1','2','3','4','5']
        .filter(v => v.includes(query)).map(v => ({ name: `${v} offers`, value: v }));

    } else if (setting === 'stream_reminder_minutes') {
      choices = ['15','30','45','60','90','120']
        .filter(v => v.includes(query)).map(v => ({ name: `${v} minutes`, value: v }));

    } else if (setting === 'advance_intervals') {
      choices = ['[24, 48]','[12, 24, 48]','[24]','[48]','[6, 12, 24, 48]']
        .filter(v => v.includes(query)).map(v => ({ name: v, value: v }));

    } else if (setting.startsWith('embed_color_')) {
      choices = [
        { name: 'Blue (default)', value: '0x1e90ff' },
        { name: 'Green',          value: '0x00ff00' },
        { name: 'Red',            value: '0xff0000' },
        { name: 'Gold',           value: '0xffd700' },
        { name: 'Purple',         value: '0x9b59b6' },
        { name: 'Orange',         value: '0xff8c00' },
        { name: 'White',          value: '0xffffff' },
        { name: 'Black',          value: '0x000000' },
      ].filter(c => c.name.toLowerCase().includes(query) || c.value.includes(query));
    }
  }

  } catch (err) {
    console.error('[autocomplete] Unhandled error:', err.message);
    choices = []; // respond with empty list so Discord doesn't show "loading failed"
  }

  // Always respond — never leave an autocomplete interaction hanging
  if (!interaction.responded) {
    await interaction.respond(choices).catch(e => {
      // Token may have expired if we took too long — log and move on
      if (e.code !== 10062) console.error('[autocomplete] respond error:', e.message);
    });
  }
}

// =====================================================
// INTERACTION ROUTER
// =====================================================
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) return handleAutocomplete(interaction);

    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'setup':             return handleSetup(interaction);
        case 'checkpermissions':  return handleCheckPermissions(interaction);
        case 'joboffers':         return handleJobOffers(interaction);
        case 'game-result':       return handleGameResult(interaction);
        case 'any-game-result':   return handleAnyGameResult(interaction);
        case 'press-release':     return handlePressRelease(interaction);
        case 'ranking':           return handleRanking(interaction);
        case 'ranking-all-time':  return handleRankingAllTime(interaction);
        case 'assign-team':       return handleAssignTeam(interaction);
        case 'resetteam':         return handleResetTeam(interaction);
        case 'listteams':         return handleListTeams(interaction);
        case 'advance':           return handleAdvance(interaction);
        case 'season-advance':    return handleSeasonAdvance(interaction);
        case 'move-coach':        return handleMoveCoach(interaction);
        case 'set-stream':        return handleSetStream(interaction);
        case 'list-streamers':    return handleListStreamers(interaction);
        case 'config':
          switch (interaction.options.getSubcommand()) {
            case 'view':     return handleConfigView(interaction);
            case 'features': return handleConfigFeatures(interaction);
            case 'edit':     return handleConfigEdit(interaction);
            case 'reload':   return handleConfigReload(interaction);
          }
          break;
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('accept-offer_')) return handleAcceptOffer(interaction);
    }
    
    if (interaction.isButton() && interaction.customId === 'copy_stream_list') {
  await interaction.deferUpdate();

  // Discord doesn't allow direct clipboard write from bot
  // So we give the user a code block they can easily copy
  const message = interaction.message.content.replace(/```/g, '').trim();

  await interaction.followUp({
    content: 'Copy the text below (click the code block and press Ctrl+C / Cmd+C):\n\n```' + message + '```',
    flags: 64 });
    }
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith('features-toggle-')) {
        const guildId  = interaction.guildId;
        const selected = interaction.values;
        const allFeatures = ['feature_job_offers','feature_stream_reminders','feature_advance_system','feature_press_releases','feature_rankings'];
        const updates  = Object.fromEntries(allFeatures.map(f => [f, selected.includes(f)]));
        await saveConfig(guildId, updates);
        const lines = allFeatures.map(f => `${updates[f] ? '✅' : '❌'} ${f.replace('feature_', '').replace(/_/g, ' ')}`);
        await interaction.update({ content: `**Features updated:**\n${lines.join('\n')}`, components: [] });
      }
    }

  } catch (err) {
    console.error('[interaction] Error:', err);
    const msg = { content: `❌ **Unexpected Error**\n\`\`\`${err.message}\`\`\`\nThis has been logged. If it keeps happening, try \`/config reload\` to refresh settings, or check your Render logs for details.`, flags: 64 };
    if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

// =====================================================
// MESSAGE LISTENER — Stream Reminders
// =====================================================
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guildId) return;

  const config = await getConfig(message.guildId).catch(() => null);
  if (!config?.feature_stream_reminders) return;

  if (message.channel.name?.toLowerCase() !== config.channel_streaming?.toLowerCase()) return;

  const streamRegex = /https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be|twitch\.tv)\/[^\s<>"')]+/i;
  if (!streamRegex.test(message.content)) return;

  const minutes = config.stream_reminder_minutes || 45;

  scheduleStreamReminder(message.channel, message.author.id, message.guildId, minutes);
});

// =====================================================
// GUILD AUTO-SETUP
// =====================================================
async function initGuild(guild) {
  try {
    const { data } = await supabase.from('config').select('guild_id').eq('guild_id', guild.id).single();
    if (data) {
      console.log(`[guild] Config exists for ${guild.name} (${guild.id})`);
      return;
    }

    await createDefaultConfig(guild.id, guild.name);
    await supabase.from('meta').upsert({
      guild_id:          guild.id,
      season:            1,
      week:              1,
      current_phase:     'preseason',
      current_sub_phase: 0,
    }, { onConflict: 'guild_id' });
    console.log(`[guild] Auto-created config for: ${guild.name} (${guild.id})`);

    const owner = await guild.fetchOwner().catch(() => null);
    if (owner) {
      const embed = new EmbedBuilder()
        .setTitle('👋 Dynasty Bot is Ready!')
        .setColor(0x1e90ff)
        .setDescription(
          `Thanks for adding Dynasty Bot to **${guild.name}**!\n\n` +
          `A default configuration has been created. Run \`/setup\` to customize your league settings, or \`/config view\` to see the defaults.`
        )
        .addFields({ name: '📋 Next Steps', value:
          '1. Run `/setup` to configure your league\n' +
          '2. Use `/listteams` to post available teams\n' +
          '3. Use `/assign-team` to assign coaches',
        });
      await owner.send({ embeds: [embed] }).catch(() => {
        console.log(`[guild] Could not DM owner of ${guild.name}`);
      });
    }
  } catch (err) {
    console.error(`[guild] Failed to init ${guild.name} (${guild.id}):`, err.message);
  }
}

client.on(Events.GuildCreate, async (guild) => {
  console.log(`[guild] Joined: ${guild.name} (${guild.id})`);
  await initGuild(guild);
});

// =====================================================
// BOT READY
// =====================================================
client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] Logged in as ${c.user.tag}`);
  await registerCommands();

  console.log(`[bot] Syncing ${c.guilds.cache.size} guild(s)...`);
  for (const guild of c.guilds.cache.values()) await initGuild(guild);
  console.log(`[bot] Ready! Serving ${c.guilds.cache.size} guild(s).`);

  expireJobOffers();
  setInterval(expireJobOffers, 30 * 60 * 1000);
});

// =====================================================
// LOGIN
// =====================================================
client.login(DISCORD_TOKEN);
