require('dotenv').config();
const fs = require('fs');
const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
  ],
});

/* ===================================================
   DATABASE & CONFIGURATION
=================================================== */
const DB_FILE = './db.json';
let db = { warns: {}, levels: {}, afk: {} };

if (fs.existsSync(DB_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE));
  } catch (e) {
    console.error("DB Error: Starting fresh.");
  }
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID;
const GOODBYE_CHANNEL_ID = process.env.GOODBYE_CHANNEL_ID;
const LEVEL_CHANNEL_ID = '1471140563951550575';
const LOG_CHANNEL_ID = '1471145714074517716';
const ADMIN_ROLE_KEYWORDS = ['admin', 'mod', 'head mod', 'head admin', 'trial mod'];

const TICKET_CATEGORIES = [
  { label: 'Giveaway Claim', value: 'giveaway', emoji: '🎁', categoryId: '1471149589624262819' },
  { label: 'Rewards Claim', value: 'rewards', emoji: '💰', categoryId: '1471148112092332104' },
  { label: 'Buying an Item', value: 'buying', emoji: '🛒', categoryId: '1471149666409250849' },
  { label: 'Hosting a Giveaway', value: 'hosting', emoji: '🎉', categoryId: '1471149637103517924' },
  { label: 'Support', value: 'support', emoji: '🛠️', categoryId: '1471148191658541186' },
  { label: 'Report', value: 'report', emoji: '🚩', categoryId: '1471149536197218407' },
];

/* ===================================================
   HELPERS & LOGS
=================================================== */
function isStaff(member) {
  if (!member) return false;
  const hasAdminPerm = member.permissions.has(PermissionFlagsBits.Administrator);
  const hasStaffRole = member.roles.cache.some(r => 
    ADMIN_ROLE_KEYWORDS.some(k => r.name.toLowerCase().includes(k))
  );
  return hasAdminPerm || hasStaffRole;
}

// Leveling formula: base * (level ^ 1.7) for harder scaling toward level 50
function getRequiredXP(level) {
  return Math.floor(300 * Math.pow(level, 1.7));
}

async function sendLog(title, description, color = 'Blue', user = null) {
  const channel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
  if (!channel) return;
  const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setTimestamp();
  if (user) embed.setFooter({ text: `Target: ${user.tag}`, iconURL: user.displayAvatarURL() });
  channel.send({ embeds: [embed] });
}

function parseDuration(str) {
  const match = str.match(/^(\d+)([smhd])$/);
  if (!match) return null;
  const multi = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return parseInt(match[1]) * multi[match[2]];
}

function getHelpEmbed() {
  return new EmbedBuilder()
    .setTitle('🛡️ Advanced Staff Command Menu')
    .setDescription('Full command suite for Administrators and authorized Staff roles.')
    .setColor('Gold')
    .addFields(
      { name: '🛠️ Setup', value: '`/setup` or `#setup` - Send the Ticket Panel Embed.\n`/help` or `#help` - View this menu.' },
      { name: '🔨 Moderation', value: '`/warn`, `/unwarn` - Warning system (Saved in DB)\n`/mute`, `/unmute` - Timouts (up to 28 days)\n`/kick`, `/ban` - Server removal commands' },
      { name: '🎫 Tickets', value: '`#ticket rename` - Only works in ticket channels.\n`#ticket close` - Remove member access.\n`#ticket delete` - 5s deletion countdown.' },
      { name: '⭐ Systems', value: '`Leveling` - Global XP with scaling difficulty (Harder XP per level).\n`AFK` - Use `#afk [reason]` to set status.\n`Logs` - Every edit/delete/mod action is logged.' }
    );
}

/* ===================================================
   READY / SLASH COMMANDS
=================================================== */
client.once(Events.ClientReady, async () => {
  console.log(`Bot Online: ${client.user.tag}`);
  await client.application.commands.set([
    { name: 'setup', description: 'Deploy the ticket panel' },
    { name: 'help', description: 'Show staff command help' },
    { name: 'warn', description: 'Warn a user', options: [{ name: 'user', type: 6, required: true, description: 'User' }, { name: 'reason', type: 3, description: 'Reason' }] },
    { name: 'unwarn', description: 'Remove last warning', options: [{ name: 'user', type: 6, required: true, description: 'User' }] },
    { name: 'kick', description: 'Kick a member', options: [{ name: 'user', type: 6, required: true, description: 'User' }, { name: 'reason', type: 3, description: 'Reason' }] },
    { name: 'ban', description: 'Ban a member', options: [{ name: 'user', type: 6, required: true, description: 'User' }, { name: 'reason', type: 3, description: 'Reason' }] },
    { name: 'mute', description: 'Timeout user', options: [{ name: 'user', type: 6, required: true, description: 'User' }, { name: 'duration', type: 3, required: true, description: '10m, 1h, 1d' }, { name: 'reason', type: 3, description: 'Reason' }] },
    { name: 'unmute', description: 'Remove timeout', options: [{ name: 'user', type: 6, required: true, description: 'User' }] },
  ]);
});

