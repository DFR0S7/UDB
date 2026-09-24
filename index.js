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
const ws = require('ws');

// =====================================================
// ENVIRONMENT & CLIENTS
// =====================================================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;
const CLIENT_ID       = process.env.CLIENT_ID;
const YOUTUBE_API_KEY  = process.env.YOUTUBE_API_KEY  || null;
const TWITCH_CLIENT_ID  = process.env.TWITCH_CLIENT_ID  || null;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || null;
const PORT          = process.env.PORT || 3000;
const SELF_PING_URL = process.env.SELF_PING_URL || '';

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
// =====================================================
// PHASE CYCLE
// =====================================================
const PHASE_CYCLE = [
  { key: 'preseason',           name: 'Preseason',               subWeeks: 1,  startSub: 0, format: ()    => 'Preseason' },
  { key: 'regular',             name: 'Regular Season',          subWeeks: 16, startSub: 0, format: (sub) => `Week ${sub}` },
  { key: 'conf_champ',          name: 'Conference Championship', subWeeks: 1,  startSub: 0, format: ()    => 'Conference Championship' },
  { key: 'bowl',                name: 'Bowl Season',             subWeeks: 4,  startSub: 0, format: (sub) => {
    const labels = ['Bowl Week 1', 'Bowl Week 2', 'Semifinals', 'National Championship'];
    return labels[sub] ?? `Bowl Week ${sub + 1}`;
  }},
  { key: 'end_of_season_recap', name: 'End of Season Recap',     subWeeks: 1,  startSub: 0, format: ()    => 'End of Season Recap' },
  { key: 'players_leaving',     name: 'Players Leaving',         subWeeks: 1,  startSub: 0, format: ()    => 'Players Leaving' },
  { key: 'transfer_portal',     name: 'Transfer Portal',         subWeeks: 4,  startSub: 0, format: (sub) => `Transfer Week ${sub + 1}` },
  { key: 'position_changes',    name: 'Position Changes',        subWeeks: 1,  startSub: 0, format: ()    => 'Position Changes' },
  { key: 'training_results',    name: 'Training Results',        subWeeks: 1,  startSub: 0, format: ()    => 'Training Results' },
  { key: 'encourage_transfers', name: 'Encourage Transfers',     subWeeks: 1,  startSub: 0, format: ()    => 'Encourage Transfers' },
];

const getPhaseByKey = (key) => PHASE_CYCLE.find(p => p.key === key) || PHASE_CYCLE[0];

// Returns a human-readable label for the current phase + sub-week
function formatPhase(phaseKey, subPhase) {
  const phase = getPhaseByKey(phaseKey);
  return phase.format ? phase.format(subPhase) : phase.name;
}


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
  league_name:                  'Dynasty League',
  league_abbreviation:          '',
  setup_complete:               false,
  league_type:                  'new',      // 'new' | 'established'
  // ── Feature flags ─────────────────────────────
  feature_job_offers:           false,
  feature_assign_team:          false,
  feature_reset_team:           false,
  feature_list_teams:           false,
  feature_move_coach:           false,
  feature_advance:              false,
  feature_custom_conferences:   false,
  feature_auto_role:            false,
  feature_stream:               false,
  feature_promotion_relegation:  false,
  // ── Channels ──────────────────────────────────
  channel_news_feed:            'news-feed',
  channel_advance_tracker:      'advance-tracker',
  channel_team_lists:           'team-lists',
  team_list_filter:             'all',   // 'all' | 'assigned' | 'available' — saved via /config edit team_list_filter
  channel_signed_coaches:       'signed-coaches',
  channel_streaming:            'streaming',
  // ── Roles ─────────────────────────────────────
  role_head_coach:              'head coach',
  role_head_coach_id:           null,
  // ── Job Offers ────────────────────────────────
  star_rating_for_offers:       2.5,
  star_rating_max_for_offers:   null,
  job_offers_count:             3,
  job_offers_expiry_hours:      48,
  // ── Stream / Advance ──────────────────────────
  advance_intervals:            '[24, 48]',
  advance_timezones:             '["ET","CT","MT","PT"]',
  // ── Embed colors ──────────────────────────────
  embed_color_primary:          '0x1e90ff',
  embed_color_win:              '0x00ff00',
  embed_color_loss:             '0xff0000',
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
  return {
    ...data,
    advance_intervals_parsed: intervals,
    advance_timezones_parsed: (() => {
      try {
        const tzs = JSON.parse(data.advance_timezones || '["ET","CT","MT","PT"]');
        return Array.isArray(tzs) ? tzs : ['ET','CT','MT','PT'];
      } catch { return ['ET','CT','MT','PT']; }
    })(),
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
// =====================================================
// SUPABASE HELPERS
// =====================================================
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

  let assignQuery = supabase
    .from('team_assignments')
    .select('*')
    .eq('team_id', team.id)
    .eq('guild_id', guildId);
  if (leagueId) assignQuery = assignQuery.eq('league_id', leagueId);
  const { data: assignment, error: assignErr } = await assignQuery.maybeSingle();

  if (assignErr) {
    console.error(`[db] getTeamByName("${teamName}") assignments query error:`, assignErr.message);
    // Non-fatal — team exists, just no assignment info
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
    // Non-fatal — return teams with no assignment info
  }

  const assignMap = {};
  for (const a of (assignments || [])) assignMap[a.team_id] = a;

  return teams.map(t => ({
    ...t,
    user_id:              assignMap[t.id]?.user_id              || null,
    assignment_id:        assignMap[t.id]?.id                  || null,
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

// =====================================================
// MULTI-LEAGUE HELPERS
// =====================================================

const LEAGUE_DEFAULTS = {
  season:            1,
  week:              1,
  current_phase:     'preseason',
  current_sub_phase: 0,
  advance_hours:     24,
  advance_deadline:  null,
  last_advance_at:   null,
  next_advance_deadline: null,
  advance_intervals: '[24, 48]',
  advance_timezones: '["ET","CT","MT","PT"]',
};

// Get a league by its category_id within a guild
async function getLeagueByCategoryId(guildId, categoryId) {
  const { data } = await supabase
    .from('leagues')
    .select('*')
    .eq('guild_id', guildId)
    .eq('category_id', categoryId)
    .single();
  return data || null;
}

// Get the default (single-league) league for a guild
async function getDefaultLeague(guildId) {
  const { data } = await supabase
    .from('leagues')
    .select('*')
    .eq('guild_id', guildId)
    .eq('category_id', 'default')
    .single();
  return data || { ...LEAGUE_DEFAULTS, guild_id: guildId, category_id: 'default' };
}

// Get all leagues for a guild
async function getGuildLeagues(guildId) {
  const { data } = await supabase
    .from('leagues')
    .select('*')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: true });
  return data || [];
}

// Detect league from an interaction — handles both single and multi-league guilds
async function getLeagueFromInteraction(interaction) {
  const guildId = interaction.guildId;
  const config  = await getConfig(guildId);

  // Single-league guild — return the default league row
  if (!config.multi_league) return getDefaultLeague(guildId);

  // Multi-league — detect from the channel's parent category
  const categoryId = interaction.channel?.parentId;
  if (!categoryId) {
    // Channel has no category — try default fallback
    return getDefaultLeague(guildId);
  }

  const league = await getLeagueByCategoryId(guildId, categoryId);
  if (!league) {
    // Channel's category isn't mapped to a league
    return null;
  }
  return league;
}

// Update league state (replaces setMeta for multi-league aware code)
async function setLeague(leagueId, updates) {
  await supabase
    .from('leagues')
    .update({ ...updates })
    .eq('league_id', leagueId);
}

// Upsert a league row (used by setup wizard)
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

// Parse league advance intervals/timezones (mirrors parseConfig logic)
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
    advance_timezones_parsed:  timezones,
  };
}

// Helper: reply with error when command is run outside a mapped league channel
function replyNoLeague(interaction) {
  return interaction.editReply({
    content: '❌ **No League Found**\nThis channel is not part of a configured league. Run the command from a channel inside a league category, or ask an admin to use `/add-league`.',
  });
}

async function getMeta(guildId) {
  // Legacy: reads from meta table for backwards compatibility
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
  // Legacy: writes to meta table for backwards compatibility
  await supabase.from('meta').upsert({ guild_id: guildId, ...updates }, { onConflict: 'guild_id' });
  // Also sync to leagues table (default league row)
  await supabase.from('leagues')
    .update(updates)
    .eq('guild_id', guildId)
    .eq('category_id', 'default');
}


