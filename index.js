const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder
} = require('discord.js');
const fs   = require('fs');
const path = require('path');
require('dotenv').config();

// ══════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════
const STOCK_CHANNEL_ID = '1481026325178220565';
const GUILD_ID         = process.env.GUILD_ID;   // REQUIRED — set in Railway
const PREFIX           = 'u!';
const COIN_COOLDOWN_MS = 60_000; // 1 min between coin grants per user

const SHOP = [
  { id: 'robux_25',   name: '25 Robux',   cost: 100,  category: 'Robux', emoji: '💎' },
  { id: 'robux_50',   name: '50 Robux',   cost: 175,  category: 'Robux', emoji: '💎' },
  { id: 'robux_100',  name: '100 Robux',  cost: 300,  category: 'Robux', emoji: '💎' },
  { id: 'robux_250',  name: '250 Robux',  cost: 650,  category: 'Robux', emoji: '💎' },
  { id: 'robux_500',  name: '500 Robux',  cost: 1200, category: 'Robux', emoji: '💎' },
  { id: 'robux_1000', name: '1000 Robux', cost: 2200, category: 'Robux', emoji: '💎' },
  { id: 'etfb_cel',   name: 'Celestial',  cost: 100,  category: 'ETFB',  emoji: '✨' },
  { id: 'etfb_div',   name: 'Divine',     cost: 250,  category: 'ETFB',  emoji: '🌟' },
];

// ══════════════════════════════════════════
//  DATABASE
// ══════════════════════════════════════════
const DATA_DIR = path.join(__dirname, 'data');
const USERS_F  = path.join(DATA_DIR, 'users.json');
const STORE_F  = path.join(DATA_DIR, 'store.json');
const MSGID_F  = path.join(DATA_DIR, 'msgid.json');
const CLAIMS_F = path.join(DATA_DIR, 'claims.json');
const COUNTER_F= path.join(DATA_DIR, 'counter.json'); // for simple claim IDs

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, def) {
  if (!fs.existsSync(file)) { fs.writeFileSync(file, JSON.stringify(def, null, 2)); return JSON.parse(JSON.stringify(def)); }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return JSON.parse(JSON.stringify(def)); }
}
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// next claim ID: C1, C2, C3 ...
function nextClaimId() {
  const c = readJSON(COUNTER_F, { next: 1 });
  const id = `C${c.next}`;
  c.next += 1;
  writeJSON(COUNTER_F, c);
  return id;
}

function getUser(userId, username) {
  const db = readJSON(USERS_F, {});
  if (!db[userId]) {
    db[userId] = {
      id: userId, username: username || 'Unknown',
      coins: 0, totalEarned: 0,
      lastDaily: null, lastWork: null, lastCoin: 0,
      inventory: [], createdAt: Date.now()
    };
    writeJSON(USERS_F, db);
  }
  return db[userId];
}
function saveUser(u)       { const db = readJSON(USERS_F, {}); db[u.id] = u; writeJSON(USERS_F, db); }
function getLeaderboard(n) { return Object.values(readJSON(USERS_F, {})).sort((a,b)=>b.coins-a.coins).slice(0,n); }
function getStore()        { return readJSON(STORE_F, { robux: 0, divines: 0, celestials: 0 }); }
function saveStore(s)      { writeJSON(STORE_F, s); }
function getMsgIds()       { return readJSON(MSGID_F, { stock: null }); }
function saveMsgIds(d)     { writeJSON(MSGID_F, d); }
function getClaims()       { return readJSON(CLAIMS_F, []); }
function saveClaims(c)     { writeJSON(CLAIMS_F, c); }

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
    .setDescription('Use `/shop` to see prices and `/redeem` or `u!redeem` to purchase!')
    .addFields(
      { name: '💎 Robux',           value: s.robux>0      ? `**${s.robux}R** available`      : '❌ Out of stock', inline: true },
      { name: '✨ ETFB Celestials', value: s.celestials>0 ? `**${s.celestials}x** available` : '❌ Out of stock', inline: true },
      { name: '🌟 ETFB Divines',   value: s.divines>0    ? `**${s.divines}x** available`    : '❌ Out of stock', inline: true }
    )
    .setFooter({ text: 'Stock is updated by admins' })
    .setTimestamp();
}

