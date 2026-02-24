// =====================================================
// Universal Dynasty League Bot - index.js
// Version: 2.0.0 (Universal Multi-Server)
// =====================================================

require('dotenv').config();
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
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const CLIENT_ID       = process.env.CLIENT_ID;
const PORT            = process.env.PORT || 3000;
const SELF_PING_URL   = process.env.SELF_PING_URL || '';

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
// CONFIG CACHE (per guild)
// =====================================================
const guildConfigs = new Map();

async function loadGuildConfig(guildId) {
  const { data, error } = await supabase
    .from('config')
    .select('*')
    .eq('guild_id', guildId)
    .single();

  if (error || !data) {
    console.log(`[config] No config found for guild ${guildId}, using defaults.`);
    const defaults = buildDefaultConfig(guildId);
    guildConfigs.set(guildId, defaults);
    return defaults;
  }

  // Parse advance_intervals JSON
  let intervals = [24, 48];
  try { intervals = JSON.parse(data.advance_intervals); } catch (_) {}
  data.advance_intervals_parsed = intervals;

  // Parse colors
  data.embed_color_primary_int = parseInt(data.embed_color_primary, 16) || 0x1e90ff;
  data.embed_color_win_int     = parseInt(data.embed_color_win, 16)     || 0x00ff00;
  data.embed_color_loss_int    = parseInt(data.embed_color_loss, 16)    || 0xff0000;

  guildConfigs.set(guildId, data);
  console.log(`[config] Loaded config for guild ${guildId}: ${data.league_name}`);
  return data;
}

async function getConfig(guildId) {
  if (guildConfigs.has(guildId)) return guildConfigs.get(guildId);
  return loadGuildConfig(guildId);
}

async function saveConfig(guildId, updates) {
  updates.updated_at = new Date().toISOString();
  const { error } = await supabase
    .from('config')
    .update(updates)
    .eq('guild_id', guildId);
  if (error) throw error;
  // Bust cache
  guildConfigs.delete(guildId);
  return loadGuildConfig(guildId);
}

async function createDefaultConfig(guildId, leagueName = 'Dynasty League') {
  const defaults = buildDefaultConfig(guildId, leagueName);
  const { error } = await supabase.from('config').upsert({
    guild_id: guildId,
    league_name: leagueName,
    league_abbreviation: '',
    feature_job_offers: true,
    feature_stream_reminders: true,
    feature_advance_system: true,
    feature_press_releases: true,
    feature_rankings: true,
    channel_news_feed: 'news-feed',
    channel_advance_tracker: 'advance-tracker',
    channel_team_lists: 'team-lists',
    channel_signed_coaches: 'signed-coaches',
    channel_streaming: 'streaming',
    role_head_coach: 'head coach',
    star_rating_for_offers: 2.5,
    star_rating_max_for_offers: null,
    job_offers_count: 3,
    job_offers_expiry_hours: 48,
    stream_reminder_minutes: 45,
    advance_intervals: '[24, 48]',
    embed_color_primary: '0x1e90ff',
    embed_color_win: '0x00ff00',
    embed_color_loss: '0xff0000',
  }, { onConflict: 'guild_id' });
  if (error) throw error;
  guildConfigs.delete(guildId);
  return loadGuildConfig(guildId);
}

function buildDefaultConfig(guildId, leagueName = 'Dynasty League') {
  return {
    guild_id: guildId,
    league_name: leagueName,
    league_abbreviation: '',
    feature_job_offers: true,
    feature_stream_reminders: true,
    feature_advance_system: true,
    feature_press_releases: true,
    feature_rankings: true,
    channel_news_feed: 'news-feed',
    channel_advance_tracker: 'advance-tracker',
    channel_team_lists: 'team-lists',
    channel_signed_coaches: 'signed-coaches',
    channel_streaming: 'streaming',
    role_head_coach: 'head coach',
    role_head_coach_id: null,
    star_rating_for_offers: 2.5,
    star_rating_max_for_offers: null,
    job_offers_count: 3,
    job_offers_expiry_hours: 48,
    stream_reminder_minutes: 45,
    advance_intervals: '[24, 48]',
    advance_intervals_parsed: [24, 48],
    embed_color_primary: '0x1e90ff',
    embed_color_win: '0x00ff00',
    embed_color_loss: '0xff0000',
    embed_color_primary_int: 0x1e90ff,
    embed_color_win_int: 0x00ff00,
    embed_color_loss_int: 0xff0000,
  };
}

// =====================================================
// DISCORD HELPERS
// =====================================================
function findTextChannel(guild, name) {
  return guild.channels.cache.find(
    c => c.type === ChannelType.GuildText && c.name.toLowerCase() === name.toLowerCase()
  );
}

async function findOrCreateRole(guild, roleName) {
  let role = guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
  if (!role) {
    role = await guild.roles.create({ name: roleName, reason: 'Dynasty Bot auto-created role' });
  }
  return role;
}


function isAdminOrMod(member) {
  return member.permissions.has(PermissionFlagsBits.ManageGuild) ||
         member.permissions.has(PermissionFlagsBits.Administrator);
}

function starRating(rating) {
  const full  = Math.floor(rating);
  const half  = (rating % 1) >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return '⭐'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);
}

// =====================================================
// SUPABASE HELPERS
// =====================================================
// Get the team a user is assigned to in a specific guild
async function getTeamByUser(userId, guildId) {
  const { data } = await supabase
    .from('team_assignments')
    .select('*, teams(*)')
    .eq('user_id', userId)
    .eq('guild_id', guildId)
    .single();
  return data ? { ...data.teams, user_id: data.user_id, assignment_id: data.id } : null;
}

// Get a team by name (global) and attach assignment info for a specific guild
async function getTeamByName(teamName, guildId) {
  const { data: team } = await supabase
    .from('teams')
    .select('*')
    .ilike('team_name', teamName)
    .single();
  if (!team) return null;

  const { data: assignment } = await supabase
    .from('team_assignments')
    .select('*')
    .eq('team_id', team.id)
    .eq('guild_id', guildId)
    .single();

  return { ...team, user_id: assignment?.user_id || null, assignment_id: assignment?.id || null };
}

// Get all global teams with assignment info for a specific guild
async function getAllTeams(guildId) {
  const { data: teams } = await supabase
    .from('teams')
    .select('*')
    .order('team_name');
  if (!teams) return [];

  const { data: assignments } = await supabase
    .from('team_assignments')
    .select('*')
    .eq('guild_id', guildId);

  const assignMap = {};
  for (const a of (assignments || [])) assignMap[a.team_id] = a;

  return teams.map(t => ({
    ...t,
    user_id: assignMap[t.id]?.user_id || null,
    assignment_id: assignMap[t.id]?.id || null,
  }));
}

// Get all unassigned teams for a specific guild
async function getAvailableTeams(guildId) {
  const all = await getAllTeams(guildId);
  return all.filter(t => !t.user_id);
}

// Assign a team to a user in a guild
async function assignTeam(teamId, userId, guildId) {
  await supabase
    .from('team_assignments')
    .upsert({ team_id: teamId, user_id: userId, guild_id: guildId }, { onConflict: 'team_id,guild_id' });
}

// Remove a team assignment for a user in a guild
async function unassignTeam(teamId, guildId) {
  await supabase
    .from('team_assignments')
    .delete()
    .eq('team_id', teamId)
    .eq('guild_id', guildId);
}