// ── Job Offer Config helpers ──────────────────────────────────────────────
async function getJobOfferConfig(guildId) {
  const { data } = await supabase
    .from('job_offer_config')
    .select('*')
    .eq('guild_id', guildId)
    .maybeSingle();
  return {
    one_per_conference: false,
    weighted_ratings:   'off',
    conf_balance:       false,
    ...( data || {} ),
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
  // Returns true if now active, false if removed
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

// =====================================================
// COACH STREAM HELPERS
// =====================================================

// =====================================================
// SLASH COMMANDS DEFINITION
// =====================================================
function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('setup')
      .setDescription('Interactive bot configuration wizard (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
      .setName('config')
      .setDescription('Manage bot configuration (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand(s => s.setName('view').setDescription('View current configuration'))
      .addSubcommand(s => s.setName('features').setDescription('Toggle features on/off'))
      .addSubcommand(s => s.setName('reload').setDescription('Reload config from database'))
      .addSubcommand(s => s.setName('edit').setDescription('Edit a specific config value')
        .addStringOption(o => o.setName('setting').setDescription('Setting name').setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName('value').setDescription('New value').setRequired(true).setAutocomplete(true))),

    new SlashCommandBuilder()
      .setName('help')
      .setDescription('Show available commands and features.'),

    new SlashCommandBuilder()
      .setName('job-offers')
      .setDescription('View available coaching job offers.'),

    new SlashCommandBuilder()
      .setName('assign-team')
      .setDescription('[Admin] Assign a team to a coach.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(true))
      .addStringOption(o => o.setName('team').setDescription('Team name').setRequired(true).setAutocomplete(true))
      .addBooleanOption(o => o.setName('skip-announcement').setDescription('Skip signing announcement').setRequired(false)),

    new SlashCommandBuilder()
      .setName('reset-team')
      .setDescription('[Admin] Remove a coach from their team.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption(o => o.setName('user').setDescription('User to reset').setRequired(false))
      .addStringOption(o => o.setName('team').setDescription('Team name').setRequired(false).setAutocomplete(true)),

    new SlashCommandBuilder()
      .setName('listteams')
      .setDescription('[Admin] Post the team availability list.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption(o => o.setName('filter').setDescription('Filter teams').setRequired(false)
        .addChoices(
          { name: 'All Teams',        value: 'all' },
          { name: 'Assigned Only',    value: 'assigned' },
          { name: 'Available Only',   value: 'available' },
          { name: 'Conference View',  value: 'conference_view' },
        )),

    new SlashCommandBuilder()
      .setName('move-coach')
      .setDescription('[Admin] Move a coach from one team to another.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption(o => o.setName('user').setDescription('Coach to move').setRequired(true))
      .addStringOption(o => o.setName('new-team').setDescription('Destination team').setRequired(true).setAutocomplete(true)),

    new SlashCommandBuilder()
      .setName('advance')
      .setDescription('[Admin] Advance the league to the next phase.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption(o => o.setName('hours').setDescription('Deadline window for this week').setRequired(true).setAutocomplete(true)),

    new SlashCommandBuilder()
      .setName('set-phase')
      .setDescription('[Admin] Manually set the current season, phase, and sub-week.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addIntegerOption(o => o.setName('season').setDescription('Season number').setRequired(false))
      .addStringOption(o => o.setName('phase').setDescription('Phase key').setRequired(false).setAutocomplete(true))
      .addIntegerOption(o => o.setName('sub').setDescription('Sub-phase number').setRequired(false)),

    new SlashCommandBuilder()
      .setName('rollback-advance')
      .setDescription('[Admin] Roll the league back to a previous season, phase, and week.'),

    new SlashCommandBuilder()
      .setName('reset-league')
      .setDescription('[Admin] Reset league data for this server. Use with caution.'),

    new SlashCommandBuilder()
      .setName('current-week')
      .setDescription('Show the current season, phase, and week for this league.'),

    new SlashCommandBuilder()
      .setName('league-list')
      .setDescription('Show all leagues configured in this server.'),

    new SlashCommandBuilder()
      .setName('add-league')
      .setDescription('[Admin] Add a new league to this server (multi-league mode).'),

    new SlashCommandBuilder()
      .setName('config-wizard')
      .setDescription('[Admin] Update specific sections of your bot config without redoing full setup.'),

    new SlashCommandBuilder()
      .setName('conference-setup')
      .setDescription('[Admin] Set up custom tier/division structure for the team list.'),

    new SlashCommandBuilder()
      .setName('set-conference')
      .setDescription('[Admin] Assign a team to a custom conference.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption(o => o.setName('team').setDescription('Team name').setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName('conference').setDescription('Conference name (e.g. SEC, B10)').setRequired(true).setAutocomplete(true)),

    new SlashCommandBuilder()
      .setName('promote-relegate')
      .setDescription('[Admin] Move a team up or down a tier within their division.'),

    new SlashCommandBuilder()
      .setName('reload-commands')
      .setDescription('[Admin] Force re-register all slash commands with Discord.'),

    new SlashCommandBuilder()
      .setName('checkpermissions')
      .setDescription('[Admin] Audit bot permissions across all configured channels.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
      .setName('stream-register')
      .setDescription('Register your Twitch or YouTube stream link.')
      .addStringOption(o => o.setName('link').setDescription('Your Twitch or YouTube stream URL').setRequired(true)),

    new SlashCommandBuilder()
      .setName('stream-admin')
      .setDescription('[Admin] Register a stream link for a specific user.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption(o => o.setName('link').setDescription('Twitch or YouTube stream URL').setRequired(true))
      .addUserOption(o => o.setName('user').setDescription('The coach to register for').setRequired(true)),

    new SlashCommandBuilder()
      .setName('stream-remove')
      .setDescription('Remove your stream registration.'),

    new SlashCommandBuilder()
      .setName('stream-live')
      .setDescription('Check if you are live and post to the streaming channel.'),

    new SlashCommandBuilder()
      .setName('stream-list')
      .setDescription('Show all registered streamers in this server.'),

    new SlashCommandBuilder()
      .setName('stream-remove-admin')
      .setDescription('[Admin] Remove a stream registration for any user.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption(o => o.setName('user').setDescription('The coach to remove').setRequired(true))
      .addStringOption(o => o.setName('platform').setDescription('Platform to remove').setRequired(false)
        .addChoices(
          { name: 'YouTube', value: 'youtube' },
          { name: 'Twitch',  value: 'twitch'  },
        )),

  ].map(cmd => cmd.toJSON());
}

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

// Setup gate — returned to user-facing handlers when setup hasn't been run
// Safe defer — returns false if interaction token already expired (e.g. after shard reconnect)
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
    content:
      '⚙️ **Setup Required**\n' +
      "This bot hasn't been configured for this server yet.\n" +
      'An admin needs to run `/setup` to get started.',
    flags: 64,
  };
  if (interaction.deferred || interaction.replied) return interaction.editReply(msg);
  return interaction.reply(msg);
}

// /setup ──────────────────────────────────────────────
async function handleSetup(interaction) {
  const guildId = interaction.guildId;
  const userId  = interaction.user.id;
  // Acknowledge immediately — must happen within 3 seconds
  await interaction.reply({ content: '📬 Check your DMs — setup wizard is starting!', flags: 64 });

  // Fetch guild with full data — use fetch({force:true}) to bypass stale cache
  let guild = interaction.guild;
  if (!guild) {
    guild = await client.guilds.fetch({ guild: guildId, force: true }).catch(() => null);
  }
  if (!guild) {
    return interaction.followUp({ content: '❌ **Setup Failed**\nCould not load server data. Please try again in a moment.', flags: 64 });
  }

  // Populate channel and role caches
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
  try {
  const textChannels = [...guild.channels.cache
    .filter(c => c.type === ChannelType.GuildText)
    .sort((a, b) => a.name.localeCompare(b.name))
    .values()];

  const roles = [...guild.roles.cache
    .filter(r => !r.managed && r.name !== '@everyone')
    .sort((a, b) => b.position - a.position)
    .values()];

  // ── League Info ───────────────────────────────────────────────────────────
  const leagueName = await ask('**[League 1/3]** What is your league name?\nExample: CMR Dynasty');
  if (!leagueName) return;

  // ── League Type ───────────────────────────────────────────────────────────
  const leagueType = await askButtons(
    '**[League 2/2]** What best describes your league?',
    [
      { id: 'new',         label: '🆕 New League',         style: ButtonStyle.Primary },
      { id: 'established', label: '🏛️ Established League', style: ButtonStyle.Secondary },
    ]
  );
  if (!leagueType) return;

  // ── Established League: capture current season + week ────────────────────
  let initialMeta = { season: 1, week: 1, current_phase: 'preseason', current_sub_phase: 0 };
  if (leagueType === 'established') {
    const seasonStr = await ask(
      '**[League 4/?]** What season is your league currently in?\nExample: `3`'
    );
    if (!seasonStr) return;
    const season = parseInt(seasonStr);
    if (isNaN(season) || season < 1) {
      await dm.send('❌ Invalid season number. Run `/setup` again.');
      return;
    }

    const phaseGroup = await askButtons(
      '**[League 5/?]** What phase is the league currently in?',
      [
        { id: 'preseason',  label: 'Preseason',               style: ButtonStyle.Secondary },
        { id: 'regular',    label: 'Regular Season',          style: ButtonStyle.Primary },
        { id: 'conf_champ', label: 'Conference Championship', style: ButtonStyle.Secondary },
        { id: 'bowl',       label: 'Bowl Season',             style: ButtonStyle.Secondary },
        { id: 'offseason',  label: 'Offseason (post-bowl)',   style: ButtonStyle.Secondary },
      ]
    );
    if (!phaseGroup) return;

    let currentWeek = 1;
    let currentSub  = 0;
    let phaseKey    = phaseGroup;

    if (phaseGroup === 'regular') {
      let validWeek = false;
      while (!validWeek) {
        const weekStr = await ask('**[League 6/?]** What week is currently displayed in your advance post? (1–16)\nExample: `8` for Week 8');
        if (!weekStr) return;
        const parsed = parseInt(weekStr);
        if (!isNaN(parsed) && parsed >= 1 && parsed <= 16) {
          currentSub  = parsed - 1; // sub is 0-indexed internally
          currentWeek = parsed;
          validWeek   = true;
        } else {
          await dm.send('❌ Please enter a number between 1 and 16.');
        }
      }

    } else if (phaseGroup === 'bowl') {
      const bowlChoice = await askButtons(
        '**[League 6/?]** Which bowl week?',
        [
          { id: '0', label: 'Bowl Week 1',           style: ButtonStyle.Secondary },
          { id: '1', label: 'Bowl Week 2',           style: ButtonStyle.Secondary },
          { id: '2', label: 'Semifinals',            style: ButtonStyle.Secondary },
          { id: '3', label: 'National Championship', style: ButtonStyle.Primary },
        ]
      );
      if (!bowlChoice) return;
      currentSub = parseInt(bowlChoice);

    } else if (phaseGroup === 'offseason') {
      const offChoice = await askButtons(
        '**[League 6/?]** Which offseason phase?',
        [
          { id: 'end_of_season_recap', label: 'End of Season Recap', style: ButtonStyle.Secondary },
          { id: 'players_leaving',     label: 'Players Leaving',     style: ButtonStyle.Secondary },
          { id: 'transfer_portal',     label: 'Transfer Portal',     style: ButtonStyle.Secondary },
          { id: 'position_changes',    label: 'Position Changes',    style: ButtonStyle.Secondary },
          { id: 'training_results',    label: 'Training Results',    style: ButtonStyle.Secondary },
        ]
      );
      if (!offChoice) return;
      phaseKey = offChoice;

      if (offChoice === 'transfer_portal') {
        const transferChoice = await askButtons(
          '**[League 7/?]** Which transfer week?',
          [
            { id: '0', label: 'Transfer Week 1', style: ButtonStyle.Secondary },
            { id: '1', label: 'Transfer Week 2', style: ButtonStyle.Secondary },
            { id: '2', label: 'Transfer Week 3', style: ButtonStyle.Secondary },
            { id: '3', label: 'Transfer Week 4', style: ButtonStyle.Secondary },
          ]
        );
        if (!transferChoice) return;
        currentSub = parseInt(transferChoice);
      }
    }
    // preseason / conf_champ: phaseKey already set, sub stays 0

    // Derive week: regular = sub+1, preseason = 1, bowl/offseason = 17 (post-regular-season)
    const derivedWeek = phaseKey === 'regular'   ? currentSub + 1
                      : phaseKey === 'preseason'  ? 1
                      : 17; // bowl / offseason — assume regular season finished at week 17

    initialMeta = {
      season:            season,
      week:              derivedWeek,
      current_phase:     phaseKey,
      current_sub_phase: currentSub,
    };
  }

  // ── Multi-League Setup ───────────────────────────────────────────────────
  const isMultiLeague = false; // Multi-league configured via /add-league after setup
  const mainLeagueCategoryId = null;
  const additionalLeagues = [];

  // ── Group-Based Feature Selection ────────────────────────────────────────

  // Helper: ask about one feature group — Enable All / Disable All / Customize
  const askGroupFeatures = async (groupLabel, groupEmoji, commands) => {
    const choice = await askButtons(
      `${groupEmoji} **${groupLabel}**\nEnable this feature group?\nIncludes: ${commands.map(c => c.label).join(', ')}`,
      [
        { id: 'all',    label: '✅ Enable All',  style: ButtonStyle.Success },
        { id: 'none',   label: '❌ Disable All', style: ButtonStyle.Danger },
        { id: 'custom', label: '🔧 Customize',   style: ButtonStyle.Secondary },
      ]
    );
    if (!choice) return null;
    if (choice === 'all')  return commands.map(c => c.id);
    if (choice === 'none') return [];
    return await askMultiButtons(
      `🔧 **${groupLabel} — Customize**\nSelect which commands to enable:`,
      commands
    );
  };

  await dm.send('**— Feature Setup —**\nConfigure each feature group one at a time. Nothing is on by default — enable only what you need.');


  const teamCmds = [
    { label: 'Job Offers',  id: 'feature_job_offers' },
    { label: 'Assign Team', id: 'feature_assign_team' },
    { label: 'Reset Team',  id: 'feature_reset_team' },
    { label: 'List Teams',  id: 'feature_list_teams' },
    { label: 'Move Coach',  id: 'feature_move_coach' },
  ];
  const advanceCmds = [
    { label: 'Advance', id: 'feature_advance' },
  ];
  const extraCmds = [
    { label: 'Streaming',                             id: 'feature_stream' },
    { label: 'Custom Conferences',                    id: 'feature_custom_conferences' },
    { label: 'Auto Role',                             id: 'feature_auto_role' },
    { label: 'Promotion/Relegation (req. Custom Conferences)',       id: 'feature_promotion_relegation' },
  ];

  if (leagueType === 'established') await dm.send('💡 **Team Selection — Recommendation:** Enable **Assign Team** to map existing coaches to their teams directly. You likely won\'t need Job Offers unless you\'re still growing.');
  else await dm.send('💡 **Team Selection — Recommendation:** Enable **Job Offers** so coaches can request and accept teams through the bot.');
  const teamEnabled      = await askGroupFeatures('Team Selection',     '👥', teamCmds);
  if (teamEnabled === null) return;
  const advanceEnabled   = await askGroupFeatures('Advance Management', '📅', advanceCmds);
  if (advanceEnabled === null) return;
  const extraEnabled     = await askGroupFeatures('Extra Features',        '⚙️', extraCmds);
  if (extraEnabled === null) return;
  const allEnabled = [...teamEnabled, ...advanceEnabled, ...extraEnabled];

  const features = {
    feature_job_offers:            allEnabled.includes('feature_job_offers'),
    feature_assign_team:           allEnabled.includes('feature_assign_team'),
    feature_reset_team:            allEnabled.includes('feature_reset_team'),
    feature_list_teams:            allEnabled.includes('feature_list_teams'),
    feature_move_coach:            allEnabled.includes('feature_move_coach'),
    feature_advance:               allEnabled.includes('feature_advance'),
    feature_custom_conferences:    allEnabled.includes('feature_custom_conferences'),
    feature_auto_role:             allEnabled.includes('feature_auto_role'),
    feature_stream:                allEnabled.includes('feature_stream'),
    feature_promotion_relegation:   allEnabled.includes('feature_promotion_relegation'),
  };

  // ── Channel Setup ─────────────────────────────────────────────────────────
  const channelConfig = {
    channel_news_feed:       'news-feed',
    channel_signed_coaches:  'signed-coaches',
    channel_team_lists:      'team-lists',
    channel_advance_tracker: 'advance-tracker',
  };

  const needsSigned    = features.feature_job_offers || features.feature_assign_team;
  const needsTeamList  = features.feature_list_teams;
  const needsAdvance   = features.feature_advance;

  if (needsSigned || needsTeamList || needsAdvance || features.feature_stream) {
    await dm.send('**— Channel Setup —**\nSelect the channel for each feature group.');
    const channelList = textChannels;

    if (features.feature_stream) {
      const ch = await pickChannel('📺 **Streaming** — Which channel should live stream posts appear in?', channelList);
      if (!ch) return;
      channelConfig.channel_streaming = ch.name;
    }

    if (needsSigned) {
      const ch = await pickChannel('✍️ **Signed Coaches** — Where should coach signing announcements post?', channelList);
      if (!ch) return;
      channelConfig.channel_signed_coaches = ch.name;
    }
    if (needsTeamList) {
      const ch = await pickChannel('📋 **Team Lists** — Where should the available teams list post?', channelList);
      if (!ch) return;
      channelConfig.channel_team_lists = ch.name;
    }
    if (needsAdvance) {
      const ch = await pickChannel('⏱️ **Advance Tracker** — Where should advance deadline notices post?', channelList);
      if (!ch) return;
      channelConfig.channel_advance_tracker = ch.name;
    }

  }

  // ── Role Setup ────────────────────────────────────────────────────────────
  let headCoachRoleName = 'head coach';
  let headCoachRoleId   = null;

  if (roles.length > 0) {
    const skipRoleChoice = await askButtons(
      '**— Role Setup —**\nShould the bot assign a role to head coaches when they are signed?\n\n💡 **Tip:** If your league uses `@everyone` as the coach role, choose **Skip** — the bot won\'t assign a role but will still track team assignments.\n\n' +
      'Choose **Pick a Role** to assign an existing role, or **Skip** if your server uses @everyone.',
      [
        { id: 'pick', label: '🎭 Pick a Role', style: ButtonStyle.Primary },
        { id: 'skip', label: '⏭️ Skip (@everyone)', style: ButtonStyle.Secondary },
      ]
    );
    if (!skipRoleChoice) return;

    if (skipRoleChoice === 'pick') {
      const role = await pickRole('Which role should be assigned to head coaches?', roles);
      if (!role) return;
      headCoachRoleName = role.name;
      headCoachRoleId   = role.id;
    }
    // skip → leave defaults ('head coach', null) — bot won't assign a role
  } else {
    await dm.send('⚠️ No roles found. The bot will skip role assignment — coaches will use @everyone.');
  }

  // ── Job Offers Config ─────────────────────────────────────────────────────
  let jobOffersConfig = { star_rating_for_offers: 2.5, star_rating_max_for_offers: null, job_offers_count: 3, job_offers_expiry_hours: 24 };

  if (features.feature_job_offers) {
    await dm.send('**— Job Offers Setup —**\nAnswer the next 4 questions to configure job offers.');

    let starMin;
    while (!starMin) {
      const input = await askWithDefault('**[Job Offers 1/4]** Minimum star rating for job offers? (1.0 – 5.0)\nDefault: 2.5', '2.5');
      if (!input) return;
      const val = parseFloat(input);
      if (!isNaN(val) && val >= 1.0 && val <= 5.0) {
        starMin = input;
      } else {
        await dm.send('❌ Please enter a number between 1.0 and 5.0 (e.g. `2.5`).');
      }
    }

    let starMax;
    while (!starMax) {
      const input = await askWithDefault('**[Job Offers 2/4]** Maximum star rating? Type `none` for no cap.\nDefault: none', 'none');
      if (!input) return;
      if (input.toLowerCase() === 'none') {
        starMax = 'none';
      } else {
        const val = parseFloat(input);
        const minVal = parseFloat(starMin);
        if (!isNaN(val) && val >= minVal && val <= 5.0) {
          starMax = input;
        } else {
          await dm.send(`❌ Please enter a number between ${starMin} and 5.0, or type \`none\` for no cap.`);
        }
      }
    }
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

  // ── Game Results Reminder Config ──────────────────────────────────────────


  // ── Advance Management Config ─────────────────────────────────────────────
  let advanceConfig = { advance_intervals: '[24, 48]' };

  if (features.feature_advance) {
    const intervalChoices = await askMultiButtons(
      '**— Advance Management Setup —**\nWhich advance intervals (hours) should be available? Select all that apply.',
      [
        { id: '12', label: '12 hours' },
        { id: '24', label: '24 hours' },
        { id: '48', label: '48 hours' },
        { id: '72', label: '72 hours' },
      ]
    );
    if (!intervalChoices) return;
    const selectedIntervals = intervalChoices.length > 0 ? intervalChoices : ['24', '48'];
    advanceConfig = { advance_intervals: JSON.stringify(selectedIntervals.map(Number)) };

  }

  // ── Save Config ───────────────────────────────────────────────────────────
  try {
    await createDefaultConfig(guildId, leagueName);
    await setMeta(guildId, initialMeta);
    await saveConfig(guildId, {
      league_name:         leagueName,
      ...channelConfig,
      role_head_coach:     headCoachRoleName,
      role_head_coach_id:  headCoachRoleId,
      ...features,
      ...jobOffersConfig,
      ...advanceConfig,
      setup_complete:      true,
      league_type:         leagueType,
      multi_league:        isMultiLeague,
    });

    // ── Save default league row (synced by setMeta above) ─────────────────
    await upsertLeague(guildId, 'default', {
      league_name:             leagueName,
      ...initialMeta,
      advance_intervals:       advanceConfig.advance_intervals || '[24, 48]',
      channel_advance_tracker: channelConfig.channel_advance_tracker,
      channel_signed_coaches:  channelConfig.channel_signed_coaches,
      channel_streaming:       channelConfig.channel_streaming || 'streaming',
      channel_team_lists:      channelConfig.channel_team_lists,
    });

    // ── Save additional leagues for multi-league servers ──────────────────
    for (const al of additionalLeagues) {
      await upsertLeague(guildId, al.categoryId, {
        league_name:             al.leagueName,
        season:                  1,
        week:                    1,
        current_phase:           'preseason',
        current_sub_phase:       0,
        advance_hours:           24,
        advance_intervals:       advanceConfig.advance_intervals || '[24, 48]',
            channel_advance_tracker: channelConfig.channel_advance_tracker,
        channel_signed_coaches:  channelConfig.channel_signed_coaches,
          channel_team_lists:      channelConfig.channel_team_lists,
      });
    }

    // ── Summary Embed — group-based display ───────────────────────────────
    const fv = (flag) => features[flag] ? '✅' : '❌';
    const summaryFields = [
      { name: 'League Name',  value: leagueName,                                          inline: true },
      { name: 'League Type',  value: leagueType === 'new' ? '🆕 New League' : '🏛️ Established League', inline: true },

      {
        name: '👥 Team Selection',
        value:
          `${fv('feature_job_offers')} Job Offers  ${fv('feature_assign_team')} Assign Team\n` +
          `${fv('feature_reset_team')} Reset Team  ${fv('feature_list_teams')} List Teams\n` +
          `${fv('feature_move_coach')} Move Coach`,
        inline: false,
      },
      {
        name: '📅 Advance Management',
        value: `${fv('feature_advance')} Advance`,
        inline: false,
      },
      { name: '\u200b', value: '\u200b', inline: false },
    ];

    if (needsSigned)    summaryFields.push({ name: 'Signed Coaches',  value: '#' + channelConfig.channel_signed_coaches,  inline: true });
    if (needsTeamList)  summaryFields.push({ name: 'Team Lists',      value: '#' + channelConfig.channel_team_lists,      inline: true });
    if (needsAdvance)   summaryFields.push({ name: 'Advance Tracker', value: '#' + channelConfig.channel_advance_tracker, inline: true });
    summaryFields.push({ name: 'Head Coach Role', value: headCoachRoleId ? `@${headCoachRoleName}` : '@everyone (no role assigned)', inline: true });
    summaryFields.push({ name: '\u200b', value: '\u200b', inline: true });

    if (features.feature_job_offers) {
      summaryFields.push(
        { name: 'Min Star Rating', value: jobOffersConfig.star_rating_for_offers + ' stars',                                                             inline: true },
        { name: 'Max Star Rating', value: jobOffersConfig.star_rating_max_for_offers ? jobOffersConfig.star_rating_max_for_offers + ' stars' : 'No cap', inline: true },
        { name: 'Offers Per User', value: String(jobOffersConfig.job_offers_count),                                                                      inline: true },
        { name: 'Offer Expiry',    value: jobOffersConfig.job_offers_expiry_hours + ' hrs',                                                              inline: true },
      );
    }
    if (features.feature_job_offers) {
      summaryFields.push({ name: '💡 Offers Config', value: 'Use `/offers-config` after setup to control conference balancing, weighting, and whitelists/blacklists.', inline: false });
    }
    if (features.feature_advance)               summaryFields.push({ name: 'Advance Intervals', value: advanceConfig.advance_intervals,               inline: true });

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
  } catch (err) {
    console.error('[setup] Unexpected error:', err);
    await dm.send(`❌ **Setup Failed — Unexpected Error**\n\`${err.message}\`\n\nPlease try running \`/setup\` again.`).catch(() => {});
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
      { name: '🆔 Guild ID',     value: config.guild_id,                         inline: true },
      { name: '\u200b',          value: '\u200b',                                 inline: true },
      { name: '🔧 Features', value:
        `👥 ${config.feature_job_offers ? '✅' : '❌'} Job Offers  ${config.feature_assign_team ? '✅' : '❌'} Assign  ${config.feature_reset_team ? '✅' : '❌'} Reset  ${config.feature_list_teams ? '✅' : '❌'} List  ${config.feature_move_coach ? '✅' : '❌'} Move\n` +
        `📅 ${config.feature_advance ? '✅' : '❌'} Advance`,
        inline: false },
      { name: '📺 Channels', value:
        `News Feed: \`${config.channel_news_feed}\`\n` +
        `Advance Tracker: \`${config.channel_advance_tracker}\`\n` +
        `Team Lists: \`${config.channel_team_lists}\`\n` +
        `Signed Coaches: \`${config.channel_signed_coaches}\``,
        inline: true },
      { name: '🎮 Settings', value:
        `Min Star Rating: \`${config.star_rating_for_offers}\`\n` +
        `Max Star Rating: \`${config.star_rating_max_for_offers || 'No cap'}\`\n` +
        `Job Offers Count: \`${config.job_offers_count}\`\n` +
        `Offers Expire: \`${config.job_offers_expiry_hours}hrs\`\n` +
        `Advance Intervals: \`${config.advance_intervals}\`\n` +
        `Timezones: \`${(config.advance_timezones_parsed || ['ET','CT','MT','PT']).join(', ')}\` — change with \`/config timezones\``,
        inline: true },
    );
  await interaction.editReply({ embeds: [embed] });
}

// /config features ────────────────────────────────────
// Feature groups definition (shared by /config features handler + select menu handler)
const FEATURE_GROUPS = [

  {
    key:   'team_selection',
    label: '👥 Team Selection',
    commands: [
      { id: 'feature_job_offers',   label: 'Job Offers',  desc: 'Coaches request job offers via DM' },
      { id: 'feature_assign_team',  label: 'Assign Team', desc: 'Admin manually assigns a team' },
      { id: 'feature_reset_team',   label: 'Reset Team',  desc: 'Admin removes a coach from their team' },
      { id: 'feature_list_teams',   label: 'List Teams',  desc: 'Post team availability list' },
      { id: 'feature_move_coach',   label: 'Move Coach',  desc: 'Admin moves a coach to a different team' },
    ],
  },
  {
    key:   'advance',
    label: '📅 Advance Management',
    commands: [
      { id: 'feature_advance', label: 'Advance', desc: 'Advance to next week/phase — season rolls over automatically' },
    ],
  },
  {
    key:   'extra',
    label: '⚙️ Extra Features',
    commands: [
      { id: 'feature_stream',               label: 'Streaming',               desc: 'Coaches register Twitch/YouTube and post when live' },
      { id: 'feature_custom_conferences',   label: 'Custom Conferences',      desc: 'Custom tier/division structure for team list' },
      { id: 'feature_promotion_relegation', label: '↳ Promotion/Relegation', desc: 'Move teams between tiers each season (requires Custom Conferences)' },
      { id: 'feature_auto_role',            label: 'Auto Role',               desc: 'Assign head coach role to everyone who joins the server' },
    ],
  },
];

async function handleConfigFeatures(interaction) {
  await interaction.deferReply({ flags: 64 });
  const config  = await getConfig(interaction.guildId);
  const guildId = interaction.guildId;

  // Build one row of buttons per group showing current on/off state
  const buildGroupRows = (currentConfig) => {
    const rows = [];
    for (const group of FEATURE_GROUPS) {
      const allOn  = group.commands.every(c => !!currentConfig[c.id]);
      const allOff = group.commands.every(c => !currentConfig[c.id]);
      const status = allOn ? '✅' : allOff ? '❌' : '🔧';
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`cfg_grp_${guildId}_${group.key}`)
          .setLabel(`${status} ${group.label}`)
          .setStyle(allOn ? ButtonStyle.Success : allOff ? ButtonStyle.Danger : ButtonStyle.Secondary),
      ));
    }
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`cfg_grp_${guildId}_done`)
        .setLabel('✔ Done')
        .setStyle(ButtonStyle.Primary),
    ));
    return rows;
  };

  const msg = await interaction.editReply({
    content: '**⚙️ Feature Groups**\nClick a group to toggle all commands in it, or customize individual commands.\n✅ = all on · ❌ = all off · 🔧 = mixed',
    components: buildGroupRows(config),
  });

  // Collector listens for group button clicks
  const collector = msg.createMessageComponentCollector({
    filter: i => i.user.id === interaction.user.id,
    time:   120000,
  });

  let currentConfig = { ...config };

  collector.on('collect', async (btnInt) => {
    const id = btnInt.customId.replace(`cfg_grp_${guildId}_`, '');

    if (id === 'done') {
      collector.stop('done');
      await btnInt.update({ content: '✅ **Features saved!**', components: [] });
      return;
    }

    const group = FEATURE_GROUPS.find(g => g.key === id);
    if (!group) return;

    // Show customize UI for this group
    const allOn = group.commands.every(c => !!currentConfig[c.id]);

    const buildCmdRows = () => {
      const rows = [];
      for (let i = 0; i < group.commands.length; i += 4) {
        rows.push(new ActionRowBuilder().addComponents(
          group.commands.slice(i, i + 4).map(cmd =>
            new ButtonBuilder()
              .setCustomId(`cfg_cmd_${guildId}_${cmd.id}`)
              .setLabel((currentConfig[cmd.id] ? '✅ ' : '❌ ') + cmd.label)
              .setStyle(currentConfig[cmd.id] ? ButtonStyle.Success : ButtonStyle.Secondary)
          )
        ));
      }
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`cfg_cmd_${guildId}_ALL_ON`)
          .setLabel('Enable All')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`cfg_cmd_${guildId}_ALL_OFF`)
          .setLabel('Disable All')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`cfg_cmd_${guildId}_BACK`)
          .setLabel('← Back')
          .setStyle(ButtonStyle.Primary),
      ));
      return rows;
    };

    const cmdLines = group.commands.map(c => `${currentConfig[c.id] ? '✅' : '❌'} **${c.label}** — ${c.desc}`).join('\n');
    await btnInt.update({
      content: `**${group.label}**\n${cmdLines}`,
      components: buildCmdRows(),
    });

    // Inner collector for this group's command toggles
    const innerCollector = msg.createMessageComponentCollector({
      filter: i => i.user.id === interaction.user.id,
      time:   120000,
    });

    innerCollector.on('collect', async (inner) => {
      const innerId = inner.customId.replace(`cfg_cmd_${guildId}_`, '');

      if (innerId === 'BACK') {
        innerCollector.stop('back');
        // Save changes then return to group view
        const updates = Object.fromEntries(group.commands.map(c => [c.id, !!currentConfig[c.id]]));
        await saveConfig(guildId, updates);
        await inner.update({
          content: '**⚙️ Feature Groups**\nClick a group to toggle all commands in it, or customize individual commands.\n✅ = all on · ❌ = all off · 🔧 = mixed',
          components: buildGroupRows(currentConfig),
        });
        return;
      }

      if (innerId === 'ALL_ON') {
        group.commands.forEach(c => { currentConfig[c.id] = true; });
      } else if (innerId === 'ALL_OFF') {
        group.commands.forEach(c => { currentConfig[c.id] = false; });
      } else {
        // Toggle individual command
        const cmd = group.commands.find(c => c.id === innerId);
        if (cmd) currentConfig[cmd.id] = !currentConfig[cmd.id];
      }

      const updatedLines = group.commands.map(c => `${currentConfig[c.id] ? '✅' : '❌'} **${c.label}** — ${c.desc}`).join('\n');
      await inner.update({
        content: `**${group.label}**\n${updatedLines}`,
        components: buildCmdRows(),
      });
    });

    innerCollector.on('end', (_, reason) => {
      if (reason !== 'back') {
        // Save on timeout too
        const updates = Object.fromEntries(group.commands.map(c => [c.id, !!currentConfig[c.id]]));
        saveConfig(guildId, updates).catch(console.error);
      }
    });
  });

  collector.on('end', async (_, reason) => {
    if (reason !== 'done') {
      // Save everything on timeout and clean up buttons
      const allFlags = FEATURE_GROUPS.flatMap(g => g.commands.map(c => c.id));
      const updates  = Object.fromEntries(allFlags.map(f => [f, !!currentConfig[f]]));
      await saveConfig(guildId, updates).catch(console.error);
      await interaction.editReply({ components: [] }).catch(() => {});
    }
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
    'job_offers_expiry_hours', 'advance_intervals', 'team_list_filter',
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

// /config timezones ─────────────────────────────────────
async function handleConfigTimezones(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guildId = interaction.guildId;
  const config  = await getConfig(guildId);

  const TZ_OPTIONS = [
    { id: 'ET',   label: '🌴 ET  (New York)'    },
    { id: 'CT',   label: '🐄 CT  (Chicago)'     },
    { id: 'MT',   label: '🏔️ MT  (Denver)'      },
    { id: 'PT',   label: '🌊 PT  (Los Angeles)' },
    { id: 'GMT',  label: '🌐 GMT (London)'      },
    { id: 'AEST', label: '🦘 AEST (Sydney)'     },
    { id: 'NZST', label: '🥝 NZST (Auckland)'  },
  ];

  const current = config.advance_timezones_parsed || ['ET','CT','MT','PT'];
  const selected = new Set(current);

  const buildRows = () => {
    const rows = [];
    for (let i = 0; i < TZ_OPTIONS.length; i += 4) {
      rows.push(new ActionRowBuilder().addComponents(
        TZ_OPTIONS.slice(i, i + 4).map(tz =>
          new ButtonBuilder()
            .setCustomId(`tz_${tz.id}`)
            .setLabel((selected.has(tz.id) ? '✅ ' : '') + tz.label)
            .setStyle(selected.has(tz.id) ? ButtonStyle.Success : ButtonStyle.Secondary)
        )
      ));
    }
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tz_DONE').setLabel('✔ Save').setStyle(ButtonStyle.Primary),
    ));
    return rows;
  };

  const msg = await interaction.editReply({
    content: '📡 **Advance Timezones**\nToggle which timezones appear on advance deadline posts, then click **Save**.',
    components: buildRows(),
  });

  const collector = msg.createMessageComponentCollector({
    filter: i => i.user.id === interaction.user.id,
    time: 120000,
  });

  collector.on('collect', async btn => {
    const id = btn.customId.replace('tz_', '');
    if (id === 'DONE') {
      collector.stop('done');
      const finalTZs = [...selected];
      if (finalTZs.length === 0) {
        await btn.update({ content: '❌ You must select at least one timezone.', components: buildRows() });
        return;
      }
      await saveConfig(guildId, { advance_timezones: JSON.stringify(finalTZs) });
      guildConfigs.delete(guildId);
      const labels = finalTZs.map(k => TZ_OPTIONS.find(t => t.id === k)?.label || k).join(', ');
      await btn.update({ content: `✅ **Timezones saved:** ${labels}`, components: [] });
    } else {
      selected.has(id) ? selected.delete(id) : selected.add(id);
      await btn.update({ components: buildRows() });
    }
  });

  collector.on('end', async (_, reason) => {
    if (reason !== 'done') {
      await interaction.editReply({ content: '⏰ Timed out — timezones not saved.', components: [] }).catch(() => {});
    }
  });
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

  if (!config.setup_complete) return replySetupRequired(interaction);
  if (!config.feature_job_offers || !config.feature_assign_team) {
    return interaction.editReply({ content: '❌ **Job Offers Disabled**\nThis feature is turned off. An admin can enable it with `/config features`.' });
  }

  const league      = await getLeagueFromInteraction(interaction);
  if (!league) return replyNoLeague(interaction);
  const leagueId    = league.league_id;

  const currentTeam = await getTeamByUser(userId, guildId, leagueId);
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
    .neq('conference', 'FCS')
    .limit(200);

  if (config.star_rating_max_for_offers) {
    query = query.lte('star_rating', config.star_rating_max_for_offers);
  }

  const { data: availableJobs } = await query;
  let pool = (availableJobs || []).filter(t => !assigned.includes(t.id) && !locked.includes(t.id));

  // ── Apply conference whitelist / blacklist ────────────────────────────────
  const offerCfg    = await getJobOfferConfig(guildId);
  const whitelist   = await getJobOfferConferences(guildId, 'whitelist');
  const blacklist   = await getJobOfferConferences(guildId, 'blacklist');

  if (whitelist.length > 0) pool = pool.filter(t => whitelist.includes(t.conference));
  if (blacklist.length > 0) pool = pool.filter(t => !blacklist.includes(t.conference));

  if (pool.length === 0) {
    return interaction.editReply({
      content: `❌ **No Available Teams**\nThere are no unassigned teams matching the current offer settings.\n\nPossible reasons:\n• All eligible teams are taken or locked\n• Conference whitelist/blacklist is too restrictive\n• Star rating range is too narrow\n\nAn admin can adjust settings with \`/config edit\` or \`/offers-config\`.`,
    });
  }

  // ── Weighted ratings ──────────────────────────────────────────────────────
  let weightedPool;
  if (offerCfg.weighted_ratings === 'highest') {
    // Weight by star rating — higher rated = more likely
    weightedPool = pool.flatMap(t => Array(Math.round((t.star_rating || 1) * 2)).fill(t));
  } else if (offerCfg.weighted_ratings === 'lowest') {
    // Inverse weight — lower rated = more likely
    const max = Math.max(...pool.map(t => t.star_rating || 1));
    weightedPool = pool.flatMap(t => Array(Math.round((max - (t.star_rating || 1) + 1) * 2)).fill(t));
  } else {
    weightedPool = pool;
  }

  // ── Pick with optional conference rules ───────────────────────────────────
  const count    = config.job_offers_count || 3;
  const shuffled = weightedPool.sort(() => Math.random() - 0.5);
  let picks      = [];
  const usedConfs = new Set();

  for (const t of shuffled) {
    if (picks.find(p => p.id === t.id)) continue; // dedupe from weighting

    if (offerCfg.one_per_conference && usedConfs.has(t.conference)) continue;

    if (offerCfg.conf_balance && usedConfs.has(t.conference) && picks.length < count) {
      // Try to keep going for a different conference
      const remaining = shuffled.filter(s =>
        !picks.find(p => p.id === s.id) && !usedConfs.has(s.conference)
      );
      if (remaining.length > 0) continue;
      // No more unique conferences available — allow duplicate
    }

    picks.push(t);
    usedConfs.add(t.conference);
    if (picks.length >= count) break;
  }

  // Fallback: if strict rules left us short, fill remainder ignoring conf rules
  if (picks.length < count) {
    const remaining = pool.filter(t => !picks.find(p => p.id === t.id))
                          .sort(() => Math.random() - 0.5);
    for (const t of remaining) {
      picks.push(t);
      if (picks.length >= count) break;
    }
  }
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

  const offerConfig = await getConfig(guildId).catch(() => null);
  if (!offerConfig?.setup_complete) {
    return interaction.followUp({ content: '⚙️ **Setup Required**\nThis server has not been configured yet. Ask an admin to run `/setup`.', flags: 64 });
  }

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

  // ── Prompt for stream handle if feature is enabled ───────────────────────

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

    // Auto-update team list
    await postTeamList(guild, guildId, config).catch(console.error);
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
      if (!config?.setup_complete) continue; // skip guilds that haven't completed setup
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
      // Log per-user errors but always continue — delete still runs below
      console.error(`[expireJobOffers] Error notifying ${user_id}:`, err.message);
    }
  }

  // Always delete expired rows regardless of notification errors above
  try {
    const { error } = await supabase.from('job_offers').delete().lt('expires_at', now);
    if (error) console.error('[expireJobOffers] Delete error:', error.message);
    else console.log(`[expireJobOffers] Removed ${expired.length} expired offer(s).`);
  } catch (err) {
    console.error('[expireJobOffers] Failed to delete expired offers:', err.message);
  }
}

