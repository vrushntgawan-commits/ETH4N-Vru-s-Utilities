const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags
} = require('discord.js');
const fetch = require('node-fetch');
require('dotenv').config();

// ══════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════
const STOCK_CHANNEL_ID = '1481026325178220565';
const VOUCH_CHANNEL_ID = '1481321672970735807';
const ALERT_CHANNEL_ID = '1480833457604268154';
const GUILD_ID         = process.env.GUILD_ID;
const JSONBIN_KEY      = process.env.JSONBIN_KEY;
const PREFIX           = 'u!';

// Custom emoji — only works in description/field values, NOT field names
const COIN_EMOJI = '<:CoinEmoji:1481246827448766526>';

// ══════════════════════════════════════════
//  CODES  (hardcoded, one-time per user)
// ══════════════════════════════════════════
const CODES = {
  'RELEASE': { coins: 25, description: '🎉 Launch reward' },
};

// ══════════════════════════════════════════
//  PENDING VOUCHES
//  Map<userId, { claimId, itemName, fulfilledBy, timeout }>
// ══════════════════════════════════════════
const pendingVouches = new Map();

// ══════════════════════════════════════════
//  SHOP
// ══════════════════════════════════════════
const SHOP = [
  { id: 'robux_25',   name: '25 Robux',   cost: 100,  category: 'Robux', robuxAmt: 25  },
  { id: 'robux_50',   name: '50 Robux',   cost: 200,  category: 'Robux', robuxAmt: 50  },
  { id: 'robux_75',   name: '75 Robux',   cost: 300,  category: 'Robux', robuxAmt: 75  },
  { id: 'robux_100',  name: '100 Robux',  cost: 400,  category: 'Robux', robuxAmt: 100 },
  { id: 'robux_125',  name: '125 Robux',  cost: 500,  category: 'Robux', robuxAmt: 125 },
  { id: 'robux_150',  name: '150 Robux',  cost: 600,  category: 'Robux', robuxAmt: 150 },
  { id: 'robux_175',  name: '175 Robux',  cost: 700,  category: 'Robux', robuxAmt: 175 },
  { id: 'robux_200',  name: '200 Robux',  cost: 800,  category: 'Robux', robuxAmt: 200 },
  { id: 'robux_225',  name: '225 Robux',  cost: 900,  category: 'Robux', robuxAmt: 225 },
  { id: 'robux_250',  name: '250 Robux',  cost: 1000, category: 'Robux', robuxAmt: 250 },
  { id: 'etfb_cel',   name: 'Celestial',  cost: 100,  category: 'ETFB',  robuxAmt: 0   },
  { id: 'etfb_div',   name: 'Divine',     cost: 250,  category: 'ETFB',  robuxAmt: 0   },
];

// ══════════════════════════════════════════
//  JSONBIN
// ══════════════════════════════════════════
const BIN_IDS = {
  users:  '69b13ea5c3097a1dd516fe70',
  store:  '69b13e7dc3097a1dd516fdc5',
  meta:   '69b13e8fb7ec241ddc5c5aa3',
  claims: '69b13ebbb7ec241ddc5c5b4b',
};
const DEFAULTS = {
  users:  {},
  store:  { robux: 0, divines: 0, celestials: 0 },
  meta:   { stockMsgId: null, claimCounter: 0 },
  claims: [],
};

const cache     = { users: null, store: null, meta: null, claims: null };
const cacheTime = { users: 0,    store: 0,    meta: 0,    claims: 0    };
const CACHE_TTL = { users: Infinity, store: 30_000, meta: 30_000, claims: 30_000 };

async function binRead(name) {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${BIN_IDS[name]}/latest`, {
    headers: { 'X-Master-Key': JSONBIN_KEY, 'X-Bin-Versioning': 'false' },
  });
  if (!res.ok) throw new Error(`READ ${name} -> ${res.status}: ${await res.text()}`);
  const j = await res.json();
  const d = j.record;
  if (!d || d.a === 'b') return JSON.parse(JSON.stringify(DEFAULTS[name]));
  if (d._empty) return d._data;
  return d;
}
async function binWrite(name, data) {
  let payload = data;
  if (Array.isArray(data) && data.length === 0)
    payload = { _empty: true, _data: [] };
  else if (typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0)
    payload = { _empty: true, _data: {} };
  const res = await fetch(`https://api.jsonbin.io/v3/b/${BIN_IDS[name]}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY, 'X-Bin-Versioning': 'false' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`WRITE ${name} -> ${res.status}: ${await res.text()}`);
}
async function dbRead(name) {
  const now = Date.now();
  if (cache[name] !== null && now - cacheTime[name] < CACHE_TTL[name]) return cache[name];
  cache[name] = await binRead(name);
  cacheTime[name] = now;
  return cache[name];
}
async function dbWrite(name, data) {
  cache[name] = data;
  cacheTime[name] = Date.now();
  await binWrite(name, data);
}

// ══════════════════════════════════════════
//  DB HELPERS
// ══════════════════════════════════════════
async function getUser(userId, username) {
  const users = await dbRead('users');
  if (!users[userId]) {
    users[userId] = { id: userId, username: username || 'Unknown', coins: 0, totalEarned: 0, lastDaily: null, lastWork: null, inventory: [], redeemedCodes: [] };
    await dbWrite('users', users);
  }
  if (!users[userId].redeemedCodes) users[userId].redeemedCodes = [];
  if (!users[userId].inventory)     users[userId].inventory     = [];
  return users[userId];
}
async function saveUser(u) {
  const users = await dbRead('users');
  users[u.id] = u;
  await dbWrite('users', users);
}
async function getLeaderboard(n) {
  const users = await dbRead('users');
  return Object.values(users).sort((a, b) => b.coins - a.coins).slice(0, n);
}
async function getStore()    { return dbRead('store'); }
async function saveStore(s)  { await dbWrite('store', s); }
async function getMeta()     { return dbRead('meta'); }
async function saveMeta(m)   { await dbWrite('meta', m); }
async function getClaims()   { return dbRead('claims'); }
async function saveClaims(c) { await dbWrite('claims', c); }
async function nextClaimId() {
  const meta = await getMeta();
  meta.claimCounter = (meta.claimCounter || 0) + 1;
  await saveMeta(meta);
  return `C${meta.claimCounter}`;
}

