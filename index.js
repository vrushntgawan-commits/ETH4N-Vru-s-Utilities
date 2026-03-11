const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits
} = require('discord.js');
const fs   = require('fs');
const path = require('path');
require('dotenv').config();

// ══════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════
const STOCK_CHANNEL_ID = '1481026325178220565';
const GUILD_ID         = process.env.GUILD_ID;   // set in Railway variables
const PREFIX           = 'u!';
const COIN_PER_MSG     = 1;
const MSG_COOLDOWN_MS  = 10_000;

const SHOP = [
  { id: 'robux_25',  name: '25 Robux',        cost: 100, category: 'Robux', emoji: '💎' },
  { id: 'robux_50',  name: '50 Robux',         cost: 175, category: 'Robux', emoji: '💎' },
  { id: 'robux_100', name: '100 Robux',        cost: 300, category: 'Robux', emoji: '💎' },
  { id: 'etfb_inv',  name: '1 ETFB Inv',       cost: 100, category: 'ETFB', emoji: '🎁' },
  { id: 'etfb_cel',  name: 'Celestial (ETFB)', cost: 100, category: 'ETFB', emoji: '✨' },
  { id: 'etfb_div',  name: 'Divine (ETFB)',    cost: 250, category: 'ETFB', emoji: '🌟' },
];