async function updateStockMessage(client) {
  try {
    const ch = await client.channels.fetch(STOCK_CHANNEL_ID);
    if (!ch) return;
    const embed = buildStockEmbed();
    const ids   = getMsgIds();
    if (ids.stock) {
      try { const m = await ch.messages.fetch(ids.stock); await m.edit({ embeds: [embed] }); return; }
      catch { /* deleted — send new */ }
    }
    const sent = await ch.send({ embeds: [embed] });
    ids.stock = sent.id;
    saveMsgIds(ids);
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
  new SlashCommandBuilder().setName('shop').setDescription('View all rewards and prices'),
  new SlashCommandBuilder().setName('redeem').setDescription('Buy a reward — goes to your inventory').addStringOption(o=>
    o.setName('item').setDescription('Item to buy').setRequired(true).addChoices(
      { name: '💎 25 Robux — 100 coins',    value: 'robux_25'   },
      { name: '💎 50 Robux — 175 coins',    value: 'robux_50'   },
      { name: '💎 100 Robux — 300 coins',   value: 'robux_100'  },
      { name: '💎 250 Robux — 650 coins',   value: 'robux_250'  },
      { name: '💎 500 Robux — 1200 coins',  value: 'robux_500'  },
      { name: '💎 1000 Robux — 2200 coins', value: 'robux_1000' },
      { name: '✨ Celestial ETFB — 100 coins', value: 'etfb_cel' },
      { name: '🌟 Divine ETFB — 250 coins',    value: 'etfb_div' }
    )
  ),
  new SlashCommandBuilder().setName('inventory').setDescription('View items in your inventory'),
  new SlashCommandBuilder().setName('claim').setDescription('Submit a claim for an item in your inventory').addStringOption(o=>o.setName('id').setDescription('Claim ID from your inventory (e.g. C1)').setRequired(true)),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Top 10 richest members'),
  new SlashCommandBuilder().setName('adminhelp').setDescription('View admin commands').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('claims').setDescription('[ADMIN] View all pending claims').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('claimed').setDescription('[ADMIN] Mark a claim fulfilled and DM the user').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o=>o.setName('id').setDescription('Claim ID (e.g. C1)').setRequired(true)),
  new SlashCommandBuilder().setName('update-robux').setDescription('[ADMIN] Update Robux stock').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addIntegerOption(o=>o.setName('amount').setDescription('New Robux amount in stock').setRequired(true).setMinValue(0)),
  new SlashCommandBuilder().setName('update-etfb').setDescription('[ADMIN] Update ETFB stock').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o=>o.setName('type').setDescription('Which item').setRequired(true).addChoices({name:'Divines',value:'divines'},{name:'Celestials',value:'celestials'}))
    .addIntegerOption(o=>o.setName('amount').setDescription('New amount').setRequired(true).setMinValue(0)),
  new SlashCommandBuilder().setName('give').setDescription('[ADMIN] Give coins to a user').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o=>o.setName('user').setDescription('Target').setRequired(true))
    .addIntegerOption(o=>o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('take').setDescription('[ADMIN] Take coins from a user').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o=>o.setName('user').setDescription('Target').setRequired(true))
    .addIntegerOption(o=>o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)),
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

// in-memory cooldown map (resets on restart, that's fine)
const coinCooldowns = new Map();

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  if (!GUILD_ID) {
    console.error('❌ GUILD_ID is not set! Slash commands will not register. Add GUILD_ID to Railway variables.');
    process.exit(1);
  }

  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  try {
    // IMPORTANT: clear global commands so no duplicates appear
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
    // Register only to this guild — instant, no duplicates
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: slashCommands });
    console.log(`✅ Slash commands registered to guild ${GUILD_ID} (instant)`);
  } catch (e) { console.error('Command registration error:', e); }

  await updateStockMessage(client);
});