// /any-game-result ────────────────────────────────────
// /ranking ────────────────────────────────────────────
// /assign-team ────────────────────────────────────────
async function handleAssignTeam(interaction) {
  const guildId  = interaction.guildId;
  await interaction.deferReply({ flags: 64 });
  const config   = await getConfig(guildId);
  if (!config.setup_complete) return interaction.editReply({ content: '⚙️ **Setup Required**\nRun `/setup` to configure the bot before using this command.' });
  if (!config.feature_assign_team) return interaction.editReply({ content: '❌ Team assignment is disabled on this server.' });
  const league   = await getLeagueFromInteraction(interaction);
  if (!league) return replyNoLeague(interaction);
  const leagueId = league.league_id;
  const guild    = interaction.guild;
  const user     = interaction.options.getUser('user');
  const teamName = interaction.options.getString('team');
  const skipAnn  = interaction.options.getBoolean('skip-announcement') || false;

  let team;
  try { team = await getTeamByName(teamName, guildId, leagueId); }
  catch (err) { return interaction.editReply(`❌ **Database Error**\nCouldn't look up team "${teamName}": ${err.message}`); }
  if (!team) return interaction.editReply(`❌ **Team Not Found: \`${teamName}\`**\nThis team doesn't exist in the global teams database. Make sure you selected from the autocomplete dropdown.\n\nIf the team is missing entirely, it may need to be added to the Supabase \`teams\` table.`);

  if (team.user_id && team.user_id !== user.id) {
    const currentCoach = await guild.members.fetch(team.user_id).catch(() => null);
    return interaction.editReply(`❌ **Team Already Assigned**\n**${team.team_name}** is currently coached by **${currentCoach ? currentCoach.displayName : 'another coach'}** in this league.\n\nTo reassign this team, first run \`/resetteam\` on the current coach, then try \`/assign-team\` again.`);
  }

  const oldTeam = await getTeamByUser(user.id, guildId, leagueId);
  if (oldTeam) await unassignTeam(oldTeam.id, guildId, leagueId);

  await assignTeam(team.id, user.id, guildId, leagueId);

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

  // Auto-update team list
  await postTeamList(guild, guildId, config).catch(console.error);
}

// /resetteam ──────────────────────────────────────────
async function handleResetTeam(interaction) {
  await interaction.deferReply();
  const guildId = interaction.guildId;
  const config  = await getConfig(guildId);
  if (!config.setup_complete) return interaction.editReply({ content: '⚙️ **Setup Required**\nRun `/setup` to configure the bot before using this command.' });
  if (!config.feature_reset_team) return interaction.editReply({ content: '❌ Team reset is disabled on this server.' });
  const league    = await getLeagueFromInteraction(interaction);
  if (!league) return replyNoLeague(interaction);
  const leagueId  = league.league_id;
  const user      = interaction.options.getUser('user');
  const teamInput = interaction.options.getString('team');

  if (!user && !teamInput) {
    return interaction.editReply({ content: '❌ Please provide either a **user** or a **team name**.' });
  }

  let team, targetId;

  if (user) {
    // Normal flow — look up by user
    targetId = user.id;
    team = await getTeamByUser(targetId, guildId, leagueId);
    if (!team) return interaction.editReply({ content: `❌ **No Team Found**\n<@${targetId}> doesn't have a team assigned in this league.` });
  } else {
    // Team name flow — find the assignment directly
    team = await getTeamByName(teamInput, guildId, leagueId);
    if (!team) return interaction.editReply({ content: `❌ **Team Not Found: \`${teamInput}\`**\nNo team with that name exists. Use the autocomplete dropdown.` });
    if (!team.user_id) return interaction.editReply({ content: `❌ **No Coach Assigned**\n**${team.team_name}** doesn't have a coach assigned. Nothing to reset.` });
    targetId = team.user_id;
  }

  await unassignTeam(team.id, guildId, leagueId);

  // Try to remove role if member is still in server
  const member = await interaction.guild.members.fetch(targetId).catch(() => null);
  let roleWarning = '';
  if (member && config.role_head_coach_id) {
    try {
      await member.roles.remove(config.role_head_coach_id);
    } catch (roleErr) {
      console.error('[roles] Failed to remove head coach role on resetteam:', roleErr.message);
      roleWarning = `\n⚠️ Couldn't remove the **${config.role_head_coach}** role — check bot role hierarchy.`;
    }
  }

  const signedChannel  = findTextChannel(interaction.guild, config.channel_signed_coaches);
  const newsChannel    = findTextChannel(interaction.guild, config.channel_news_feed);
  const announceTarget = signedChannel || newsChannel;

  const releaseEmbed = new EmbedBuilder()
    .setTitle(`🚪 Coach Released — ${team.team_name}`)
    .setColor(0xff4444)
    .setDescription(member
      ? `<@${targetId}> has been released from **${team.team_name}**.`
      : `A coach who left the server has been removed from **${team.team_name}**.`)
    .addFields(
      { name: 'Team',   value: team.team_name,                               inline: true },
      { name: 'Status', value: '🟢 Now Available',                           inline: true },
    )
    .setTimestamp();

  if (announceTarget) await announceTarget.send({ embeds: [releaseEmbed] }).catch(() => {});
  await postTeamList(interaction.guild, guildId, config, filterOverride).catch(() => {});

  await interaction.editReply({ content: `✅ **${team.team_name}** has been reset and is now available.${roleWarning}` });
}

// /listteams ──────────────────────────────────────────
async function handleListTeams(interaction) {
  const guildId = interaction.guildId;
  await interaction.deferReply({ flags: 64 });
  const config  = await getConfig(guildId);
  if (!config.setup_complete) return interaction.editReply({ content: '⚙️ **Setup Required**\nRun `/setup` to configure the bot before using this command.' });
  if (!config.feature_list_teams) return interaction.editReply({ content: '❌ Team listing is disabled on this server.' });
  const league        = await getLeagueFromInteraction(interaction);
  if (!league) return replyNoLeague(interaction);
  const filterOverride = interaction.options.getString('filter') || null;

  await postTeamList(interaction.guild, guildId, config, filterOverride);

  const listsChannel = findTextChannel(interaction.guild, config.channel_team_lists);
  await interaction.editReply(
    listsChannel && listsChannel.id !== interaction.channelId
      ? `✅ Team list posted in ${listsChannel}!`
      : '✅ Team list posted!'
  );
}

// postTeamList — internal helper, no interaction object needed
// =====================================================
// CUSTOM CONFERENCE HELPERS
// =====================================================

async function getCustomConferences(guildId, leagueId = null) {
  let q = supabase.from('custom_conferences').select('*').eq('guild_id', guildId);
  if (leagueId) q = q.eq('league_id', leagueId);
  const { data } = await q.order('position').order('division_name');
  return data || [];
}

async function upsertCustomConference(guildId, leagueId, tierName, divisionName, position) {
  // Delete existing entry first to avoid NULL conflict key issues (NULL != NULL in Postgres)
  let delQ = supabase.from('custom_conferences')
    .delete()
    .eq('guild_id', guildId)
    .eq('tier_name', tierName)
    .eq('division_name', divisionName);
  if (leagueId) delQ = delQ.eq('league_id', leagueId);
  else delQ = delQ.is('league_id', null);
  await delQ;

  // Insert fresh
  const { data, error } = await supabase.from('custom_conferences')
    .insert({ guild_id: guildId, league_id: leagueId || null, tier_name: tierName, division_name: divisionName, position })
    .select().single();
  if (error) throw error;
  return data;
}

async function setTeamCustomConference(teamId, guildId, customConferenceId) {
  await supabase.from('team_assignments')
    .update({ custom_conference_id: customConferenceId })
    .eq('team_id', teamId).eq('guild_id', guildId);
}