/* ===================================================
   SYSTEM EVENTS (LOGS / CHATting)
=================================================== */
client.on(Events.MessageDelete, async msg => {
  if (!msg.guild || msg.author?.bot) return;
  sendLog('🗑️ Message Deleted', `**User:** ${msg.author.tag}\n**Channel:** ${msg.channel}\n**Content:** ${msg.content || 'No text'}`, 'Red');
});

client.on(Events.MessageUpdate, async (oldM, newM) => {
  if (!newM.guild || newM.author?.bot || oldM.content === newM.content) return;
  sendLog('📝 Message Edited', `**User:** ${newM.author.tag}\n**Channel:** ${newM.channel}\n**Old:** ${oldM.content}\n**New:** ${newM.content}`, 'Orange');
});

/* ===================================================
   INTERACTION HANDLING
=================================================== */
client.on(Events.InteractionCreate, async i => {
  try {
    if (i.isChatInputCommand()) {
      if (!isStaff(i.member)) return i.reply({ content: '❌ Staff Only!', ephemeral: true });
      await i.deferReply({ ephemeral: true });

      const user = i.options.getUser('user');
      const reason = i.options.getString('reason') || 'No reason';
      const member = user ? await i.guild.members.fetch(user.id).catch(() => null) : null;

      if (i.commandName === 'help') return i.editReply({ embeds: [getHelpEmbed()] });

      if (i.commandName === 'setup') {
        const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('ticket_menu').setPlaceholder('Select Category').addOptions(TICKET_CATEGORIES.map(c => ({ label: c.label, value: c.value, emoji: c.emoji }))));
        const embed = new EmbedBuilder().setTitle('🎫 Create a Ticket').setDescription('Select a category below to open a ticket.').setColor('Blue');
        return i.editReply({ embeds: [embed], components: [row] });
      }

      if (i.commandName === 'warn') {
        db.warns[user.id] = (db.warns[user.id] || 0) + 1;
        saveDB();
        sendLog('⚠️ User Warned', `**Target:** ${user.tag}\n**Staff:** ${i.user.tag}\n**Reason:** ${reason}\n**Total Warns:** ${db.warns[user.id]}`, 'Yellow', user);
        return i.editReply(`⚠️ Warned ${user.tag}. (Total: ${db.warns[user.id]})`);
      }

      if (i.commandName === 'unwarn') {
        if (!db.warns[user.id]) return i.editReply('❌ No warns found.');
        db.warns[user.id]--;
        saveDB();
        sendLog('✅ Warning Removed', `**Target:** ${user.tag}\n**Staff:** ${i.user.tag}`, 'Green', user);
        return i.editReply(`✅ Removed 1 warn from ${user.tag}.`);
      }

      if (i.commandName === 'kick') {
        if (!member?.kickable) return i.editReply('❌ Cannot kick.');
        await member.kick(reason);
        sendLog('👢 Member Kicked', `**Target:** ${user.tag}\n**Staff:** ${i.user.tag}\n**Reason:** ${reason}`, 'Orange', user);
        return i.editReply(`👢 Kicked ${user.tag}.`);
      }

      if (i.commandName === 'ban') {
        if (member && !member.bannable) return i.editReply('❌ Cannot ban.');
        await i.guild.members.ban(user.id, { reason });
        sendLog('🔨 Member Banned', `**Target:** ${user.tag}\n**Staff:** ${i.user.tag}\n**Reason:** ${reason}`, 'DarkRed', user);
        return i.editReply(`🔨 Banned ${user.tag}.`);
      }

      if (i.commandName === 'mute') {
        const ms = parseDuration(i.options.getString('duration'));
        if (!ms || !member) return i.editReply('❌ Invalid duration.');
        await member.timeout(ms, reason);
        sendLog('🔇 Member Muted', `**Target:** ${user.tag}\n**Staff:** ${i.user.tag}\n**Duration:** ${i.options.getString('duration')}`, 'Grey', user);
        return i.editReply(`🔇 Muted ${user.tag}.`);
      }

      if (i.commandName === 'unmute') {
        if (member) await member.timeout(null);
        return i.editReply(`🔊 Unmuted ${user.tag}.`);
      }
    }

    if (i.isStringSelectMenu() && i.customId === 'ticket_menu') {
      await i.deferReply({ ephemeral: true });
      const cat = TICKET_CATEGORIES.find(c => c.value === i.values[0]);
      const ch = await i.guild.channels.create({
        name: `ticket-${i.user.username}`, parent: cat.categoryId,
        permissionOverwrites: [{ id: i.guild.id, deny: [PermissionFlagsBits.ViewChannel] }, { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }]
      });
      await ch.send(`Hello <@${i.user.id}>, welcome to your **${cat.label}** ticket.`);
      return i.editReply(`✅ Ticket: ${ch}`);
    }
  } catch (err) { console.error(err); }
});