async function getMeta(guildId) {
  const { data } = await supabase
    .from('meta')
    .select('*')
    .eq('guild_id', guildId)
    .single();
  return data || { season: 1, week: 1, advance_hours: 24, advance_deadline: null };
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
// SLASH COMMANDS DEFINITION
// =====================================================
function buildCommands() {
  return [
    // ---- USER COMMANDS ----
    new SlashCommandBuilder()
      .setName('joboffers')
      .setDescription('Get coaching job offers based on your current team rating'),

    new SlashCommandBuilder()
      .setName('game-result')
      .setDescription('Submit your game result')
      .addStringOption(o => o.setName('opponent').setDescription('Opponent team name').setRequired(true).setAutocomplete(true))
      .addIntegerOption(o => o.setName('your-score').setDescription('Your score').setRequired(true))
      .addIntegerOption(o => o.setName('opponent-score').setDescription('Opponent score').setRequired(true)),

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

    // ---- ADMIN COMMANDS ----
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
          .addStringOption(o => o.setName('setting').setDescription('Setting name').setRequired(true))
          .addStringOption(o => o.setName('value').setDescription('New value').setRequired(true))
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
      .addIntegerOption(o => o.setName('hours').setDescription('Hours until advance').setRequired(false)),

    new SlashCommandBuilder()
      .setName('season-advance')
      .setDescription('Advance to next season (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
      .setName('move-coach')
      .setDescription('Move a coach from one team to another (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption(o => o.setName('user').setDescription('Coach to move').setRequired(true))
      .addStringOption(o => o.setName('new-team').setDescription('Destination team').setRequired(true).setAutocomplete(true)),

    new SlashCommandBuilder()
      .setName('any-game-result')
      .setDescription('Enter a result for any two teams (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption(o => o.setName('team1').setDescription('First team name').setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName('team2').setDescription('Second team name').setRequired(true).setAutocomplete(true))
      .addIntegerOption(o => o.setName('score1').setDescription('Team 1 score').setRequired(true))
      .addIntegerOption(o => o.setName('score2').setDescription('Team 2 score').setRequired(true)),
  ].map(cmd => cmd.toJSON());
}

// =====================================================
// REGISTER SLASH COMMANDS
// =====================================================
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
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
// STREAM REMINDER TRACKING
// =====================================================
const streamReminderTimers = new Map(); // channelId -> timeout

function scheduleStreamReminder(channel, userId, guildId, minutes) {
  const key = `${guildId}-${channel.id}-${userId}`;
  if (streamReminderTimers.has(key)) return; // already scheduled
  const ms = minutes * 60 * 1000;
  const timer = setTimeout(async () => {
    streamReminderTimers.delete(key);
    try {
      await channel.send(`<@${userId}> ⏰ **Stream Reminder:** ${minutes} minutes have passed since you posted your stream link! Make sure you've notified your opponent.`);
    } catch (e) {
      console.error('[stream] Could not send reminder:', e.message);
    }
  }, ms);
  streamReminderTimers.set(key, timer);
}

// =====================================================
// COMMAND HANDLERS
// =====================================================

// /setup
async function handleSetup(interaction) {
  const guildId = interaction.guildId;
  const userId  = interaction.user.id;

  // Open a DM with the admin and run the entire conversation there
  let dm;
  try {
    dm = await interaction.user.createDM();
  } catch {
    return interaction.reply({
      content: "❌ I couldn't open a DM with you. Please enable DMs from server members and try again.",
      ephemeral: true,
    });
  }

  await interaction.reply({ content: '📬 Check your DMs — setup wizard is waiting!', ephemeral: true });
  await dm.send("👋 **Dynasty Bot Setup Wizard**\nAnswer each question in this DM. You have 2 minutes per question.");

  const guild = interaction.guild;

  // ── Generic ask (free text) ───────────────────────────────────────────────
  const ask = async (question) => {
    await dm.send(question);
    try {
      const col = await dm.awaitMessages({ filter: m => m.author.id === userId && !m.author.bot, max: 1, time: 120000, errors: ['time'] });
      return col.first().content.trim();
    } catch {
      await dm.send('⏰ Setup timed out. Run `/setup` in your server again to restart.');
      return null;
    }
  };

  const askWithDefault = async (question, defaultVal) => {
    const answer = await ask(question);
    if (!answer) return null;
    return answer.toLowerCase() === 'default' ? String(defaultVal) : answer;
  };

  // ── Pick list helper — sends a numbered list and returns the chosen item ──
  const askPickList = async (header, items, labelFn) => {
    const lines = items.map((item, i) => `\`${i + 1}\` — ${labelFn(item)}`);
    await dm.send(`${header}\n\n${lines.join('\n')}`);
    try {
      const col = await dm.awaitMessages({
        filter: m => m.author.id === userId && !m.author.bot,
        max: 1, time: 120000, errors: ['time'],
      });
      const idx = parseInt(col.first().content.trim()) - 1;
      if (isNaN(idx) || idx < 0 || idx >= items.length) {
        await dm.send('❌ Invalid selection. Run `/setup` again to restart.');
        return null;
      }
      return items[idx];
    } catch {
      await dm.send('⏰ Setup timed out. Run `/setup` in your server again to restart.');
      return null;
    }
  };

  // Get all text channels and roles from the guild up front
  const textChannels = guild.channels.cache
    .filter(c => c.type === 0) // GuildText
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(c => c);

  const roles = guild.roles.cache
    .filter(r => !r.managed && r.name !== '@everyone')
    .sort((a, b) => b.position - a.position)
    .map(r => r);

  // ── League info ───────────────────────────────────────────────────────────
  const leagueName = await ask('**[League 1/2]** What is your league name?\nExample: CMR Dynasty');
  if (!leagueName) return;

  const leagueAbbr = await ask('**[League 2/2]** What is your league abbreviation or keyword?\nThis will be used to identify your league in stream titles.\nExample: CMR');
  if (!leagueAbbr) return;

  // ── Channels ──────────────────────────────────────────────────────────────
  await dm.send('**— Channel Setup —**\nSelect your channels from the list. Reply with the number next to each channel.');

  const newsFeedCh = await askPickList(
    '**[Channel 1/5]** Which channel should game results and announcements post to? (News Feed)',
    textChannels, c => `#${c.name}`
  );
  if (!newsFeedCh) return;

  const signedCh = await askPickList(
    '**[Channel 2/5]** Which channel should signing announcements post to? (Signed Coaches)',
    textChannels, c => `#${c.name}`
  );
  if (!signedCh) return;

  const teamListCh = await askPickList(
    '**[Channel 3/5]** Which channel should the team availability list post to? (Team Lists)',
    textChannels, c => `#${c.name}`
  );
  if (!teamListCh) return;

  const advanceCh = await askPickList(
    '**[Channel 4/5]** Which channel should advance notices post to? (Advance Tracker)',
    textChannels, c => `#${c.name}`
  );
  if (!advanceCh) return;

  const streamCh = await askPickList(
    '**[Channel 5/5]** Which channel should stream links be monitored in? (Streaming)',
    textChannels, c => `#${c.name}`
  );
  if (!streamCh) return;

  // ── Head Coach Role ───────────────────────────────────────────────────────
  let headCoachRole;
  if (roles.length > 0) {
    headCoachRole = await askPickList(
      '**— Role Setup —**\nWhich role should be assigned to head coaches?\n(If the role does not exist yet, pick the closest one — you can update it later with `/config edit`)',
      roles, r => `@${r.name}`
    );
    if (!headCoachRole) return;
  } else {
    await dm.send('⚠️ No roles found in the server. The bot will create a "head coach" role automatically when the first coach is assigned.');
  }

  const channelConfig = {
    channel_news_feed:       newsFeedCh.name,
    channel_signed_coaches:  signedCh.name,
    channel_team_lists:      teamListCh.name,
    channel_advance_tracker: advanceCh.name,
    channel_streaming:       streamCh.name,
    role_head_coach:         headCoachRole ? headCoachRole.name : 'head coach',
    role_head_coach_id:      headCoachRole ? headCoachRole.id   : null,
  };

  // ── Features ──────────────────────────────────────────────────────────────
  const featureInput = await ask(
    '**— Feature Selection —**\n' +
    'Which features would you like to enable? Reply with a comma-separated list:\n\n' +
    '1 — Job Offers\n' +
    '2 — Stream Reminders\n' +
    '3 — Advance System\n' +
    '4 — Press Releases\n' +
    '5 — Rankings\n\n' +
    'Example: 1,2,3,4,5 for all'
  );
  if (!featureInput) return;

  const enabled = featureInput.split(',').map(n => parseInt(n.trim()));
  const features = {
    feature_job_offers:       enabled.includes(1),
    feature_stream_reminders: enabled.includes(2),
    feature_advance_system:   enabled.includes(3),
    feature_press_releases:   enabled.includes(4),
    feature_rankings:         enabled.includes(5),
  };

  // ── Job Offers follow-up ──────────────────────────────────────────────────
  let jobOffersConfig = { star_rating_for_offers: 2.5, star_rating_max_for_offers: null, job_offers_count: 3, job_offers_expiry_hours: 24 };

  if (features.feature_job_offers) {
    await dm.send('**— Job Offers Setup —**\nYou enabled job offers. Answer the next 4 questions to configure it.');

    const starMin = await askWithDefault('**[Job Offers 1/4]** Minimum star rating for job offers? (1.0 – 5.0)\nDefault: 2.5', '2.5');
    if (!starMin) return;

    const starMax = await askWithDefault('**[Job Offers 2/4]** Maximum star rating? Type none for no cap.\nDefault: none', 'none');
    if (!starMax) return;

    const offersCount = await askWithDefault('**[Job Offers 3/4]** How many offers should each user receive?\nDefault: 3', '3');
    if (!offersCount) return;

    const offersExpiry = await askWithDefault('**[Job Offers 4/4]** How many hours should offers last before expiring? (1 – 24 hours)\nDefault: 24', '24');
    if (!offersExpiry) return;

    jobOffersConfig = {
      star_rating_for_offers:     parseFloat(starMin) || 2.5,
      star_rating_max_for_offers: starMax.toLowerCase() === 'none' ? null : (parseFloat(starMax) || null),
      job_offers_count:           parseInt(offersCount) || 3,
      job_offers_expiry_hours:    Math.min(24, Math.max(1, parseInt(offersExpiry) || 24)),
    };
  }

  // ── Stream Reminders follow-up ────────────────────────────────────────────
  let streamConfig = { stream_reminder_minutes: 45 };

  if (features.feature_stream_reminders) {
    const reminderMins = await askWithDefault(
      '**— Stream Reminders Setup —**\nHow many minutes after a stream link is posted should the bot send a reminder?\nDefault: 45', '45'
    );
    if (!reminderMins) return;
    streamConfig = { stream_reminder_minutes: parseInt(reminderMins) || 45 };
  }

  // ── Advance System follow-up ──────────────────────────────────────────────
  let advanceConfig = { advance_intervals: '[24, 48]' };

  if (features.feature_advance_system) {
    const advanceInput = await askWithDefault(
      '**— Advance System Setup —**\nWhat advance intervals (hours) should be available? Enter as a JSON array.\nExample: [24, 48] or [12, 24, 48]\nDefault: [24, 48]', '[24, 48]'
    );
    if (!advanceInput) return;
    advanceConfig = { advance_intervals: advanceInput };
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  try {
    await createDefaultConfig(guildId, leagueName);
    await saveConfig(guildId, {
      league_name:         leagueName,
      league_abbreviation: leagueAbbr,
      ...channelConfig,
      ...features,
      ...jobOffersConfig,
      ...streamConfig,
      ...advanceConfig,
    });

    const summaryFields = [
      { name: 'League Name',      value: leagueName,              inline: true },
      { name: 'Abbreviation',     value: leagueAbbr,              inline: true },
      { name: '​',           value: '​',                inline: true },
      { name: 'News Feed',        value: `#${newsFeedCh.name}`,   inline: true },
      { name: 'Signed Coaches',   value: `#${signedCh.name}`,     inline: true },
      { name: 'Team Lists',       value: `#${teamListCh.name}`,   inline: true },
      { name: 'Advance Tracker',  value: `#${advanceCh.name}`,    inline: true },
      { name: 'Streaming',        value: `#${streamCh.name}`,     inline: true },
      { name: 'Head Coach Role',  value: channelConfig.role_head_coach, inline: true },
      { name: '​',           value: '​',                inline: true },
      { name: 'Job Offers',       value: features.feature_job_offers       ? '✅' : '❌', inline: true },
      { name: 'Stream Reminders', value: features.feature_stream_reminders ? '✅' : '❌', inline: true },
      { name: 'Advance System',   value: features.feature_advance_system   ? '✅' : '❌', inline: true },
      { name: 'Press Releases',   value: features.feature_press_releases   ? '✅' : '❌', inline: true },
      { name: 'Rankings',         value: features.feature_rankings         ? '✅' : '❌', inline: true },
      { name: '​',           value: '​',                inline: true },
    ];

    if (features.feature_job_offers) {
      const maxStr = jobOffersConfig.star_rating_max_for_offers ? jobOffersConfig.star_rating_max_for_offers + ' stars' : 'No cap';
      summaryFields.push(
        { name: 'Min Star Rating', value: jobOffersConfig.star_rating_for_offers + ' stars', inline: true },
        { name: 'Max Star Rating', value: maxStr,                                             inline: true },
        { name: 'Offers Per User', value: String(jobOffersConfig.job_offers_count),           inline: true },
        { name: 'Offer Expiry',    value: jobOffersConfig.job_offers_expiry_hours + ' hrs',   inline: true },
      );
    }
    if (features.feature_stream_reminders) {
      summaryFields.push({ name: 'Stream Reminder', value: streamConfig.stream_reminder_minutes + ' min', inline: true });
    }
    if (features.feature_advance_system) {
      summaryFields.push({ name: 'Advance Intervals', value: advanceConfig.advance_intervals, inline: true });
    }

    const embed = new EmbedBuilder()
      .setTitle('✅ Setup Complete!')
      .setColor(0x00ff00)
      .setDescription('Your league is configured! Use `/config view` to review or `/config edit` to change anything.')
      .addFields(summaryFields);

    await dm.send({ embeds: [embed] });
  } catch (err) {
    await dm.send(`❌ Setup failed: ${err.message}`);
  }
}

// /config view
async function handleConfigView(interaction) {
  const config = await getConfig(interaction.guildId);
  const embed = new EmbedBuilder()
    .setTitle(`⚙️ ${config.league_name} — Bot Configuration`)
    .setColor(config.embed_color_primary_int || 0x1e90ff)
    .addFields(
      { name: '📌 League', value: config.league_name, inline: true },
      { name: '🔤 Abbreviation', value: config.league_abbreviation || 'Not set', inline: true },
      { name: '🆔 Guild ID', value: config.guild_id, inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
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
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// /config features
async function handleConfigFeatures(interaction) {
  const config = await getConfig(interaction.guildId);

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`features-toggle-${interaction.guildId}`)
      .setPlaceholder('Select features to toggle...')
      .setMinValues(0)
      .setMaxValues(6)
      .addOptions([
        { label: 'Job Offers', value: 'feature_job_offers', description: 'Enable/disable job offer system', default: config.feature_job_offers },
        { label: 'Stream Reminders', value: 'feature_stream_reminders', description: 'Enable/disable stream reminders', default: config.feature_stream_reminders },
        { label: 'Advance System', value: 'feature_advance_system', description: 'Enable/disable advance system', default: config.feature_advance_system },
        { label: 'Press Releases', value: 'feature_press_releases', description: 'Enable/disable press releases', default: config.feature_press_releases },
        { label: 'Rankings', value: 'feature_rankings', description: 'Enable/disable rankings', default: config.feature_rankings },
      ])
  );

  await interaction.reply({
    content: '**Feature Toggles** — Select the features you want **ENABLED** (deselect to disable):',
    components: [row],
    ephemeral: true,
  });
}

// /config edit
async function handleConfigEdit(interaction) {
  const setting = interaction.options.getString('setting');
  const value   = interaction.options.getString('value');
  const allowed = [
    'league_name', 'league_abbreviation', 'channel_news_feed', 'channel_advance_tracker', 'channel_team_lists',
    'channel_signed_coaches', 'channel_streaming', 'role_head_coach',
    'star_rating_for_offers', 'star_rating_max_for_offers', 'job_offers_count', 'job_offers_expiry_hours', 'stream_reminder_minutes', 'advance_intervals',
    'embed_color_primary', 'embed_color_win', 'embed_color_loss',
  ];
  if (!allowed.includes(setting)) {
    return interaction.reply({ content: `❌ Unknown setting \`${setting}\`. Allowed: ${allowed.join(', ')}`, ephemeral: true });
  }
  try {
    await saveConfig(interaction.guildId, { [setting]: value });
    await interaction.reply({ content: `✅ Updated **${setting}** to \`${value}\``, ephemeral: true });
  } catch (err) {
    await interaction.reply({ content: `❌ Failed to update: ${err.message}`, ephemeral: true });
  }
}

// /config reload
async function handleConfigReload(interaction) {
  guildConfigs.delete(interaction.guildId);
  const config = await loadGuildConfig(interaction.guildId);
  await interaction.reply({ content: `✅ Config reloaded for **${config.league_name}**!`, ephemeral: true });
}

// /joboffers
async function handleJobOffers(interaction) {
  const guildId = interaction.guildId;
  const userId  = interaction.user.id;
  const config  = await getConfig(guildId);

  if (!config.feature_job_offers) {
    return interaction.reply({ content: '❌ Job offers are disabled in this server.', ephemeral: true });
  }

  // Block users who already have a team — job offers are for new coaches only
  const currentTeam = await getTeamByUser(userId, guildId);
  if (currentTeam) {
    return interaction.reply({
      content: `❌ You already coach **${currentTeam.team_name}**. Job offers are only for coaches without a team.`,
      ephemeral: true,
    });
  }

  const now = new Date();

  // Check for existing active offers and resend them with buttons
  const { data: existingOffers } = await supabase
    .from('job_offers')
    .select('*, teams(team_name, star_rating, conference)')
    .eq('guild_id', guildId)
    .eq('user_id', userId)
    .gt('expires_at', now.toISOString());

  if (existingOffers && existingOffers.length > 0) {
    await sendOffersAsDM(interaction, existingOffers, config, guildId, true);
    return;
  }

  // Find teams available — not assigned in this guild, not locked in active offers
  const { data: lockedTeamIds } = await supabase
    .from('job_offers')
    .select('team_id')
    .eq('guild_id', guildId)
    .gt('expires_at', now.toISOString());
  const locked = (lockedTeamIds || []).map(r => r.team_id);

  const { data: assignedInGuild } = await supabase
    .from('team_assignments')
    .select('team_id')
    .eq('guild_id', guildId);
  const assignedIds = (assignedInGuild || []).map(a => a.team_id);

  let jobQuery = supabase
    .from('teams')
    .select('*')
    .gte('star_rating', config.star_rating_for_offers)
    .order('star_rating', { ascending: false })
    .limit(50);
  if (config.star_rating_max_for_offers) {
    jobQuery = jobQuery.lte('star_rating', config.star_rating_max_for_offers);
  }
  const { data: availableJobs } = await jobQuery;

  const pool = (availableJobs || []).filter(t =>
    !assignedIds.includes(t.id) && !locked.includes(t.id)
  );

  if (pool.length === 0) {
    return interaction.reply({
      content: `ℹ️ No available jobs meet the ${config.star_rating_for_offers}⭐ minimum right now. Try again later.`,
      ephemeral: true,
    });
  }

  // Shuffle and pick N offers
  const picks = pool.sort(() => Math.random() - 0.5).slice(0, config.job_offers_count);

  // Lock them in the job_offers table
  const expiryHours = config.job_offers_expiry_hours || 48;
  const expiresAt   = new Date(now.getTime() + expiryHours * 60 * 60 * 1000);

  await supabase.from('job_offers').insert(
    picks.map(t => ({
      guild_id:   guildId,
      user_id:    userId,
      team_id:    t.id,
      expires_at: expiresAt.toISOString(),
    }))
  );

  // Format as {teams: {...}} to match existing offer shape
  const shaped = picks.map(t => ({ teams: t, expires_at: expiresAt.toISOString(), team_id: t.id }));
  await sendOffersAsDM(interaction, shaped, config, guildId, false);
}

// Sends offers to DM with an Accept button per offer
async function sendOffersAsDM(interaction, offers, config, guildId, isExisting) {
  const expiresAt  = new Date(offers[0].expires_at);
  const now        = new Date();
  const hoursLeft  = Math.ceil((expiresAt - now) / (1000 * 60 * 60));

  const embed = new EmbedBuilder()
    .setTitle('📋 Your Job Offers')
    .setColor(config.embed_color_primary_int)
    .setDescription(
      isExisting
        ? `You already have active offers. They expire in **${hoursLeft} hour(s)**. Click a button below to accept one.`
        : `Here are your **${offers.length}** offer(s). They expire in **${hoursLeft} hours**. Click a button below to accept one.`
    )
    .addFields(
      offers.map((o, i) => ({
        name: `${i + 1}. ${o.teams.team_name}`,
        value: `Rating: ${starRating(o.teams.star_rating || 0)} (${o.teams.star_rating || '?'}⭐)\nConference: ${o.teams.conference || 'Unknown'}`,
        inline: false,
      }))
    )
    .setFooter({ text: 'Offers cannot be refreshed until they expire.' });

  // One Accept button per offer
  const rows = [];
  for (let i = 0; i < offers.length; i += 5) {
    const row = new ActionRowBuilder().addComponents(
      offers.slice(i, i + 5).map((o, j) =>
        new ButtonBuilder()
          .setCustomId(`accept-offer_${guildId}_${offers[i + j].team_id}`)
          .setLabel(`Accept: ${o.teams.team_name}`)
          .setStyle(ButtonStyle.Primary)
      )
    );
    rows.push(row);
  }

  try {
    const dm = await interaction.user.createDM();
    await dm.send({ embeds: [embed], components: rows });
    await interaction.reply({ content: '📬 Your job offers have been sent to your DMs!', ephemeral: true });
  } catch {
    await interaction.reply({ embeds: [embed], components: rows, ephemeral: true });
  }
}

// Handle Accept button clicks
async function handleAcceptOffer(interaction) {
  // customId format: accept-offer_guildId_teamId
  const parts   = interaction.customId.split('_');
  const guildId = parts[1];
  const teamId  = parseInt(parts[2]);
  const userId  = interaction.user.id;

  await interaction.deferUpdate();

  // Verify the offer still exists and belongs to this user
  const { data: offer } = await supabase
    .from('job_offers')
    .select('*, teams(*)')
    .eq('guild_id', guildId)
    .eq('user_id', userId)
    .eq('team_id', teamId)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (!offer) {
    await interaction.editReply({
      content: '❌ This offer is no longer available — it may have expired or already been taken.',
      components: [],
      embeds: [],
    });
    return;
  }

  // Double-check team isn't already assigned in this guild
  const { data: existing } = await supabase
    .from('team_assignments')
    .select('user_id')
    .eq('guild_id', guildId)
    .eq('team_id', teamId)
    .single();

  if (existing) {
    await interaction.editReply({
      content: `❌ **${offer.teams.team_name}** was just taken by someone else. Run \`/joboffers\` again for a new set.`,
      components: [],
      embeds: [],
    });
    return;
  }

  // Assign the team
  await assignTeam(teamId, userId, guildId);

  // Delete ALL of this user's offers for this guild — they have a team now
  await supabase
    .from('job_offers')
    .delete()
    .eq('guild_id', guildId)
    .eq('user_id', userId);

  // Assign head coach role in the guild
  const config = await getConfig(guildId);
  const guild  = client.guilds.cache.get(guildId);
  if (guild) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) {
      const hcRole = await findOrCreateRole(guild, config.role_head_coach);
      await member.roles.add(hcRole).catch(() => {});
      if (!config.role_head_coach_id) {
        await saveConfig(guildId, { role_head_coach_id: hcRole.id });
      }
    }
  }

  // Update the DM to show acceptance
  const successEmbed = new EmbedBuilder()
    .setTitle('✅ Offer Accepted!')
    .setColor(0x00ff00)
    .setDescription(`You are now the Head Coach of **${offer.teams.team_name}**! Welcome to the league.`)
    .addFields(
      { name: 'Team',       value: offer.teams.team_name,              inline: true },
      { name: 'Conference', value: offer.teams.conference || 'Unknown', inline: true },
      { name: 'Rating',     value: `${starRating(offer.teams.star_rating || 0)} (${offer.teams.star_rating || '?'}⭐)`, inline: true },
    );

  await interaction.editReply({ embeds: [successEmbed], components: [] });

  // Post signing announcement to the guild
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

    const signedChannel = findTextChannel(guild, config.channel_signed_coaches);
    const newsChannel   = findTextChannel(guild, config.channel_news_feed);
    const target        = signedChannel || newsChannel;
    if (target) await target.send({ embeds: [signingEmbed] });
  }
}

// Expire job offers — runs on an interval, notifies users and releases teams back to pool
async function expireJobOffers() {
  const now = new Date().toISOString();

  const { data: expired } = await supabase
    .from('job_offers')
    .select('*, teams(team_name)')
    .lt('expires_at', now);

  if (!expired || expired.length === 0) return;

  // Group by user+guild so we send one message per user
  const byUser = {};
  for (const offer of expired) {
    const key = `${offer.guild_id}:${offer.user_id}`;
    if (!byUser[key]) byUser[key] = { guild_id: offer.guild_id, user_id: offer.user_id, teams: [] };
    byUser[key].teams.push(offer.teams?.team_name || 'Unknown');
  }

  // Notify each user
  for (const { guild_id, user_id, teams } of Object.values(byUser)) {
    try {
      const guild = client.guilds.cache.get(guild_id);
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
        // DMs disabled — try posting in news channel
        const newsChannel = findTextChannel(guild, config.channel_news_feed);
        if (newsChannel) {
          newsChannel.send({ content: `<@${user_id}>`, embeds: [embed] });
        }
      });
    } catch (err) {
      console.error('[expireJobOffers] Error notifying user:', err.message);
    }
  }

  // Delete all expired rows
  await supabase.from('job_offers').delete().lt('expires_at', now);
  console.log(`[expireJobOffers] Cleaned up ${expired.length} expired offer(s).`);
}

// /game-result
async function handleGameResult(interaction, adminOverride = false) {
  const guildId      = interaction.guildId;
  const config       = await getConfig(guildId);
  const meta         = await getMeta(guildId);
  const opponentName = interaction.options.getString('opponent');
  const yourScore    = interaction.options.getInteger('your-score');
  const oppScore     = interaction.options.getInteger('opponent-score');
  const userId       = interaction.user.id;

  let yourTeam = await getTeamByUser(userId, guildId);
  if (!yourTeam) {
    return interaction.reply({ content: '❌ You don\'t have a team assigned.', ephemeral: true });
  }

  const oppTeam = await getTeamByName(opponentName, guildId);
  if (!oppTeam) {
    return interaction.reply({ content: `❌ Team \`${opponentName}\` not found.`, ephemeral: true });
  }

  const won  = yourScore > oppScore;
  const tied = yourScore === oppScore;

  // Update records
  const yourRecord = await getRecord(yourTeam.id, meta.season, guildId);
  const oppRecord  = await getRecord(oppTeam.id, meta.season, guildId);

  if (won) {
    yourRecord.wins   = (yourRecord.wins || 0) + 1;
    oppRecord.losses  = (oppRecord.losses || 0) + 1;
  } else if (!tied) {
    yourRecord.losses = (yourRecord.losses || 0) + 1;
    oppRecord.wins    = (oppRecord.wins || 0) + 1;
  }

  await upsertRecord({ ...yourRecord, team_id: yourTeam.id, season: meta.season, guild_id: guildId });
  await upsertRecord({ ...oppRecord,  team_id: oppTeam.id,  season: meta.season, guild_id: guildId });

  // Save result
  await supabase.from('results').insert({
    guild_id: guildId,
    season: meta.season,
    week: meta.week,
    team1_id: yourTeam.id,
    team2_id: oppTeam.id,
    score1: yourScore,
    score2: oppScore,
    submitted_by: userId,
  });

  const color = tied ? 0xffa500 : (won ? config.embed_color_win_int : config.embed_color_loss_int);
  const result = tied ? 'TIE' : (won ? 'WIN' : 'LOSS');

  const embed = new EmbedBuilder()
    .setTitle(`🏈 Game Result — Season ${meta.season} Week ${meta.week}`)
    .setColor(color)
    .setDescription(`**${yourTeam.team_name}** vs **${oppTeam.team_name}**`)
    .addFields(
      { name: yourTeam.team_name, value: `${yourScore}`, inline: true },
      { name: result, value: '—', inline: true },
      { name: oppTeam.team_name, value: `${oppScore}`, inline: true },
      { name: `${yourTeam.team_name} Record`, value: `${yourRecord.wins}-${yourRecord.losses}`, inline: true },
      { name: `${oppTeam.team_name} Record`, value: `${oppRecord.wins}-${oppRecord.losses}`, inline: true },
    )
    .setFooter({ text: `Submitted by ${interaction.user.displayName}` });

  await interaction.reply({ embeds: [embed] });

  // Post to news feed
  const newsChannel = findTextChannel(interaction.guild, config.channel_news_feed);
  if (newsChannel && newsChannel.id !== interaction.channelId) {
    await newsChannel.send({ embeds: [embed] });
  }
}

// /any-game-result (admin)
async function handleAnyGameResult(interaction) {
  const guildId   = interaction.guildId;
  const config    = await getConfig(guildId);
  const meta      = await getMeta(guildId);
  const team1Name = interaction.options.getString('team1');
  const team2Name = interaction.options.getString('team2');
  const score1    = interaction.options.getInteger('score1');
  const score2    = interaction.options.getInteger('score2');

  const team1 = await getTeamByName(team1Name, guildId);
  const team2 = await getTeamByName(team2Name, guildId);

  if (!team1) return interaction.reply({ content: `❌ Team \`${team1Name}\` not found.`, ephemeral: true });
  if (!team2) return interaction.reply({ content: `❌ Team \`${team2Name}\` not found.`, ephemeral: true });

  const record1 = await getRecord(team1.id, meta.season, guildId);
  const record2 = await getRecord(team2.id, meta.season, guildId);

  if (score1 > score2) {
    record1.wins = (record1.wins || 0) + 1;
    record2.losses = (record2.losses || 0) + 1;
  } else if (score2 > score1) {
    record2.wins = (record2.wins || 0) + 1;
    record1.losses = (record1.losses || 0) + 1;
  }

  await upsertRecord({ ...record1, team_id: team1.id, season: meta.season, guild_id: guildId });
  await upsertRecord({ ...record2, team_id: team2.id, season: meta.season, guild_id: guildId });

  await supabase.from('results').insert({
    guild_id: guildId,
    season: meta.season,
    week: meta.week,
    team1_id: team1.id,
    team2_id: team2.id,
    score1,
    score2,
    submitted_by: interaction.user.id,
  });

  const won1  = score1 > score2;
  const tied  = score1 === score2;
  const color = tied ? 0xffa500 : (won1 ? config.embed_color_win_int : config.embed_color_loss_int);

  const embed = new EmbedBuilder()
    .setTitle(`🏈 Game Result Entered — S${meta.season} W${meta.week}`)
    .setColor(color)
    .addFields(
      { name: team1.team_name, value: `${score1}`, inline: true },
      { name: tied ? 'TIE' : (won1 ? 'WIN' : 'LOSS'), value: '—', inline: true },
      { name: team2.team_name, value: `${score2}`, inline: true },
      { name: `${team1.team_name} Record`, value: `${record1.wins}-${record1.losses}`, inline: true },
      { name: `${team2.team_name} Record`, value: `${record2.wins}-${record2.losses}`, inline: true },
    )
    .setFooter({ text: `Entered by ${interaction.user.displayName} (admin)` });

  await interaction.reply({ embeds: [embed] });

  const newsChannel = findTextChannel(interaction.guild, config.channel_news_feed);
  if (newsChannel && newsChannel.id !== interaction.channelId) {
    await newsChannel.send({ embeds: [embed] });
  }
}

// /press-release
async function handlePressRelease(interaction) {
  const config = await getConfig(interaction.guildId);
  if (!config.feature_press_releases) {
    return interaction.reply({ content: '❌ Press releases are disabled in this server.', ephemeral: true });
  }

  const message   = interaction.options.getString('message');
  const userTeam  = await getTeamByUser(interaction.user.id, interaction.guildId);
  const teamName  = userTeam ? userTeam.team_name : interaction.user.displayName;

  const embed = new EmbedBuilder()
    .setTitle(`📰 Press Release — ${teamName}`)
    .setColor(config.embed_color_primary_int)
    .setDescription(message)
    .setFooter({ text: `Posted by ${interaction.user.displayName}` })
    .setTimestamp();

  const newsChannel = findTextChannel(interaction.guild, config.channel_news_feed);
  if (!newsChannel) {
    return interaction.reply({ content: `❌ News feed channel \`${config.channel_news_feed}\` not found.`, ephemeral: true });
  }

  await newsChannel.send({ embeds: [embed] });
  await supabase.from('news_feed').insert({
    guild_id: interaction.guildId,
    author_id: interaction.user.id,
    team_name: teamName,
    message,
  });

  await interaction.reply({ content: '✅ Press release posted!', ephemeral: true });
}

// /ranking
async function handleRanking(interaction) {
  const config = await getConfig(interaction.guildId);
  if (!config.feature_rankings) {
    return interaction.reply({ content: '❌ Rankings are disabled in this server.', ephemeral: true });
  }

  const meta = await getMeta(interaction.guildId);
  const { data: records } = await supabase
    .from('records')
    .select('*, teams(team_name, user_id)')
    .eq('guild_id', interaction.guildId)
    .eq('season', meta.season)
    .order('wins', { ascending: false });

  if (!records || records.length === 0) {
    return interaction.reply({ content: 'No records found for this season.', ephemeral: true });
  }

  const lines = records.map((r, i) => {
    const name = r.teams?.team_name || `Team ${r.team_id}`;
    return `**${i + 1}.** ${name} — ${r.wins}W - ${r.losses}L`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`🏆 Season ${meta.season} Standings`)
    .setColor(config.embed_color_primary_int)
    .setDescription(lines.join('\n'))
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

// /ranking-all-time
async function handleRankingAllTime(interaction) {
  const config = await getConfig(interaction.guildId);

  const { data: records } = await supabase
    .from('records')
    .select('team_id, wins, losses, teams(team_name)')
    .eq('guild_id', interaction.guildId);

  if (!records || records.length === 0) {
    return interaction.reply({ content: 'No records found.', ephemeral: true });
  }

  // Aggregate by team
  const totals = {};
  for (const r of records) {
    const name = r.teams?.team_name || r.team_id;
    if (!totals[name]) totals[name] = { wins: 0, losses: 0 };
    totals[name].wins   += r.wins   || 0;
    totals[name].losses += r.losses || 0;
  }

  const sorted = Object.entries(totals)
    .sort((a, b) => b[1].wins - a[1].wins);

  const lines = sorted.map(([name, rec], i) => {
    const pct = (rec.wins + rec.losses) > 0
      ? ((rec.wins / (rec.wins + rec.losses)) * 100).toFixed(1)
      : '0.0';
    return `**${i + 1}.** ${name} — ${rec.wins}W - ${rec.losses}L (${pct}%)`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`🏆 All-Time Rankings`)
    .setColor(config.embed_color_primary_int)
    .setDescription(lines.join('\n'))
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

// /assign-team
async function handleAssignTeam(interaction) {
  const guildId  = interaction.guildId;
  const config   = await getConfig(guildId);
  const guild    = interaction.guild;
  const user     = interaction.options.getUser('user');
  const teamName = interaction.options.getString('team');
  const skipAnn  = interaction.options.getBoolean('skip-announcement') || false;

  await interaction.deferReply({ ephemeral: false });

  // Check team exists
  const team = await getTeamByName(teamName, guildId);
  if (!team) {
    return interaction.editReply(`❌ Team \`${teamName}\` not found. Make sure it's in the database.`);
  }

  // Check if already taken in this guild
  if (team.user_id && team.user_id !== user.id) {
    const currentCoach = await guild.members.fetch(team.user_id).catch(() => null);
    const coachName = currentCoach ? currentCoach.displayName : 'someone';
    return interaction.editReply(`❌ **${team.team_name}** is already assigned to ${coachName} in this league.`);
  }

  // Unassign old team if user has one in this guild
  const oldTeam = await getTeamByUser(user.id, guildId);
  if (oldTeam) {
    await unassignTeam(oldTeam.id, guildId);
  }

  // Assign team in this guild
  await assignTeam(team.id, user.id, guildId);

  // Assign head coach role
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (member) {
    const hcRole = await findOrCreateRole(guild, config.role_head_coach);
    if (!member.roles.cache.has(hcRole.id)) {
      await member.roles.add(hcRole);
    }
    // Save role ID to config if not already saved
    if (!config.role_head_coach_id) {
      await saveConfig(guildId, { role_head_coach_id: hcRole.id });
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(`✍️ Coach Signed — ${team.team_name}`)
    .setColor(config.embed_color_primary_int)
    .setDescription(`<@${user.id}> has been assigned to **${team.team_name}**!`)
    .addFields(
      { name: 'Coach', value: `<@${user.id}>`, inline: true },
      { name: 'Team', value: team.team_name, inline: true },
    )
    .setTimestamp();


  await interaction.editReply({ embeds: [embed] });

  if (!skipAnn) {
    const signedChannel = findTextChannel(guild, config.channel_signed_coaches);
    const newsChannel   = findTextChannel(guild, config.channel_news_feed);
    const target        = signedChannel || newsChannel;
    if (target && target.id !== interaction.channelId) {
      await target.send({ embeds: [embed] });
    }
  }
}

// /resetteam
async function handleResetTeam(interaction) {
  const guildId = interaction.guildId;
  const config  = await getConfig(guildId);
  const user    = interaction.options.getUser('user');

  const team = await getTeamByUser(user.id, guildId);
  if (!team) {
    return interaction.reply({ content: `❌ <@${user.id}> doesn't have a team assigned.`, ephemeral: true });
  }

  await unassignTeam(team.id, guildId);

  // Remove head coach role
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (member && config.role_head_coach_id) {
    await member.roles.remove(config.role_head_coach_id).catch(() => {});
  }

  await interaction.reply({ content: `✅ <@${user.id}> has been removed from **${team.team_name}**.` });
}

// /listteams
async function handleListTeams(interaction) {
  const guildId = interaction.guildId;
  const config  = await getConfig(guildId);
  const teams   = await getAllTeams(guildId);

  const taken     = teams.filter(t => t.user_id);
  const available = teams.filter(t => !t.user_id);

  const takenLines = taken.length > 0
    ? taken.map(t => `✅ **${t.team_name}** — <@${t.user_id}>`).join('\n')
    : '_None_';

  const availLines = available.length > 0
    ? available.map(t => `⬜ **${t.team_name}**${t.star_rating ? ` (${t.star_rating}⭐)` : ''}`).join('\n')
    : '_None — all teams taken!_';

  const embed = new EmbedBuilder()
    .setTitle(`📋 ${config.league_name} — Team List`)
    .setColor(config.embed_color_primary_int)
    .addFields(
      { name: `✅ Taken Teams (${taken.length})`, value: takenLines.substring(0, 1024), inline: false },
      { name: `⬜ Available Teams (${available.length})`, value: availLines.substring(0, 1024), inline: false },
    )
    .setFooter({ text: 'Contact an admin to join the league!' })
    .setTimestamp();

  const listsChannel = findTextChannel(interaction.guild, config.channel_team_lists);
  if (listsChannel && listsChannel.id !== interaction.channelId) {
    await listsChannel.send({ embeds: [embed] });
    await interaction.reply({ content: `✅ Team list posted in ${listsChannel}!`, ephemeral: true });
  } else {
    await interaction.reply({ embeds: [embed] });
  }
}

// /advance
async function handleAdvance(interaction) {
  const guildId = interaction.guildId;
  const config  = await getConfig(guildId);

  if (!config.feature_advance_system) {
    return interaction.reply({ content: '❌ The advance system is disabled.', ephemeral: true });
  }

  const meta       = await getMeta(guildId);
  const intervals  = config.advance_intervals_parsed || [24, 48];
  let hoursInput   = interaction.options.getInteger('hours');

  if (!hoursInput) {
    // If none provided, default to first interval
    hoursInput = intervals[0] || 24;
  }

  if (!intervals.includes(hoursInput)) {
    return interaction.reply({
      content: `❌ Invalid interval. Choose from: ${intervals.join(', ')} hours.`,
      ephemeral: true,
    });
  }

  const deadline = new Date(Date.now() + hoursInput * 60 * 60 * 1000);
  await setMeta(guildId, { advance_hours: hoursInput, advance_deadline: deadline.toISOString() });

  // Format deadline in multiple timezones
  const formatTZ = (date, tz) =>
    date.toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

  const embed = new EmbedBuilder()
    .setTitle(`⏭️ Advance — Season ${meta.season} Week ${meta.week + 1}`)
    .setColor(config.embed_color_primary_int)
    .setDescription(`The league is advancing to **Week ${meta.week + 1}**!\nAll games must be completed within **${hoursInput} hours**.`)
    .addFields(
      { name: '🕐 Deadline', value:
        `🌴 ET: **${formatTZ(deadline, 'America/New_York')}**\n` +
        `🌵 CT: **${formatTZ(deadline, 'America/Chicago')}**\n` +
        `🏔️ MT: **${formatTZ(deadline, 'America/Denver')}**\n` +
        `🌊 PT: **${formatTZ(deadline, 'America/Los_Angeles')}**`,
        inline: false },
    )
    .setTimestamp();

  const advanceChannel = findTextChannel(interaction.guild, config.channel_advance_tracker);
  await interaction.reply({ embeds: [embed] });
  if (advanceChannel && advanceChannel.id !== interaction.channelId) {
    await advanceChannel.send({ embeds: [embed] });
  }
}

// /season-advance
async function handleSeasonAdvance(interaction) {
  const guildId = interaction.guildId;
  const config  = await getConfig(guildId);
  const meta    = await getMeta(guildId);
  const newSeason = meta.season + 1;

  await setMeta(guildId, { season: newSeason, week: 1, advance_deadline: null });

  const embed = new EmbedBuilder()
    .setTitle(`🏆 Season ${newSeason} Has Begun!`)
    .setColor(config.embed_color_primary_int)
    .setDescription(`Season **${meta.season}** is over! Welcome to **Season ${newSeason}**!\nAll records reset. Good luck!`)
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
  const newsChannel = findTextChannel(interaction.guild, config.channel_news_feed);
  if (newsChannel && newsChannel.id !== interaction.channelId) {
    await newsChannel.send({ embeds: [embed] });
  }
}

// /move-coach
async function handleMoveCoach(interaction) {
  const guildId   = interaction.guildId;
  const config    = await getConfig(guildId);
  const user      = interaction.options.getUser('user');
  const newTeamName = interaction.options.getString('new-team');

  await interaction.deferReply();

  const currentTeam = await getTeamByUser(user.id, guildId);
  const newTeam     = await getTeamByName(newTeamName, guildId);

  if (!newTeam) return interaction.editReply(`❌ Team \`${newTeamName}\` not found.`);
  if (newTeam.user_id && newTeam.user_id !== user.id) {
    return interaction.editReply(`❌ **${newTeam.team_name}** is already occupied.`);
  }

  if (currentTeam) {
    await unassignTeam(currentTeam.id, guildId);
  }
  await assignTeam(newTeam.id, user.id, guildId);

  const embed = new EmbedBuilder()
    .setTitle('🔄 Coach Moved')
    .setColor(config.embed_color_primary_int)
    .setDescription(`<@${user.id}> has moved to **${newTeam.team_name}**.`)
    .addFields(
      { name: 'From', value: currentTeam ? currentTeam.team_name : 'No previous team', inline: true },
      { name: 'To',   value: newTeam.team_name, inline: true },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
  const newsChannel = findTextChannel(interaction.guild, config.channel_news_feed);
  if (newsChannel && newsChannel.id !== interaction.channelId) {
    await newsChannel.send({ embeds: [embed] });
  }
}

// =====================================================
// INTERACTION ROUTER
// =====================================================
// =====================================================
// AUTOCOMPLETE HANDLER
// =====================================================

async function handleAutocomplete(interaction) {
  const { commandName, guildId } = interaction;
  const focused = interaction.options.getFocused(true);
  const query   = focused.value.toLowerCase();

  let choices = [];

  if (commandName === 'assign-team' || commandName === 'any-game-result' || commandName === 'move-coach') {
    // Show all global teams (unfiltered — admin commands)
    const { data: teams } = await supabase
      .from('teams')
      .select('id, team_name, conference, star_rating')
      .ilike('team_name', `%${query}%`)
      .order('team_name')
      .limit(25);

    choices = (teams || []).map(t => ({
      name: `${t.team_name}${t.conference ? ' · ' + t.conference : ''}${t.star_rating ? ' · ' + t.star_rating + '⭐' : ''}`,
      value: t.team_name,
    }));
  }

  else if (commandName === 'game-result') {
    // Opponent field — show all teams except the user's own
    const userTeam = await getTeamByUser(interaction.user.id, guildId);
    const { data: teams } = await supabase
      .from('teams')
      .select('id, team_name, conference')
      .ilike('team_name', `%${query}%`)
      .order('team_name')
      .limit(25);

    choices = (teams || [])
      .filter(t => !userTeam || t.team_name !== userTeam.team_name)
      .map(t => ({
        name: `${t.team_name}${t.conference ? ' · ' + t.conference : ''}`,
        value: t.team_name,
      }));
  }

  else if (commandName === 'resetteam') {
    // Only show teams that are currently assigned in this guild
    const { data: assignments } = await supabase
      .from('team_assignments')
      .select('team_id, user_id, teams(team_name, conference)')
      .eq('guild_id', guildId);

    choices = (assignments || [])
      .filter(a => a.teams && a.teams.team_name.toLowerCase().includes(query))
      .slice(0, 25)
      .map(a => ({
        name: a.teams.team_name + (a.teams.conference ? ' · ' + a.teams.conference : ''),
        value: a.teams.team_name,
      }));
  }

  await interaction.respond(choices);
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Handle autocomplete before anything else
    if (interaction.isAutocomplete()) {
      return handleAutocomplete(interaction);
    }

    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'setup':         return handleSetup(interaction);
        case 'config':
          switch (interaction.options.getSubcommand()) {
            case 'view':     return handleConfigView(interaction);
            case 'features': return handleConfigFeatures(interaction);
            case 'edit':     return handleConfigEdit(interaction);
            case 'reload':   return handleConfigReload(interaction);
          }
          break;
        case 'joboffers':          return handleJobOffers(interaction);
        case 'game-result':        return handleGameResult(interaction);
        case 'any-game-result':    return handleAnyGameResult(interaction);
        case 'press-release':      return handlePressRelease(interaction);
        case 'ranking':            return handleRanking(interaction);
        case 'ranking-all-time':   return handleRankingAllTime(interaction);
        case 'assign-team':        return handleAssignTeam(interaction);
        case 'resetteam':          return handleResetTeam(interaction);
        case 'listteams':          return handleListTeams(interaction);
        case 'advance':            return handleAdvance(interaction);
        case 'season-advance':     return handleSeasonAdvance(interaction);
        case 'move-coach':         return handleMoveCoach(interaction);
        default:
          await interaction.reply({ content: '❓ Unknown command.', ephemeral: true });
      }
    }

    // Handle Accept Offer buttons
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('accept-offer_')) {
        return handleAcceptOffer(interaction);
      }
    }

    // Handle select menu for feature toggles
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith('features-toggle-')) {
        const guildId  = interaction.guildId;
        const selected = interaction.values;
        const allFeatures = [
          'feature_job_offers',
          'feature_stream_reminders',
          'feature_advance_system',
          'feature_press_releases',
          'feature_rankings',
        ];
        const updates = {};
        for (const f of allFeatures) {
          updates[f] = selected.includes(f);
        }
        await saveConfig(guildId, updates);
        const lines = allFeatures.map(f => `${updates[f] ? '✅' : '❌'} ${f.replace('feature_', '').replace(/_/g, ' ')}`);
        await interaction.update({ content: `**Features updated:**\n${lines.join('\n')}`, components: [] });
      }
    }
  } catch (err) {
    console.error('[interaction] Error:', err);
    const msg = { content: `❌ An error occurred: ${err.message}`, ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
});

// =====================================================
// MESSAGE LISTENER — Stream Reminders
// =====================================================
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const guildId = message.guildId;
  if (!guildId) return;

  const config = await getConfig(guildId).catch(() => null);
  if (!config || !config.feature_stream_reminders) return;

  // Check if in streaming channel or a team channel
  const isStreamChannel = message.channel.name?.toLowerCase() === config.channel_streaming?.toLowerCase();

  if (!isStreamChannel) return;

  // Check for YouTube/Twitch links
  const hasStreamLink = /https?:\/\/(www\.)?(youtube\.com|youtu\.be|twitch\.tv)\//i.test(message.content);
  if (!hasStreamLink) return;

  const minutes = config.stream_reminder_minutes || 45;
  scheduleStreamReminder(message.channel, message.author.id, guildId, minutes);
  console.log(`[stream] Scheduled ${minutes}min reminder for ${message.author.username} in #${message.channel.name}`);
});