// ══════════════════════════════════════════
//  COIN TRACKING — 1 message = 1 coin
//  Uses in-memory Map for cooldown (fast)
//  lastCoin saved to DB so coins persist
// ══════════════════════════════════════════
client.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.guild) return;

  const uid = msg.author.id;
  const now = Date.now();

  // Check in-memory cooldown first (fast path)
  const lastCoinTime = coinCooldowns.get(uid) || 0;
  if (now - lastCoinTime < COIN_COOLDOWN_MS) {
    // still on cooldown — no coin but still process prefix command below
  } else {
    // Grant 1 coin
    coinCooldowns.set(uid, now);
    const u = getUser(uid, msg.author.username);
    u.coins += 1;
    u.totalEarned = (u.totalEarned || 0) + 1;
    u.lastCoin = now;
    saveUser(u);
  }

  // ── PREFIX COMMANDS ──────────────────
  if (!msg.content.startsWith(PREFIX)) return;
  const args    = msg.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();
  const reply   = (payload) => msg.reply(payload);
  const isAdmin = msg.member?.permissions.has(PermissionFlagsBits.Administrator);

  try {
    if (command==='balance'||command==='bal') {
      const target = msg.mentions.users.first() || msg.author;
      return await cmdBalance(reply, target);
    }
    if (command==='daily')       return await cmdDaily(reply, uid, msg.author.username);
    if (command==='work')        return await cmdWork(reply, uid, msg.author.username);
    if (command==='shop')        return await cmdShop(reply);
    if (command==='inventory')   return await cmdInventory(reply, uid, msg.author.username);
    if (command==='lb'||command==='leaderboard') return await cmdLeaderboard(reply);
    if (command==='help')        return await cmdHelp(reply);
    if (command==='adminhelp' && isAdmin) return await cmdAdminHelp(reply);

    if (command==='coinflip'||command==='cf') {
      const amt = parseInt(args[0]);
      if (isNaN(amt)||amt<1) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Usage: \`${PREFIX}coinflip <amount>\``)] });
      return await cmdCoinflip(reply, uid, msg.author.username, amt);
    }
    if (command==='rain') {
      const amt = parseInt(args[0]);
      if (isNaN(amt)||amt<10) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Usage: \`${PREFIX}rain <amount>\` (min 10)`)] });
      return await cmdRain(reply, msg.guild, uid, msg.author.username, amt);
    }
    if (command==='redeem') {
      if (!args[0]) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Usage: \`${PREFIX}redeem <itemId>\` — see \`${PREFIX}shop\` for IDs`)] });
      return await cmdRedeem(reply, uid, msg.author.username, args[0].toLowerCase());
    }
    if (command==='give' && isAdmin) {
      const t=msg.mentions.users.first(), amt=parseInt(args[1]);
      if (!t||isNaN(amt)||amt<1) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Usage: \`${PREFIX}give @user <amount>\``)] });
      const u=getUser(t.id,t.username); u.coins+=amt; u.totalEarned=(u.totalEarned||0)+amt; saveUser(u);
      return reply({ embeds:[new EmbedBuilder().setColor(0x57F287).setDescription(`✅ Gave **${amt} coins** to <@${t.id}>. Balance: **${u.coins.toLocaleString()}**`)] });
    }
    if (command==='take' && isAdmin) {
      const t=msg.mentions.users.first(), amt=parseInt(args[1]);
      if (!t||isNaN(amt)||amt<1) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Usage: \`${PREFIX}take @user <amount>\``)] });
      const u=getUser(t.id,t.username); u.coins=Math.max(0,u.coins-amt); saveUser(u);
      return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`✅ Took **${amt} coins** from <@${t.id}>. Balance: **${u.coins.toLocaleString()}**`)] });
    }
  } catch(e) {
    console.error(`Prefix ${command} error:`, e);
    return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription('❌ Something went wrong!')] });
  }
});

// ══════════════════════════════════════════
//  COMMAND FUNCTIONS
// ══════════════════════════════════════════
async function cmdBalance(reply, targetUser) {
  const u = getUser(targetUser.id, targetUser.username);
  return reply({ embeds:[new EmbedBuilder().setTitle(`🪙 ${targetUser.username}'s Balance`).setColor(0xF1C40F)
    .setThumbnail(targetUser.displayAvatarURL())
    .addFields(
      { name:'💰 Coins',        value:`**${u.coins.toLocaleString()}**`,              inline:true },
      { name:'📈 Total Earned', value:`${(u.totalEarned||0).toLocaleString()} coins`, inline:true },
      { name:'🎒 Inventory',    value:`${(u.inventory||[]).length} item(s)`,          inline:true }
    ).setTimestamp()] });
}