/* ===================================================
   TEXT COMMANDS, LEVELS & AFK
=================================================== */
client.on(Events.MessageCreate, async m => {
  if (m.author.bot || !m.guild) return;

  // AFK Logic
  if (db.afk[m.author.id]) {
    delete db.afk[m.author.id]; saveDB();
    m.member.setNickname(m.member.displayName.replace('[AFK] ', '')).catch(() => {});
    m.reply('👋 Welcome back! Removed AFK status.').then(x => setTimeout(() => x.delete(), 3000));
  }
  m.mentions.users.forEach(u => { if (db.afk[u.id]) m.reply(`💤 **${u.username}** is AFK: ${db.afk[u.id]}`); });

  // Leveling System with Scaling
  const uid = m.author.id;
  if (!db.levels[uid]) db.levels[uid] = { xp: 0, lvl: 1 };
  db.levels[uid].xp += Math.floor(Math.random() * 10) + 10;

  if (db.levels[uid].xp >= getRequiredXP(db.levels[uid].lvl)) {
    db.levels[uid].lvl++;
    const lvCh = await client.channels.fetch(LEVEL_CHANNEL_ID).catch(() => null);
    if (lvCh) lvCh.send(`⬆️ **${m.author.username}** leveled up! You are now **Level ${db.levels[uid].lvl}**!\n*XP needed for next level: ${getRequiredXP(db.levels[uid].lvl)}*`);
  }
  saveDB();

  // AFK Command
  if (m.content.startsWith('#afk')) {
    const reason = m.content.split(' ').slice(1).join(' ') || 'Away';
    db.afk[m.author.id] = reason;
    m.member.setNickname(`[AFK] ${m.member.displayName}`).catch(() => {});
    saveDB();
    return m.reply(`💤 You are now AFK: ${reason}`);
  }

  // Staff Only Text Commands
  if (isStaff(m.member)) {
    if (m.content.toLowerCase() === '#help') return m.channel.send({ embeds: [getHelpEmbed()] });

    if (m.content.toLowerCase() === '#setup') {
      const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('ticket_menu').setPlaceholder('Select Category').addOptions(TICKET_CATEGORIES.map(c => ({ label: c.label, value: c.value, emoji: c.emoji }))));
      const embed = new EmbedBuilder().setTitle('🎫 Create a Ticket').setDescription('Select a category below.').setColor('Blue');
      return m.channel.send({ embeds: [embed], components: [row] });
    }

    if (m.content.startsWith('#ticket')) {
      const args = m.content.split(' ');
      const sub = args[1];

      // Restrict rename to ONLY ticket categories
      const isTicket = TICKET_CATEGORIES.some(c => c.categoryId === m.channel.parentId);

      if (sub === 'rename') {
        if (!isTicket) return m.reply("❌ This command only works inside ticket channels.");
        const name = args.slice(2).join('-');
        if (name) await m.channel.setName(name);
        return m.reply(`✅ Renamed to \`${name}\``);
      }
      if (sub === 'close') {
        m.channel.permissionOverwrites.cache.filter(o => o.type === 1).forEach(o => m.channel.permissionOverwrites.edit(o.id, { ViewChannel: false }));
        return m.reply('🔒 Ticket Locked.');
      }
      if (sub === 'delete') {
        let s = 5; const msg = await m.reply(`🗑️ Deleting in **${s}**...`);
        const i = setInterval(async () => {
          if (--s <= 0) { clearInterval(i); await m.channel.delete(); }
          else msg.edit(`🗑️ Deleting in **${s}**...`).catch(() => {});
        }, 1000);
      }
    }
  }
});

/* ===================================================
   WELCOME / GOODBYE
=================================================== */
client.on(Events.GuildMemberAdd, async member => {
  const ch = await client.channels.fetch(WELCOME_CHANNEL_ID).catch(() => null);
  if (!ch) return;
  const embed = new EmbedBuilder().setTitle('👋 Welcome!').setDescription(`Welcome <@${member.id}> to **${member.guild.name}**!`).setColor('#00FF00').setThumbnail(member.user.displayAvatarURL());
  ch.send({ embeds: [embed] });
});

client.on(Events.GuildMemberRemove, async member => {
  const ch = await client.channels.fetch(GOODBYE_CHANNEL_ID).catch(() => null);
  if (!ch) return;
  const embed = new EmbedBuilder().setTitle('😢 Goodbye!').setDescription(`**${member.user.tag}** has left the server.`).setColor('#FF0000').setThumbnail(member.user.displayAvatarURL());
  ch.send({ embeds: [embed] });
});

client.login(process.env.DISCORD_TOKEN);