async function postTeamList(guild, guildId, config, filterOverride = null) {
  if (!config.feature_list_teams) return;
  const listsChannel = findTextChannel(guild, config.channel_team_lists);
  if (!listsChannel) return;

  let allTeams;
  try { allTeams = await getAllTeams(guildId); } catch { return; }

  const minRating = config.star_rating_for_offers     || 0;
  const maxRating = config.star_rating_max_for_offers || 999;
  const filter    = filterOverride || config.team_list_filter || 'all';

  // Apply filter
  let teams = allTeams.filter(t => t.user_id || (t.star_rating != null && parseFloat(t.star_rating) >= minRating && parseFloat(t.star_rating) <= maxRating));
  if (filter === 'assigned')  teams = teams.filter(t => t.user_id);
  if (filter === 'available') teams = teams.filter(t => !t.user_id);
  // conference_view shows all teams within their tier structure — handled in display block below

  const fields = [];

  if (config.feature_custom_conferences) {
    // ── Custom tier/division display ────────────────────────────────────────
    const customConfs = await getCustomConferences(guildId);

    // For conference_view: use all teams regardless of filter so every slot shows
    const displayTeams = filter === 'conference_view' ? allTeams.filter(t =>
      t.user_id || (t.star_rating != null && parseFloat(t.star_rating) >= minRating && parseFloat(t.star_rating) <= maxRating)
    ) : teams;

    // Build a map of custom_conference_id -> teams
    const confTeamMap = {};
    for (const cc of customConfs) confTeamMap[cc.id] = [];

    // Unassigned to any custom conference
    const unassigned = [];

    for (const t of displayTeams) {
      if (t.custom_conference_id && confTeamMap[t.custom_conference_id] !== undefined) {
        confTeamMap[t.custom_conference_id].push(t);
      } else {
        unassigned.push(t);
      }
    }

    // Group by tier position, then list each division
    const tierPositions = [...new Set(customConfs.map(cc => cc.position))].sort((a, b) => a - b);
    const maxPos = tierPositions.length > 0 ? tierPositions[tierPositions.length - 1] : null;

    for (const pos of tierPositions) {
      const divisionsAtTier = customConfs.filter(cc => cc.position === pos);
      const isBottomTier = pos === maxPos;

      for (const cc of divisionsAtTier) {
        // Use each conference's own tier_name — East and West can have different names
        const label = `__${cc.tier_name} — ${cc.division_name}__`;

        // For assigned filter: bottom tier also shows available teams so openings are visible
        let confTeams;
        if (filter === 'assigned' && isBottomTier) {
          // Show all teams in bottom tier (assigned + available)
          confTeams = (displayTeams.filter(t => t.custom_conference_id === cc.id))
            .sort((a, b) => (a.team_name || '').localeCompare(b.team_name || ''));
        } else {
          confTeams = (confTeamMap[cc.id] || [])
            .sort((a, b) => (a.team_name || '').localeCompare(b.team_name || ''));
        }
        if (confTeams.length === 0) {
          // Hide empty conferences when filter is assigned-only or conference_view with no assigned teams
          if (filter === 'assigned') continue;
          fields.push({ name: label, value: '*No teams assigned*', inline: false });
          continue;
        }
        const lines = confTeams.map(t => t.user_id
          ? `🏈 **${t.team_name}** — <@${t.user_id}> (${t.star_rating || '?'}⭐)`
          : `🟢 **${t.team_name}** — Available (${t.star_rating || '?'}⭐)`
        );
        for (let i = 0; i < lines.length; i += 15) {
          fields.push({ name: i === 0 ? label : `__${cc.tier_name} — ${cc.division_name} (cont.)__`, value: lines.slice(i, i + 15).join('\n'), inline: false });
        }
      }
    }

    // Show unassigned teams at the bottom
    if (unassigned.length > 0) {
      const lines = unassigned
        .sort((a, b) => (a.team_name || '').localeCompare(b.team_name || ''))
        .map(t => t.user_id
          ? `🏈 **${t.team_name}** — <@${t.user_id}> (${t.star_rating || '?'}⭐)`
          : `🟢 **${t.team_name}** — Available (${t.star_rating || '?'}⭐)`
        );
      for (let i = 0; i < lines.length; i += 15) {
        fields.push({ name: i === 0 ? '__Unassigned__' : '__Unassigned (cont.)__', value: lines.slice(i, i + 15).join('\n'), inline: false });
      }
    }

  } else {
    // ── Standard conference display ─────────────────────────────────────────
    const confMap = {};
    for (const t of teams) {
      const conf = t.conference || 'Independent';
      if (!confMap[conf]) confMap[conf] = [];
      confMap[conf].push(t);
    }
    for (const [conf, confTeams] of Object.entries(confMap).sort()) {
      const lines = confTeams
        .sort((a, b) => (a.team_name || '').localeCompare(b.team_name || ''))
        .map(t => t.user_id
          ? `🏈 **${t.team_name}** — <@${t.user_id}> (${t.star_rating || '?'}⭐)`
          : `🟢 **${t.team_name}** — Available (${t.star_rating || '?'}⭐)`
        );
      for (let i = 0; i < lines.length; i += 15) {
        fields.push({ name: i === 0 ? `__${conf}__` : `__${conf} (cont.)__`, value: lines.slice(i, i + 15).join('\n'), inline: false });
      }
    }
  }
  if (fields.length === 0) return;

  // Delete old bot messages in channel, post fresh
  const PAGE = 25;
  const embeds = [];
  for (let i = 0; i < fields.length; i += PAGE) {
    embeds.push(new EmbedBuilder()
      .setTitle(i === 0
          ? `📋 Team Availability — ${config.league_name}${
              filter === 'assigned'        ? ' (Assigned)'        :
              filter === 'available'       ? ' (Available)'       :
              filter === 'conference_view' ? ' (Conference View)' : ''
            }`
          : `📋 Team Availability (cont.)`)
      .setColor(config.embed_color_primary_int || 0x1e90ff)
      .setDescription(i === 0 ? `**${config.league_name}** · Updated <t:${Math.floor(Date.now()/1000)}:R>` : null)
      .addFields(fields.slice(i, i + PAGE))
      .setTimestamp()
    );
  }

  try {
    const messages = await listsChannel.messages.fetch({ limit: 100 });
    for (const m of messages.filter(m => m.author.id === listsChannel.client.user.id).values()) {
      await m.delete().catch(() => {});
    }
  } catch { /* ignore */ }

  for (const embed of embeds) await listsChannel.send({ embeds: [embed] });
}