// ══════════════════════════════════════════
//  UTIL
// ══════════════════════════════════════════
function fmt(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

// Discord dynamic timestamp — renders in each user's own local timezone
// style: R=relative, t=short time, T=long time, d=short date, f=full
function ts(unixMs, style = 'R') {
  return `<t:${Math.floor(unixMs / 1000)}:${style}>`;
}

function errEmbed(text) { return new EmbedBuilder().setColor(0xED4245).setDescription(`❌ ${text}`); }
function okEmbed(text)  { return new EmbedBuilder().setColor(0x57F287).setDescription(`✅ ${text}`); }

function stockEmbed(store) {
  return new EmbedBuilder()
    .setTitle('🏪 Current Stock')
    .setColor(0x5865F2)
    .setDescription('Use `/shop` to see prices and `/redeem` or `u!redeem` to purchase!')
    .addFields(
      { name: '💎 Robux',      value: store.robux      > 0 ? `**${store.robux}** available`       : '❌ Out of stock', inline: true },
      { name: '✨ Celestials', value: store.celestials > 0 ? `**${store.celestials}x** available`  : '❌ Out of stock', inline: true },
      { name: '🌟 Divines',   value: store.divines    > 0 ? `**${store.divines}x** available`     : '❌ Out of stock', inline: true }
    )
    .setFooter({ text: 'Stock updated by admins' });
}

async function updateStockEmbed(clientRef) {
  try {
    const ch    = await clientRef.channels.fetch(STOCK_CHANNEL_ID);
    if (!ch) return;
    const store = await getStore();
    const embed = stockEmbed(store);
    const meta  = await getMeta();
    if (meta.stockMsgId) {
      try { const m = await ch.messages.fetch(meta.stockMsgId); await m.edit({ embeds: [embed] }); return; }
      catch { /* deleted, resend below */ }
    }
    const sent = await ch.send({ embeds: [embed] });
    meta.stockMsgId = sent.id;
    await saveMeta(meta);
  } catch (e) { console.error('Stock embed error:', e.message); }
}

// ══════════════════════════════════════════
//  SLASH COMMANDS
// ══════════════════════════════════════════
const slashDefs = [
  new SlashCommandBuilder().setName('balance').setDescription('Check your coin balance')
    .addUserOption(o => o.setName('user').setDescription('Check someone else').setRequired(false)),
  new SlashCommandBuilder().setName('daily').setDescription('Claim coins (24h cooldown)'),
  new SlashCommandBuilder().setName('rain').setDescription('[ADMIN] Rain coins — react to enter, 2 min timer')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addIntegerOption(o => o.setName('amount').setDescription('Total coins to rain').setRequired(true).setMinValue(10)),
  new SlashCommandBuilder().setName('shop').setDescription('View all items and prices'),
  new SlashCommandBuilder().setName('redeem').setDescription('Buy an item from the shop')
    .addStringOption(o => o.setName('item').setDescription('Item to buy').setRequired(true).addChoices(
      { name: '25 Robux — 100 coins',    value: 'robux_25'   },
      { name: '50 Robux — 200 coins',    value: 'robux_50'   },
      { name: '75 Robux — 300 coins',    value: 'robux_75'   },
      { name: '100 Robux — 400 coins',   value: 'robux_100'  },
      { name: '125 Robux — 500 coins',   value: 'robux_125'  },
      { name: '150 Robux — 600 coins',   value: 'robux_150'  },
      { name: '175 Robux — 700 coins',   value: 'robux_175'  },
      { name: '200 Robux — 800 coins',   value: 'robux_200'  },
      { name: '225 Robux — 900 coins',   value: 'robux_225'  },
      { name: '250 Robux — 1000 coins',  value: 'robux_250'  },
      { name: 'Celestial ETFB — 100 coins', value: 'etfb_cel' },
      { name: 'Divine ETFB — 250 coins',    value: 'etfb_div' }
    )),
  new SlashCommandBuilder().setName('inventory').setDescription('View your unclaimed items'),
  new SlashCommandBuilder().setName('claim').setDescription('Submit a delivery claim for an item')
    .addStringOption(o => o.setName('id').setDescription('Claim ID, e.g. C1').setRequired(true)),
  new SlashCommandBuilder().setName('use-code').setDescription('Redeem a code for coins')
    .addStringOption(o => o.setName('code').setDescription('The code to redeem').setRequired(true)),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Top 10 richest members'),
  new SlashCommandBuilder().setName('help').setDescription('View all commands'),
  new SlashCommandBuilder().setName('adminhelp').setDescription('View admin commands')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('claims').setDescription('[ADMIN] View all pending claims')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('claimed').setDescription('[ADMIN] Mark a claim as fulfilled')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('id').setDescription('Claim ID, e.g. C1').setRequired(true)),
  new SlashCommandBuilder().setName('deny-claim').setDescription('[ADMIN] Deny a claim and refund item to user inventory')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('id').setDescription('Claim ID, e.g. C1').setRequired(true)),
  new SlashCommandBuilder().setName('update-robux').setDescription('[ADMIN] Update Robux stock')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addIntegerOption(o => o.setName('amount').setDescription('New amount').setRequired(true).setMinValue(0)),
  new SlashCommandBuilder().setName('update-etfb').setDescription('[ADMIN] Update ETFB stock')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('type').setDescription('Which item').setRequired(true)
      .addChoices({ name: 'Divines', value: 'divines' }, { name: 'Celestials', value: 'celestials' }))
    .addIntegerOption(o => o.setName('amount').setDescription('New amount').setRequired(true).setMinValue(0)),
  new SlashCommandBuilder().setName('give').setDescription('[ADMIN] Give coins to a user')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName('user').setDescription('Target').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('take').setDescription('[ADMIN] Take coins from a user')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName('user').setDescription('Target').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('remove-inv').setDescription('[ADMIN] Remove an item from a user inventory by claim ID')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
    .addStringOption(o => o.setName('claim_id').setDescription('Claim ID to remove, e.g. C1').setRequired(true)),
  new SlashCommandBuilder().setName('check-inventory').setDescription('[ADMIN] View any user inventory')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true)),
].map(c => c.toJSON());

// ══════════════════════════════════════════
//  CLIENT
// ══════════════════════════════════════════
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

// ══════════════════════════════════════════
//  SPAM DETECTION
//  15+ consecutive messages in a channel without anyone else talking = -100 coins
// ══════════════════════════════════════════
const channelLastMsg = new Map(); // Map<channelId, { lastUserId, count }>
const spamCooldown   = new Set(); // prevents double-penalising within 60s