// ══════════════════════════════════════════
//  DATABASE
// ══════════════════════════════════════════
const DATA_DIR = path.join(__dirname, 'data');
const USERS_F  = path.join(DATA_DIR, 'users.json');
const STORE_F  = path.join(DATA_DIR, 'store.json');
const MSGID_F  = path.join(DATA_DIR, 'msgid.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, def) {
  if (!fs.existsSync(file)) { fs.writeFileSync(file, JSON.stringify(def, null, 2)); return def; }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

function getUser(userId, username) {
  const db = readJSON(USERS_F, {});
  if (!db[userId]) {
    db[userId] = { id: userId, username: username || 'Unknown', coins: 0, totalEarned: 0, lastDaily: null, lastWork: null, inventory: [], createdAt: Date.now() };
    writeJSON(USERS_F, db);
  }
  return db[userId];
}
function saveUser(u)      { const db = readJSON(USERS_F, {}); db[u.id] = u; writeJSON(USERS_F, db); }
function getLeaderboard(n){ return Object.values(readJSON(USERS_F, {})).sort((a,b)=>b.coins-a.coins).slice(0,n); }
function getStore()       { return readJSON(STORE_F, { robux: 0, divines: 0, celestials: 0 }); }
function saveStore(s)     { writeJSON(STORE_F, s); }
function getMsgId()       { return readJSON(MSGID_F, { id: null }).id; }
function setMsgId(id)     { writeJSON(MSGID_F, { id }); }

// ══════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════
function fmt(ms) {
  const s=Math.floor(ms/1000), m=Math.floor(s/60), h=Math.floor(m/60);
  return h>0?`${h}h ${m%60}m`:m>0?`${m}m ${s%60}s`:`${s}s`;
}

function buildStockEmbed() {
  const s = getStore();
  return new EmbedBuilder()
    .setTitle('🏪 Current Stock')
    .setColor(0x5865F2)
    .setDescription('Redeem your coins for rewards below!')
    .addFields(
      { name: '💎 Robux',           value: s.robux>0      ? `**${s.robux}R** available`      : '❌ Out of stock', inline: true },
      { name: '✨ ETFB Celestials', value: s.celestials>0 ? `**${s.celestials}x** available` : '❌ Out of stock', inline: true },
      { name: '🌟 ETFB Divines',   value: s.divines>0    ? `**${s.divines}x** available`    : '❌ Out of stock', inline: true },
      {
        name: '📋 Exchange Rates',
        value:
          '💎 **25 Robux** → 100 coins\n' +
          '💎 **50 Robux** → 175 coins\n' +
          '💎 **100 Robux** → 300 coins\n' +
          '🎁 **1 ETFB Inv** → 100 coins\n' +
          '✨ **Celestial** → 100 coins\n' +
          '🌟 **Divine** → 250 coins',
        inline: false
      }
    )
    .setFooter({ text: `Stock updated by admins • ${PREFIX}help or /shop` })
    .setTimestamp();
}

async function updateStockMessage(client) {
  try {
    const ch = await client.channels.fetch(STOCK_CHANNEL_ID);
    if (!ch) return;
    const embed = buildStockEmbed();
    const existingId = getMsgId();
    if (existingId) {
      try { const m = await ch.messages.fetch(existingId); await m.edit({ embeds: [embed] }); return; }
      catch { /* deleted, send new */ }
    }
    const sent = await ch.send({ embeds: [embed] });
    setMsgId(sent.id);
  } catch (e) { console.error('Stock embed error:', e.message); }
}

// ══════════════════════════════════════════
//  SLASH COMMAND DEFINITIONS
// ══════════════════════════════════════════
const slashCommands = [
  new SlashCommandBuilder().setName('balance').setDescription('Check coin balance').addUserOption(o=>o.setName('user').setDescription('User to check').setRequired(false)),
  new SlashCommandBuilder().setName('daily').setDescription('Claim 50 coins (24h cooldown)'),
  new SlashCommandBuilder().setName('work').setDescription('Work a job for coins (1h cooldown)'),
  new SlashCommandBuilder().setName('coinflip').setDescription('Bet coins on a flip!').addIntegerOption(o=>o.setName('amount').setDescription('Coins to bet').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('rain').setDescription('Rain coins on random members!').addIntegerOption(o=>o.setName('amount').setDescription('Total coins to rain').setRequired(true).setMinValue(10)),
  new SlashCommandBuilder().setName('shop').setDescription('View all rewards'),
  new SlashCommandBuilder().setName('redeem').setDescription('Redeem coins for a reward').addStringOption(o=>
    o.setName('item').setDescription('Item to redeem').setRequired(true).addChoices(
      { name: '💎 25 Robux (100 coins)',      value: 'robux_25'  },
      { name: '💎 50 Robux (175 coins)',       value: 'robux_50'  },
      { name: '💎 100 Robux (300 coins)',      value: 'robux_100' },
      { name: '🎁 1 ETFB Inv (100 coins)',     value: 'etfb_inv'  },
      { name: '✨ Celestial ETFB (100 coins)', value: 'etfb_cel'  },
      { name: '🌟 Divine ETFB (250 coins)',    value: 'etfb_div'  }
    )
  ),
  new SlashCommandBuilder().setName('inventory').setDescription('View your redeemed rewards'),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Top 10 richest members'),
  new SlashCommandBuilder().setName('give').setDescription('[ADMIN] Give coins to a user').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o=>o.setName('user').setDescription('Target').setRequired(true))
    .addIntegerOption(o=>o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('take').setDescription('[ADMIN] Take coins from a user').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o=>o.setName('user').setDescription('Target').setRequired(true))
    .addIntegerOption(o=>o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('update-robux').setDescription('[ADMIN] Update Robux stock').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addIntegerOption(o=>o.setName('amount').setDescription('New Robux amount').setRequired(true).setMinValue(0)),
  new SlashCommandBuilder().setName('update-etfb').setDescription('[ADMIN] Update ETFB stock').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o=>o.setName('type').setDescription('Which item').setRequired(true).addChoices({name:'Divines',value:'divines'},{name:'Celestials',value:'celestials'}))
    .addIntegerOption(o=>o.setName('amount').setDescription('New amount').setRequired(true).setMinValue(0)),
].map(c=>c.toJSON());

// ══════════════════════════════════════════
//  CLIENT
// ══════════════════════════════════════════
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

const msgCooldowns = new Map();

// ── READY ─────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  try {
    if (GUILD_ID) {
      // Guild-specific = instant (use during development)
      await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: slashCommands });
      console.log(`✅ Slash commands registered instantly to guild ${GUILD_ID}`);
    } else {
      // Global = up to 1 hour delay (fallback)
      await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommands });
      console.log('⚠️  Slash commands registered globally (up to 1hr to appear). Set GUILD_ID for instant registration.');
    }
  } catch (e) { console.error('Command registration error:', e); }
  await updateStockMessage(client);
});

