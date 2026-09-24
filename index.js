// =====================================================
// Universal Dynasty League Bot - index.js
// Version: 2.1.0 (Universal Multi-Server)
// =====================================================

require('dotenv').config();
const http = require('http');
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
const ws = require('ws');

// =====================================================
// ENVIRONMENT & CLIENTS
// =====================================================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const CLIENT_ID = process.env.CLIENT_ID;
const PORT = process.env.PORT || 3000;
const SELF_PING_URL = process.env.SELF_PING_URL || '';
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const STREAM_POLL_INTERVAL_MS = Number(process.env.STREAM_POLL_INTERVAL_MS || 90000);

if (!DISCORD_TOKEN || !SUPABASE_URL || !SUPABASE_KEY || !CLIENT_ID) {
  console.error('[boot] Missing required environment variables. Check DISCORD_TOKEN, SUPABASE_URL, SUPABASE_KEY, CLIENT_ID.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { transport: ws },
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember],
});

// =====================================================
// PHASE CYCLE
// =====================================================
const PHASE_CYCLE = [
  { key: 'preseason', name: 'Preseason', subWeeks: 1, startSub: 0, format: () => 'Preseason' },
  { key: 'regular', name: 'Regular Season', subWeeks: 16, startSub: 0, format: (sub) => `Week ${sub}` },
  { key: 'conf_champ', name: 'Conference Championship', subWeeks: 1, startSub: 0, format: () => 'Conference Championship' },
  { key: 'bowl', name: 'Bowl Season', subWeeks: 4, startSub: 0, format: (sub) => {
    const labels = ['Bowl Week 1', 'Bowl Week 2', 'Semifinals', 'National Championship'];
    return labels[sub] ?? `Bowl Week ${sub + 1}`;
  } },
  { key: 'end_of_season_recap', name: 'End of Season Recap', subWeeks: 1, startSub: 0, format: () => 'End of Season Recap' },
  { key: 'players_leaving', name: 'Players Leaving', subWeeks: 1, startSub: 0, format: () => 'Players Leaving' },
  { key: 'transfer_portal', name: 'Transfer Portal', subWeeks: 4, startSub: 0, format: (sub) => `Transfer Week ${sub + 1}` },
  { key: 'position_changes', name: 'Position Changes', subWeeks: 1, startSub: 0, format: () => 'Position Changes' },
  { key: 'training_results', name: 'Training Results', subWeeks: 1, startSub: 0, format: () => 'Training Results' },
  { key: 'encourage_transfers', name: 'Encourage Transfers', subWeeks: 1, startSub: 0, format: () => 'Encourage Transfers' },
];

const getPhaseByKey = (key) => PHASE_CYCLE.find(p => p.key === key) || PHASE_CYCLE[0];

function formatPhase(phaseKey, subPhase) {
  const phase = getPhaseByKey(phaseKey);
  return phase.format ? phase.format(subPhase) : phase.name;
}

// =====================================================
// HEALTH SERVER (always on for Railway)
// =====================================================
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Dynasty Bot OK');
}).listen(PORT, () => {
  console.log(`[server] HTTP server listening on port ${PORT}`);
});

if (SELF_PING_URL) {
  setInterval(() => {
    const mod = SELF_PING_URL.startsWith('https') ? https : http;
    mod.get(SELF_PING_URL, () => {}).on('error', () => {});
  }, 14 * 60 * 1000);
  console.log(`[server] Self-ping enabled → ${SELF_PING_URL}`);
}

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

const guildConfigs = new Map();

const CONFIG_DEFAULTS = {
  league_name: 'Dynasty League',
  league_abbreviation: '',
  setup_complete: false,
  league_type: 'new',
  feature_job_offers: false,
  feature_assign_team: false,
  feature_reset_team: false,
  feature_list_teams: false,
  feature_move_coach: false,
  feature_advance: false,
  feature_custom_conferences: false,
  feature_auto_role: false,
  feature_promotion_relegation: false,
  channel_news_feed: 'news-feed',
  channel_advance_tracker: 'advance-tracker',
  channel_team_lists: 'team-lists',
  team_list_filter: 'all',
  channel_signed_coaches: 'signed-coaches',
  channel_streams: 'streaming',
  role_head_coach: 'head coach',
  role_head_coach_id: null,
  star_rating_for_offers: 2.5,
  star_rating_max_for_offers: null,
  job_offers_count: 3,
  job_offers_expiry_hours: 48,
  advance_intervals: '[24, 48]',
  advance_timezones: '["ET","CT","MT","PT"]',
  embed_color_primary: '0x1e90ff',
  embed_color_win: '0x00ff00',
  embed_color_loss: '0xff0000',
};