async function handleSpamCheck(msg) {
  const { id: uid, username } = msg.author;
  const cid = msg.channel.id;

  const state = channelLastMsg.get(cid) || { lastUserId: null, count: 0 };

  if (state.lastUserId === uid) {
    state.count += 1;
  } else {
    // A different real human spoke — reset this channel's streak
    state.lastUserId = uid;
    state.count = 1;
  }
  channelLastMsg.set(cid, state);

  // Penalise at exactly 15 consecutive messages
  if (state.count === 15 && !spamCooldown.has(uid)) {
    spamCooldown.add(uid);
    setTimeout(() => spamCooldown.delete(uid), 60_000);

    // Deduct 100 coins
    if (cache.users && cache.users[uid]) {
      cache.users[uid].coins = Math.max(0, (cache.users[uid].coins || 0) - 100);
      scheduleCoinFlush();
    } else {
      try {
        const u = await getUser(uid, username);
        u.coins = Math.max(0, u.coins - 100);
        await saveUser(u);
      } catch (e) { console.error('Spam deduct error:', e.message); }
    }

    // DM the user
    try {
      await msg.author.send({ embeds: [new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('⚠️ Spam Warning!')
        .setDescription(
          `You have been caught spamming in <#${cid}>.

` +
          `**100** <:CoinEmoji:1481246827448766526> have been deducted from your balance.

` +
          `Please stop spamming — if you continue you will be penalised again!`
        )] });
    } catch { /* DMs closed */ }

    // Warn in channel, auto-delete after 8s
    try {
      const warn = await msg.channel.send({ embeds: [new EmbedBuilder()
        .setColor(0xED4245)
        .setDescription(`⚠️ <@${uid}> stop spamming! **100** <:CoinEmoji:1481246827448766526> have been deducted from your balance.`)] });
      setTimeout(() => warn.delete().catch(() => {}), 8000);
    } catch { /* no perms */ }
  }
}

// Batched coin flush — avoids a JSONBin write on every single message
let coinWriteTimer = null;
function scheduleCoinFlush() {
  if (coinWriteTimer) return;
  coinWriteTimer = setTimeout(async () => {
    coinWriteTimer = null;
    if (!cache.users) return;
    try { await binWrite('users', cache.users); cacheTime.users = Date.now(); }
    catch (e) { console.error('Coin flush error:', e.message); }
  }, 3000);
}

client.once('clientReady', async () => {
  console.log(`Bot online: ${client.user.tag}`);
  if (!GUILD_ID)    { console.error('GUILD_ID missing'); process.exit(1); }
  if (!JSONBIN_KEY) { console.error('JSONBIN_KEY missing'); process.exit(1); }

  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
    for (const g of client.guilds.cache.values()) {
      try { await rest.put(Routes.applicationGuildCommands(client.user.id, g.id), { body: [] }); }
      catch (e) { console.error(`Clear guild cmds ${g.id}:`, e.message); }
    }
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: slashDefs });
    console.log('Slash commands registered');
  } catch (e) { console.error('Command reg error:', e); }

  try { await dbRead('users'); console.log('Users cache warmed'); } catch (e) { console.error('Warmup error:', e.message); }
  await updateStockEmbed(client);
  console.log('Ready');
});

// ══════════════════════════════════════════
//  MESSAGE — 1 message = 1 coin, always
// ══════════════════════════════════════════
client.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.guild) return;

  // ── Vouch channel listener ──
  if (msg.channel.id === VOUCH_CHANNEL_ID && pendingVouches.has(msg.author.id)) {
    // Valid vouch format: "Vouch @user <reason>" (case-insensitive, mentions or plain @name)
    const vouchMatch = msg.content.match(/^vouch\s+@\S+\s+.+/i);
    if (vouchMatch) {
      const data = pendingVouches.get(msg.author.id);
      clearTimeout(data.timeout);
      pendingVouches.delete(msg.author.id);
      // React to confirm
      try { await msg.react('✅'); } catch {}
    }
  }

  // Spam check — runs on every real human message
  await handleSpamCheck(msg);

  const uid = msg.author.id;
  if (!cache.users) {
    try { await dbRead('users'); } catch (e) { console.error('Cache load error:', e.message); }
  }

  if (cache.users) {
    if (!cache.users[uid]) {
      cache.users[uid] = { id: uid, username: msg.author.username, coins: 0, totalEarned: 0, lastDaily: null, lastWork: null, inventory: [], redeemedCodes: [] };
    }
    cache.users[uid].coins       = (cache.users[uid].coins       || 0) + 1;
    cache.users[uid].totalEarned = (cache.users[uid].totalEarned || 0) + 1;
    cache.users[uid].username    = msg.author.username;
    scheduleCoinFlush();
  } else {
    getUser(uid, msg.author.username).then(u => {
      u.coins++; u.totalEarned = (u.totalEarned || 0) + 1;
      saveUser(u).catch(e => console.error('Coin save error:', e.message));
    }).catch(e => console.error('Coin user error:', e.message));
  }

  // ── Prefix commands ──
  if (!msg.content.startsWith(PREFIX)) return;
  const args    = msg.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd     = args.shift().toLowerCase();
  const reply   = p => msg.reply(p);
  const isAdmin = msg.member?.permissions.has(PermissionFlagsBits.Administrator);

  try {
    if (cmd === 'balance' || cmd === 'bal')       return await cmdBalance(reply, msg.mentions.users.first() || msg.author);
    if (cmd === 'daily')                          return await cmdDaily(reply, uid, msg.author.username);
    if (cmd === 'shop')                           return await cmdShop(reply);
    if (cmd === 'inventory')                      return await cmdInventory(reply, uid, msg.author.username);
    if (cmd === 'lb' || cmd === 'leaderboard')    return await cmdLeaderboard(reply, msg.guild);
    if (cmd === 'help')                           return await cmdHelp(reply);
    if (cmd === 'adminhelp' && isAdmin)           return await cmdAdminHelp(reply);
    if (cmd === 'rain') {
      if (!isAdmin) return reply({ embeds: [errEmbed('Only admins can use rain!')] });
      const amt = parseInt(args[0]);
      if (isNaN(amt) || amt < 10) return reply({ embeds: [errEmbed(`Usage: \`${PREFIX}rain <amount>\` (min 10)`)] });
      return await cmdRain(msg, msg.guild, uid, msg.author.username, amt);
    }
    if (cmd === 'redeem') {
      if (!args[0]) return reply({ embeds: [errEmbed(`Usage: \`${PREFIX}redeem <itemId>\` — see \`${PREFIX}shop\``)] });
      return await cmdRedeem(reply, uid, msg.author.username, args[0].toLowerCase());
    }
    if (cmd === 'use-code') {
      if (!args[0]) return reply({ embeds: [errEmbed(`Usage: \`${PREFIX}use-code <code>\``)] });
      return await cmdUseCode(reply, uid, msg.author.username, args[0]);
    }
    if (cmd === 'give' && isAdmin) {
      const t = msg.mentions.users.first(), amt = parseInt(args[1]);
      if (!t || isNaN(amt) || amt < 1) return reply({ embeds: [errEmbed(`Usage: \`${PREFIX}give @user <amount>\``)] });
      const u = await getUser(t.id, t.username);
      u.coins += amt; u.totalEarned = (u.totalEarned || 0) + amt;
      await saveUser(u);
      return reply({ embeds: [okEmbed(`Gave **${amt}** ${COIN_EMOJI} to <@${t.id}>. Balance: **${u.coins.toLocaleString()}** ${COIN_EMOJI}`)] });
    }
    if (cmd === 'take' && isAdmin) {
      const t = msg.mentions.users.first(), amt = parseInt(args[1]);
      if (!t || isNaN(amt) || amt < 1) return reply({ embeds: [errEmbed(`Usage: \`${PREFIX}take @user <amount>\``)] });
      const u = await getUser(t.id, t.username);
      u.coins = Math.max(0, u.coins - amt);
      await saveUser(u);
      return reply({ embeds: [okEmbed(`Took **${amt}** ${COIN_EMOJI} from <@${t.id}>. Balance: **${u.coins.toLocaleString()}** ${COIN_EMOJI}`)] });
    }
  } catch (e) {
    console.error(`Prefix ${cmd}:`, e);
    reply({ embeds: [errEmbed('Something went wrong!')] }).catch(() => {});
  }
});