async function cmdDaily(reply, userId, username) {
  const u=getUser(userId, username);
  const cd=24*60*60*1000, now=Date.now();
  if (u.lastDaily && now-u.lastDaily<cd)
    return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`⏰ Come back in **${fmt(cd-(now-u.lastDaily))}** for your daily!`)] });
  u.coins+=50; u.totalEarned=(u.totalEarned||0)+50; u.lastDaily=now; saveUser(u);
  return reply({ embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('🎁 Daily Claimed!').setDescription(`You received **50 coins**!\nBalance: **${u.coins.toLocaleString()} coins**`).setTimestamp()] });
}

async function cmdWork(reply, userId, username) {
  const u=getUser(userId, username);
  const cd=60*60*1000, now=Date.now();
  if (u.lastWork && now-u.lastWork<cd)
    return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`⏰ Too tired! Work again in **${fmt(cd-(now-u.lastWork))}**`)] });
  const jobs=[
    {name:'Pizza Delivery',r:[15,35],e:'🍕'},{name:'Dog Walker',r:[10,30],e:'🐕'},
    {name:'Streamer',r:[20,50],e:'🎮'},{name:'Trader',r:[25,60],e:'📈'},
    {name:'YouTuber',r:[30,70],e:'📹'},{name:'Miner',r:[15,40],e:'⛏️'},
    {name:'Hacker',r:[35,75],e:'💻'},{name:'Chef',r:[20,45],e:'👨‍🍳'},
    {name:'Fisherman',r:[10,35],e:'🎣'},
  ];
  const job=jobs[Math.floor(Math.random()*jobs.length)];
  const earned=Math.floor(Math.random()*(job.r[1]-job.r[0]+1))+job.r[0];
  u.coins+=earned; u.totalEarned=(u.totalEarned||0)+earned; u.lastWork=now; saveUser(u);
  return reply({ embeds:[new EmbedBuilder().setColor(0x57F287).setTitle(`${job.e} Work Complete!`).setDescription(`You worked as a **${job.name}** and earned **${earned} coins**!\nBalance: **${u.coins.toLocaleString()} coins**`).setTimestamp()] });
}

async function cmdCoinflip(reply, userId, username, amount) {
  const u=getUser(userId, username);
  if (u.coins<amount) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ You only have **${u.coins} coins**!`)] });
  const win=Math.random()<0.5;
  u.coins+=win?amount:-amount;
  if(win) u.totalEarned=(u.totalEarned||0)+amount;
  saveUser(u);
  return reply({ embeds:[new EmbedBuilder().setColor(win?0x57F287:0xED4245).setTitle(win?'🟡 Heads — You Win!':'⚫ Tails — You Lose!')
    .setDescription(win?`Won **${amount} coins**! 🎉\nBalance: **${u.coins.toLocaleString()}**`:`Lost **${amount} coins**. 💸\nBalance: **${u.coins.toLocaleString()}**`).setTimestamp()] });
}

async function cmdRain(reply, guild, senderId, senderUsername, amount) {
  const sender=getUser(senderId, senderUsername);
  if (sender.coins<amount) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ You only have **${sender.coins} coins**!`)] });
  await guild.members.fetch();
  const pool=[...guild.members.cache.filter(m=>!m.user.bot&&m.user.id!==senderId).values()];
  const picks=pool.sort(()=>0.5-Math.random()).slice(0,Math.min(5,pool.length));
  if (!picks.length) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription('❌ No eligible members!')] });
  const per=Math.floor(amount/picks.length);
  sender.coins-=per*picks.length; saveUser(sender);
  const names=picks.map(m=>{ const u=getUser(m.user.id,m.user.username); u.coins+=per; u.totalEarned=(u.totalEarned||0)+per; saveUser(u); return `<@${m.user.id}>`; });
  return reply({ embeds:[new EmbedBuilder().setColor(0x3498DB).setTitle('🌧️ Coin Rain!')
    .setDescription(`<@${senderId}> rained **${per*picks.length} coins** across **${picks.length} members**!\nEach got **${per} coins**: ${names.join(' ')}`).setTimestamp()] });
}