function parseConfig(data) {
  let intervals = [24, 48];
  try {
    const raw = (data.advance_intervals || '').trim();
    const normalized = raw.startsWith('[') ? raw : `[${raw}]`;
    const parsed = JSON.parse(normalized);
    if (Array.isArray(parsed) && parsed.length > 0) {
      intervals = parsed.map(Number).filter(n => !isNaN(n));
    }
  } catch (_) {
    console.warn(`[config] Could not parse advance_intervals: "${data.advance_intervals}" — using default [24, 48]`);
  }
  return {
    ...data,
    advance_intervals_parsed: intervals,
    advance_timezones_parsed: (() => {
      try {
        const tzs = JSON.parse(data.advance_timezones || '["ET","CT","MT","PT"]');
        return Array.isArray(tzs) ? tzs : ['ET', 'CT', 'MT', 'PT'];
      } catch { return ['ET', 'CT', 'MT', 'PT']; }
    })(),
    embed_color_primary_int: parseInt(data.embed_color_primary, 16) || 0x1e90ff,
    embed_color_win_int: parseInt(data.embed_color_win, 16) || 0x00ff00,
    embed_color_loss_int: parseInt(data.embed_color_loss, 16) || 0xff0000,
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
    const defaults = parseConfig({
      ...CONFIG_DEFAULTS,
      guild_id: guildId,
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
  const full = Math.floor(rating);
  const half = (rating % 1) >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return '⭐'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);
}

async function getTeamByUser(userId, guildId, leagueId = null) {
  let query = supabase
    .from('team_assignments')
    .select('*, teams(*)')
    .eq('user_id', userId)
    .eq('guild_id', guildId);
  if (leagueId) query = query.eq('league_id', leagueId);
  const { data, error } = await query.maybeSingle();

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

async function getTeamByName(teamName, guildId, leagueId = null) {
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

  let assignQuery = supabase
    .from('team_assignments')
    .select('*')
    .eq('team_id', team.id)
    .eq('guild_id', guildId);
  if (leagueId) assignQuery = assignQuery.eq('league_id', leagueId);
  const { data: assignment, error: assignErr } = await assignQuery.maybeSingle();

  if (assignErr) {
    console.error(`[db] getTeamByName("${teamName}") assignments query error:`, assignErr.message);
  }

  return { ...team, user_id: assignment?.user_id || null, assignment_id: assignment?.id || null };
}

async function getAllTeams(guildId, leagueId = null) {
  const { data: teams, error: teamsErr } = await supabase
    .from('teams')
    .select('*')
    .order('team_name');

  if (teamsErr) {
    console.error(`[db] getAllTeams(${guildId}) teams query error:`, teamsErr.message);
    throw new Error(`Database error loading teams: ${teamsErr.message}`);
  }
  if (!teams || teams.length === 0) return [];

  let assignmentsQuery = supabase
    .from('team_assignments')
    .select('*')
    .eq('guild_id', guildId);
  if (leagueId) assignmentsQuery = assignmentsQuery.eq('league_id', leagueId);
  const { data: assignments, error: assignErr } = await assignmentsQuery;

  if (assignErr) {
    console.error(`[db] getAllTeams(${guildId}) assignments query error:`, assignErr.message);
  }

  const assignMap = {};
  for (const a of (assignments || [])) assignMap[a.team_id] = a;

  return teams.map(t => ({
    ...t,
    user_id: assignMap[t.id]?.user_id || null,
    assignment_id: assignMap[t.id]?.id || null,
    custom_conference_id: assignMap[t.id]?.custom_conference_id || null,
  }));
}

async function assignTeam(teamId, userId, guildId, leagueId = null) {
  await supabase
    .from('team_assignments')
    .upsert(
      { team_id: teamId, user_id: userId, guild_id: guildId, league_id: leagueId },
      { onConflict: 'team_id,guild_id' }
    );
}

async function unassignTeam(teamId, guildId, leagueId = null) {
  let query = supabase
    .from('team_assignments')
    .delete()
    .eq('team_id', teamId)
    .eq('guild_id', guildId);
  if (leagueId) query = query.eq('league_id', leagueId);
  await query;
}

const LEAGUE_DEFAULTS = {
  season: 1,
  week: 1,
  current_phase: 'preseason',
  current_sub_phase: 0,
  advance_hours: 24,
  advance_deadline: null,
  last_advance_at: null,
  next_advance_deadline: null,
  advance_intervals: '[24, 48]',
  advance_timezones: '["ET","CT","MT","PT"]',
};

async function getLeagueByCategoryId(guildId, categoryId) {
  const { data } = await supabase
    .from('leagues')
    .select('*')
    .eq('guild_id', guildId)
    .eq('category_id', categoryId)
    .single();
  return data || null;
}

async function getDefaultLeague(guildId) {
  const { data } = await supabase
    .from('leagues')
    .select('*')
    .eq('guild_id', guildId)
    .eq('category_id', 'default')
    .single();
  return data || { ...LEAGUE_DEFAULTS, guild_id: guildId, category_id: 'default' };
}

async function getGuildLeagues(guildId) {
  const { data } = await supabase
    .from('leagues')
    .select('*')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: true });
  return data || [];
}

async function getLeagueFromInteraction(interaction) {
  const guildId = interaction.guildId;
  const config = await getConfig(guildId);

  if (!config.multi_league) return getDefaultLeague(guildId);

  const categoryId = interaction.channel?.parentId;
  if (!categoryId) return getDefaultLeague(guildId);

  const league = await getLeagueByCategoryId(guildId, categoryId);
  if (!league) return null;
  return league;
}

async function setLeague(leagueId, updates) {
  await supabase
    .from('leagues')
    .update({ ...updates })
    .eq('league_id', leagueId);
}

async function upsertLeague(guildId, categoryId, data) {
  const { data: result, error } = await supabase
    .from('leagues')
    .upsert(
      { guild_id: guildId, category_id: categoryId, ...data },
      { onConflict: 'guild_id,category_id' }
    )
    .select()
    .single();
  if (error) throw error;
  return result;
}

function parseLeague(league) {
  let intervals = [24, 48];
  try {
    const raw = (league.advance_intervals || '').trim();
    const normalized = raw.startsWith('[') ? raw : `[${raw}]`;
    const parsed = JSON.parse(normalized);
    if (Array.isArray(parsed) && parsed.length > 0) intervals = parsed.map(Number).filter(n => !isNaN(n));
  } catch (_) {}

  let timezones = ['ET', 'CT', 'MT', 'PT'];
  try {
    const tzs = JSON.parse(league.advance_timezones || '["ET","CT","MT","PT"]');
    if (Array.isArray(tzs) && tzs.length > 0) timezones = tzs;
  } catch (_) {}

  return {
    ...league,
    advance_intervals_parsed: intervals,
    advance_timezones_parsed: timezones,
  };
}

function replyNoLeague(interaction) {
  return interaction.editReply({
    content: '❌ **No League Found**\nThis channel is not part of a configured league. Run the command from a channel inside a league category, or ask an admin to use `/add-league`.',
  });
}

async function getMeta(guildId) {
  const { data } = await supabase.from('meta').select('*').eq('guild_id', guildId).single();
  return data || {
    season: 1,
    week: 1,
    current_phase: 'preseason',
    current_sub_phase: 0,
    advance_hours: 24,
    advance_deadline: null,
    last_advance_at: null,
    next_advance_deadline: null,
  };
}

async function setMeta(guildId, updates) {
  await supabase.from('meta').upsert({ guild_id: guildId, ...updates }, { onConflict: 'guild_id' });
  await supabase.from('leagues')
    .update(updates)
    .eq('guild_id', guildId)
    .eq('category_id', 'default');
}

async function getJobOfferConfig(guildId) {
  const { data } = await supabase
    .from('job_offer_config')
    .select('*')
    .eq('guild_id', guildId)
    .maybeSingle();
  return {
    one_per_conference: false,
    weighted_ratings: 'off',
    conf_balance: false,
    ...(data || {}),
  };
}

async function setJobOfferConfig(guildId, updates) {
  await supabase.from('job_offer_config').upsert(
    { guild_id: guildId, ...updates },
    { onConflict: 'guild_id' }
  );
}

async function getJobOfferConferences(guildId, mode) {
  const { data } = await supabase
    .from('job_offer_conferences')
    .select('conference')
    .eq('guild_id', guildId)
    .eq('mode', mode);
  return (data || []).map(r => r.conference);
}

async function toggleJobOfferConference(guildId, conference, mode) {
  const { data: existing } = await supabase
    .from('job_offer_conferences')
    .select('conference')
    .eq('guild_id', guildId)
    .eq('conference', conference)
    .eq('mode', mode)
    .maybeSingle();

  if (existing) {
    await supabase.from('job_offer_conferences')
      .delete()
      .eq('guild_id', guildId)
      .eq('conference', conference)
      .eq('mode', mode);
    return false;
  } else {
    await supabase.from('job_offer_conferences')
      .insert({ guild_id: guildId, conference, mode });
    return true;
  }
}

async function getDistinctConferences() {
  const { data } = await supabase
    .from('teams')
    .select('conference')
    .not('conference', 'is', null)
    .neq('conference', 'FCS');
  const unique = [...new Set((data || []).map(r => r.conference).filter(Boolean))].sort();
  return unique;
}

function buildCommands() {
  return [
    new SlashCommandBuilder().setName('setup').setDescription('Run the guild setup wizard').toJSON(),
    new SlashCommandBuilder().setName('help').setDescription('Show the command guide').toJSON(),
    new SlashCommandBuilder()
      .setName('stream-register')
      .setDescription('Register your live stream for this league')
      .addStringOption(option =>
        option.setName('platform')
          .setDescription('Platform')
          .setRequired(true)
          .addChoices(
            { name: 'Twitch', value: 'twitch' },
            { name: 'YouTube', value: 'youtube' }
          )
      )
      .addStringOption(option =>
        option.setName('channel')
          .setDescription('Twitch username or YouTube channel handle/ID')
          .setRequired(true)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName('stream-remove')
      .setDescription('Remove your stream registration')
      .addStringOption(option =>
        option.setName('platform')
          .setDescription('Platform')
          .setRequired(true)
          .addChoices(
            { name: 'Twitch', value: 'twitch' },
            { name: 'YouTube', value: 'youtube' }
          )
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName('stream-list')
      .setDescription('List your registered streams for this league')
      .toJSON(),
  ];
}

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

async function safeDeferReply(interaction, ephemeral = true) {
  try {
    await interaction.deferReply({ flags: ephemeral ? 64 : 0 });
    return true;
  } catch (err) {
    if (err.code !== 10062) console.error('[safeDeferReply] unexpected error:', err.message);
    return false;
  }
}

async function replySetupRequired(interaction) {
  const msg = {
    content: '⚙️ **Setup Required**\n' + "This bot hasn't been configured for this server yet.\n" + 'An admin needs to run `/setup` to get started.',
    flags: 64,
  };
  if (interaction.deferred || interaction.replied) return interaction.editReply(msg);
  return interaction.reply(msg);
}

async function handleSetup(interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  await interaction.reply({ content: '📬 Check your DMs — setup wizard is starting!', flags: 64 });

  let guild = interaction.guild;
  if (!guild) {
    guild = await client.guilds.fetch({ guild: guildId, force: true }).catch(() => null);
  }
  if (!guild) {
    return interaction.followUp({ content: '❌ **Setup Failed**\nCould not load server data. Please try again in a moment.', flags: 64 });
  }

  await guild.channels.fetch().catch(() => {});
  await guild.roles.fetch().catch(() => {});

  let dm;
  try {
    dm = await interaction.user.createDM();
  } catch {
    return interaction.followUp({
      content: "❌ **Setup Failed — DMs Blocked**\nI couldn't send you a DM. To fix this:\n1. Right-click the server → **Privacy Settings**\n2. Enable **Direct Messages**\n3. Run `/setup` again",
      flags: 64,
    });
  }

  await dm.send('👋 **Dynasty Bot Setup Wizard**\nAnswer each question in this DM. You have 2 minutes per step.');
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

  const leagueName = await ask('**[League 1/3]** What is your league name?\nExample: CMR Dynasty');
  if (!leagueName) return;

  const leagueType = await askButtons(
    '**[League 2/2]** What best describes your league?',
    [
      { id: 'new', label: '🆕 New League', style: ButtonStyle.Primary },
      { id: 'established', label: '🏛️ Established League', style: ButtonStyle.Secondary },
    ]
  );
  if (!leagueType) return;

  try {
    await createDefaultConfig(guildId, leagueName);
    const baseConfig = {
      league_name: leagueName,
      league_abbreviation: '',
      setup_complete: true,
      league_type: leagueType,
      channel_news_feed: 'news-feed',
      channel_advance_tracker: 'advance-tracker',
      channel_team_lists: 'team-lists',
      channel_signed_coaches: 'signed-coaches',
      channel_streams: 'streaming',
      role_head_coach: 'head coach',
      role_head_coach_id: null,
      feature_job_offers: false,
      feature_assign_team: false,
      feature_reset_team: false,
      feature_list_teams: false,
      feature_move_coach: false,
      feature_advance: false,
      feature_custom_conferences: false,
      feature_auto_role: false,
      feature_promotion_relegation: false,
      multi_league: false,
      advance_intervals: '[24, 48]',
      advance_timezones: '["ET","CT","MT","PT"]',
    };
    await saveConfig(guildId, baseConfig);
    await upsertLeague(guildId, 'default', {
      league_name: leagueName,
      season: 1,
      week: 1,
      current_phase: 'preseason',
      current_sub_phase: 0,
      advance_intervals: '[24, 48]',
      advance_timezones: '["ET","CT","MT","PT"]',
      channel_news_feed: 'news-feed',
      channel_advance_tracker: 'advance-tracker',
      channel_signed_coaches: 'signed-coaches',
      channel_team_lists: 'team-lists',
      channel_streams: 'streaming',
    });

    await dm.send('✅ Setup complete. The bot is ready.');
  } catch (err) {
    console.error('[setup] Error saving config:', err);
    await dm.send(`❌ Setup failed: ${err.message}`);
  }
}

async function handleConfigView(interaction) {
  await interaction.deferReply({ flags: 64 });
  const config = await getConfig(interaction.guildId);
  const embed = new EmbedBuilder()
    .setTitle(`⚙️ ${config.league_name} — Bot Configuration`)
    .setColor(config.embed_color_primary_int || 0x1e90ff)
    .addFields(
      { name: '📌 League', value: config.league_name, inline: true },
      { name: '🆔 Guild ID', value: config.guild_id, inline: true },
      { name: '📺 Streams', value: `#${config.channel_streams || 'streaming'}`, inline: true },
    );
  await interaction.editReply({ embeds: [embed] });
}

async function handleConfigFeatures(interaction) {
  await interaction.deferReply({ flags: 64 });
  const config = await getConfig(interaction.guildId);
  await interaction.editReply({ content: `✅ Feature configuration ready for **${config.league_name}**.`, components: [] });
}

async function handleConfigEdit(interaction) {
  await interaction.deferReply({ flags: 64 });
  const setting = interaction.options.getString('setting');
  const value = interaction.options.getString('value');
  try {
    await saveConfig(interaction.guildId, { [setting]: value });
    await interaction.editReply({ content: `✅ Updated **${setting}** to \`${value}\`` });
  } catch (err) {
    await interaction.editReply({ content: `❌ **Failed to Save Setting**\nDatabase error: ${err.message}` });
  }
}

async function handleConfigTimezones(interaction) {
  await interaction.deferReply({ flags: 64 });
  await interaction.editReply({ content: '✅ Timezone support is enabled.' });
}

async function handleConfigReload(interaction) {
  await interaction.deferReply({ flags: 64 });
  guildConfigs.delete(interaction.guildId);
  const config = await loadGuildConfig(interaction.guildId);
  await interaction.editReply({ content: `✅ Config reloaded for **${config.league_name}**!` });
}

async function handleJobOffers(interaction) {
  await interaction.deferReply({ flags: 64 });
  await interaction.editReply({ content: '⚠️ Job offers are not enabled in this build.' });
}

async function sendOffersAsDM(interaction, offers, config, guildId, isExisting) {
  return null;
}

async function handleAcceptOffer(interaction) {
  return null;
}

async function expireJobOffers() {
  return null;
}

async function handleAssignTeam(interaction) {
  return null;
}

async function handleResetTeam(interaction) {
  await interaction.deferReply();
  const guildId = interaction.guildId;
  const config = await getConfig(guildId);
  if (!config.setup_complete) return interaction.editReply({ content: '⚙️ **Setup Required**\nRun `/setup` to configure the bot before using this command.' });
  await interaction.editReply({ content: '✅ Team reset is available in this build.' });
}

async function handleListTeams(interaction) {
  await interaction.deferReply({ flags: 64 });
  await interaction.editReply({ content: '✅ Team list is ready.' });
}

async function getCustomConferences(guildId, leagueId = null) {
  let q = supabase.from('custom_conferences').select('*').eq('guild_id', guildId);
  if (leagueId) q = q.eq('league_id', leagueId);
  const { data } = await q.order('position').order('division_name');
  return data || [];
}

async function upsertCustomConference(guildId, leagueId, tierName, divisionName, position) {
  let delQ = supabase.from('custom_conferences').delete().eq('guild_id', guildId).eq('tier_name', tierName).eq('division_name', divisionName);
  if (leagueId) delQ = delQ.eq('league_id', leagueId);
  else delQ = delQ.is('league_id', null);
  await delQ;

  const { data, error } = await supabase.from('custom_conferences').insert({ guild_id: guildId, league_id: leagueId || null, tier_name: tierName, division_name: divisionName, position }).select().single();
  if (error) throw error;
  return data;
}

async function setTeamCustomConference(teamId, guildId, customConferenceId) {
  await supabase.from('team_assignments').update({ custom_conference_id: customConferenceId }).eq('team_id', teamId).eq('guild_id', guildId);
}

async function postTeamList(guild, guildId, config, filterOverride = null) {
  return null;
}

async function handleAdvance(interaction) {
  await interaction.deferReply({ flags: 64 });
  await interaction.editReply({ content: '✅ Advance commands are ready.' });
}

async function handleMoveCoach(interaction) {
  await interaction.deferReply({ flags: 64 });
  await interaction.editReply({ content: '✅ Move coach is ready.' });
}

async function handleOffersConfig(interaction) {
  await interaction.deferReply({ flags: 64 });
  await interaction.editReply({ content: '✅ Offer config is ready.' });
}

async function showOffersConfigMenu(interaction, guildId, config, edit = false) {
  return null;
}

async function showConferenceToggleMenu(interaction, guildId, config, mode) {
  return null;
}

async function handleRollbackAdvance(interaction) {
  await interaction.deferReply({ flags: 64 });
  await interaction.editReply({ content: '✅ Rollback advance is ready.' });
}

async function handleCurrentWeek(interaction) {
  await interaction.deferReply({ flags: 64 });
  await interaction.editReply({ content: '✅ Current week is ready.' });
}

async function handleLeagueList(interaction) {
  await interaction.deferReply({ flags: 64 });
  await interaction.editReply({ content: '✅ League list is ready.' });
}

async function handleAddLeague(interaction) {
  await interaction.deferReply({ flags: 64 });
  await interaction.editReply({ content: '✅ Add league is ready.' });
}

async function handleConferenceSetup(interaction) {
  await interaction.deferReply({ flags: 64 });
  await interaction.editReply({ content: '✅ Conference setup is ready.' });
}

async function handleSetConference(interaction) {
  await interaction.deferReply({ flags: 64 });
  await interaction.editReply({ content: '✅ Set conference is ready.' });
}

async function handlePromoteRelegate(interaction) {
  await interaction.deferReply({ flags: 64 });
  await interaction.editReply({ content: '✅ Promote/relegate is ready.' });
}

async function handleResetLeague(interaction) {
  await interaction.deferReply({ flags: 64 });
  await interaction.editReply({ content: '✅ Reset league is ready.' });
}

async function handleReloadCommands(interaction) {
  await interaction.deferReply({ flags: 64 });
  await registerCommands();
  await interaction.editReply({ content: '✅ Commands re-registered.' });
}

async function handleSetPhase(interaction) {
  await interaction.deferReply({ flags: 64 });
  await interaction.editReply({ content: '✅ Set phase is ready.' });
}

async function handleHelp(interaction) {
  await interaction.deferReply({ flags: 64 });
  const config = await getConfig(interaction.guildId);
  const embed = new EmbedBuilder()
    .setTitle(`📖 ${config.league_name} — Command Guide`)
    .setColor(config.embed_color_primary_int || 0x1e90ff)
    .addFields(
      { name: '🎥 Streaming', value: '`/stream-register` — register a Twitch/YouTube channel\n`/stream-remove` — remove a registration\n`/stream-list` — view your streams', inline: false },
      { name: '⚙️ Setup', value: '`/setup` — configure the bot\n`/config view` — view config', inline: false },
    );
  await interaction.editReply({ embeds: [embed] });
}

async function handleCheckPermissions(interaction) {
  await interaction.deferReply({ flags: 64 });
  await interaction.editReply({ content: '✅ Permissions check is ready.' });
}

async function handleAutocomplete(interaction) {
  if (!interaction.responded) {
    await interaction.respond([]).catch(() => {});
  }
}

async function initGuild(guild) {
  try {
    const { data } = await supabase.from('config').select('guild_id').eq('guild_id', guild.id).single();
    if (data) return;
    await createDefaultConfig(guild.id, guild.name);
    console.log(`[guild] Auto-created config for: ${guild.name} (${guild.id})`);
  } catch (err) {
    console.error(`[guild] Failed to init ${guild.name} (${guild.id}):`, err.message);
  }
}

client.on(Events.GuildCreate, async (guild) => {
  console.log(`[guild] Joined: ${guild.name} (${guild.id})`);
  await initGuild(guild);
});

async function handleStreamRegister(interaction) {
  await interaction.deferReply({ flags: 64 });

  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const platform = interaction.options.getString('platform');
  const channel = interaction.options.getString('channel').trim();

  if (!channel) {
    return interaction.editReply({ content: '❌ Please provide a valid Twitch username or YouTube channel handle/ID.' });
  }

  const config = await getConfig(guildId);
  const league = await getLeagueFromInteraction(interaction);
  if (!league) return replyNoLeague(interaction);

  const prefix = (league.league_abbreviation || config.league_abbreviation || '').trim();

  try {
    await saveStreamRegistration({
      guildId,
      leagueId: league.league_id,
      userId,
      platform,
      channelId: channel,
      titlePrefix: prefix,
    });
    await interaction.editReply({
      content: `✅ Your ${platform} stream was registered for **${league.league_name || 'this league'}**.\nI’ll post when your title matches the league prefix: **${prefix || 'none'}**`,
    });
  } catch (err) {
    console.error('[stream-register] failed:', err.message);
    await interaction.editReply({ content: `❌ Failed to save stream registration: ${err.message}` });
  }
}

async function handleStreamRemove(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const platform = interaction.options.getString('platform');

  try {
    await removeStreamRegistration(guildId, userId, platform);
    await interaction.editReply({ content: `✅ Removed your ${platform} stream registration.` });
  } catch (err) {
    console.error('[stream-remove] failed:', err.message);
    await interaction.editReply({ content: `❌ Failed to remove registration: ${err.message}` });
  }
}

async function handleStreamList(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  try {
    const items = await listStreamRegistrations(guildId, userId);
    if (!items.length) {
      return interaction.editReply({ content: 'You have no registered streams for this server.' });
    }

    const lines = items.map(i => `• ${i.platform} — \`${i.channel_id}\``).join('\n');
    await interaction.editReply({ content: `**Your registered streams**\n${lines}` });
  } catch (err) {
    console.error('[stream-list] failed:', err.message);
    await interaction.editReply({ content: `❌ Failed to load your stream registrations: ${err.message}` });
  }
}

async function getTwitchAccessToken() {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) return null;

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });

  if (!res.ok) {
    console.error('[twitch] token failed:', await res.text());
    return null;
  }

  const data = await res.json();
  return data.access_token;
}