// ══════════════════════════════════════════
//  SHARED COMMAND LOGIC
//  (used by both slash commands AND prefix)
// ══════════════════════════════════════════
async function handleBalance(respond, targetUser) {
  const u = getUser(targetUser.id, targetUser.username);
  return respond({ embeds: [new EmbedBuilder().setTitle(`🪙 ${targetUser.username}'s Balance`).setColor(0xF1C40F)
    .setThumbnail(targetUser.displayAvatarURL())
    .addFields(
      { name: '💰 Coins',        value: `**${u.coins.toLocaleString()}**`,              inline: true },
      { name: '📈 Total Earned', value: `${(u.totalEarned||0).toLocaleString()} coins`, inline: true },
      { name: '🎒 Inventory',    value: `${(u.inventory||[]).length} items`,             inline: true }
    ).setTimestamp()] });
}

async function handleDaily(respond, userId, username) {
  const u = getUser(userId, username);
  const cd = 24*60*60*1000, now = Date.now();
  if (u.lastDaily && now - u.lastDaily < cd)
    return respond({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription(`⏰ Come back in **${fmt(cd-(now-u.lastDaily))}** for your daily!`)] });
  u.coins+=50; u.totalEarned=(u.totalEarned||0)+50; u.lastDaily=now; saveUser(u);
  return respond({ embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('🎁 Daily Claimed!').setDescription(`You received **50 coins**!\nBalance: **${u.coins.toLocaleString()} coins**`).setTimestamp()] });
}

async function handleWork(respond, userId, username) {
  const u = getUser(userId, username);
  const cd = 60*60*1000, now = Date.now();
  if (u.lastWork && now - u.lastWork < cd)
    return respond({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription(`⏰ Too tired! Work again in **${fmt(cd-(now-u.lastWork))}**`)] });
  const jobs = [
    {name:'Pizza Delivery',r:[15,35],e:'🍕'},{name:'Dog Walker',r:[10,30],e:'🐕'},
    {name:'Streamer',r:[20,50],e:'🎮'},{name:'Trader',r:[25,60],e:'📈'},
    {name:'YouTuber',r:[30,70],e:'📹'},{name:'Miner',r:[15,40],e:'⛏️'},
    {name:'Hacker',r:[35,75],e:'💻'},{name:'Chef',r:[20,45],e:'👨‍🍳'},
    {name:'Fisherman',r:[10,35],e:'🎣'},
  ];
  const job = jobs[Math.floor(Math.random()*jobs.length)];
  const earned = Math.floor(Math.random()*(job.r[1]-job.r[0]+1))+job.r[0];
  u.coins+=earned; u.totalEarned=(u.totalEarned||0)+earned; u.lastWork=now; saveUser(u);
  return respond({ embeds: [new EmbedBuilder().setColor(0x57F287).setTitle(`${job.e} Work Complete!`).setDescription(`You worked as a **${job.name}** and earned **${earned} coins**!\nBalance: **${u.coins.toLocaleString()} coins**`).setTimestamp()] });
}

async function handleCoinflip(respond, userId, username, amount) {
  const u = getUser(userId, username);
  if (u.coins < amount) return respond({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription(`❌ You only have **${u.coins} coins**!`)] });
  const win = Math.random()<0.5;
  u.coins+=win?amount:-amount;
  if(win) u.totalEarned=(u.totalEarned||0)+amount;
  saveUser(u);
  return respond({ embeds: [new EmbedBuilder().setColor(win?0x57F287:0xED4245).setTitle(win?'🟡 Heads — You Win!':'⚫ Tails — You Lose!')
    .setDescription(win?`Won **${amount} coins**! 🎉\nBalance: **${u.coins.toLocaleString()}**`:`Lost **${amount} coins**. 💸\nBalance: **${u.coins.toLocaleString()}**`).setTimestamp()] });
}

async function handleRain(respond, guild, senderId, senderUsername, amount) {
  const sender = getUser(senderId, senderUsername);
  if (sender.coins < amount) return respond({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription(`❌ You only have **${sender.coins} coins**!`)] });
  await guild.members.fetch();
  const pool  = [...guild.members.cache.filter(m=>!m.user.bot&&m.user.id!==senderId).values()];
  const picks = pool.sort(()=>0.5-Math.random()).slice(0,Math.min(5,pool.length));
  if (!picks.length) return respond({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('❌ No eligible members!')] });
  const per = Math.floor(amount/picks.length);
  sender.coins-=per*picks.length; saveUser(sender);
  const names = picks.map(m=>{ const u=getUser(m.user.id,m.user.username); u.coins+=per; u.totalEarned=(u.totalEarned||0)+per; saveUser(u); return `<@${m.user.id}>`; });
  return respond({ embeds: [new EmbedBuilder().setColor(0x3498DB).setTitle('🌧️ Coin Rain!')
    .setDescription(`<@${senderId}> rained **${per*picks.length} coins** across **${picks.length} members**!\nEach got **${per} coins**: ${names.join(' ')}`).setTimestamp()] });
}