async function cmdShop(reply) {
  return reply({ embeds:[new EmbedBuilder().setTitle('🏪 Rewards Shop').setColor(0x9B59B6)
    .setDescription(`Use \`/redeem\` or \`${PREFIX}redeem <id>\` to buy. Items go to inventory, then use \`/claim\` or \`${PREFIX}claim <id>\`.`)
    .addFields(
      { name:'💎 Robux', value:SHOP.filter(i=>i.category==='Robux').map(i=>`${i.emoji} **${i.name}** — \`${i.cost} coins\`  ID: \`${i.id}\``).join('\n'), inline:false },
      { name:'🎮 ETFB',  value:SHOP.filter(i=>i.category==='ETFB').map(i=>`${i.emoji} **${i.name}** — \`${i.cost} coins\`  ID: \`${i.id}\``).join('\n'), inline:false },
      { name:'💡 Earn coins', value:`💬 1 msg per min = 1 coin\n📅 \`${PREFIX}daily\` = 50 coins\n💼 \`${PREFIX}work\` = 10–75 coins\n🪙 \`${PREFIX}coinflip\` = double or nothing`, inline:false }
    ).setTimestamp()] });
}

async function cmdInventory(reply, userId, username) {
  const u=getUser(userId, username);
  const inv=u.inventory||[];
  if (!inv.length) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`🎒 Your inventory is empty! Use \`${PREFIX}redeem <id>\` or \`/redeem\` to buy items.`)] });
  const list=inv.map(item=>
    `${item.emoji} **${item.name}** — Claim ID: \`${item.claimId}\`\n> Bought <t:${Math.floor(item.purchasedAt/1000)}:R> • Type \`/claim ${item.claimId}\` to submit`
  ).join('\n\n');
  return reply({ embeds:[new EmbedBuilder().setColor(0x9B59B6).setTitle(`🎒 ${username}'s Inventory`)
    .setDescription(list).setFooter({text:`${inv.length} item(s) — use /claim <id> to submit`}).setTimestamp()] });
}

async function cmdLeaderboard(reply) {
  const top=getLeaderboard(10);
  const medals=['🥇','🥈','🥉'];
  const list=top.map((u,i)=>`${medals[i]||`**${i+1}.**`} <@${u.id}> — **${u.coins.toLocaleString()} coins**`).join('\n');
  return reply({ embeds:[new EmbedBuilder().setColor(0xF1C40F).setTitle('🏆 Coin Leaderboard').setDescription(list||'No data yet!').setTimestamp()] });
}

async function cmdHelp(reply) {
  return reply({ embeds:[new EmbedBuilder().setTitle(`📖 Commands — Prefix: \`${PREFIX}\``).setColor(0x5865F2)
    .addFields(
      { name:'💰 Economy', value:
        `\`${PREFIX}balance [@user]\` — check coins\n`+
        `\`${PREFIX}daily\` — claim 50 coins (24h)\n`+
        `\`${PREFIX}work\` — earn 10–75 coins (1h)\n`+
        `\`${PREFIX}coinflip <amount>\` — double or nothing\n`+
        `\`${PREFIX}rain <amount>\` — rain coins on members\n`+
        `\`${PREFIX}leaderboard\` — top 10`, inline:false },
      { name:'🛒 Shop & Rewards', value:
        `\`${PREFIX}shop\` — view items & prices\n`+
        `\`${PREFIX}redeem <itemId>\` — buy → goes to inventory\n`+
        `\`${PREFIX}inventory\` — view your items\n`+
        `\`/claim <id>\` — submit claim for delivery`, inline:false },
      { name:'💡 All commands also work as slash commands!', value:'\u200b', inline:false }
    ).setTimestamp()] });
}