// ══════════════════════════════════════════
//  COMMAND FUNCTIONS
// ══════════════════════════════════════════

// BALANCE — coins only, clean design
async function cmdBalance(reply, target) {
  const u = await getUser(target.id, target.username);
  return reply({ embeds: [new EmbedBuilder()
    .setColor(0xF1C40F)
    .setAuthor({ name: `${target.username}'s Balance`, iconURL: target.displayAvatarURL() })
    .setDescription(`## ${COIN_EMOJI} ${u.coins.toLocaleString()} coins`)
    .setFooter({ text: `Total earned all-time: ${(u.totalEarned || 0).toLocaleString()} coins` })] });
}

// DAILY
async function cmdDaily(reply, userId, username) {
  const u = await getUser(userId, username);
  const cd = 24 * 60 * 60 * 1000, now = Date.now();
  if (u.lastDaily && now - u.lastDaily < cd) {
    return reply({ embeds: [errEmbed(`Your next daily is ready ${ts(u.lastDaily + cd)} (${ts(u.lastDaily + cd, 'T')})`)] });
  }
  const earned = Math.floor(Math.random() * 6) + 10; // 10–15
  u.coins += earned; u.totalEarned = (u.totalEarned || 0) + earned; u.lastDaily = now;
  await saveUser(u);
  const next = now + cd;
  return reply({ embeds: [new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('🎁 Daily Claimed!')
    .setDescription(`You received **${earned}** ${COIN_EMOJI}!\nBalance: **${u.coins.toLocaleString()}** ${COIN_EMOJI}`)
    .setFooter({ text: 'Next daily available' })
    .setTimestamp(next)] });
}


// USE-CODE
async function cmdUseCode(reply, userId, username, codeInput) {
  const key  = codeInput.toUpperCase().trim();
  const code = CODES[key];
  if (!code) return reply({ embeds: [errEmbed(`Code \`${key}\` doesn't exist!`)] });
  const u = await getUser(userId, username);
  if (u.redeemedCodes.includes(key)) return reply({ embeds: [errEmbed(`You've already redeemed \`${key}\`!`)] });
  u.coins += code.coins;
  u.totalEarned = (u.totalEarned || 0) + code.coins;
  u.redeemedCodes.push(key);
  await saveUser(u);
  return reply({ embeds: [new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('🎟️ Code Redeemed!')
    .setDescription(`${code.description}\nYou received **${code.coins}** ${COIN_EMOJI}!\nNew balance: **${u.coins.toLocaleString()}** ${COIN_EMOJI}`)] });
}

// SHOP — items only, no extra info
async function cmdShop(reply) {
  const robuxLines = SHOP.filter(i => i.category === 'Robux')
    .map(i => `💎 **${i.name}** — \`${i.cost}\` ${COIN_EMOJI}  ·  ID: \`${i.id}\``).join('\n');
  const etfbLines  = SHOP.filter(i => i.category === 'ETFB')
    .map(i => `${i.id === 'etfb_cel' ? '✨' : '🌟'} **${i.name}** — \`${i.cost}\` ${COIN_EMOJI}  ·  ID: \`${i.id}\``).join('\n');
  return reply({ embeds: [new EmbedBuilder()
    .setTitle('🏪 Rewards Shop')
    .setColor(0x9B59B6)
    .addFields(
      { name: '💎 Robux', value: robuxLines, inline: false },
      { name: '🎮 ETFB',  value: etfbLines,  inline: false }
    )
    .setFooter({ text: `Buy: /redeem <id> or ${PREFIX}redeem <id>  |  Then: /claim <id>` })] });
}

// INVENTORY
async function cmdInventory(reply, userId, username) {
  const u   = await getUser(userId, username);
  const inv = u.inventory || [];
  if (!inv.length) return reply({ embeds: [errEmbed(`Your inventory is empty! Use \`/redeem\` or \`${PREFIX}redeem <id>\` to buy items.`)] });
  const list = inv.map(item => {
    const emoji = item.category === 'Robux' ? '💎' : item.name === 'Divine' ? '🌟' : '✨';
    return `${emoji} **${item.name}** — Claim ID: \`${item.claimId}\`\n> Use \`/claim ${item.claimId}\` to submit`;
  }).join('\n\n');
  return reply({ embeds: [new EmbedBuilder()
    .setTitle(`🎒 ${username}'s Inventory`)
    .setColor(0x9B59B6)
    .setDescription(list)
    .setFooter({ text: `${inv.length} item(s) · /claim <id> to submit` })] });
}

// LEADERBOARD
async function cmdLeaderboard(reply, guild) {
  const top    = await getLeaderboard(50);
  const medals = ["🥇", "🥈", "🥉"];
  const filtered = [];
  for (const u of top) {
    if (filtered.length >= 10) break;
    try {
      const member = await guild.members.fetch(u.id);
      if (!member.permissions.has(PermissionFlagsBits.Administrator)) filtered.push(u);
    } catch { /* user left server — skip */ }
  }
  const list = filtered.map((u, i) => `${medals[i] || `**${i + 1}.**`} <@${u.id}> — **${u.coins.toLocaleString()}** ${COIN_EMOJI}`).join("\n");
  return reply({ embeds: [new EmbedBuilder().setTitle("🏆 Coin Leaderboard").setColor(0xF1C40F).setDescription(list || "No data yet!")] });
}