// =====================================================
// SELF-PING (Keep Render alive)
// =====================================================
if (SELF_PING_URL) {
  const http = require('http');
  const https = require('https');
  setInterval(() => {
    const mod = SELF_PING_URL.startsWith('https') ? https : http;
    mod.get(SELF_PING_URL, () => {}).on('error', () => {});
  }, 14 * 60 * 1000); // every 14 minutes

  // Simple HTTP server for Render health checks
  http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Dynasty Bot OK');
  }).listen(PORT, () => {
    console.log(`[server] HTTP server listening on port ${PORT}`);
  });
}

// =====================================================
// GUILD AUTO-SETUP
// =====================================================

/**
 * Called whenever the bot joins a new server.
 * Creates a default config + meta row so admins can
 * immediately run /setup without any manual SQL.
 */
async function initGuild(guild) {
  try {
    // Check if config already exists for this guild
    const { data } = await supabase
      .from('config')
      .select('guild_id')
      .eq('guild_id', guild.id)
      .single();

    if (data) {
      console.log(`[guild] Config already exists for ${guild.name} (${guild.id})`);
      return;
    }

    // Create default config row
    await createDefaultConfig(guild.id, guild.name);

    // Create default meta row
    await supabase
      .from('meta')
      .upsert({ guild_id: guild.id, season: 1, week: 1 }, { onConflict: 'guild_id' });

    console.log(`[guild] Auto-created config for new guild: ${guild.name} (${guild.id})`);

    // Try to notify the server owner
    const owner = await guild.fetchOwner().catch(() => null);
    if (owner) {
      const embed = new EmbedBuilder()
        .setTitle('👋 Dynasty Bot is Ready!')
        .setColor(0x1e90ff)
        .setDescription(
          `Thanks for adding Dynasty Bot to **${guild.name}**!\n\n` +
          `A default configuration has been created for your server. ` +
          `Run \`/setup\` in your server to customize your league settings, ` +
          `or use \`/config view\` to see the defaults.`
        )
        .addFields(
          { name: '📋 Next Steps', value:
            '1. Run `/setup` to configure your league\n' +
            '2. Use `/listteams` to post available teams\n' +
            '3. Use `/assign-team` to assign coaches',
          }
        );
      await owner.send({ embeds: [embed] }).catch(() => {
        console.log(`[guild] Could not DM owner of ${guild.name}, skipping welcome message.`);
      });
    }
  } catch (err) {
    console.error(`[guild] Failed to auto-init guild ${guild.name} (${guild.id}):`, err.message);
  }
}

// Fires when the bot is invited to a new server
client.on(Events.GuildCreate, async (guild) => {
  console.log(`[guild] Joined new guild: ${guild.name} (${guild.id})`);
  await initGuild(guild);
});

// =====================================================
// BOT READY
// =====================================================
client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] Logged in as ${c.user.tag}`);
  await registerCommands();

  // Sync any guilds that were added while the bot was offline
  console.log(`[bot] Syncing ${c.guilds.cache.size} guild(s)...`);
  for (const guild of c.guilds.cache.values()) {
    await initGuild(guild);
  }

  console.log(`[bot] Ready! Serving ${c.guilds.cache.size} guild(s).`);

  // Check for expired job offers every 30 minutes
  expireJobOffers();
  setInterval(expireJobOffers, 30 * 60 * 1000);
});

// =====================================================
// LOGIN
// =====================================================
client.login(DISCORD_TOKEN);