async function cmdAdminHelp(reply) {
  return reply({ embeds:[new EmbedBuilder().setTitle('🔒 Admin Commands').setColor(0xFF6B35)
    .addFields(
      { name:'📦 Stock', value:
        `/update-robux <amount>\n`+
        `/update-etfb <divines|celestials> <amount>`, inline:false },
      { name:'👥 Users', value:
        `/give @user <amount>  or  \`${PREFIX}give @user <amount>\`\n`+
        `/take @user <amount>  or  \`${PREFIX}take @user <amount>\``, inline:false },
      { name:'📋 Claims', value:
        `/claims — see all pending claims\n`+
        `/claimed <id> — mark fulfilled + DM user`, inline:false }
    ).setTimestamp()] });
}

// ══════════════════════════════════════════
//  REDEEM — deducts coins, adds to inventory
// ══════════════════════════════════════════
async function cmdRedeem(reply, userId, username, itemId) {
  const item=SHOP.find(i=>i.id===itemId);
  const u=getUser(userId, username);
  if (!item) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Invalid item ID. Use \`${PREFIX}shop\` to see valid IDs.`)] });
  if (u.coins<item.cost) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Need **${item.cost} coins**, you have **${u.coins}**!`)] });

  const store=getStore();
  const robuxAmt=item.id.startsWith('robux') ? parseInt(item.id.replace('robux_','')) : 0;
  if (item.id==='etfb_cel' && store.celestials<=0) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription('❌ Celestials are out of stock!')] });
  if (item.id==='etfb_div' && store.divines<=0)    return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription('❌ Divines are out of stock!')] });
  if (item.id.startsWith('robux') && store.robux<robuxAmt) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Only **${store.robux}R** in stock, not enough for ${item.name}!`)] });

  if (item.id==='etfb_cel')             store.celestials=Math.max(0,store.celestials-1);
  else if (item.id==='etfb_div')        store.divines=Math.max(0,store.divines-1);
  else if (item.id.startsWith('robux')) store.robux=Math.max(0,store.robux-robuxAmt);
  saveStore(store);
  await updateStockMessage(client);

  u.coins-=item.cost;
  u.inventory=u.inventory||[];
  const claimId=nextClaimId();
  u.inventory.push({ claimId, itemId:item.id, name:item.name, emoji:item.emoji, category:item.category, cost:item.cost, purchasedAt:Date.now() });
  saveUser(u);

  return reply({ embeds:[new EmbedBuilder().setColor(0x57F287).setTitle(`${item.emoji} Added to Inventory!`)
    .setDescription(
      `**${item.name}** has been added to your inventory!\n`+
      `Remaining balance: **${u.coins.toLocaleString()} coins**\n\n`+
      `📬 Your Claim ID is \`${claimId}\`\nType \`/claim ${claimId}\` to submit your delivery request!`
    ).setTimestamp()] });
}

// ══════════════════════════════════════════
//  CLAIM — opens modal to collect details
// ══════════════════════════════════════════
async function openClaimModal(interaction, claimIdArg) {
  const userId=interaction.user.id;
  const u=getUser(userId, interaction.user.username);
  const inv=u.inventory||[];
  const invItem=inv.find(i=>i.claimId===claimIdArg.toUpperCase());

  if (!invItem) {
    const payload={ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ No item with ID \`${claimIdArg.toUpperCase()}\` in your inventory.\nUse \`/inventory\` to check.`)], ephemeral:true };
    return interaction.replied||interaction.deferred ? interaction.followUp(payload) : interaction.reply(payload);
  }

  const modal=new ModalBuilder().setCustomId(`claim_modal_${invItem.claimId}`).setTitle(`Claim: ${invItem.name}`);
  const usernameRow=new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('roblox_username').setLabel('Your Roblox Username').setStyle(TextInputStyle.Short).setPlaceholder('e.g. Builderman').setRequired(true)
  );
  modal.addComponents(usernameRow);
  if (invItem.category==='Robux') {
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('gamepass_link').setLabel('Gamepass Link (set it to 1 Robux)').setStyle(TextInputStyle.Short).setPlaceholder('https://www.roblox.com/game-pass/...').setRequired(true)
    ));
  }
  await interaction.showModal(modal);
}