// HELP
async function cmdHelp(reply) {
  return reply({ embeds: [new EmbedBuilder()
    .setTitle(`📖 Help — Prefix: \`${PREFIX}\``)
    .setColor(0x5865F2)
    .addFields(
      { name: '💰 Economy', value:
        `\`${PREFIX}balance\` / \`${PREFIX}bal\` — check your ${COIN_EMOJI}\n` +
        `\`${PREFIX}daily\` — 10–15 ${COIN_EMOJI} every 24h\n` +
        `\`${PREFIX}leaderboard\` — top 10\n` +
        `💬 Every message = 1 ${COIN_EMOJI}`, inline: false },
      { name: '🛒 Shop', value:
        `\`${PREFIX}shop\` — view items & prices\n` +
        `\`${PREFIX}redeem <id>\` — buy an item\n` +
        `\`${PREFIX}inventory\` — view your items\n` +
        `\`/claim <id>\` — submit a claim`, inline: false },
      { name: '🎟️ Codes', value:
        `\`/use-code <code>\` or \`${PREFIX}use-code <code>\``, inline: false }
    )] });
}

// ADMIN HELP
async function cmdAdminHelp(reply) {
  return reply({ embeds: [new EmbedBuilder()
    .setTitle('🔒 Admin Commands')
    .setColor(0xFF6B35)
    .addFields(
      { name: '📦 Stock',  value: `/update-robux <amount>\n/update-etfb <type> <amount>`, inline: false },
      { name: '👥 Coins',  value: `/give @user <amount>\n/take @user <amount>`, inline: false },
      { name: '🌧️ Rain',  value: `/rain <amount> — 2-min reaction rain (admin only)`, inline: false },
      { name: '📋 Claims', value: `/claims — view pending\n/claimed <id> — mark fulfilled\n/deny-claim <id> — deny & refund to inventory`, inline: false }
    )] });
}

// REDEEM
async function cmdRedeem(reply, userId, username, itemId) {
  const item = SHOP.find(i => i.id === itemId);
  if (!item) return reply({ embeds: [errEmbed(`Unknown item ID. Use \`${PREFIX}shop\` to see valid IDs.`)] });

  const u = await getUser(userId, username);
  if (u.coins < item.cost) return reply({ embeds: [errEmbed(`Need **${item.cost}** ${COIN_EMOJI}, you only have **${u.coins}** ${COIN_EMOJI}!`)] });

  const store = await getStore();
  if (item.id === 'etfb_cel' && store.celestials <= 0)              return reply({ embeds: [errEmbed('Celestials are out of stock!')] });
  if (item.id === 'etfb_div' && store.divines    <= 0)              return reply({ embeds: [errEmbed('Divines are out of stock!')] });
  if (item.category === 'Robux' && store.robux < item.robuxAmt)     return reply({ embeds: [errEmbed(`Only **${store.robux}** Robux in stock — not enough for **${item.name}**!`)] });

  // Deduct stock at purchase
  if      (item.id === 'etfb_cel')       store.celestials = Math.max(0, store.celestials - 1);
  else if (item.id === 'etfb_div')       store.divines    = Math.max(0, store.divines    - 1);
  else if (item.category === 'Robux')    store.robux      = Math.max(0, store.robux      - item.robuxAmt);
  await saveStore(store);
  await updateStockEmbed(client);

  const claimId = await nextClaimId();
  u.coins -= item.cost;
  u.inventory.push({ claimId, itemId: item.id, name: item.name, category: item.category, robuxAmt: item.robuxAmt, cost: item.cost });
  await saveUser(u);

  return reply({ embeds: [new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('🎒 Added to Inventory!')
    .setDescription(
      `**${item.name}** is now in your inventory!\n` +
      `Remaining balance: **${u.coins.toLocaleString()}** ${COIN_EMOJI}\n\n` +
      `📬 Claim ID: \`${claimId}\`\nUse \`/claim ${claimId}\` to submit your delivery request!`
    )] });
}

// RAIN — admin only, reaction-based 2 min
async function cmdRain(msgOrInteraction, guild, senderId, senderName, amount) {
  const isInteraction = !!msgOrInteraction.deferReply;
  const sender = await getUser(senderId, senderName);
  const errReply = text => {
    const e = errEmbed(text);
    return isInteraction ? msgOrInteraction.editReply({ embeds: [e] }) : msgOrInteraction.reply({ embeds: [e] });
  };
  if (sender.coins < amount) return errReply(`You only have **${sender.coins}** ${COIN_EMOJI}!`);

  const RAIN_DURATION = 2 * 60 * 1000;
  const endsAt        = Date.now() + RAIN_DURATION;

  const rainEmbed = new EmbedBuilder()
    .setColor(0x3498DB)
    .setTitle('🌧️ Coin Rain — React to Enter!')
    .setDescription(
      `<@${senderId}> is raining **${amount}** ${COIN_EMOJI}!\n\n` +
      `React with 🌧️ to enter!\n` +
      `Coins will be split equally among all who react.\n\n` +
      `⏰ Ends ${ts(endsAt)} — at ${ts(endsAt, 'T')} your local time`
    );

  let rainMsg;
  if (isInteraction) {
    await msgOrInteraction.editReply({ embeds: [rainEmbed] });
    rainMsg = await msgOrInteraction.fetchReply();
  } else {
    rainMsg = await msgOrInteraction.reply({ embeds: [rainEmbed] });
  }
  await rainMsg.react('🌧️');

  setTimeout(async () => {
    try {
      const freshMsg = await rainMsg.fetch();
      const reaction = freshMsg.reactions.cache.get('🌧️');
      let reactors = [];
      if (reaction) {
        const users = await reaction.users.fetch();
        reactors = [...users.values()].filter(u => !u.bot && u.id !== senderId);
      }

      if (!reactors.length) {
        await rainMsg.reply({ embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('🌧️ Rain Ended').setDescription(`Nobody reacted! **${amount}** ${COIN_EMOJI} refunded to <@${senderId}>.`)] });
        return;
      }

      const per = Math.floor(amount / reactors.length);
      if (per < 1) {
        await rainMsg.reply({ embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('🌧️ Rain Ended').setDescription(`Too many reactors for the pool! **${amount}** ${COIN_EMOJI} refunded to <@${senderId}>.`)] });
        return;
      }

      const totalGiven = per * reactors.length;
      const senderUser = await getUser(senderId, senderName);
      senderUser.coins = Math.max(0, senderUser.coins - totalGiven);
      await saveUser(senderUser);

      const names = [];
      for (const reactor of reactors) {
        const u = await getUser(reactor.id, reactor.username);
        u.coins += per; u.totalEarned = (u.totalEarned || 0) + per;
        await saveUser(u);
        names.push(`<@${reactor.id}>`);
      }

      await rainMsg.reply({ embeds: [new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('🌧️ Rain Finished!')
        .setDescription(
          `<@${senderId}> rained **${totalGiven}** ${COIN_EMOJI} across **${reactors.length}** member(s)!\n` +
          `Each received **${per}** ${COIN_EMOJI}\n\n` +
          `**Winners:** ${names.join(' ')}`
        )] });
    } catch (e) { console.error('Rain end error:', e.message); }
  }, RAIN_DURATION);
}