async function handleShop(respond) {
  return respond({ embeds: [new EmbedBuilder().setTitle('🏪 Rewards Shop').setColor(0x9B59B6)
    .setDescription(`Use \`/redeem\` or \`${PREFIX}redeem <item>\` to purchase!`)
    .addFields(
      { name: '💎 Robux', value: SHOP.filter(i=>i.category==='Robux').map(i=>`${i.emoji} **${i.name}** — \`${i.cost} coins\``).join('\n'), inline: true },
      { name: '🎁 ETFB',  value: SHOP.filter(i=>i.category==='ETFB').map(i=>`${i.emoji} **${i.name}** — \`${i.cost} coins\``).join('\n'), inline: true },
      { name: '💡 Earning coins', value: `💬 1 message = 1 coin\n📅 \`${PREFIX}daily\` = 50 coins\n💼 \`${PREFIX}work\` = 10–75 coins\n🪙 \`${PREFIX}coinflip\` = double or nothing`, inline: false }
    ).setTimestamp()] });
}

async function handleRedeem(respond, userId, username, itemId) {
  const item = SHOP.find(i=>i.id===itemId);
  const u    = getUser(userId, username);
  if (!item) return respond({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('❌ Invalid item. Use `u!shop` to see items.')] });
  if (u.coins < item.cost) return respond({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Need **${item.cost} coins**, you have **${u.coins}**!`)] });
  const store = getStore();
  if (itemId==='etfb_cel' && store.celestials<=0) return respond({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('❌ Celestials are out of stock!')] });
  if (itemId==='etfb_div' && store.divines<=0)    return respond({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('❌ Divines are out of stock!')] });
  if (itemId.startsWith('robux') && store.robux<=0) return respond({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('❌ Robux is out of stock!')] });
  if (itemId==='etfb_cel')       store.celestials=Math.max(0,store.celestials-1);
  else if (itemId==='etfb_div')  store.divines=Math.max(0,store.divines-1);
  else if (itemId==='robux_25')  store.robux=Math.max(0,store.robux-25);
  else if (itemId==='robux_50')  store.robux=Math.max(0,store.robux-50);
  else if (itemId==='robux_100') store.robux=Math.max(0,store.robux-100);
  saveStore(store);
  await updateStockMessage(client);
  u.coins-=item.cost;
  u.inventory=u.inventory||[];
  u.inventory.push({ itemId, name: item.name, cost: item.cost, claimedAt: Date.now() });
  saveUser(u);
  return respond({ embeds: [new EmbedBuilder().setColor(0x57F287).setTitle(`${item.emoji} Redeemed!`)
    .setDescription(`Redeemed **${item.name}** for **${item.cost} coins**!\nBalance: **${u.coins.toLocaleString()} coins**\n\n📩 An admin will deliver your reward shortly!`).setTimestamp()] });
}

async function handleInventory(respond, userId, username) {
  const u   = getUser(userId, username);
  const inv = u.inventory||[];
  if (!inv.length) return respond({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('🎒 Inventory is empty! Use `/redeem` to get rewards.')] });
  const list = inv.slice(-10).reverse().map((item,i)=>`**${i+1}.** ${item.name} — <t:${Math.floor(item.claimedAt/1000)}:R>`).join('\n');
  return respond({ embeds: [new EmbedBuilder().setColor(0x9B59B6).setTitle(`🎒 ${username}'s Inventory`).setDescription(list).setFooter({text:`Last ${Math.min(10,inv.length)} of ${inv.length} items`}).setTimestamp()] });
}

async function handleLeaderboard(respond) {
  const top    = getLeaderboard(10);
  const medals = ['🥇','🥈','🥉'];
  const list   = top.map((u,i)=>`${medals[i]||`**${i+1}.**`} <@${u.id}> — **${u.coins.toLocaleString()} coins**`).join('\n');
  return respond({ embeds: [new EmbedBuilder().setColor(0xF1C40F).setTitle('🏆 Coin Leaderboard').setDescription(list||'No data yet!').setTimestamp()] });
}

async function handleHelp(respond) {
  return respond({ embeds: [new EmbedBuilder().setTitle(`📖 Commands — prefix: \`${PREFIX}\``)
    .setColor(0x5865F2)
    .addFields(
      { name: '👤 Economy', value:
        `\`${PREFIX}balance [@user]\` — check balance\n` +
        `\`${PREFIX}daily\` — claim 50 coins\n` +
        `\`${PREFIX}work\` — earn 10–75 coins\n` +
        `\`${PREFIX}coinflip <amount>\` — double or nothing\n` +
        `\`${PREFIX}rain <amount>\` — rain coins on members\n` +
        `\`${PREFIX}shop\` — view rewards\n` +
        `\`${PREFIX}redeem <itemId>\` — redeem a reward\n` +
        `\`${PREFIX}inventory\` — your redeemed items\n` +
        `\`${PREFIX}leaderboard\` — top 10`, inline: false },
      { name: '🔒 Admin', value:
        `\`${PREFIX}give @user <amount>\`\n` +
        `\`${PREFIX}take @user <amount>\`\n` +
        `/update-robux <amount>\n` +
        `/update-etfb <divines/celestials> <amount>`, inline: false },
      { name: '💡 Item IDs for redeem', value: SHOP.map(i=>`\`${i.id}\` — ${i.name}`).join('\n'), inline: false }
    ).setFooter({text:'All commands also available as slash commands!'}).setTimestamp()] });
}

// ══════════════════════════════════════════
//  MESSAGE HANDLER (prefix + coin tracking)
// ══════════════════════════════════════════
client.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.guild) return;

  const uid = msg.author.id;
  const now = Date.now();

  // Coin tracking (10s cooldown)
  if (!msgCooldowns.has(uid) || now - msgCooldowns.get(uid) >= MSG_COOLDOWN_MS) {
    msgCooldowns.set(uid, now);
    const u = getUser(uid, msg.author.username);
    u.coins += COIN_PER_MSG;
    u.totalEarned = (u.totalEarned||0) + COIN_PER_MSG;
    saveUser(u);
  }

  // Prefix command handling
  if (!msg.content.startsWith(PREFIX)) return;
  const args    = msg.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();
  const respond = (payload) => msg.reply(payload);
  const isAdmin = msg.member?.permissions.has(PermissionFlagsBits.Administrator);

  try {
    if (command === 'balance' || command === 'bal') {
      const target = msg.mentions.users.first() || msg.author;
      return await handleBalance(respond, target);
    }
    if (command === 'daily')  return await handleDaily(respond, uid, msg.author.username);
    if (command === 'work')   return await handleWork(respond, uid, msg.author.username);
    if (command === 'shop')   return await handleShop(respond);
    if (command === 'inv' || command === 'inventory') return await handleInventory(respond, uid, msg.author.username);
    if (command === 'lb' || command === 'leaderboard') return await handleLeaderboard(respond);
    if (command === 'help')   return await handleHelp(respond);

    if (command === 'coinflip' || command === 'cf') {
      const amount = parseInt(args[0]);
      if (isNaN(amount) || amount < 1) return respond({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Usage: \`${PREFIX}coinflip <amount>\``)] });
      return await handleCoinflip(respond, uid, msg.author.username, amount);
    }

    if (command === 'rain') {
      const amount = parseInt(args[0]);
      if (isNaN(amount) || amount < 10) return respond({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Usage: \`${PREFIX}rain <amount>\` (min 10)`)] });
      return await handleRain(respond, msg.guild, uid, msg.author.username, amount);
    }

    if (command === 'redeem') {
      if (!args[0]) return respond({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Usage: \`${PREFIX}redeem <itemId>\`\nSee \`${PREFIX}shop\` for item IDs.`)] });
      return await handleRedeem(respond, uid, msg.author.username, args[0].toLowerCase());
    }

    // Admin commands
    if (command === 'give') {
      if (!isAdmin) return respond({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('❌ Admins only!')] });
      const target = msg.mentions.users.first();
      const amount = parseInt(args[1]);
      if (!target || isNaN(amount) || amount < 1) return respond({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Usage: \`${PREFIX}give @user <amount>\``)] });
      const u = getUser(target.id, target.username);
      u.coins+=amount; u.totalEarned=(u.totalEarned||0)+amount; saveUser(u);
      return respond({ embeds: [new EmbedBuilder().setColor(0x57F287).setDescription(`✅ Gave **${amount} coins** to <@${target.id}>. Balance: **${u.coins.toLocaleString()}**`)] });
    }

    if (command === 'take') {
      if (!isAdmin) return respond({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('❌ Admins only!')] });
      const target = msg.mentions.users.first();
      const amount = parseInt(args[1]);
      if (!target || isNaN(amount) || amount < 1) return respond({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Usage: \`${PREFIX}take @user <amount>\``)] });
      const u = getUser(target.id, target.username);
      u.coins=Math.max(0,u.coins-amount); saveUser(u);
      return respond({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription(`✅ Took **${amount} coins** from <@${target.id}>. Balance: **${u.coins.toLocaleString()}**`)] });
    }

  } catch (e) {
    console.error(`Prefix command error (${command}):`, e);
    return respond({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('❌ Something went wrong!')] });
  }
});