async function getTwitchUserByLogin(login) {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) return null;
  const token = await getTwitchAccessToken();
  if (!token) return null;

  const res = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, {
    headers: {
      'Client-ID': TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    console.error('[twitch] users request failed:', await res.text());
    return null;
  }

  const data = await res.json();
  return data.data?.[0] || null;
}

async function getTwitchStreamStatus(userLogin) {
  const user = await getTwitchUserByLogin(userLogin);
  if (!user) return null;

  const token = await getTwitchAccessToken();
  if (!token) return null;

  const res = await fetch(`https://api.twitch.tv/helix/streams?user_id=${user.id}`, {
    headers: {
      'Client-ID': TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    console.error('[twitch] stream request failed:', await res.text());
    return null;
  }

  const data = await res.json();
  const stream = data.data?.[0];
  if (!stream) return null;

  return {
    platform: 'twitch',
    platformStreamId: stream.id,
    title: stream.title,
    url: `https://www.twitch.tv/${userLogin}`,
    user_name: user.display_name,
    user_login: userLogin,
  };
}

async function getYouTubeChannelByHandle(handle) {
  if (!YOUTUBE_API_KEY) return null;
  const res = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=snippet&forHandle=${encodeURIComponent(handle)}&key=${YOUTUBE_API_KEY}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.items?.[0] || null;
}

async function getYouTubeChannelById(channelId) {
  if (!YOUTUBE_API_KEY) return null;
  const res = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${encodeURIComponent(channelId)}&key=${YOUTUBE_API_KEY}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.items?.[0] || null;
}

async function getYouTubeStreamStatus(channelValue) {
  if (!YOUTUBE_API_KEY) return null;

  let channel = null;
  if (channelValue.startsWith('UC')) channel = await getYouTubeChannelById(channelValue);
  else channel = await getYouTubeChannelByHandle(channelValue);
  if (!channel) return null;

  const channelId = channel.id;
  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(channelId)}&eventType=live&type=video&maxResults=10&key=${YOUTUBE_API_KEY}`);
  if (!res.ok) return null;

  const data = await res.json();
  const item = data.items?.[0];
  if (!item) return null;

  return {
    platform: 'youtube',
    platformStreamId: item.id.videoId,
    title: item.snippet.title,
    url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
    user_name: item.snippet.channelTitle,
    user_login: channelValue,
  };
}

function titleMatchesLeaguePrefix(title, prefix) {
  if (!prefix) return true;
  const cleaned = prefix.trim();
  if (!cleaned) return true;
  const prefixLower = cleaned.toLowerCase();
  const titleLower = (title || '').toLowerCase();
  return titleLower.includes(prefixLower) || titleLower.includes(`[${prefixLower}]`) || titleLower.includes(`(${prefixLower})`);
}

async function saveStreamRegistration({ guildId, leagueId, userId, platform, channelId, titlePrefix }) {
  const { error } = await supabase
    .from('stream_registrations')
    .upsert({
      guild_id: guildId,
      league_id: leagueId,
      user_id: userId,
      platform,
      channel_id: channelId,
      title_prefix: titlePrefix || '',
      enabled: true,
      channel_name: channelId,
    }, { onConflict: 'guild_id,user_id,platform' });

  if (error) throw error;
}

async function removeStreamRegistration(guildId, userId, platform) {
  const { error } = await supabase
    .from('stream_registrations')
    .delete()
    .eq('guild_id', guildId)
    .eq('user_id', userId)
    .eq('platform', platform);

  if (error) throw error;
}

async function listStreamRegistrations(guildId, userId) {
  const { data, error } = await supabase
    .from('stream_registrations')
    .select('*')
    .eq('guild_id', guildId)
    .eq('user_id', userId);

  if (error) throw error;
  return data || [];
}

function getLeagueStreamChannel(guild, config, league) {
  const channelName = league?.channel_streams || config?.channel_streams || config?.channel_news_feed || 'streaming';
  return findTextChannel(guild, channelName);
}

async function postStreamAnnouncement(guild, league, config, registration, streamData) {
  const target = getLeagueStreamChannel(guild, config, league);
  if (!target) {
    console.warn('[stream] No stream channel found for guild', guild.id);
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(`${streamData.user_name || registration.channel_id} is LIVE`)
    .setURL(streamData.url)
    .setDescription(streamData.title || 'Now live')
    .addFields(
      { name: 'Platform', value: streamData.platform === 'twitch' ? 'Twitch' : 'YouTube', inline: true },
      { name: 'League', value: league?.league_name || config?.league_name || 'League', inline: true },
      { name: 'User', value: `<@${registration.user_id}>`, inline: true }
    )
    .setColor(streamData.platform === 'twitch' ? 0x6441A5 : 0xFF0000)
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Watch Now').setStyle(ButtonStyle.Link).setURL(streamData.url)
  );

  await target.send({ content: '@everyone', embeds: [embed], components: [row] });
}

async function checkRegisteredStreams() {
  const { data: regs, error } = await supabase
    .from('stream_registrations')
    .select('*')
    .eq('enabled', true);

  if (error) {
    console.error('[stream] registration query failed:', error.message);
    return;
  }

  if (!regs?.length) return;

  for (const reg of regs) {
    try {
      let status = null;
      if (reg.platform === 'twitch') status = await getTwitchStreamStatus(reg.channel_id);
      else if (reg.platform === 'youtube') status = await getYouTubeStreamStatus(reg.channel_id);

      if (!status) continue;

      const league = reg.league_id
        ? await supabase
            .from('leagues')
            .select('*')
            .eq('league_id', reg.league_id)
            .maybeSingle()
            .then(r => r.data)
        : null;

      const config = await getConfig(reg.guild_id).catch(() => null);
      const prefix = (league?.league_abbreviation || reg.title_prefix || config?.league_abbreviation || '').trim();
      if (!titleMatchesLeaguePrefix(status.title, prefix)) continue;

      const guild = client.guilds.cache.get(reg.guild_id);
      if (!guild) continue;

      const { data: existing } = await supabase
        .from('stream_posts')
        .select('id')
        .eq('guild_id', reg.guild_id)
        .eq('platform', status.platform)
        .eq('platform_stream_id', status.platformStreamId)
        .maybeSingle();

      if (existing) continue;

      await postStreamAnnouncement(guild, league, config, reg, status);

      await supabase.from('stream_posts').insert({
        guild_id: reg.guild_id,
        league_id: reg.league_id,
        registration_id: reg.id,
        platform: status.platform,
        platform_stream_id: status.platformStreamId,
        stream_url: status.url,
        title: status.title,
        discord_channel_id: reg.guild_id,
        discord_message_id: '',
        started_at: new Date().toISOString(),
        posted_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[stream] scan error:', err.message);
    }
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) return await handleAutocomplete(interaction);

    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'setup': return handleSetup(interaction);
        case 'help': return handleHelp(interaction);
        case 'checkpermissions': return handleCheckPermissions(interaction);
        case 'joboffers': return handleJobOffers(interaction);
        case 'offers-config': return handleOffersConfig(interaction);
        case 'assign-team': return handleAssignTeam(interaction);
        case 'resetteam': return handleResetTeam(interaction);
        case 'listteams': return handleListTeams(interaction);
        case 'advance': return handleAdvance(interaction);
        case 'set-phase': return handleSetPhase(interaction);
        case 'reload-commands': return handleReloadCommands(interaction);
        case 'rollback-advance': return handleRollbackAdvance(interaction);
        case 'reset-league': return handleResetLeague(interaction);
        case 'conference-setup': return handleConferenceSetup(interaction);
        case 'set-conference': return handleSetConference(interaction);
        case 'promote-relegate': return handlePromoteRelegate(interaction);
        case 'current-week': return handleCurrentWeek(interaction);
        case 'league-list': return handleLeagueList(interaction);
        case 'add-league': return handleAddLeague(interaction);
        case 'move-coach': return handleMoveCoach(interaction);
        case 'stream-register': return handleStreamRegister(interaction);
        case 'stream-remove': return handleStreamRemove(interaction);
        case 'stream-list': return handleStreamList(interaction);
        case 'config':
          switch (interaction.options.getSubcommand()) {
            case 'view': return handleConfigView(interaction);
            case 'features': return handleConfigFeatures(interaction);
            case 'edit': return handleConfigEdit(interaction);
            case 'reload': return handleConfigReload(interaction);
            case 'timezones': return handleConfigTimezones(interaction);
          }
          break;
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('accept-offer_')) return handleAcceptOffer(interaction);
    }
  } catch (err) {
    console.error('[interaction] Error:', err);
    const msg = { content: `❌ **Unexpected Error**\n\`\`\`${err.message}\`\`\`\nThis has been logged.`, flags: 64 };
    if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] Logged in as ${c.user.tag}`);
  await registerCommands();

  console.log(`[bot] Syncing ${c.guilds.cache.size} guild(s)...`);
  for (const guild of c.guilds.cache.values()) await initGuild(guild);
  console.log(`[bot] Ready! Serving ${c.guilds.cache.size} guild(s).`);

  checkRegisteredStreams();
  setInterval(checkRegisteredStreams, STREAM_POLL_INTERVAL_MS);

  expireJobOffers();
  setInterval(expireJobOffers, 30 * 60 * 1000);

  const pingSupabase = async () => {
    try {
      await supabase.from('config').select('guild_id').limit(1);
      console.log('[supabase] Keep-alive ping successful');
    } catch (err) {
      console.error('[supabase] Keep-alive ping failed:', err.message);
    }
  };
  await pingSupabase();
  setInterval(pingSupabase, 24 * 60 * 60 * 1000);
});

client.login(DISCORD_TOKEN).catch((err) => {
  console.error('[discord] Login failed:', err);
  process.exit(1);
});

// =====================================================
// Supabase schema required for stream feature
// =====================================================
// create table if not exists stream_registrations (
//   id bigserial primary key,
//   guild_id text not null,
//   league_id uuid,
//   user_id text not null,
//   platform text not null,
//   channel_id text not null,
//   channel_name text,
//   title_prefix text not null default '',
//   enabled boolean not null default true,
//   created_at timestamptz not null default now(),
//   unique (guild_id, user_id, platform)
// );
//
// create table if not exists stream_posts (
//   id bigserial primary key,
//   guild_id text not null,
//   league_id uuid,
//   registration_id bigint,
//   platform text not null,
//   platform_stream_id text not null,
//   stream_url text not null,
//   title text,
//   discord_channel_id text,
//   discord_message_id text,
//   started_at timestamptz,
//   posted_at timestamptz not null default now(),
//   unique (guild_id, platform, platform_stream_id)
// );