// ══════════════════════════════════════════
//  INTERACTION HANDLER
// ══════════════════════════════════════════
client.on('interactionCreate', async interaction => {

  // ── MODAL SUBMIT ──────────────────────────
  if (interaction.isModalSubmit()) {
    if (!interaction.customId.startsWith('claim_modal_')) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const claimId = interaction.customId.replace('claim_modal_', '');
    const u       = await getUser(interaction.user.id, interaction.user.username);
    const inv     = u.inventory || [];
    const idx     = inv.findIndex(i => i.claimId === claimId);
    if (idx === -1) return interaction.editReply({ embeds: [errEmbed('Item not found in your inventory.')] });

    const item         = inv[idx];
    const robloxUser   = interaction.fields.getTextInputValue('roblox_username').trim();
    const gamepassLink = item.category === 'Robux' ? interaction.fields.getTextInputValue('gamepass_link').trim() : null;

    // Verify stock before accepting the claim
    const store = await getStore();
    if (item.category === 'Robux' && store.robux < item.robuxAmt)
      return interaction.editReply({ embeds: [errEmbed(`Not enough Robux in stock right now (need **${item.robuxAmt}**, have **${store.robux}**). Contact an admin.`)] });
    if (item.id === 'etfb_cel' && store.celestials <= 0)
      return interaction.editReply({ embeds: [errEmbed('Celestials are out of stock! Contact an admin.')] });
    if (item.id === 'etfb_div' && store.divines <= 0)
      return interaction.editReply({ embeds: [errEmbed('Divines are out of stock! Contact an admin.')] });

    const claims    = await getClaims();
    const claimsArr = Array.isArray(claims) ? claims : [];
    claimsArr.push({
      claimId,
      userId:         interaction.user.id,
      username:       interaction.user.username,
      itemId:         item.itemId || item.id,
      itemName:       item.name,
      category:       item.category,
      robuxAmt:       item.robuxAmt || 0,
      robloxUsername: robloxUser,
      gamepassLink:   gamepassLink || null,
      claimedAt:      Date.now(),
      status:         'pending',
    });
    await saveClaims(claimsArr);

    u.inventory.splice(idx, 1);
    await saveUser(u);

    return interaction.editReply({ embeds: [new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle('📬 Claim Submitted!')
      .setDescription(
        `Your claim for **${item.name}** has been submitted!\n\n` +
        `**Claim ID:** \`${claimId}\`\n` +
        `**Roblox Username:** \`${robloxUser}\`\n` +
        (gamepassLink ? `**Gamepass:** ${gamepassLink}\n` : '') +
        `\nAn admin will process this shortly!`
      )] });
  }

  if (!interaction.isChatInputCommand()) return;
  const cmd   = interaction.commandName;
  const me    = interaction.user;
  const reply = p => interaction.reply(p);

  try {
    if (cmd === 'balance')     return await cmdBalance(reply, interaction.options.getUser('user') || me);
    if (cmd === 'daily')       return await cmdDaily(reply, me.id, me.username);
    if (cmd === 'shop')        return await cmdShop(reply);
    if (cmd === 'inventory')   return await cmdInventory(reply, me.id, me.username);
    if (cmd === 'leaderboard') return await cmdLeaderboard(reply, interaction.guild);
    if (cmd === 'help')        return await cmdHelp(reply);
    if (cmd === 'adminhelp')   return await cmdAdminHelp(reply);
    if (cmd === 'use-code')    return await cmdUseCode(reply, me.id, me.username, interaction.options.getString('code'));

    if (cmd === 'rain') {
      await interaction.deferReply();
      return await cmdRain(interaction, interaction.guild, me.id, me.username, interaction.options.getInteger('amount'));
    }

    if (cmd === 'redeem') {
      await interaction.deferReply();
      return await cmdRedeem(p => interaction.editReply(p), me.id, me.username, interaction.options.getString('item'));
    }

    // /claim — show modal
    if (cmd === 'claim') {
      const idArg = interaction.options.getString('id').toUpperCase();
      const u     = await getUser(me.id, me.username);
      const item  = (u.inventory || []).find(i => i.claimId === idArg);
      if (!item) return reply({ embeds: [errEmbed(`No item with ID \`${idArg}\` in your inventory. Use \`/inventory\` to check.`)], flags: MessageFlags.Ephemeral });

      const modal = new ModalBuilder().setCustomId(`claim_modal_${item.claimId}`).setTitle(`Claim: ${item.name}`);
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('roblox_username')
          .setLabel('Your Roblox Username')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. Builderman')
          .setRequired(true)
      ));
      if (item.category === 'Robux') {
        const rbxAmt = item.robuxAmt || 0;
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('gamepass_link')
            .setLabel(`Gamepass Link (set price to ${rbxAmt} Robux)`)
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('https://www.roblox.com/game-pass/...')
            .setRequired(true)
        ));
      }
      return interaction.showModal(modal);
    }

    // /claims — embed list of pending claims
    if (cmd === 'claims') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const allClaims = await getClaims();
      const pending   = (Array.isArray(allClaims) ? allClaims : []).filter(c => c.status === 'pending' && c.status !== 'denied' && c.status !== 'fulfilled');
      if (!pending.length) {
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('📋 Pending Claims').setDescription('No pending claims right now!')] });
      }

      const fields = pending.map(c => ({
        name:  `${c.claimId} — ${c.itemName}`,
        value: `👤 **${c.username}**  ·  Roblox: \`${c.robloxUsername}\`\n` +
               (c.gamepassLink ? `🔗 ${c.gamepassLink}\n` : '') +
               `📅 ${ts(c.claimedAt, 'R')} (${ts(c.claimedAt, 'f')})`,
        inline: false,
      }));

      // Max 10 fields per embed to keep it clean
      const chunks = [];
      for (let i = 0; i < fields.length; i += 10) chunks.push(fields.slice(i, i + 10));

      for (let i = 0; i < chunks.length; i++) {
        const embed = new EmbedBuilder()
          .setColor(0xF1C40F)
          .setTitle(i === 0 ? `📋 Pending Claims — ${pending.length} total` : '📋 Pending Claims (continued)')
          .addFields(chunks[i])
          .setFooter({ text: '/claimed <id>  ·  /deny-claim <id>' });
        if (i === 0) await interaction.editReply({ embeds: [embed] });
        else         await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
      return;
    }

    // /claimed — fulfil claim + DM user
    if (cmd === 'claimed') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const claimId   = interaction.options.getString('id').toUpperCase();
      const allClaims = await getClaims();
      const claimsArr = Array.isArray(allClaims) ? allClaims : [];
      const idx       = claimsArr.findIndex(c => c.claimId === claimId);
      if (idx === -1)                              return interaction.editReply({ embeds: [errEmbed(`Claim \`${claimId}\` not found.`)] });
      if (claimsArr[idx].status === 'fulfilled')   return interaction.editReply({ embeds: [errEmbed(`Claim \`${claimId}\` is already fulfilled.`)] });
      if (claimsArr[idx].status === 'denied')      return interaction.editReply({ embeds: [errEmbed(`Claim \`${claimId}\` was denied — cannot fulfil.`)] });

      const claim              = claimsArr[idx];
      claimsArr[idx].status    = 'fulfilled';
      claimsArr[idx].fulfilledAt = Date.now();
      claimsArr[idx].fulfilledBy = me.username;
      await saveClaims(claimsArr);

      const dmText = claim.category === 'Robux'
        ? `Your **${claim.itemName}** reward has been sent! We purchased your gamepass — check your Roblox account!`
        : `Your **${claim.itemName} (ETFB)** reward is ready!\n\n**vru4447** has sent you a friend request on Roblox. Accept it and they will join your game to deliver your reward!`;

      let dmSent = false;
      try {
        const target = await client.users.fetch(claim.userId);
        await target.send({ embeds: [new EmbedBuilder()
          .setColor(0x57F287)
          .setTitle('🎉 Reward Delivered!')
          .setDescription(`✅ ${dmText}`)
          .addFields(
            { name: 'Claim ID', value: `\`${claimId}\``,    inline: true },
            { name: 'Item',     value: claim.itemName,       inline: true },
            { name: 'Roblox',   value: claim.robloxUsername, inline: true }
          )] });
        dmSent = true;
      } catch (e) { console.error('DM failed:', e.message); }

      // Notify claimer publicly in the channel
      try {
        await interaction.channel.send({ embeds: [new EmbedBuilder()
          .setColor(0x57F287)
          .setTitle('🎉 Claim Fulfilled!')
          .setDescription(
            `<@${claim.userId}> your claim **${claimId}** for **${claim.itemName}** has been fulfilled by <@${me.id}>!\n` +
            (claim.category === 'Robux'
              ? `Check your Roblox gamepass — the Robux have been sent!`
              : `Accept the friend request from **vru4447** on Roblox to receive your reward!`)
          )] });
      } catch { /* no channel access */ }

      // Send vouch request to the vouch channel
      try {
        const vouchCh = await client.channels.fetch(VOUCH_CHANNEL_ID);
        if (vouchCh) {
          await vouchCh.send({
            content: `<@${claim.userId}>`,
            embeds: [new EmbedBuilder()
              .setColor(0x5865F2)
              .setTitle('⭐ Please Leave a Vouch!')
              .setDescription(
                `Hey <@${claim.userId}>! You just received **${claim.itemName}** — we hope everything went smoothly! 🎉\n\n` +
                `Please leave a vouch so others know we're legit!\n\n` +
                `**Format:**\n\`Vouch @${me.username} <your reason>\``
              )
              .setFooter({ text: `Claim ${claimId} · Fulfilled by ${me.username}` })] });

          // Set a 10-minute timer — if they haven't vouched, DM them + alert channel
          const vouchTimeout = setTimeout(async () => {
            pendingVouches.delete(claim.userId);
            // DM the user
            try {
              const vouchTarget = await client.users.fetch(claim.userId);
              await vouchTarget.send({ embeds: [new EmbedBuilder()
                .setColor(0xFEE75C)
                .setTitle('⭐ Dont forget to vouch!')
                .setDescription(
                  `You received **${claim.itemName}** but haven't left a vouch yet!\n\n` +
                  `Head to <#${VOUCH_CHANNEL_ID}> and type:\n\`Vouch @${me.username} <your reason>\`\n\n` +
                  `It only takes a second and helps the community a lot! 🙏`
                )] });
            } catch { /* DMs closed */ }
            // Alert the admin channel
            try {
              const alertCh = await client.channels.fetch(ALERT_CHANNEL_ID);
              if (alertCh) {
                await alertCh.send({ embeds: [new EmbedBuilder()
                  .setColor(0xED4245)
                  .setTitle('⚠️ Vouch Not Received')
                  .setDescription(
                    `<@${claim.userId}> has not vouched after receiving **${claim.itemName}** (claim \`${claimId}\`).\n` +
                    `A reminder DM has been sent to them.`
                  )] });
              }
            } catch (e) { console.error('Alert channel error:', e.message); }
          }, 10 * 60 * 1000); // 10 minutes

          pendingVouches.set(claim.userId, {
            claimId,
            itemName:    claim.itemName,
            fulfilledBy: me.username,
            timeout:     vouchTimeout,
          });
        }
      } catch (e) { console.error('Vouch channel send error:', e.message); }

      return interaction.editReply({ embeds: [new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('✅ Claim Fulfilled')
        .addFields(
          { name: 'Claim ID', value: `\`${claimId}\``,                              inline: true },
          { name: 'User',     value: `<@${claim.userId}>`,                           inline: true },
          { name: 'Roblox',   value: claim.robloxUsername,                           inline: true },
          { name: 'Item',     value: claim.itemName,                                 inline: true },
          { name: 'DM',       value: dmSent ? '✅ Sent' : '❌ DMs disabled',         inline: true }
        )] });
    }

    // /deny-claim — deny + refund item back to inventory + restore stock
    if (cmd === 'deny-claim') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const claimId   = interaction.options.getString('id').toUpperCase();
      const allClaims = await getClaims();
      const claimsArr = Array.isArray(allClaims) ? allClaims : [];
      const idx       = claimsArr.findIndex(c => c.claimId === claimId);
      if (idx === -1)                            return interaction.editReply({ embeds: [errEmbed(`Claim \`${claimId}\` not found.`)] });
      if (claimsArr[idx].status === 'fulfilled') return interaction.editReply({ embeds: [errEmbed(`Claim \`${claimId}\` is already fulfilled — cannot deny.`)] });
      if (claimsArr[idx].status === 'denied')    return interaction.editReply({ embeds: [errEmbed(`Claim \`${claimId}\` is already denied.`)] });

      const claim            = claimsArr[idx];
      claimsArr[idx].status  = 'denied';
      claimsArr[idx].deniedAt = Date.now();
      claimsArr[idx].deniedBy = me.username;
      await saveClaims(claimsArr);

      // Refund item to user's inventory
      const shopItem = SHOP.find(i => i.id === claim.itemId);
      const u        = await getUser(claim.userId, claim.username);
      u.inventory.push({
        claimId:  claim.claimId,
        itemId:   claim.itemId,
        name:     claim.itemName,
        category: claim.category,
        robuxAmt: claim.robuxAmt || 0,
        cost:     shopItem ? shopItem.cost : 0,
      });
      await saveUser(u);

      // Restore stock
      const store = await getStore();
      if      (claim.category === 'Robux')       store.robux      += (claim.robuxAmt || 0);
      else if (claim.itemId   === 'etfb_cel')    store.celestials += 1;
      else if (claim.itemId   === 'etfb_div')    store.divines    += 1;
      await saveStore(store);
      await updateStockEmbed(client);

      // DM the user
      let dmSent = false;
      try {
        const target = await client.users.fetch(claim.userId);
        await target.send({ embeds: [new EmbedBuilder()
          .setColor(0xED4245)
          .setTitle('❌ Claim Denied')
          .setDescription(
            `Your claim \`${claimId}\` for **${claim.itemName}** was denied by an admin.\n\n` +
            `The item has been returned to your inventory — use \`/inventory\` to see it.\n` +
            `You can re-submit with \`/claim ${claimId}\` whenever stock is available.`
          )] });
        dmSent = true;
      } catch (e) { console.error('Deny DM failed:', e.message); }

      return interaction.editReply({ embeds: [new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('❌ Claim Denied')
        .addFields(
          { name: 'Claim ID',   value: `\`${claimId}\``,                              inline: true },
          { name: 'User',       value: `<@${claim.userId}>`,                           inline: true },
          { name: 'Roblox',     value: claim.robloxUsername,                           inline: true },
          { name: 'Item',       value: claim.itemName,                                 inline: true },
          { name: 'Refunded',   value: '✅ Item back in inventory',                    inline: true },
          { name: 'Stock',      value: '✅ Restored',                                  inline: true },
          { name: 'DM',         value: dmSent ? '✅ Sent' : '❌ DMs disabled',         inline: true }
        )] });
    }

    if (cmd === 'give') {
      const t = interaction.options.getUser('user'), amt = interaction.options.getInteger('amount');
      const u = await getUser(t.id, t.username);
      u.coins += amt; u.totalEarned = (u.totalEarned || 0) + amt;
      await saveUser(u);
      return reply({ embeds: [okEmbed(`Gave **${amt}** ${COIN_EMOJI} to <@${t.id}>. Balance: **${u.coins.toLocaleString()}** ${COIN_EMOJI}`)] });
    }
    if (cmd === 'take') {
      const t = interaction.options.getUser('user'), amt = interaction.options.getInteger('amount');
      const u = await getUser(t.id, t.username);
      u.coins = Math.max(0, u.coins - amt);
      await saveUser(u);
      return reply({ embeds: [okEmbed(`Took **${amt}** ${COIN_EMOJI} from <@${t.id}>. Balance: **${u.coins.toLocaleString()}** ${COIN_EMOJI}`)] });
    }
    if (cmd === 'remove-inv') {
      const t       = interaction.options.getUser('user');
      const claimId = interaction.options.getString('claim_id').toUpperCase();
      const u       = await getUser(t.id, t.username);
      const inv     = u.inventory || [];
      if (!inv.length) return reply({ embeds: [errEmbed(`<@${t.id}> has an empty inventory.`)], flags: MessageFlags.Ephemeral });
      const idx = inv.findIndex(i => i.claimId === claimId);
      if (idx === -1) return reply({ embeds: [errEmbed(`No item with claim ID \`${claimId}\` in <@${t.id}>'s inventory.`)], flags: MessageFlags.Ephemeral });
      const removed = inv.splice(idx, 1)[0];
      await saveUser(u);
      return reply({ embeds: [new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('🗑️ Item Removed')
        .setDescription(`Removed **${removed.name}** (\`${claimId}\`) from <@${t.id}>'s inventory.`)] });
    }
    if (cmd === 'check-inventory') {
      const t   = interaction.options.getUser('user');
      const u   = await getUser(t.id, t.username);
      const inv = u.inventory || [];
      if (!inv.length) return reply({ embeds: [new EmbedBuilder().setColor(0xFEE75C).setDescription(`🎒 <@${t.id}>'s inventory is empty.`)], flags: MessageFlags.Ephemeral });
      const list = inv.map(item => {
        const emoji = item.category === 'Robux' ? '💎' : item.name === 'Divine' ? '🌟' : '✨';
        return `${emoji} **${item.name}** — Claim ID: \`${item.claimId}\``;
      }).join('\n');
      return reply({ embeds: [new EmbedBuilder()
        .setTitle(`🎒 ${t.username}'s Inventory`)
        .setColor(0x9B59B6)
        .setDescription(list)
        .setFooter({ text: `${inv.length} item(s)` })], flags: MessageFlags.Ephemeral });
    }
    if (cmd === 'update-robux') {
      await interaction.deferReply();
      const amt   = interaction.options.getInteger('amount');
      const store = await getStore();
      store.robux = amt;
      await saveStore(store);
      await updateStockEmbed(client);
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('✅ Stock Updated').setDescription(`💎 Robux stock set to **${amt}**.`)] });
    }
    if (cmd === 'update-etfb') {
      await interaction.deferReply();
      const type  = interaction.options.getString('type'), amt = interaction.options.getInteger('amount');
      const store = await getStore();
      store[type] = amt;
      await saveStore(store);
      await updateStockEmbed(client);
      const label = type === 'divines' ? '🌟 Divines' : '✨ Celestials';
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('✅ Stock Updated').setDescription(`${label} set to **${amt}x**.`)] });
    }

  } catch (e) {
    console.error(`/${cmd} error:`, e);
    const err = { embeds: [errEmbed('Something went wrong!')], flags: MessageFlags.Ephemeral };
    try { interaction.replied || interaction.deferred ? await interaction.followUp(err) : await interaction.reply(err); } catch {}
  }
});

client.login(process.env.BOT_TOKEN);