// ══════════════════════════════════════════
//  INTERACTION HANDLER
// ══════════════════════════════════════════
client.on('interactionCreate', async interaction => {

  // ── MODAL SUBMIT ──────────────────────
  if (interaction.isModalSubmit()) {
    if (!interaction.customId.startsWith('claim_modal_')) return;
    const claimId=interaction.customId.replace('claim_modal_','');
    const userId=interaction.user.id;
    const u=getUser(userId, interaction.user.username);
    const inv=u.inventory||[];
    const idx=inv.findIndex(i=>i.claimId===claimId);

    if (idx===-1) return interaction.reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription('❌ Item not found in your inventory.')], ephemeral:true });

    const invItem=inv[idx];
    const robloxUsername=interaction.fields.getTextInputValue('roblox_username').trim();
    const gamepaskLink=invItem.category==='Robux' ? interaction.fields.getTextInputValue('gamepass_link').trim() : null;

    // Save claim to claims.json
    const claims=getClaims();
    claims.push({
      claimId, userId,
      username: interaction.user.username,
      itemId: invItem.itemId,
      itemName: invItem.name,
      category: invItem.category,
      robloxUsername,
      gamepaskLink: gamepaskLink||null,
      claimedAt: Date.now(),
      status: 'pending'
    });
    saveClaims(claims);

    // Remove from inventory
    u.inventory.splice(idx,1);
    saveUser(u);

    return interaction.reply({ embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('📬 Claim Submitted!')
      .setDescription(
        `Your claim for **${invItem.name}** has been submitted!\n\n`+
        `**Claim ID:** \`${claimId}\`\n`+
        `**Roblox Username:** \`${robloxUsername}\`\n`+
        (gamepaskLink?`**Gamepass:** ${gamepaskLink}\n`:'')+
        `\n✅ An admin will process your claim shortly!`
      ).setTimestamp()], ephemeral:true });
  }

  if (!interaction.isChatInputCommand()) return;
  const cmd=interaction.commandName;
  const me=interaction.user;
  const reply=(p)=>interaction.reply(p);

  try {
    if (cmd==='balance')     return await cmdBalance(reply, interaction.options.getUser('user')||me);
    if (cmd==='daily')       return await cmdDaily(reply, me.id, me.username);
    if (cmd==='work')        return await cmdWork(reply, me.id, me.username);
    if (cmd==='shop')        return await cmdShop(reply);
    if (cmd==='inventory')   return await cmdInventory(reply, me.id, me.username);
    if (cmd==='leaderboard') return await cmdLeaderboard(reply);
    if (cmd==='adminhelp')   return await cmdAdminHelp(reply);
    if (cmd==='coinflip') return await cmdCoinflip(reply, me.id, me.username, interaction.options.getInteger('amount'));
    if (cmd==='rain')     return await cmdRain(reply, interaction.guild, me.id, me.username, interaction.options.getInteger('amount'));
    if (cmd==='redeem')   return await cmdRedeem(reply, me.id, me.username, interaction.options.getString('item'));
    if (cmd==='claim')    return await openClaimModal(interaction, interaction.options.getString('id'));

    // /claims — list pending
    if (cmd==='claims') {
      const pending=getClaims().filter(c=>c.status==='pending');
      if (!pending.length) return reply({ embeds:[new EmbedBuilder().setColor(0x57F287).setDescription('✅ No pending claims!')], ephemeral:true });

      // Split into chunks if too long
      const lines=pending.map(c=>
        `\`${c.claimId}\` • ${c.itemName} • <@${c.userId}> • Roblox: **${c.robloxUsername}**`+
        (c.gamepaskLink?`\n> 🔗 ${c.gamepaskLink}`:'')+
        `\n> Submitted <t:${Math.floor(c.claimedAt/1000)}:R>`
      );
      const chunks=[];
      let cur='';
      for (const l of lines) {
        if (cur.length+l.length+2>3800) { chunks.push(cur); cur=''; }
        cur+=l+'\n\n';
      }
      if (cur) chunks.push(cur);
      const embeds=chunks.map((ch,i)=>new EmbedBuilder()
        .setColor(0xFF6B35)
        .setTitle(i===0?`📋 Pending Claims (${pending.length})`:'📋 (continued)')
        .setDescription(ch)
        .setFooter({text:'Use /claimed <id> to mark as fulfilled'})
        .setTimestamp()
      );
      return reply({ embeds, ephemeral:true });
    }

    // /claimed — mark fulfilled
    if (cmd==='claimed') {
      const claimId=interaction.options.getString('id').toUpperCase();
      const claims=getClaims();
      const idx=claims.findIndex(c=>c.claimId===claimId);
      if (idx===-1) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Claim \`${claimId}\` not found.`)], ephemeral:true });
      if (claims[idx].status==='fulfilled') return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Claim \`${claimId}\` is already fulfilled.`)], ephemeral:true });

      claims[idx].status='fulfilled';
      claims[idx].fulfilledAt=Date.now();
      claims[idx].fulfilledBy=me.username;
      saveClaims(claims);

      const claim=claims[idx];
      let dmText='';
      if (claim.category==='Robux') {
        dmText=`✅ Your **${claim.itemName}** reward has been sent!\n\nWe purchased your gamepass — check your Roblox account. If you have any issues, contact a server admin.`;
      } else {
        dmText=`✅ Your **${claim.itemName} (ETFB)** reward is ready!\n\n**vru4447** has sent you a friend request on Roblox. Accept it — they will join your game and send you the reward!`;
      }

      let dmSent=false;
      try {
        const targetUser=await client.users.fetch(claim.userId);
        await targetUser.send({ embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('🎉 Reward Delivered!')
          .setDescription(dmText)
          .addFields(
            { name:'Claim ID', value:`\`${claimId}\``, inline:true },
            { name:'Item',     value:claim.itemName,   inline:true },
            { name:'Roblox Username', value:claim.robloxUsername, inline:true }
          ).setTimestamp()] });
        dmSent=true;
      } catch(e) { console.error('Failed to DM user:', e.message); }

      return reply({ embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('✅ Claim Fulfilled')
        .setDescription(
          `Claim \`${claimId}\` marked as fulfilled.\n`+
          `**User:** <@${claim.userId}> (${claim.robloxUsername})\n`+
          `**Item:** ${claim.itemName}\n`+
          `**DM sent:** ${dmSent?'✅ Yes':'❌ Failed (user may have DMs off)'}`
        ).setTimestamp()] });
    }

    if (cmd==='give') {
      const t=interaction.options.getUser('user'), amt=interaction.options.getInteger('amount');
      const u=getUser(t.id,t.username); u.coins+=amt; u.totalEarned=(u.totalEarned||0)+amt; saveUser(u);
      return reply({ embeds:[new EmbedBuilder().setColor(0x57F287).setDescription(`✅ Gave **${amt} coins** to <@${t.id}>. Balance: **${u.coins.toLocaleString()}**`)] });
    }
    if (cmd==='take') {
      const t=interaction.options.getUser('user'), amt=interaction.options.getInteger('amount');
      const u=getUser(t.id,t.username); u.coins=Math.max(0,u.coins-amt); saveUser(u);
      return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`✅ Took **${amt} coins** from <@${t.id}>. Balance: **${u.coins.toLocaleString()}**`)] });
    }
    if (cmd==='update-robux') {
      const amt=interaction.options.getInteger('amount');
      const store=getStore(); store.robux=amt; saveStore(store);
      await updateStockMessage(client);
      return reply({ embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('✅ Stock Updated').setDescription(`💎 Robux stock set to **${amt}R**. Embed refreshed.`).setTimestamp()] });
    }
    if (cmd==='update-etfb') {
      const type=interaction.options.getString('type'), amt=interaction.options.getInteger('amount');
      const store=getStore(); store[type]=amt; saveStore(store);
      await updateStockMessage(client);
      const label=type==='divines'?'🌟 Divines':'✨ Celestials';
      return reply({ embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('✅ Stock Updated').setDescription(`${label} set to **${amt}x**. Embed refreshed.`).setTimestamp()] });
    }

  } catch(e) {
    console.error(`/${cmd} error:`, e);
    const err={ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription('❌ Something went wrong!')], ephemeral:true };
    interaction.replied||interaction.deferred ? await interaction.followUp(err) : await interaction.reply(err);
  }
});

client.login(process.env.BOT_TOKEN);