// ══════════════════════════════════════════
//  SLASH COMMAND HANDLER
// ══════════════════════════════════════════
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;
  const inv = interaction.user;
  const respond = (payload) => interaction.reply(payload);

  try {
    if (cmd === 'balance')     return await handleBalance(respond, interaction.options.getUser('user') || inv);
    if (cmd === 'daily')       return await handleDaily(respond, inv.id, inv.username);
    if (cmd === 'work')        return await handleWork(respond, inv.id, inv.username);
    if (cmd === 'shop')        return await handleShop(respond);
    if (cmd === 'inventory')   return await handleInventory(respond, inv.id, inv.username);
    if (cmd === 'leaderboard') return await handleLeaderboard(respond);

    if (cmd === 'coinflip') return await handleCoinflip(respond, inv.id, inv.username, interaction.options.getInteger('amount'));
    if (cmd === 'rain')     return await handleRain(respond, interaction.guild, inv.id, inv.username, interaction.options.getInteger('amount'));
    if (cmd === 'redeem')   return await handleRedeem(respond, inv.id, inv.username, interaction.options.getString('item'));

    if (cmd === 'give') {
      const t=interaction.options.getUser('user'), amount=interaction.options.getInteger('amount');
      const u=getUser(t.id,t.username); u.coins+=amount; u.totalEarned=(u.totalEarned||0)+amount; saveUser(u);
      return respond({ embeds: [new EmbedBuilder().setColor(0x57F287).setDescription(`✅ Gave **${amount} coins** to <@${t.id}>. Balance: **${u.coins.toLocaleString()}**`)] });
    }

    if (cmd === 'take') {
      const t=interaction.options.getUser('user'), amount=interaction.options.getInteger('amount');
      const u=getUser(t.id,t.username); u.coins=Math.max(0,u.coins-amount); saveUser(u);
      return respond({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription(`✅ Took **${amount} coins** from <@${t.id}>. Balance: **${u.coins.toLocaleString()}**`)] });
    }

    if (cmd === 'update-robux') {
      const amount=interaction.options.getInteger('amount');
      const store=getStore(); store.robux=amount; saveStore(store);
      await updateStockMessage(client);
      return respond({ embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('✅ Stock Updated').setDescription(`💎 Robux stock set to **${amount}R**. Embed refreshed.`).setTimestamp()] });
    }

    if (cmd === 'update-etfb') {
      const type=interaction.options.getString('type'), amount=interaction.options.getInteger('amount');
      const store=getStore(); store[type]=amount; saveStore(store);
      await updateStockMessage(client);
      const label=type==='divines'?'🌟 Divines':'✨ Celestials';
      return respond({ embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('✅ Stock Updated').setDescription(`${label} set to **${amount}x**. Embed refreshed.`).setTimestamp()] });
    }

  } catch (e) {
    console.error(`/${cmd} error:`, e);
    const err = { embeds: [new EmbedBuilder().setColor(0xED4245).setDescription('❌ Something went wrong!')], ephemeral: true };
    interaction.replied||interaction.deferred ? await interaction.followUp(err) : await interaction.reply(err);
  }
});

client.login(process.env.BOT_TOKEN);