// /advance helpers ────────────────────────────────────
// /advance ────────────────────────────────────────────
async function handleAdvance(interaction) {
  try {
    await interaction.deferReply({ flags: 64 });
  } catch (err) {
    if (err.code === 10062) return; // Interaction token expired — silently drop
    console.error('[advance] deferReply failed:', err.message);
    return;
  }
  const guildId = interaction.guildId;
  guildConfigs.delete(guildId);
  const config = await loadGuildConfig(guildId);

  if (!config.setup_complete) return interaction.editReply({ content: '⚙️ **Setup Required**\nRun `/setup` to configure the bot before using this command.' });
  if (!config.feature_advance) {
    return interaction.editReply({ content: '❌ **Advance Disabled**\nThis feature is turned off. An admin can enable it with `/config features`.' });
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

  const rawLeague = await getLeagueFromInteraction(interaction);
  if (!rawLeague) return replyNoLeague(interaction);
  const league = parseLeague(rawLeague);
  const meta   = league; // league row mirrors meta structure

  // ── Advance phase/sub-phase ───────────────────────────────────────────
  const currentPhase = meta.current_phase     || 'preseason';
  const currentSub   = meta.current_sub_phase  || 0;
  const phaseDef     = getPhaseByKey(currentPhase);

  let newPhase  = currentPhase;
  let newSub    = currentSub + 1;
  let newSeason = meta.season || 1;

  if (newSub >= phaseDef.subWeeks) {
    const idx      = PHASE_CYCLE.findIndex(p => p.key === currentPhase);
    const nextIdx  = (idx + 1) % PHASE_CYCLE.length;
    const nextPhase = PHASE_CYCLE[nextIdx];
    newPhase       = nextPhase.key;
    newSub         = nextPhase.startSub ?? 0;
    if (newPhase === 'preseason') {
      newSeason = newSeason + 1;
      // Post season rollover announcement
      const seasonEmbed = new EmbedBuilder()
        .setTitle(`🏆 Season ${newSeason} Has Begun!`)
        .setColor(config.embed_color_primary_int)
        .setDescription(`Season **${meta.season}** is over! Welcome to **Season ${newSeason}**!\nWe are now in **Preseason**. Good luck!`)
        .setTimestamp();
      const advCh = findTextChannel(interaction.guild, config.channel_advance_tracker);
      const newsCh = findTextChannel(interaction.guild, config.channel_news_feed);
      const hcRoleName = (config.role_head_coach || 'head coach').trim();
      const hcRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === hcRoleName.toLowerCase());
      const seasonMention = hcRole ? `<@&${hcRole.id}> ` : '@everyone ';
      if (advCh) await advCh.send({ content: seasonMention, embeds: [seasonEmbed] });
      if (newsCh && newsCh.id !== advCh?.id) await newsCh.send({ embeds: [seasonEmbed] });
    }
  }

  // ── Training Results skip prompt ─────────────────────────────────────────
  // Fires when advancing from Position Changes to Training Results.
  // Some leagues skip Training Results and go straight to Encourage Transfers.
  if (currentPhase === 'position_changes') {
    const skipRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('advance_continue_training')
        .setLabel('▶️ Continue to Training Results')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('advance_skip_training')
        .setLabel('⏭️ Skip to Encourage Transfers')
        .setStyle(ButtonStyle.Primary),
    );
    const promptMsg = await interaction.editReply({
      content: '**Training Results Prompt**\nDoes your league use Training Results?',
      components: [skipRow],
    });
    try {
      const btn = await promptMsg.awaitMessageComponent({
        filter: i => i.user.id === interaction.user.id,
        time: 60000,
      });
      await btn.update({ components: [] });
      if (btn.customId === 'advance_skip_training') {
        const etIdx = PHASE_CYCLE.findIndex(p => p.key === 'encourage_transfers');
        newPhase = PHASE_CYCLE[etIdx].key;
        newSub   = 0;
      }
      // else continue to Training Results as normal
    } catch {
      await interaction.editReply({ content: '⏰ No response — advance cancelled. Run `/advance` again.', components: [] });
      return;
    }
  }

  // ── Week 14 / Week 15 skip prompts ──────────────────────────────────────
  // Fires independently at Week 14 and Week 15 — leagues may skip either or both
  // depending on their schedule. Each advance gets its own prompt.
  const skipWeekPrompts = [
    { triggerSub: 13, weekLabel: 'Week 14', continueId: 'advance_continue14', skipId: 'advance_skip14' },
    { triggerSub: 14, weekLabel: 'Week 15', continueId: 'advance_continue15', skipId: 'advance_skip15' },
  ];

  for (const { triggerSub, weekLabel, continueId, skipId } of skipWeekPrompts) {
    if (currentPhase === 'regular' && currentSub === triggerSub) {
      const skipRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(continueId)
          .setLabel(`▶️ Continue to ${weekLabel}`)
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(skipId)
          .setLabel('⏭️ Skip to Conference Championship')
          .setStyle(ButtonStyle.Primary),
      );
      const promptMsg = await interaction.editReply({
        content: `**${weekLabel} Prompt**\nDoes your league play ${weekLabel}?`,
        components: [skipRow],
      });
      try {
        const btn = await promptMsg.awaitMessageComponent({
          filter: i => i.user.id === interaction.user.id,
          time: 60000,
        });
        await btn.update({ components: [] });
        if (btn.customId === skipId) {
          const confIdx = PHASE_CYCLE.findIndex(p => p.key === 'conf_champ');
          newPhase = PHASE_CYCLE[confIdx].key;
          newSub   = 0;
        }
        // else continue to the week as normal
      } catch {
        await interaction.editReply({ content: '⏰ No response — advance cancelled. Run `/advance` again.', components: [] });
        return;
      }
      break; // Only one prompt per advance — next advance will trigger the next prompt if applicable
    }
  }

  const phaseLabel = formatPhase(newPhase, newSub);
  const deadline   = new Date(Date.now() + hours * 60 * 60 * 1000);

  // Discord dynamic timestamp — renders in each user's own local timezone automatically
  const unixTimestamp = Math.floor(deadline.getTime() / 1000);
  const deadlineLines = `<t:${unixTimestamp}:F> (<t:${unixTimestamp}:R>)`;

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
      value: deadlineLines || 'No timezones configured.',
      inline: false,
    })
    .setTimestamp();

  // Only post weekly game recap during regular season.
  // Skip if news-feed and advance-tracker are the same channel — would duplicate.
  if (currentPhase === 'regular') {
    const recapNewsChannel    = findTextChannel(interaction.guild, config.channel_news_feed);
    const recapAdvanceChannel = findTextChannel(interaction.guild, config.channel_advance_tracker);
    const sameChannel = recapNewsChannel && recapAdvanceChannel && recapNewsChannel.id === recapAdvanceChannel.id;
  }

  const metaUpdate = {
    season:                newSeason,
    week:                  newPhase === 'regular' ? newSub + 1 : (newPhase === 'preseason' ? 1 : meta.week),
    current_phase:         newPhase,
    current_sub_phase:     newSub,
    advance_hours:         hours,
    advance_deadline:      deadline.toISOString(),
    last_advance_at:       new Date().toISOString(),
    next_advance_deadline: deadline.toISOString(),
  };
  await setLeague(league.league_id, metaUpdate);
  if (!config.multi_league) await setMeta(guildId, metaUpdate);

  const advanceChannel = findTextChannel(interaction.guild, config.channel_advance_tracker);
  if (advanceChannel) {
    await advanceChannel.send({ content: mention, embeds: [embed] });
    await interaction.editReply({ content: `✅ Advance posted in ${advanceChannel}!` });
  } else {
    await interaction.editReply({ content: mention, embeds: [embed] });
  }
}
// /move-coach ─────────────────────────────────────────
async function handleMoveCoach(interaction) {
  const guildId     = interaction.guildId;
  await interaction.deferReply({ flags: 64 });
  const config      = await getConfig(guildId);
  if (!config.setup_complete) return interaction.editReply({ content: '⚙️ **Setup Required**\nRun `/setup` to configure the bot before using this command.' });
  if (!config.feature_move_coach) return interaction.editReply({ content: '❌ Move coach is disabled on this server.' });
  const league      = await getLeagueFromInteraction(interaction);
  if (!league) return replyNoLeague(interaction);
  const leagueId    = league.league_id;
  const coachId     = interaction.options.getString('coach');
  const newTeamName = interaction.options.getString('new-team');

  const user = await interaction.guild.members.fetch(coachId).then(m => m.user).catch(() => null);
  if (!user) return interaction.editReply('❌ **Coach Not Found**\nThis user couldn\'t be fetched from the server. They may have left.\n\nIf they\'re still in the server, try running `/move-coach` again and selecting from the autocomplete list.');

  let currentTeam, newTeam;
  try { currentTeam = await getTeamByUser(user.id, guildId, leagueId); }
  catch (err) { return interaction.editReply(`❌ **Database Error**\nCouldn't load current team for this coach: ${err.message}`); }
  try { newTeam = await getTeamByName(newTeamName, guildId, leagueId); }
  catch (err) { return interaction.editReply(`❌ **Database Error**\nCouldn't look up destination team "${newTeamName}": ${err.message}`); }

  if (!newTeam) return interaction.editReply(`❌ **Team Not Found: \`${newTeamName}\`**\nThis team doesn't exist in the database. Use the autocomplete dropdown to select a valid destination team.`);
  if (newTeam.user_id && newTeam.user_id !== user.id) {
    return interaction.editReply(`❌ **Team Already Occupied**\n**${newTeam.team_name}** is currently assigned to another coach in this league.\n\nTo move this coach there, first run \`/resetteam\` on the current coach of that team, then try again.`);
  }

  if (currentTeam) await unassignTeam(currentTeam.id, guildId, leagueId);
  await assignTeam(newTeam.id, user.id, guildId, leagueId);

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


// /offers-config ─────────────────────────────────────────────────────────
async function handleOffersConfig(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guildId = interaction.guildId;
  const config  = await getConfig(guildId);
  const isAdmin = interaction.member?.permissions.has(PermissionFlagsBits.ManageGuild);
  if (!isAdmin) return interaction.editReply({ content: '❌ Admin only.' });

  await showOffersConfigMenu(interaction, guildId, config);
}

async function showOffersConfigMenu(interaction, guildId, config, edit = false) {
  const offerCfg = await getJobOfferConfig(guildId);
  const whitelist = await getJobOfferConferences(guildId, 'whitelist');
  const blacklist = await getJobOfferConferences(guildId, 'blacklist');

  const weightLabel = offerCfg.weighted_ratings === 'highest' ? '⭐ Weighted: Highest'
                    : offerCfg.weighted_ratings === 'lowest'  ? '⭐ Weighted: Lowest'
                    : '⭐ Weighted: Off';

  const embed = new EmbedBuilder()
    .setTitle('⚙️ Job Offer Configuration')
    .setColor(config.embed_color_primary_int || 0x1e90ff)
    .setDescription('Toggle rules that apply when generating job offers. FCS teams are always excluded.')
    .addFields(
      { name: '🚫 Max 1 Per Conference', value: offerCfg.one_per_conference ? '✅ On'  : '❌ Off', inline: true },
      { name: '⚖️ Conference Balance',   value: offerCfg.conf_balance       ? '✅ On'  : '❌ Off', inline: true },
      { name: weightLabel,               value: offerCfg.weighted_ratings === 'off' ? '❌ Off' : '✅ On', inline: true },
      { name: '✅ Whitelist',            value: whitelist.length > 0 ? whitelist.join(', ') : 'None (all allowed)', inline: true },
      { name: '🚫 Blacklist',            value: blacklist.length > 0 ? blacklist.join(', ') : 'None',               inline: true },
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ofc_one_per_conf')
      .setLabel(offerCfg.one_per_conference ? '✅ 1 Per Conference' : '❌ 1 Per Conference')
      .setStyle(offerCfg.one_per_conference ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('ofc_balance')
      .setLabel(offerCfg.conf_balance ? '✅ Conf Balance' : '❌ Conf Balance')
      .setStyle(offerCfg.conf_balance ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('ofc_weighted')
      .setLabel(weightLabel)
      .setStyle(offerCfg.weighted_ratings !== 'off' ? ButtonStyle.Success : ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ofc_whitelist')
      .setLabel(`✅ Manage Whitelist${whitelist.length > 0 ? ` (${whitelist.length})` : ''}`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('ofc_blacklist')
      .setLabel(`🚫 Manage Blacklist${blacklist.length > 0 ? ` (${blacklist.length})` : ''}`)
      .setStyle(ButtonStyle.Primary),
  );

  const payload = { embeds: [embed], components: [row1, row2] };
  const msg = edit
    ? await interaction.editReply(payload)
    : await interaction.editReply(payload);

  // Collect button interaction
  try {
    const btn = await msg.awaitMessageComponent({
      filter: i => i.user.id === interaction.user.id,
      time: 120000,
    });
    await btn.deferUpdate();

    if (btn.customId === 'ofc_one_per_conf') {
      await setJobOfferConfig(guildId, { one_per_conference: !offerCfg.one_per_conference });
      await showOffersConfigMenu(interaction, guildId, config, true);

    } else if (btn.customId === 'ofc_balance') {
      await setJobOfferConfig(guildId, { conf_balance: !offerCfg.conf_balance });
      await showOffersConfigMenu(interaction, guildId, config, true);

    } else if (btn.customId === 'ofc_weighted') {
      // Cycle: off → highest → lowest → off
      const next = offerCfg.weighted_ratings === 'off'     ? 'highest'
                 : offerCfg.weighted_ratings === 'highest' ? 'lowest'
                 : 'off';
      await setJobOfferConfig(guildId, { weighted_ratings: next });
      await showOffersConfigMenu(interaction, guildId, config, true);

    } else if (btn.customId === 'ofc_whitelist') {
      await showConferenceToggleMenu(interaction, guildId, config, 'whitelist');

    } else if (btn.customId === 'ofc_blacklist') {
      await showConferenceToggleMenu(interaction, guildId, config, 'blacklist');
    }

  } catch {
    await interaction.editReply({ embeds: [embed], components: [] });
  }
}

async function showConferenceToggleMenu(interaction, guildId, config, mode) {
  const conferences = await getDistinctConferences();
  const active      = await getJobOfferConferences(guildId, mode);
  const modeLabel   = mode === 'whitelist' ? '✅ Whitelist' : '🚫 Blacklist';
  const modeDesc    = mode === 'whitelist'
    ? 'Only these conferences will appear in job offers. If empty, all are allowed.'
    : 'These conferences will never appear in job offers.';

  if (conferences.length === 0) {
    await interaction.editReply({ content: '❌ No conferences found in the teams database.', components: [] });
    return;
  }

  // Build toggle buttons — up to 25 (5 rows of 5)
  const buttons = conferences.slice(0, 20).map(conf =>
    new ButtonBuilder()
      .setCustomId(`ofc_conf_${mode}_${conf}`)
      .setLabel(active.includes(conf) ? `✅ ${conf}` : conf)
      .setStyle(active.includes(conf) ? ButtonStyle.Success : ButtonStyle.Secondary)
  );

  // Add a Back button at the end
  buttons.push(
    new ButtonBuilder()
      .setCustomId('ofc_back')
      .setLabel('← Back')
      .setStyle(ButtonStyle.Primary)
  );

  // Chunk into rows of 5
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  }

  const embed = new EmbedBuilder()
    .setTitle(`${modeLabel} Conferences`)
    .setColor(config.embed_color_primary_int || 0x1e90ff)
    .setDescription(`${modeDesc}\n\nCurrently active: ${active.length > 0 ? active.join(', ') : 'None'}`);

  const msg = await interaction.editReply({ embeds: [embed], components: rows });

  try {
    const btn = await msg.awaitMessageComponent({
      filter: i => i.user.id === interaction.user.id,
      time: 120000,
    });
    await btn.deferUpdate();

    if (btn.customId === 'ofc_back') {
      await showOffersConfigMenu(interaction, guildId, config, true);
      return;
    }

    // Parse conference from customId: ofc_conf_{mode}_{conference}
    const parts = btn.customId.split('_');
    // customId format: ofc_conf_whitelist_Big Ten  (conference name may have spaces replaced)
    const confName = conferences.find(c => `ofc_conf_${mode}_${c}` === btn.customId);
    if (confName) {
      await toggleJobOfferConference(guildId, confName, mode);
    }

    // Re-show the same screen to allow multiple toggles
    await showConferenceToggleMenu(interaction, guildId, config, mode);

  } catch {
    await interaction.editReply({ embeds: [embed], components: [] });
  }
}

// /rollback-advance ───────────────────────────────────────────────────────
async function handleRollbackAdvance(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guildId = interaction.guildId;
  const config  = await getConfig(guildId);
  const isAdmin = interaction.member?.permissions.has(PermissionFlagsBits.ManageGuild);
  if (!isAdmin) return interaction.editReply({ content: '❌ Admin only.' });

  const meta = await getMeta(guildId);

  // ── Open DM ───────────────────────────────────────────────────────────────
  let dm;
  try {
    dm = await interaction.user.createDM();
  } catch {
    return interaction.editReply({ content: '❌ **Could not open a DM.** Please allow DMs from server members and try again.' });
  }

  await interaction.editReply({ content: '📬 Check your DMs — rollback wizard is starting!' });

  const ask = async (prompt) => {
    await dm.send(prompt);
    try {
      const collected = await dm.awaitMessages({ filter: m => m.author.id === interaction.user.id, max: 1, time: 120000, errors: ['time'] });
      return collected.first().content.trim();
    } catch { return null; }
  };

  const askButtons = async (prompt, buttons) => {
    const row = new ActionRowBuilder().addComponents(
      buttons.map(b => new ButtonBuilder().setCustomId(b.id).setLabel(b.label).setStyle(b.style || ButtonStyle.Secondary))
    );
    const msg = await dm.send({ content: prompt, components: [row] });
    try {
      const btn = await msg.awaitMessageComponent({ filter: i => i.user.id === interaction.user.id, time: 120000 });
      await btn.update({ components: [] });
      return btn.customId;
    } catch {
      await msg.edit({ components: [] });
      return null;
    }
  };

  // ── Step 1: Target season ─────────────────────────────────────────────────
  await dm.send(
    `↩️ **Rollback Advance Wizard**

` +
    `Current state: **Season ${meta.season}** · **${formatPhase(meta.current_phase, meta.current_sub_phase)}**

` +
    `This will roll the league back to a previous point. Game results after that point can optionally be deleted and records recalculated.

` +
    `⚠️ **This cannot be undone.** Proceed carefully.`
  );

  const seasonStr = await ask(`**[Step 1/4]** What season should the league roll back to?\nExample: 3`);
  if (!seasonStr) return dm.send('⏰ Timed out — rollback cancelled.');
  const targetSeason = parseInt(seasonStr);
  if (isNaN(targetSeason) || targetSeason < 1) return dm.send('❌ Invalid season. Rollback cancelled.');

  // ── Step 2: Target phase ──────────────────────────────────────────────────
  const phaseChoice = await askButtons(
    '**[Step 2/4]** What phase should the league roll back to?',
    [
      { id: 'preseason',  label: 'Preseason' },
      { id: 'regular',    label: 'Regular Season', style: ButtonStyle.Primary },
      { id: 'conf_champ', label: 'Conference Championship' },
      { id: 'bowl',       label: 'Bowl Season' },
      { id: 'offseason',  label: 'Offseason' },
    ]
  );
  if (!phaseChoice) return dm.send('⏰ Timed out — rollback cancelled.');

  let targetPhase = phaseChoice;
  let targetSub   = 0;

  if (phaseChoice === 'regular') {
    const weekStr = await ask(`**[Step 3/4]** What week of the regular season? (1–16)\nExample: 8`);
    if (!weekStr) return dm.send('⏰ Timed out — rollback cancelled.');
    const parsed = parseInt(weekStr);
    if (isNaN(parsed) || parsed < 1 || parsed > 16) return dm.send('❌ Invalid week (1–16). Rollback cancelled.');
    targetSub = parsed - 1; // sub is 0-indexed; Week 1 = sub 0, Week 8 = sub 7, etc.
  } else if (phaseChoice === 'bowl') {
    const bowlChoice = await askButtons('**[Step 3/4]** Which bowl week?', [
      { id: '0', label: 'Bowl Week 1' },
      { id: '1', label: 'Bowl Week 2' },
      { id: '2', label: 'Semifinals' },
      { id: '3', label: 'National Championship', style: ButtonStyle.Primary },
    ]);
    if (!bowlChoice) return dm.send('⏰ Timed out — rollback cancelled.');
    targetSub = parseInt(bowlChoice);
  } else if (phaseChoice === 'offseason') {
    const offChoice = await askButtons('**[Step 3/4]** Which offseason phase?', [
      { id: 'end_of_season_recap', label: 'End of Season Recap' },
      { id: 'players_leaving',  label: 'Players Leaving' },
      { id: 'transfer_portal',  label: 'Transfer Portal' },
      { id: 'position_changes', label: 'Position Changes' },
      { id: 'training_results', label: 'Training Results' },
    ]);
    if (!offChoice) return dm.send('⏰ Timed out — rollback cancelled.');
    targetPhase = offChoice;
    if (offChoice === 'transfer_portal') {
      const twChoice = await askButtons('Which transfer week?', [
        { id: '0', label: 'Transfer Week 1' },
        { id: '1', label: 'Transfer Week 2' },
        { id: '2', label: 'Transfer Week 3' },
        { id: '3', label: 'Transfer Week 4' },
      ]);
      if (!twChoice) return dm.send('⏰ Timed out — rollback cancelled.');
      targetSub = parseInt(twChoice);
    }
  } else {
    // preseason / conf_champ — no sub needed, already 0
    await dm.send('**[Step 3/4]** *(No sub-phase needed for this phase — skipping.)*');
  }

  const targetWeek  = targetPhase === 'regular' ? targetSub + 1 : targetPhase === 'preseason' ? 1 : 17;
  const targetLabel = formatPhase(targetPhase, targetSub);

  // ── Step 4: Delete results? ───────────────────────────────────────────────
  const deleteChoice = await askButtons(
    `**[Step 4/4]** Do you want to delete game results submitted after **Season ${targetSeason} · ${targetLabel}**?

` +
    `• **Yes — Delete & Recalculate**: Removes results from later weeks and recomputes W/L records
` +
    `• **No — Keep Results**: Only rolls the phase/week back, leaves all results intact`,
    [
      { id: 'delete',  label: '🗑️ Yes — Delete & Recalculate', style: ButtonStyle.Danger },
      { id: 'keep',    label: '✅ No — Keep Results',           style: ButtonStyle.Success },
    ]
  );
  if (!deleteChoice) return dm.send('⏰ Timed out — rollback cancelled.');

  // ── Confirm ───────────────────────────────────────────────────────────────
  const confirm = await askButtons(
    `⚠️ **Confirm Rollback**

` +
    `Season: **${targetSeason}**
` +
    `Phase: **${targetLabel}**
` +
    `Results: **${deleteChoice === 'delete' ? 'Delete results after this point & recalculate records' : 'Keep all results'}**

` +
    `Are you sure? This cannot be undone.`,
    [
      { id: 'confirm', label: '✅ Confirm Rollback', style: ButtonStyle.Danger },
      { id: 'cancel',  label: '❌ Cancel',           style: ButtonStyle.Secondary },
    ]
  );
  if (!confirm || confirm === 'cancel') return dm.send('↩️ Rollback cancelled.');

  // ── Execute ───────────────────────────────────────────────────────────────
  await dm.send('⏳ Processing rollback...');

  // 1. Roll meta back
  const rollbackUpdate = {
    season:            targetSeason,
    week:              targetWeek,
    current_phase:     targetPhase,
    current_sub_phase: targetSub,
    advance_deadline:  null,
    last_advance_at:   null,
    next_advance_deadline: null,
  };
  const rollbackLeague = await getLeagueFromInteraction(interaction);
  if (rollbackLeague) await setLeague(rollbackLeague.league_id, rollbackUpdate);
  if (!config.multi_league) await setMeta(guildId, rollbackUpdate);

  let resultsSummary = 'Results left intact.';

  if (deleteChoice === 'delete') {
    // 2. Find results after the target week in the target season, plus all future seasons
    // Fetch results to delete in two queries (Supabase JS v2 doesn't support nested and() inside or())
    const rbLeagueId = rollbackLeague?.league_id || null;

    const laterSeasonsQ = supabase
      .from('results')
      .select('id, team1_id, team2_id, score1, score2, season, week')
      .eq('guild_id', guildId)
      .gt('season', targetSeason);
    if (rbLeagueId) laterSeasonsQ.eq('league_id', rbLeagueId);
    const { data: laterSeasons } = await laterSeasonsQ;

    const sameSeasonQ = supabase
      .from('results')
      .select('id, team1_id, team2_id, score1, score2, season, week')
      .eq('guild_id', guildId)
      .eq('season', targetSeason)
      .gt('week', targetWeek);
    if (rbLeagueId) sameSeasonQ.eq('league_id', rbLeagueId);
    const { data: sameSeasonLaterWeeks } = await sameSeasonQ;

    const toDelete = [...(laterSeasons || []), ...(sameSeasonLaterWeeks || [])];

    if (toDelete.length > 0) {
      // Delete in two passes scoped to this league
      const del1 = supabase.from('results').delete().eq('guild_id', guildId).gt('season', targetSeason);
      if (rbLeagueId) del1.eq('league_id', rbLeagueId);
      await del1;
      const del2 = supabase.from('results').delete().eq('guild_id', guildId).eq('season', targetSeason).gt('week', targetWeek);
      if (rbLeagueId) del2.eq('league_id', rbLeagueId);
      await del2;

      // 3. Recompute records for affected seasons
      const affectedSeasons = [...new Set(toDelete.map(r => r.season))];

      for (const season of affectedSeasons) {
        // Clear existing records for this season
        await supabase.from('records').delete().eq('guild_id', guildId).eq('season', season);

        // Re-fetch all remaining results for this season
        const { data: remaining } = await supabase
          .from('results')
          .select('team1_id, team2_id, score1, score2')
          .eq('guild_id', guildId)
          .eq('season', season);

        if (!remaining || remaining.length === 0) continue;

        // Recompute from scratch
        const tallies = {};
        const ensure  = (id) => { if (!tallies[id]) tallies[id] = { wins: 0, losses: 0, ties: 0 }; };

        for (const r of remaining) {
          ensure(r.team1_id);
          ensure(r.team2_id);
          if (r.score1 > r.score2)      { tallies[r.team1_id].wins++;   tallies[r.team2_id].losses++; }
          else if (r.score2 > r.score1) { tallies[r.team2_id].wins++;   tallies[r.team1_id].losses++; }
          else                          { tallies[r.team1_id].ties++;    tallies[r.team2_id].ties++; }
        }

        // Get assignments to only write assigned teams
        const { data: assignments } = await supabase
          .from('team_assignments').select('team_id').eq('guild_id', guildId);
        const assignedIds = new Set((assignments || []).map(a => a.team_id));

        for (const [teamId, rec] of Object.entries(tallies)) {
          if (!assignedIds.has(teamId)) continue;
          await supabase.from('records').upsert({
            guild_id: guildId, season, team_id: teamId,
            wins: rec.wins, losses: rec.losses, ties: rec.ties,
          }, { onConflict: 'team_id,season,guild_id' });
        }
      }

      resultsSummary = `Deleted **${toDelete.length}** result(s) and recalculated records for season(s): ${affectedSeasons.join(', ')}.`;
    } else {
      resultsSummary = 'No results found after the target point — nothing to delete.';
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  await dm.send(
    `✅ **Rollback Complete**

` +
    `**Season:** ${targetSeason}
` +
    `**Phase:** ${targetLabel}
` +
    `**Results:** ${resultsSummary}

` +
    `Use \`/advance\` to continue from this point.`
  );

  // Post to advance tracker
  const advanceChannel = findTextChannel(interaction.guild, config.channel_advance_tracker);
  if (advanceChannel) {
    const embed = new EmbedBuilder()
      .setTitle('↩️ Advance Rolled Back')
      .setColor(0xff9900)
      .setDescription(`The league has been rolled back by an admin.`)
      .addFields(
        { name: 'Season', value: `Season ${targetSeason}`, inline: true },
        { name: 'Phase',  value: targetLabel,               inline: true },
        { name: 'Results', value: resultsSummary,           inline: false },
      )
      .setTimestamp();
    await advanceChannel.send({ embeds: [embed] }).catch(() => {});
  }
}

// =====================================================
// STREAM REGISTRATION HELPERS
// =====================================================

function parseStreamLink(link) {
  // YouTube: youtube.com/watch?v=ID, youtube.com/live/ID, youtu.be/ID, youtube.com/@handle, youtube.com/c/handle
  const ytMatch = link.match(
    /(?:youtube\.com\/(?:watch\?v=|live\/|@|c\/|channel\/)|youtu\.be\/)([a-zA-Z0-9_\-@]+)/i
  );
  if (ytMatch) return { platform: 'youtube', channelId: ytMatch[1] };

  // Twitch (ready for when we add it)
  const ttMatch = link.match(/twitch\.tv\/([a-zA-Z0-9_]+)/i);
  if (ttMatch) return { platform: 'twitch', channelId: ttMatch[1] };

  return null;
}

async function saveStreamRegistration({ guildId, leagueId, userId, platform, channelId, titlePrefix }) {
  const { error } = await supabase.from('stream_registrations').upsert(
    { guild_id: guildId, league_id: leagueId || null, user_id: userId, platform, channel_id: channelId, title_prefix: titlePrefix || null },
    { onConflict: 'guild_id,user_id,platform' }
  );
  if (error) throw error;
}

async function getStreamRegistration(guildId, userId, platform) {
  const { data } = await supabase.from('stream_registrations')
    .select('*').eq('guild_id', guildId).eq('user_id', userId).eq('platform', platform).maybeSingle();
  return data;
}

async function listStreamRegistrations(guildId, userId) {
  const { data } = await supabase.from('stream_registrations')
    .select('*').eq('guild_id', guildId).eq('user_id', userId);
  return data || [];
}

async function deleteStreamRegistration(guildId, userId, platform) {
  await supabase.from('stream_registrations')
    .delete().eq('guild_id', guildId).eq('user_id', userId).eq('platform', platform);
}

async function checkYouTubeLive(channelId) {
  if (!YOUTUBE_API_KEY) return null;

  // If it looks like a handle (@username) or channel name, search for it first
  let resolvedChannelId = channelId;
  if (channelId.startsWith('@') || !channelId.startsWith('UC')) {
    const handle = channelId.startsWith('@') ? channelId.slice(1) : channelId;
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(handle)}&key=${YOUTUBE_API_KEY}&maxResults=1`;
    try {
      const res  = await fetch(searchUrl);
      const data = await res.json();
      if (data.items?.[0]) resolvedChannelId = data.items[0].snippet.channelId;
    } catch { return null; }
  }

  // Check for live streams on the resolved channel
  const liveUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(resolvedChannelId)}&eventType=live&type=video&key=${YOUTUBE_API_KEY}&maxResults=1`;
  try {
    const res  = await fetch(liveUrl);
    const data = await res.json();
    if (!data.items?.length) return null;
    const item = data.items[0];
    return {
      title:     item.snippet.title,
      url:       `https://www.youtube.com/watch?v=${item.id.videoId}`,
      thumbnail: item.snippet.thumbnails?.medium?.url || null,
      channelTitle: item.snippet.channelTitle,
    };
  } catch { return null; }
}

// Twitch OAuth token cache
let twitchToken = null;
let twitchTokenExpiry = 0;

async function getTwitchToken() {
  if (twitchToken && Date.now() < twitchTokenExpiry) return twitchToken;
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) return null;
  try {
    const res  = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`, { method: 'POST' });
    const data = await res.json();
    twitchToken       = data.access_token;
    twitchTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return twitchToken;
  } catch (err) {
    console.error('[twitch] Token fetch failed:', err.message);
    return null;
  }
}

async function checkTwitchLive(channelId) {
  const token = await getTwitchToken();
  if (!token) return null;
  try {
    const res  = await fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(channelId)}`, {
      headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` },
    });
    const data = await res.json();
    if (!data.data?.length) return null;
    const stream = data.data[0];
    return {
      title:        stream.title,
      url:          `https://twitch.tv/${channelId}`,
      thumbnail:    stream.thumbnail_url?.replace('{width}', '320').replace('{height}', '180') || null,
      channelTitle: stream.user_name,
      viewerCount:  stream.viewer_count,
    };
  } catch (err) {
    console.error('[twitch] Live check failed:', err.message);
    return null;
  }
}

// =====================================================
// STREAM COMMAND HANDLERS
// =====================================================

async function handleStreamRegister(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guildId = interaction.guildId;
  const userId  = interaction.user.id;
  const link    = interaction.options.getString('link')?.trim();
  const config  = await getConfig(guildId);

  if (!config.feature_stream) return interaction.editReply({ content: '❌ Streaming is not enabled on this server.' });

  const parsed = parseStreamLink(link);
  if (!parsed) return interaction.editReply({ content: '❌ Could not parse that link. Please paste a valid YouTube URL.' });
  // Both youtube and twitch supported

  const league   = await getLeagueFromInteraction(interaction);
  const leagueId = league?.league_id || null;
  const prefix   = config.league_abbreviation || null;

  try {
    await saveStreamRegistration({ guildId, leagueId, userId, platform: parsed.platform, channelId: parsed.channelId, titlePrefix: prefix });
    await interaction.editReply({
      content: `✅ **Stream registered!**
**Platform:** ${parsed.platform === 'youtube' ? 'YouTube' : 'Twitch'}
**Channel:** \`${parsed.channelId}\`

When you go live, run \`/stream-live\` and the bot will post to the streaming channel.`,
    });
  } catch (err) {
    console.error('[stream-register] failed:', err.message);
    await interaction.editReply({ content: `❌ Failed to save registration: ${err.message}` });
  }
}

async function handleStreamAdmin(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guildId = interaction.guildId;
  const config  = await getConfig(guildId);
  const isAdmin = interaction.member?.permissions.has(PermissionFlagsBits.ManageGuild);
  if (!isAdmin) return interaction.editReply({ content: '❌ Admin only.' });
  if (!config.feature_stream) return interaction.editReply({ content: '❌ Streaming is not enabled on this server.' });

  const link   = interaction.options.getString('link')?.trim();
  const target = interaction.options.getUser('user');
  const parsed = parseStreamLink(link);

  if (!parsed) return interaction.editReply({ content: '❌ Could not parse that link. Please paste a valid YouTube URL.' });
  // Both youtube and twitch supported

  const league   = await getLeagueFromInteraction(interaction);
  const leagueId = league?.league_id || null;
  const prefix   = config.league_abbreviation || null;

  try {
    await saveStreamRegistration({ guildId, leagueId, userId: target.id, platform: parsed.platform, channelId: parsed.channelId, titlePrefix: prefix });
    await interaction.editReply({
      content: `✅ Registered **${parsed.platform}** channel \`${parsed.channelId}\` for <@${target.id}>.`,
    });
  } catch (err) {
    console.error('[stream-admin] failed:', err.message);
    await interaction.editReply({ content: `❌ Failed: ${err.message}` });
  }
}

async function handleStreamRemove(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guildId = interaction.guildId;
  const userId  = interaction.user.id;

  const regs = await listStreamRegistrations(guildId, userId);
  if (!regs.length) return interaction.editReply({ content: '❌ You have no stream registrations in this server.' });

  // If only one registration, remove it directly
  if (regs.length === 1) {
    await deleteStreamRegistration(guildId, userId, regs[0].platform);
    return interaction.editReply({ content: `✅ Removed your ${regs[0].platform} registration (\`${regs[0].channel_id}\`).` });
  }

  // Multiple — show buttons
  const row = new ActionRowBuilder().addComponents(
    regs.map(r => new ButtonBuilder()
      .setCustomId(`srm_${r.platform}`)
      .setLabel(`${r.platform}: ${r.channel_id}`)
      .setStyle(ButtonStyle.Danger))
  );
  const msg = await interaction.editReply({ content: 'Which registration would you like to remove?', components: [row] });
  try {
    const btn = await msg.awaitMessageComponent({ filter: i => i.user.id === userId, time: 60000 });
    const platform = btn.customId.replace('srm_', '');
    await deleteStreamRegistration(guildId, userId, platform);
    await btn.update({ content: `✅ Removed your ${platform} registration.`, components: [] });
  } catch {
    await interaction.editReply({ content: '⏰ Timed out.', components: [] });
  }
}

async function handleStreamLive(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guildId = interaction.guildId;
  const userId  = interaction.user.id;
  const config  = await getConfig(guildId);

  if (!config.feature_stream) return interaction.editReply({ content: '❌ Streaming is not enabled on this server.' });

  const regs = await listStreamRegistrations(guildId, userId);
  if (!regs.length) return interaction.editReply({ content: '❌ You have no stream registered. Run `/stream-register` with your YouTube link first.' });

  const streamingChannel = findTextChannel(interaction.guild, config.channel_streaming);
  if (!streamingChannel) return interaction.editReply({ content: `❌ Streaming channel \`${config.channel_streaming}\` not found. Ask an admin to check the config.` });

  // Check each registration for a live stream
  let posted = false;
  for (const reg of regs) {
    const platformLabel = reg.platform === 'youtube' ? 'YouTube' : 'Twitch';
    await interaction.editReply({ content: `⏳ Checking ${platformLabel} for an active stream...` });

    const live = reg.platform === 'youtube'
      ? await checkYouTubeLive(reg.channel_id)
      : await checkTwitchLive(reg.channel_id);
    if (!live) continue;

    // Check title prefix if configured
    if (reg.title_prefix && !live.title.toLowerCase().includes(reg.title_prefix.toLowerCase())) {
      await interaction.editReply({
        content: `⚠️ Found a live stream but the title doesn't include the league keyword **${reg.title_prefix}**.
**Stream title:** ${live.title}

Make sure your stream title contains **${reg.title_prefix}** and try again.`,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`🔴 ${live.channelTitle} is Live!`)
      .setColor(reg.platform === 'twitch' ? 0x9146ff : 0xff0000)
      .setDescription(`<@${userId}> is streaming now!\n\n**${live.title}**`)
      .setURL(live.url)
      .addFields({ name: '📺 Watch Now', value: live.url, inline: false })
      .setTimestamp();

    if (live.thumbnail) embed.setThumbnail(live.thumbnail);
    if (live.viewerCount != null) embed.addFields({ name: '👥 Viewers', value: String(live.viewerCount), inline: true });

    await streamingChannel.send({ content: '@here', embeds: [embed] });
    await interaction.editReply({ content: `✅ Posted your stream to ${streamingChannel}!` });
    setTimeout(() => interaction.deleteReply().catch(() => {}), 8000);
    posted = true;
    break;
  }

  if (!posted) {
    await interaction.editReply({
      content: `❌ **No active stream found.**
Make sure your stream is live on YouTube before running this command.

If you just started streaming, wait 30 seconds and try again.`,
    });
  }
}

// /stream-list ────────────────────────────────────────────────────────────
async function handleStreamList(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guildId = interaction.guildId;
  const config  = await getConfig(guildId);
  if (!config.feature_stream) return interaction.editReply({ content: '❌ Streaming is not enabled on this server.' });

  const { data: regs } = await supabase
    .from('stream_registrations')
    .select('*')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: true });

  if (!regs?.length) return interaction.editReply({ content: '❌ No streamers registered yet. Coaches can register with `/stream-register`.' });

  const lines = regs.map(r => {
    const icon = r.platform === 'twitch' ? '🟣' : '🔴';
    const link = r.platform === 'twitch'
      ? `https://twitch.tv/${r.channel_id}`
      : `https://youtube.com/@${r.channel_id}`;
    return `${icon} <@${r.user_id}> — [${r.channel_id}](${link})`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`📺 Registered Streamers — ${config.league_name}`)
    .setColor(config.embed_color_primary_int || 0x1e90ff)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${regs.length} streamer(s) registered` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// /stream-remove-admin ────────────────────────────────────────────────────
async function handleStreamRemoveAdmin(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guildId  = interaction.guildId;
  const isAdmin  = interaction.member?.permissions.has(PermissionFlagsBits.ManageGuild);
  if (!isAdmin) return interaction.editReply({ content: '❌ Admin only.' });

  const target   = interaction.options.getUser('user');
  const platform = interaction.options.getString('platform');

  const regs = await listStreamRegistrations(guildId, target.id);
  if (!regs.length) return interaction.editReply({ content: `❌ <@${target.id}> has no stream registrations in this server.` });

  if (platform) {
    // Remove specific platform
    const match = regs.find(r => r.platform === platform);
    if (!match) return interaction.editReply({ content: `❌ <@${target.id}> has no ${platform} registration.` });
    await deleteStreamRegistration(guildId, target.id, platform);
    return interaction.editReply({ content: `✅ Removed <@${target.id}>'s ${platform} registration (\`${match.channel_id}\`).` });
  }

  // Remove all registrations for that user
  for (const reg of regs) {
    await deleteStreamRegistration(guildId, target.id, reg.platform);
  }
  await interaction.editReply({ content: `✅ Removed all stream registrations for <@${target.id}>.` });
}

// /current-week ───────────────────────────────────────────────────────────
async function handleCurrentWeek(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guildId = interaction.guildId;
  const config  = await getConfig(guildId);
  if (!config.setup_complete) return replySetupRequired(interaction);

  const league = await getLeagueFromInteraction(interaction);
  if (!league) return replyNoLeague(interaction);

  const phase    = formatPhase(league.current_phase, league.current_sub_phase);
  const deadline = league.advance_deadline ? new Date(league.advance_deadline) : null;
  const unix     = deadline ? Math.floor(deadline.getTime() / 1000) : null;

  const embed = new EmbedBuilder()
    .setTitle(`📅 ${config.league_name} — Current Week`)
    .setColor(config.embed_color_primary_int || 0x1e90ff)
    .addFields(
      { name: 'Season',  value: `Season ${league.season}`,  inline: true },
      { name: 'Phase',   value: phase,                       inline: true },
      { name: 'Week',    value: `Week ${league.week}`,       inline: true },
    );

  if (unix) {
    embed.addFields({
      name:  '⏰ Advance Deadline',
      value: `<t:${unix}:F> (<t:${unix}:R>)`,
      inline: false,
    });
  } else {
    embed.addFields({ name: '⏰ Advance Deadline', value: 'No active deadline', inline: false });
  }

  embed.setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}

// /league-list ────────────────────────────────────────────────────────────
async function handleLeagueList(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guildId = interaction.guildId;
  const config  = await getConfig(guildId);
  if (!config.setup_complete) return replySetupRequired(interaction);

  const leagues = await getGuildLeagues(guildId);
  if (!leagues.length) return interaction.editReply({ content: '❌ No leagues found for this server.' });

  const fields = leagues.map(l => {
    const phase = formatPhase(l.current_phase, l.current_sub_phase);
    const cat   = l.category_id === 'default' ? 'Server-wide' : `<#${l.category_id}>`;
    return {
      name:   l.league_name,
      value:  `Season ${l.season} · ${phase}\nCategory: ${cat}`,
      inline: false,
    };
  });

  const embed = new EmbedBuilder()
    .setTitle(`🏟️ Leagues — ${config.league_name || interaction.guild.name}`)
    .setColor(config.embed_color_primary_int || 0x1e90ff)
    .addFields(fields)
    .setFooter({ text: `${leagues.length} league(s) configured` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// /add-league ─────────────────────────────────────────────────────────────
async function handleAddLeague(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guildId = interaction.guildId;
  const config  = await getConfig(guildId);

  const isAdmin = interaction.member?.permissions.has(PermissionFlagsBits.ManageGuild);
  if (!isAdmin) return interaction.editReply({ content: '❌ Admin only.' });
  if (!config.setup_complete) return replySetupRequired(interaction);

  let dm;
  try {
    dm = await interaction.user.createDM();
  } catch {
    return interaction.editReply({ content: '❌ Could not open a DM. Please allow DMs from server members.' });
  }
  await interaction.editReply({ content: '📬 Check your DMs — add league wizard is starting!' });

  const ask = async (prompt) => {
    await dm.send(prompt);
    try {
      const collected = await dm.awaitMessages({ filter: m => m.author.id === interaction.user.id, max: 1, time: 120000, errors: ['time'] });
      return collected.first().content.trim();
    } catch { return null; }
  };

  // Step 1: League name
  const leagueName = await ask('🏟️ **Add League Wizard**\n\n**[Step 1/2]** What is the name of this league?\nExample: `East Division`');
  if (!leagueName) return dm.send('⏰ Timed out — cancelled.');

  // Step 2: Pick category
  const categories = interaction.guild.channels.cache
    .filter(c => c.type === 4) // CategoryChannel
    .sort((a, b) => a.position - b.position);

  if (!categories.size) return dm.send('❌ No categories found in this server. Create a Discord category first, then run `/add-league` again.');

  // Show categories as buttons (up to 20)
  const catArray = [...categories.values()].slice(0, 20);
  const rows = [];
  for (let i = 0; i < catArray.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(
      catArray.slice(i, i + 5).map(cat =>
        new ButtonBuilder()
          .setCustomId(`cat_${cat.id}`)
          .setLabel(cat.name.slice(0, 80))
          .setStyle(ButtonStyle.Secondary)
      )
    ));
  }

  const catMsg = await dm.send({ content: '**[Step 2/2]** Which category does this league live in?', components: rows });
  let categoryId, categoryName;
  try {
    const btn = await catMsg.awaitMessageComponent({ filter: i => i.user.id === interaction.user.id, time: 120000 });
    await btn.update({ components: [] });
    categoryId   = btn.customId.replace('cat_', '');
    categoryName = catArray.find(c => c.id === categoryId)?.name || categoryId;
  } catch {
    return dm.send('⏰ Timed out — cancelled.');
  }

  // Check for duplicate
  const existing = await getLeagueByCategoryId(guildId, categoryId);
  if (existing) return dm.send(`❌ **${categoryName}** is already mapped to league **${existing.league_name}**.`);

  // Step 3: configure channels for this league — filtered to selected category
  const categoryChannels = interaction.guild.channels.cache
    .filter(c => c.type === ChannelType.GuildText && c.parentId === categoryId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(c => c);

  const pickLeagueChannel = async (label, defaultVal) => {
    if (categoryChannels.size === 0) {
      // No channels in category — fall back to text input
      const response = await ask(`${label}\nNo channels found in **${categoryName}**. Type the channel name or \`skip\`.`);
      if (!response) return defaultVal;
      return response.toLowerCase() === 'skip' ? defaultVal : response.replace(/^#/, '');
    }
    const chList = [...categoryChannels.values()];
    const rows = [];
    for (let i = 0; i < chList.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(
        chList.slice(i, i + 5).map(ch =>
          new ButtonBuilder()
            .setCustomId(`lch_${ch.id}`)
            .setLabel('#' + ch.name)
            .setStyle(ButtonStyle.Secondary)
        )
      ));
    }
    // Add skip button
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('lch_skip').setLabel(`⏭️ Skip (use default: #${defaultVal || 'none'})`).setStyle(ButtonStyle.Primary)
    ));
    const msg = await dm.send({ content: label, components: rows });
    try {
      const btn = await msg.awaitMessageComponent({ filter: i => i.user.id === interaction.user.id, time: 120000 });
      await btn.update({ components: [] });
      if (btn.customId === 'lch_skip') return defaultVal;
      const ch = chList.find(c => c.id === btn.customId.replace('lch_', ''));
      return ch?.name || defaultVal;
    } catch { return defaultVal; }
  };

  await dm.send(`**[Step 3/3]** Configure channels for **${leagueName}** (showing channels in **${categoryName}**).`);
  const newsFeed      = await pickLeagueChannel('📰 **News Feed** — Where should game results post?', config.channel_news_feed);
  const advTracker    = await pickLeagueChannel('⏱️ **Advance Tracker** — Where should advance deadlines post?', config.channel_advance_tracker);
  const signedCoaches = await pickLeagueChannel('📋 **Signed Coaches** — Where should coach assignments post?', config.channel_signed_coaches);

  // Save the new league
  const newLeague = await upsertLeague(guildId, categoryId, {
    league_name:        leagueName,
    season:             1,
    week:               1,
    current_phase:      'preseason',
    current_sub_phase:  0,
    advance_hours:      config.advance_hours || 24,
    channel_news_feed:       newsFeed,
    channel_advance_tracker: advTracker,
    channel_signed_coaches:  signedCoaches,
    channel_team_lists:      config.channel_team_lists,
  });

  // Enable multi_league on the guild config
  await saveConfig(guildId, { multi_league: true });
  guildConfigs.delete(guildId);

  await dm.send(
    `✅ **League Added!**\n\n` +
    `**Name:** ${leagueName}\n` +
    `**Category:** ${categoryName}\n` +
    `**News Feed:** #${newsFeed || 'not set'}\n` +
    `**Advance Tracker:** #${advTracker || 'not set'}\n` +
    `**Signed Coaches:** #${signedCoaches || 'not set'}\n\n` +
    `Commands run in channels inside **${categoryName}** will now use this league's state.\n` +
    `Use \`/set-phase\` from within that category to set the starting season and phase.`
  );
}

// /conference-setup ───────────────────────────────────────────────────────
async function handleConferenceSetup(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guildId = interaction.guildId;
  const config  = await getConfig(guildId);
  const isAdmin = interaction.member?.permissions.has(PermissionFlagsBits.ManageGuild);
  if (!isAdmin) return interaction.editReply({ content: '❌ Admin only.' });
  if (!config.setup_complete) return replySetupRequired(interaction);
  if (!config.feature_custom_conferences) return interaction.editReply({ content: '❌ Custom Conferences is not enabled. Turn it on in `/config features`.' });

  let dm;
  try { dm = await interaction.user.createDM(); }
  catch { return interaction.editReply({ content: '❌ Could not open a DM. Please allow DMs from server members.' }); }
  await interaction.editReply({ content: '📬 Check your DMs — conference setup wizard is starting.' });

  const ask = async (prompt) => {
    await dm.send(prompt);
    try {
      const collected = await dm.awaitMessages({ filter: m => m.author.id === interaction.user.id, max: 1, time: 120000, errors: ['time'] });
      return collected.first().content.trim();
    } catch { return null; }
  };

  const askButtons = async (prompt, buttons) => {
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(
        buttons.slice(i, i + 5).map(b => new ButtonBuilder()
          .setCustomId(b.id).setLabel(b.label).setStyle(b.style || ButtonStyle.Secondary))
      ));
    }
    const msg = await dm.send({ content: prompt, components: rows });
    try {
      const btn = await msg.awaitMessageComponent({ filter: i => i.user.id === interaction.user.id, time: 120000 });
      await btn.update({ components: [] });
      return btn.customId;
    } catch { await msg.edit({ components: [] }); return null; }
  };

  const league = await getLeagueFromInteraction(interaction);
  const leagueId = league?.league_id || null;

  // ── Auto-fill from existing team conferences ────────────────────────────
  const existing = await getCustomConferences(guildId, leagueId);
  const { data: distinctConfs } = await supabase
    .from('teams').select('conference').neq('conference', 'FCS').order('conference');
  const stdConfs = [...new Set((distinctConfs || []).map(t => t.conference).filter(Boolean))];

  await dm.send(
    `🏟️ **Conference Setup Wizard**\n\n` +
    `This wizard lets you define custom tiers and divisions for your team list.\n\n` +
    `**Example structure:**\n` +
    `• Premier — East / West\n` +
    `• Championship — East / West\n` +
    `• League One — East / West\n\n` +
    `${existing.length > 0 ? `You currently have **${existing.length}** conference slots configured.` : 'No custom conferences set up yet.'}`
  );

  // ── Step 1: Division names ─────────────────────────────────────────────
  const divStr = await ask(
    `**[Step 1]** What are your division names?\nEnter them comma-separated.\nExample: \`East, West\` or \`North, South\` or \`American, National\``
  );
  if (!divStr) return dm.send('⏰ Timed out — cancelled.');
  const divisions = divStr.split(',').map(d => d.trim()).filter(Boolean);
  if (divisions.length < 2) return dm.send('❌ Need at least 2 divisions. Cancelled.');

  // ── Step 2: How many tiers? ────────────────────────────────────────────
  const tierCountStr = await ask(`**[Step 2]** How many tiers do you want?\nExample: \`3\` (for Premier, Championship, League One)`);
  if (!tierCountStr) return dm.send('⏰ Timed out — cancelled.');
  const tierCount = parseInt(tierCountStr);
  if (isNaN(tierCount) || tierCount < 1) return dm.send('❌ Invalid number. Cancelled.');

  // ── Step 3: Name each division within each tier separately ──────────────
  // tierSlots[i] = { position: i+1, names: { [divisionName]: tierName } }
  const tierSlots = [];
  let suggestionIndex = 0;

  for (let i = 0; i < tierCount; i++) {
    const slotNames = {};
    await dm.send(`**[Step 3.${i + 1}]** Tier ${i + 1} — name each division:`);
    for (const div of divisions) {
      const suggestion = stdConfs[suggestionIndex] ? ` (suggestion: \`${stdConfs[suggestionIndex]}\`)` : '';
      const name = await ask(`  Name for **Tier ${i + 1} — ${div}**${suggestion}`);
      if (!name) return dm.send('⏰ Timed out — cancelled.');
      slotNames[div] = name.trim();
      suggestionIndex++;
    }
    tierSlots.push({ position: i + 1, names: slotNames });
  }

  // ── Confirm ────────────────────────────────────────────────────────────
  const preview = tierSlots.map(slot =>
    divisions.map(d => `  • ${slot.names[d]} — ${d}`).join('\n')
  ).join('\n');

  const confirm = await askButtons(
    `**Confirm Conference Structure:**\n\n${preview}\n\nThis will replace any existing custom conferences.`,
    [
      { id: 'confirm', label: '✅ Confirm', style: ButtonStyle.Success },
      { id: 'cancel',  label: '❌ Cancel',  style: ButtonStyle.Secondary },
    ]
  );
  if (!confirm || confirm === 'cancel') return dm.send('↩️ Cancelled.');

  // ── Save ───────────────────────────────────────────────────────────────
  if (existing.length > 0) {
    await supabase.from('custom_conferences').delete().eq('guild_id', guildId)
      .eq('league_id', leagueId || '00000000-0000-0000-0000-000000000000');
    if (!leagueId) await supabase.from('custom_conferences').delete().eq('guild_id', guildId).is('league_id', null);
  }

  try {
    for (const slot of tierSlots) {
      for (const div of divisions) {
        await upsertCustomConference(guildId, leagueId, slot.names[div], div, slot.position);
      }
    }
  } catch (err) {
    console.error('[conference-setup] Save error:', err.message);
    return dm.send(`❌ **Failed to save conference structure:** ${err.message}`);
  }

  await dm.send(
    `✅ **Conference structure saved!**\n\n${preview}\n\n` +
    `Use \`/set-conference\` to assign teams to their tier and division.\n` +
    `Use \`/promote-relegate\` to move teams between tiers each season.`
  );

  await postTeamList(interaction.guild, guildId, config);
}

// /set-conference ──────────────────────────────────────────────────────────
async function handleSetConference(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guildId  = interaction.guildId;
  const config   = await getConfig(guildId);
  const isAdmin  = interaction.member?.permissions.has(PermissionFlagsBits.ManageGuild);
  if (!isAdmin) return interaction.editReply({ content: '❌ Admin only.' });
  if (!config.feature_custom_conferences) return interaction.editReply({ content: '❌ Custom Conferences is not enabled.' });

  const teamName     = interaction.options.getString('team');
  const conferenceId = interaction.options.getString('conference');

  // Find team
  const { data: team } = await supabase.from('teams').select('id, team_name')
    .ilike('team_name', teamName).maybeSingle();
  if (!team) return interaction.editReply({ content: `❌ Team not found: **${teamName}**` });

  // Look up the conference slot directly by ID
  const { data: slot } = await supabase.from('custom_conferences')
    .select('*').eq('id', conferenceId).maybeSingle();
  if (!slot) return interaction.editReply({ content: `❌ Conference not found. Run \`/conference-setup\` first.` });

  await setTeamCustomConference(team.id, guildId, slot.id);
  await interaction.editReply({ content: `✅ **${team.team_name}** assigned to **${slot.tier_name} — ${slot.division_name}**.` });
  await postTeamList(interaction.guild, guildId, config);
}

// /promote-relegate ────────────────────────────────────────────────────────
async function handlePromoteRelegate(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guildId  = interaction.guildId;
  const config   = await getConfig(guildId);
  const isAdmin  = interaction.member?.permissions.has(PermissionFlagsBits.ManageGuild);
  if (!isAdmin) return interaction.editReply({ content: '❌ Admin only.' });
  if (!config.feature_custom_conferences) return interaction.editReply({ content: '❌ Custom Conferences is not enabled. Turn it on in `/config features`.' });
  if (!config.feature_promotion_relegation) return interaction.editReply({ content: '❌ Promotion/Relegation is not enabled. Turn it on in `/config features`.' });

  let dm;
  try { dm = await interaction.user.createDM(); }
  catch { return interaction.editReply({ content: '❌ Could not open a DM.' }); }
  await interaction.editReply({ content: '📬 Check your DMs — promote/relegate wizard is starting.' });

  const askButtons = async (prompt, buttons) => {
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(
        buttons.slice(i, i + 5).map(b => new ButtonBuilder()
          .setCustomId(b.id).setLabel(b.label).setStyle(b.style || ButtonStyle.Secondary))
      ));
    }
    const msg = await dm.send({ content: prompt, components: rows });
    try {
      const btn = await msg.awaitMessageComponent({ filter: i => i.user.id === interaction.user.id, time: 120000 });
      await btn.update({ components: [] });
      return btn.customId;
    } catch { await msg.edit({ components: [] }); return null; }
  };

  const league   = await getLeagueFromInteraction(interaction);
  const leagueId = league?.league_id || null;
  const confs    = await getCustomConferences(guildId, leagueId);
  if (!confs.length) return dm.send('❌ No custom conferences set up. Run `/conference-setup` first.');

  // ── Step 1: Pick direction ─────────────────────────────────────────────
  const direction = await askButtons(
    '⬆️ **Promote/Relegate Wizard**\n\nAre you promoting or relegating a team?',
    [
      { id: 'promote', label: '⬆️ Promote', style: ButtonStyle.Success },
      { id: 'relegate', label: '⬇️ Relegate', style: ButtonStyle.Danger },
    ]
  );
  if (!direction) return dm.send('⏰ Timed out — cancelled.');

  // ── Step 2: Pick team from assigned teams ──────────────────────────────
  let assignQuery = supabase
    .from('team_assignments')
    .select('team_id, custom_conference_id, teams(team_name), custom_conferences(tier_name, division_name, position)')
    .eq('guild_id', guildId)
    .not('custom_conference_id', 'is', null);
  if (leagueId) assignQuery = assignQuery.eq('league_id', leagueId);
  const { data: assignments } = await assignQuery;

  if (!assignments?.length) return dm.send('❌ No teams are assigned to custom conferences yet.');

  // Filter to teams that CAN move in the chosen direction
  const tierPositions = [...new Set(confs.map(c => c.position))].sort((a, b) => a - b);
  const minPos = Math.min(...tierPositions);
  const maxPos = Math.max(...tierPositions);

  const moveable = assignments.filter(a => {
    const pos = a.custom_conferences?.position;
    if (pos == null) return false;
    if (direction === 'promote') return pos > minPos;
    return pos < maxPos;
  });

  if (!moveable.length) return dm.send(`❌ No teams can be ${direction === 'promote' ? 'promoted' : 'relegated'} further.`);

  // Show teams as buttons — cap at 24 to leave room within Discord's 5-row limit
  const teamButtons = moveable.slice(0, 24).map(a => {
    const teamName = a.teams?.team_name || 'Unknown';
    const confName = a.custom_conferences?.tier_name || '';
    const divName  = a.custom_conferences?.division_name || '';
    const rawLabel = `${teamName} (${confName} ${divName})`;
    return {
      id:    `team_${a.team_id}`,
      label: rawLabel.slice(0, 80), // Discord button label max
    };
  });

  const teamPick = await askButtons('Which team?', teamButtons);
  if (!teamPick) return dm.send('⏰ Timed out — cancelled.');

  // Use string comparison to safely match team_id regardless of int/string type
  const pickedId   = teamPick.replace('team_', '');
  const assignment = moveable.find(a => String(a.team_id) === pickedId);
  if (!assignment) return dm.send('❌ Could not find that team — please try again.');
  const currentConf = assignment.custom_conferences;

  // Find target tier — match by position and division within the league-filtered confs
  const currentPos = currentConf.position;
  const targetPos  = direction === 'promote' ? currentPos - 1 : currentPos + 1;
  const targetConf = confs.find(c => c.position === targetPos && c.division_name === currentConf.division_name);

  if (!targetConf) return dm.send(`❌ No **${currentConf.division_name}** division found at the ${direction === 'promote' ? 'tier above' : 'tier below'}. Check your conference structure with \`/conference-setup\`.`);

  // ── Confirm ────────────────────────────────────────────────────────────
  const verb    = direction === 'promote' ? 'Promoted' : 'Relegated';
  const confirm = await askButtons(
    `**Confirm:** ${verb} **${assignment.teams?.team_name}**\n` +
    `From: **${currentConf.tier_name} — ${currentConf.division_name}**\n` +
    `To: **${targetConf.tier_name} — ${targetConf.division_name}**`,
    [
      { id: 'confirm', label: `✅ ${verb}`, style: direction === 'promote' ? ButtonStyle.Success : ButtonStyle.Danger },
      { id: 'cancel',  label: '❌ Cancel',  style: ButtonStyle.Secondary },
    ]
  );
  if (!confirm || confirm === 'cancel') return dm.send('↩️ Cancelled.');

  await setTeamCustomConference(teamId, guildId, targetConf.id);

  await dm.send(
    `✅ **${verb}!**\n` +
    `**${assignment.teams?.team_name}** moved to **${targetConf.tier_name} — ${targetConf.division_name}**.`
  );

  await postTeamList(interaction.guild, guildId, config);
  console.log(`[conference] ${verb} team ${teamId} from pos ${currentPos} to ${targetPos} in guild ${guildId}`);
}

// /reset-league ───────────────────────────────────────────────────────────
async function handleResetLeague(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guildId = interaction.guildId;
  const config  = await getConfig(guildId);
  const isAdmin = interaction.member?.permissions.has(PermissionFlagsBits.ManageGuild);
  if (!isAdmin) return interaction.editReply({ content: '❌ Admin only.' });

  let dm;
  try {
    dm = await interaction.user.createDM();
  } catch {
    return interaction.editReply({ content: '❌ Could not open a DM. Please allow DMs from server members.' });
  }
  await interaction.editReply({ content: '📬 Check your DMs — reset wizard is starting.' });

  const askButtons = async (prompt, buttons) => {
    const row = new ActionRowBuilder().addComponents(
      buttons.map(b => new ButtonBuilder()
        .setCustomId(b.id).setLabel(b.label).setStyle(b.style || ButtonStyle.Secondary))
    );
    const msg = await dm.send({ content: prompt, components: [row] });
    try {
      const btn = await msg.awaitMessageComponent({ filter: i => i.user.id === interaction.user.id, time: 120000 });
      await btn.update({ components: [] });
      return btn.customId;
    } catch {
      await msg.edit({ components: [] });
      return null;
    }
  };

  const ask = async (prompt) => {
    await dm.send(prompt);
    try {
      const collected = await dm.awaitMessages({ filter: m => m.author.id === interaction.user.id, max: 1, time: 120000, errors: ['time'] });
      return collected.first().content.trim();
    } catch { return null; }
  };

  const leagueName = config.league_name || 'this league';

  // ── Step 1: Choose reset type ─────────────────────────────────────────
  await dm.send(
    `⚠️ **Reset League Wizard**\n\n` +
    `Server: **${interaction.guild.name}**\n` +
    `League: **${leagueName}**\n\n` +
    `Choose a reset type:\n\n` +
    `🔄 **Season Reset** — Clears game results and records, resets to Season 1 Preseason. Coaches stay assigned.\n\n` +
    `👥 **Full Reset** — Everything above plus unassigns all coaches. Config and channels stay intact.\n\n` +
    `💥 **Nuclear Reset** — Wipes everything including bot config. All admins will need to run \`/setup\` again.`
  );

  const resetType = await askButtons(
    'Which reset type?',
    [
      { id: 'season', label: '🔄 Season Reset',  style: ButtonStyle.Primary },
      { id: 'full',   label: '👥 Full Reset',     style: ButtonStyle.Secondary },
      { id: 'nuclear',label: '💥 Nuclear Reset',  style: ButtonStyle.Danger },
    ]
  );
  if (!resetType) return dm.send('⏰ Timed out — reset cancelled.');

  // ── Step 2: Describe what will happen ─────────────────────────────────
  const descriptions = {
    season:  `**Season Reset** will:\n• Delete all game results\n• Delete all win/loss records\n• Reset season to **Season 1 · Preseason**\n• Keep all coach assignments\n• Keep all bot settings`,
    full:    `**Full Reset** will:\n• Delete all game results\n• Delete all win/loss records\n• Reset season to **Season 1 · Preseason**\n• **Unassign all coaches**\n• Keep all bot settings`,
    nuclear: `**Nuclear Reset** will:\n• Delete all game results\n• Delete all win/loss records\n• **Unassign all coaches**\n• **Wipe all bot config** (channels, features, etc.)\n• All admins must run \`/setup\` to restart`,
  };

  // ── Step 3: Type league name to confirm ───────────────────────────────
  const typed = await ask(
    `⚠️ **Confirm Reset**\n\n${descriptions[resetType]}\n\n` +
    `**This cannot be undone.**\n\nType the league name exactly to confirm:\n\`${leagueName}\``
  );
  if (!typed) return dm.send('⏰ Timed out — reset cancelled.');
  if (typed !== leagueName) return dm.send(`❌ League name didn't match — reset cancelled.\nYou typed: \`${typed}\`\nExpected: \`${leagueName}\``);

  // ── Step 4: Final confirmation button ────────────────────────────────
  const confirmed = await askButtons(
    `⚠️ **Final Confirmation**\nAre you absolutely sure? This will permanently delete data.`,
    [
      { id: 'confirm', label: '✅ Yes, reset now', style: ButtonStyle.Danger },
      { id: 'cancel',  label: '❌ Cancel',          style: ButtonStyle.Secondary },
    ]
  );
  if (!confirmed || confirmed === 'cancel') return dm.send('↩️ Reset cancelled.');

  // ── Execute ───────────────────────────────────────────────────────────
  await dm.send('⏳ Executing reset...');

  const summary = [];

  try {
    // Always: wipe results and records for this guild
    const { count: resultCount } = await supabase.from('results').delete().eq('guild_id', guildId).select('id', { count: 'exact', head: true });
    const { count: recordCount } = await supabase.from('records').delete().eq('guild_id', guildId).select('id', { count: 'exact', head: true });
    summary.push(`🗑️ Deleted game results and records`);

    // Always: reset season state
    const resetState = {
      season: 1, week: 1,
      current_phase: 'preseason', current_sub_phase: 0,
      advance_deadline: null, last_advance_at: null, next_advance_deadline: null,
    };
    await supabase.from('leagues').update(resetState).eq('guild_id', guildId);
    await supabase.from('meta').update(resetState).eq('guild_id', guildId);
    guildConfigs.delete(guildId);
    summary.push(`📅 Reset to Season 1 · Preseason`);

    if (resetType === 'full' || resetType === 'nuclear') {
      await supabase.from('team_assignments').delete().eq('guild_id', guildId);
      await supabase.from('job_offer_config').delete().eq('guild_id', guildId);
      await supabase.from('job_offer_conferences').delete().eq('guild_id', guildId);
      summary.push(`👥 Unassigned all coaches`);
      summary.push(`🧹 Cleared job offer config`);
    }

    if (resetType === 'nuclear') {
      await supabase.from('leagues').delete().eq('guild_id', guildId);
      await supabase.from('meta').delete().eq('guild_id', guildId);
      await supabase.from('config').delete().eq('guild_id', guildId);
      guildConfigs.delete(guildId);
      summary.push(`💥 Wiped all bot config — admins must run \`/setup\``);
    }

  } catch (err) {
    console.error('[reset-league] Error:', err.message);
    return dm.send(`❌ **Reset failed:** ${err.message}\nSome data may have been partially deleted. Check Supabase.`);
  }

  // ── Post to advance tracker ───────────────────────────────────────────
  const advanceChannel = findTextChannel(interaction.guild, config.channel_advance_tracker);
  if (advanceChannel && resetType !== 'nuclear') {
    const embed = new EmbedBuilder()
      .setTitle('🔄 League Reset')
      .setColor(0xff9900)
      .setDescription(`The league has been reset by an admin.`)
      .addFields({ name: 'Reset Type', value: resetType.charAt(0).toUpperCase() + resetType.slice(1), inline: true })
      .addFields({ name: 'Details', value: summary.join('\n'), inline: false })
      .setTimestamp();
    await advanceChannel.send({ embeds: [embed] }).catch(() => {});
  }

  await dm.send(
    `✅ **Reset Complete**\n\n${summary.join('\n')}\n\n` +
    (resetType === 'nuclear'
      ? '⚠️ Bot config has been wiped. Admins must run `/setup` to reconfigure.'
      : 'Use `/advance` to begin the new season.')
  );

  console.log(`[reset-league] ${resetType} reset executed for guild ${guildId} by ${interaction.user.tag}`);
}

// /reload-commands ───────────────────────────────────────────────────
async function handleReloadCommands(interaction) {
  await interaction.deferReply({ flags: 64 });
  const isAdmin = interaction.member?.permissions.has(PermissionFlagsBits.ManageGuild);
  if (!isAdmin) return interaction.editReply({ content: '❌ Admin only.' });
  try {
    await registerCommands();
    await interaction.editReply({ content: '✅ **Commands re-registered.** New commands may take up to a minute to appear in Discord.' });
  } catch (err) {
    await interaction.editReply({ content: `❌ **Failed to re-register commands:** ${err.message}` });
  }
}

// /set-phase ───────────────────────────────────────────────────────────
async function handleSetPhase(interaction) {
  await interaction.deferReply({ flags: 64 });
  const guildId = interaction.guildId;
  const config  = await getConfig(guildId);

  const isAdmin = interaction.member?.permissions.has(PermissionFlagsBits.ManageGuild);
  if (!isAdmin) return interaction.editReply({ content: '❌ Admin only.' });

  const league = await getLeagueFromInteraction(interaction);
  if (!league) return replyNoLeague(interaction);

  const season   = interaction.options.getInteger('season') ?? league.season;
  const phaseKey = interaction.options.getString('phase');
  const subInput = interaction.options.getInteger('sub');

  const phaseDef = getPhaseByKey(phaseKey);

  // Determine sub — if not provided use the phase's startSub default
  let sub = subInput !== null ? subInput : phaseDef.startSub;

  // Validate sub range
  const maxSub = phaseDef.startSub + phaseDef.subWeeks - 1;
  if (sub < phaseDef.startSub || sub > maxSub) {
    return interaction.editReply({
      content: `❌ **Invalid sub-phase for ${phaseDef.name}**\nValid range: ${phaseDef.startSub}–${maxSub}. You entered: ${sub}.`,
    });
  }

  // Derive week the same way advance does
  const week = phaseKey === 'regular'  ? sub + 1
             : phaseKey === 'preseason' ? 1
             : 17; // bowl / offseason — post-regular-season

  const setPhaseUpdate = {
    season,
    week,
    current_phase:     phaseKey,
    current_sub_phase: sub,
  };
  await setLeague(league.league_id, setPhaseUpdate);
  if (!config.multi_league) await setMeta(guildId, setPhaseUpdate);

  const label = formatPhase(phaseKey, sub);

  const embed = new EmbedBuilder()
    .setTitle('📅 Phase Updated')
    .setColor(config.embed_color_primary_int || 0x1e90ff)
    .setDescription(`League phase has been manually updated.`)
    .addFields(
      { name: 'Season',  value: `Season ${season}`,    inline: true },
      { name: 'Phase',   value: label,                 inline: true },
      { name: 'Week',    value: `Week ${week}`,         inline: true },
      { name: 'Sub-Phase Index', value: `${sub}`,      inline: true },
    )
    .setFooter({ text: 'Use /advance to continue advancing from this point.' });

  await interaction.editReply({ embeds: [embed] });
}

// /help ──────────────────────────────────────────────
async function handleHelp(interaction) {
  await interaction.deferReply({ flags: 64 });

  const config  = await getConfig(interaction.guildId);
  const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
  if (!config.setup_complete && !isAdmin) return replySetupRequired(interaction);

  // ── Command catalogue ─────────────────────────────────────────────────────
  // Each entry: { flag, adminOnly, title, usage, description }
  // flag: config key that must be true for the command to show (null = always show)
  const COMMANDS = [
    // ── Team Selection ─────────────────────────────────────────────────────
    {
      flag:      'feature_job_offers',
      adminOnly: true,
      title:     '⚙️ `/offers-config`',
      usage:     '/offers-config',
      desc:      'Configure conference rules and weighting for job offers. Toggle max-1-per-conference, conference balance, weighted ratings, and manage conference whitelists/blacklists.',
    },
    {
      flag:      'feature_job_offers',
      adminOnly: false,
      title:     '📋 `/joboffers`',
      usage:     '/joboffers',
      desc:      "Request a set of coaching job offers. You'll receive up to " + (config.job_offers_count || 3) + " teams via DM based on star rating. Offers expire after " + (config.job_offers_expiry_hours || 48) + " hours.",
    },
    {
      flag:      'feature_assign_team',
      adminOnly: true,
      title:     '➕ `/assign-team`',
      usage:     '/assign-team user: @user team: <team>',
      desc:      "Manually assign a team to a user and post a signing announcement. Use skip-announcement: true to assign quietly.",
    },
    {
      flag:      'feature_reset_team',
      adminOnly: true,
      title:     '❌ `/resetteam`',
      usage:     '/resetteam user: @user',
      desc:      "Remove a coach from their team and strip their Head Coach role.",
    },
    {
      flag:      'feature_list_teams',
      adminOnly: true,
      title:     '📋 `/listteams`',
      usage:     '/listteams',
      desc:      "Post the full team availability list to the configured channel, showing which teams are taken and which are open.",
    },
    {
      flag:      'feature_move_coach',
      adminOnly: true,
      title:     '🔀 `/move-coach`',
      usage:     '/move-coach coach: <name> new-team: <team>',
      desc:      "Move an assigned coach from their current team to a different one.",
    },
    // ── Advance Management ─────────────────────────────────────────────────
    {
      flag:      'feature_advance',
      adminOnly: true,
      title:     '⏩ `/advance`',
      usage:     '/advance hours: <n>',
      desc:      "Advance the league to the next phase/week and set a deadline. The bot posts the new phase and deadline to the advance tracker channel.",
    },

    // ── Streaming ──────────────────────────────────────────────────────────    // ── Always available ───────────────────────────────────────────────────
    {
      flag:      null,
      adminOnly: false,
      title:     '❓ `/help`',
      usage:     '/help',
      desc:      "Show this list. Admins see all commands; coaches see only commands available to them.",
    },
    {
      flag:      null,
      adminOnly: true,
      title:     '⚙️ `/config view`',
      usage:     '/config view',
      desc:      "View all current bot settings for this server.",
    },
    {
      flag:      null,
      adminOnly: true,
      title:     '⚙️ `/config edit`',
      usage:     '/config edit setting: <name> value: <value>',
      desc:      "Change a specific config value (channel names, star ratings, colors, etc.).",
    },
    {
      flag:      null,
      adminOnly: true,
      title:     '⚙️ `/config features`',
      usage:     '/config features',
      desc:      "Toggle individual features on or off for this server.",
    },
    {
      flag:      null,
      adminOnly: true,
      title:     '⚙️ `/config reload`',
      usage:     '/config reload',
      desc:      "Force-reload the bot config from the database. Use after editing Supabase directly.",
    },
    {
      flag:      null,
      adminOnly: true,
      title:     '🔧 `/setup`',
      usage:     '/setup',
      desc:      "Run the interactive setup wizard. Walks through league name, features, channels, roles, and settings via DM.",
    },
    {
      flag:      null,
      adminOnly: true,
      title:     '🔧 `/checkpermissions`',
      usage:     '/checkpermissions',
      desc:      "Audit the bot's permissions across all configured channels and confirm everything is set up correctly.",
    },
    {
      flag:      null,
      adminOnly: true,
      title:     '📅 `/set-phase`',
      usage:     '/set-phase season: <n> phase: <phase> sub: <n>',
      desc:      "Manually set the current season, phase, and sub-week. Use to correct the league state if it gets out of sync. /advance will continue from wherever you set it.",
    },
    {
      flag:      null,
      adminOnly: true,
      title:     '↩️ `/rollback-advance`',
      usage:     '/rollback-advance',
      desc:      "Roll the league back to a previous season and week via DM. Optionally delete game results submitted after that point and recalculate records.",
    },
    {
      flag:      null,
      adminOnly: false,
      title:     '🏟️ `/league-list`',
      usage:     '/league-list',
      desc:      'Show all leagues configured in this server, along with their current season and phase.',
    },
    {
      flag:      null,
      adminOnly: true,
      title:     '➕ `/add-league`',
      usage:     '/add-league',
      desc:      'Add a new league to this server via DM wizard. Maps a Discord category to a league with its own season, phase, and channels. Automatically enables multi-league mode.',
    },
    {
      flag:      null,
      adminOnly: true,
      title:     '🔄 `/reset-league`',
      usage:     '/reset-league',
      desc:      'Reset league data via DM wizard. Choose between season reset, full coach reset, or nuclear reset. Requires typing the league name to confirm.',
    },
  ];

  // ── Filter by feature flag + role ─────────────────────────────────────────
  const visible = COMMANDS.filter(cmd => {
    if (cmd.adminOnly && !isAdmin) return false;
    if (cmd.flag && !config[cmd.flag]) return false;
    return true;
  });

  // ── Build embed fields (max 25 Discord fields) ────────────────────────────
  const fields = visible.map(cmd => ({
    name:   cmd.title,
    value:  `${cmd.usage}\n${cmd.desc}`,
    inline: false,
  }));

  // Split into pages of 10 if needed
  const PAGE = 10;
  const pages = [];
  for (let i = 0; i < fields.length; i += PAGE) pages.push(fields.slice(i, i + PAGE));

  const roleLabel = isAdmin ? 'Admin' : 'Coach';
  const embed = new EmbedBuilder()
    .setTitle(`📖 ${config.league_name} — Command Guide (${roleLabel})`)
    .setColor(config.embed_color_primary_int || 0x1e90ff)
    .setDescription(
      isAdmin
        ? `Showing all **${visible.length}** commands available on this server. Disabled features are hidden.`
        : `Showing **${visible.length}** commands available to you. Ask an admin to enable additional features.`
    )
    .addFields(pages[0])
    .setFooter({ text: '🔗 Invite Dynasty Bot: http://bit.ly/46t7pjs' });

  await interaction.editReply({ embeds: [embed] });

  // Send additional pages as follow-ups if list is long
  for (let p = 1; p < pages.length; p++) {
    const pageEmbed = new EmbedBuilder()
      .setColor(config.embed_color_primary_int || 0x1e90ff)
      .addFields(pages[p]);
    await interaction.followUp({ embeds: [pageEmbed], flags: 64 });
  }
}

// /checkpermissions ───────────────────────────────────
async function handleCheckPermissions(interaction) {
  const guildId   = interaction.guildId;
  await interaction.deferReply({ flags: 64 });
  const guild = interaction.guild || await client.guilds.fetch({ guild: guildId, force: true }).catch(() => null);
  if (!guild) return interaction.editReply({ content: '❌ Could not load server data. Please try again.' });
  await guild.channels.fetch().catch(() => {});
  const config    = await getConfig(guildId);
  const botMember = guild.members.cache.get(client.user.id) || await guild.members.fetch(client.user.id).catch(() => null);
  if (!botMember) return interaction.editReply({ content: '❌ Could not fetch bot member data. Please try again.' });

  const REQUIRED = ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory'];

  const channelChecks = [
    { key: 'channel_news_feed',       label: 'News Feed',       needsManage: false },
    { key: 'channel_signed_coaches',  label: 'Signed Coaches',  needsManage: false },
    { key: 'channel_team_lists',      label: 'Team Lists',      needsManage: true  },
    { key: 'channel_advance_tracker', label: 'Advance Tracker', needsManage: false },
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

  } else if (commandName === 'resetteam' && focused.name === 'team') {
    // Only autocomplete the team option — show assigned teams only
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

  } else if (commandName === 'set-conference') {
    // Fetch all custom conferences for this guild regardless of league_id
    const { data: allConfs } = await supabase
      .from('custom_conferences')
      .select('*')
      .eq('guild_id', guildId)
      .order('position');
    const confs = allConfs || [];

    if (focused.name === 'team') {
      const { data: teams } = await supabase.from('teams').select('team_name')
        .ilike('team_name', `%${query}%`).order('team_name').limit(25);
      choices = (teams || []).map(t => ({ name: t.team_name, value: t.team_name }));
    } else if (focused.name === 'conference') {
      // Each conference name is unique (tier_name includes division context)
      // Show as "SEC (East)" so admin knows which division it maps to
      choices = confs
        .filter(c => c.tier_name.toLowerCase().includes(query) || c.division_name.toLowerCase().includes(query))
        .map(c => ({ name: `${c.tier_name} (${c.division_name})`, value: c.id }))
        .slice(0, 25);
    }

  } else if (commandName === 'advance') {
    // Always load fresh config so intervals reflect latest settings
    try {
      guildConfigs.delete(guildId);
      const advConfig  = await loadGuildConfig(guildId);
      const intervals  = advConfig.advance_intervals_parsed || [24, 48];
      choices = intervals
        .filter(h => String(h).includes(query))
        .map(h => ({ name: `${h} Hours`, value: String(h) }));
    } catch {
      choices = [24, 48].map(h => ({ name: `${h} Hours`, value: String(h) }));
    }

  } else if (commandName === 'config' && focused.name === 'setting') {
    const allSettings = [
      { label: 'League Name',             key: 'league_name',                hint: 'League display name' },
      { label: 'League Abbreviation',     key: 'league_abbreviation',        hint: 'Short name for your league' },
      { label: 'News Feed Channel',       key: 'channel_news_feed',          hint: 'Channel for results & announcements' },
      { label: 'Advance Tracker Channel', key: 'channel_advance_tracker',    hint: 'Channel for advance notices' },
      { label: 'Team Lists Channel',      key: 'channel_team_lists',         hint: 'Channel for team availability list' },
      { label: 'Signed Coaches Channel',  key: 'channel_signed_coaches',     hint: 'Channel for signing announcements' },
      { label: 'Streaming Channel',         key: 'channel_streaming',          hint: 'Channel for live stream posts' },
      { label: 'Team List Filter',         key: 'team_list_filter',           hint: 'Default filter: all, assigned, available, or conference_view' },
      { label: 'Head Coach Role',         key: 'role_head_coach',            hint: 'Role assigned to coaches' },

      { label: 'Min Star Rating',         key: 'star_rating_for_offers',     hint: 'Minimum star rating for job offers' },
      { label: 'Max Star Rating',         key: 'star_rating_max_for_offers', hint: 'Maximum star rating for job offers' },
      { label: 'Offers Per User',         key: 'job_offers_count',           hint: 'Number of offers per user' },
      { label: 'Offer Expiry Hours',      key: 'job_offers_expiry_hours',    hint: 'Hours before offers expire (1–24)' },
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

    } else if (setting === 'team_list_filter') {
      choices = [
        { name: '👥 All Teams',           value: 'all' },
        { name: '🏈 Assigned Only',       value: 'assigned' },
        { name: '🟢 Available Only',      value: 'available' },
        { name: '🏟️ Conference View',     value: 'conference_view' },
      ].filter(c => c.name.toLowerCase().includes(query) || c.value.includes(query));

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
    if (interaction.isAutocomplete()) return await handleAutocomplete(interaction);

    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'setup':             return handleSetup(interaction);
        case 'help':              return handleHelp(interaction);
        case 'checkpermissions':  return handleCheckPermissions(interaction);
        case 'joboffers':         return handleJobOffers(interaction);
        case 'offers-config':     return handleOffersConfig(interaction);
        case 'assign-team':       return handleAssignTeam(interaction);
        case 'resetteam':         return handleResetTeam(interaction);
        case 'listteams':         return handleListTeams(interaction);
        case 'advance':           return handleAdvance(interaction);
        case 'set-phase':          return handleSetPhase(interaction);
        case 'reload-commands':    return handleReloadCommands(interaction);
        case 'rollback-advance':   return handleRollbackAdvance(interaction);
        case 'reset-league':        return handleResetLeague(interaction);
        case 'config-wizard':       return handleConfigWizard(interaction);
        case 'conference-setup':    return handleConferenceSetup(interaction);
        case 'set-conference':      return handleSetConference(interaction);
        case 'promote-relegate':    return handlePromoteRelegate(interaction);
        case 'current-week':        return handleCurrentWeek(interaction);
        case 'stream-register':     return handleStreamRegister(interaction);
        case 'stream-admin':        return handleStreamAdmin(interaction);
        case 'stream-remove':       return handleStreamRemove(interaction);
        case 'stream-live':         return handleStreamLive(interaction);
        case 'stream-list':         return handleStreamList(interaction);
        case 'stream-remove-admin': return handleStreamRemoveAdmin(interaction);
        case 'league-list':         return handleLeagueList(interaction);
        case 'add-league':          return handleAddLeague(interaction);
        case 'move-coach':        return handleMoveCoach(interaction);
        case 'config':
          switch (interaction.options.getSubcommand()) {
            case 'view':     return handleConfigView(interaction);
            case 'features': return handleConfigFeatures(interaction);
            case 'edit':     return handleConfigEdit(interaction);
            case 'reload':     return handleConfigReload(interaction);
            case 'timezones':  return handleConfigTimezones(interaction);
          }
          break;
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('accept-offer_')) return handleAcceptOffer(interaction);
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
// =====================================================
// MEMBER LEAVE — Auto-resign coach
// =====================================================
// =====================================================
// MEMBER JOIN — Auto-assign head coach role
// =====================================================
client.on(Events.GuildMemberAdd, async (member) => {
  const guildId = member.guild.id;
  try {
    const config = await getConfig(guildId);
    if (!config?.setup_complete)          return;
    if (!config?.feature_auto_role)       return;
    if (!config?.role_head_coach_id)      return;

    const role = member.guild.roles.cache.get(config.role_head_coach_id);
    if (!role) return;

    await member.roles.add(role);
    console.log(`[auto-role] Assigned "${role.name}" to ${member.user?.username || member.id} in ${member.guild.name}`);
  } catch (err) {
    console.error(`[auto-role] Failed to assign role in ${guildId}:`, err.message);
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  const guildId = member.guild?.id;
  if (!guildId) return;

  // Fetch full member data if partial
  const userId = member.id || member.user?.id;
  if (!userId) return;

  const config = await getConfig(guildId).catch(() => null);
  if (!config?.setup_complete) return;

  // Check if this user had a team assigned
  const team = await getTeamByUser(userId, guildId).catch(() => null);
  if (!team) {
    console.log(`[leave] ${member.user?.username || userId} left ${member.guild?.name} — no team assigned`);
    return;
  }

  // Unassign the team — pass league_id if available (multi-league aware)
  await unassignTeam(team.id, guildId, team.league_id || null).catch(() => {});

  // Remove stream registration

  // Post resignation announcement
  const signedChannel = findTextChannel(member.guild, config.channel_signed_coaches);
  const newsChannel   = findTextChannel(member.guild, config.channel_news_feed);
  const target        = signedChannel || newsChannel;

  if (target) {
    const embed = new EmbedBuilder()
      .setTitle('📋 Coach Resigned')
      .setColor(0xff4444)
      .setDescription(`**${member.user?.username || userId}** has left the server and resigned as head coach of **${team.team_name}**.`)
      .addFields(
        { name: 'Team',   value: team.team_name,                    inline: true },
        { name: 'Status', value: '🟢 Now Available',                inline: true },
      )
      .setTimestamp()
      .setFooter({ text: 'The position is now open for new applicants.' });

    await target.send({ embeds: [embed] }).catch(() => {});
  }

  // Refresh team list
  await postTeamList(member.guild, guildId, config).catch(() => {});

  console.log(`[leave] ${member.user?.username || userId} left ${member.guild?.name} — unassigned from ${team.team_name}`);
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

    const setupMsg =
      `👋 **Thanks for adding Dynasty Bot to ${guild.name}!**\n\n` +
      `To get started, run \`/setup\` in your server and I'll walk you through the configuration via DM.\n\n` +
      `⚙️ Setup covers:\n` +
      `• League name & abbreviation\n` +
      `• Feature group selection\n` +
      `• Channel assignments\n` +
      `• Role assignments\n` +
      `• Feature-specific settings\n\n` +
      `Until setup is complete, commands will not be available to members.\n\n` +
      `⚠️ **Important:** Make sure the bot was invited using the correct link to ensure it has the right permissions:\nhttp://bit.ly/46t7pjs`;

    // Try DM first
    let dmSent = false;
    try {
      const owner = await guild.fetchOwner();
      await owner.send(setupMsg);
      dmSent = true;
      console.log(`[guild] Setup DM sent to owner of ${guild.name}`);
    } catch {
      console.warn(`[guild] Could not DM owner of ${guild.name} — falling back to channel`);
    }

    // Fall back to system channel, then first available text channel
    if (!dmSent) {
      const fallback =
        guild.systemChannel ||
        guild.channels.cache
          .filter(c => c.type === ChannelType.GuildText && c.permissionsFor(guild.members.me)?.has('SendMessages'))
          .sort((a, b) => a.position - b.position)
          .first();

      if (fallback) {
        const owner = await guild.fetchOwner().catch(() => null);
        const mention = owner ? `<@${owner.id}> ` : '';
        await fallback.send(mention + setupMsg).catch(err => {
          console.warn(`[guild] Could not post setup message in ${guild.name}:`, err.message);
        });
      }
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

  // ── Supabase keep-alive ping ───────────────────────────────────────────
  // Runs once at startup then every 24 hours to prevent Supabase pausing due to inactivity
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

  // ── Shard watchdog ────────────────────────────────────────────────────
  // If the WebSocket ping goes stale (shard zombie), force-exit so Render restarts cleanly.
  setInterval(() => {
    const ping = client.ws.ping;
    if (ping === -1) {
      console.error('[watchdog] WebSocket ping is -1 — shard appears dead. Forcing restart...');
      process.exit(1);
    }
  }, 60 * 1000); // check every 60 seconds
});

// =====================================================
// LOGIN
// =====================================================
// Quick connectivity check before attempting login
fetch('https://discord.com/api/v10/gateway').then(r => {
  console.log(`[bot] Discord gateway reachable — HTTP ${r.status}`);
}).catch(err => {
  console.error('[bot] Cannot reach Discord gateway:', err.message);
});
console.log('[bot] Attempting Discord login...');
const loginTimeout = setTimeout(() => {
  console.error('[bot] Login timed out after 30s — DISCORD_TOKEN may be invalid or Discord gateway unreachable. Exiting...');
  process.exit(1);
}, 30000);

client.login(DISCORD_TOKEN).then(() => {
  clearTimeout(loginTimeout);
  console.log('[bot] Login successful — awaiting ready event...');
}).catch(err => {
  clearTimeout(loginTimeout);
  console.error('[bot] Login failed:', err.message);
  process.exit(1);
});
