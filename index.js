const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder
} = require('discord.js');
const fetch = require('node-fetch');
require('dotenv').config();

// ══════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════
const STOCK_CHANNEL_ID = '1481026325178220565';
const GUILD_ID         = process.env.GUILD_ID;
const JSONBIN_KEY      = process.env.JSONBIN_KEY;
const PREFIX           = 'u!';
const COIN_COOLDOWN_MS = 60_000; // 1 min cooldown between coin grants

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
//  JSONBIN API — hardcoded bin IDs
// ══════════════════════════════════════════
const BIN_IDS = {
  users:  '69b13ea5c3097a1dd516fe70',
  store:  '69b13e7dc3097a1dd516fdc5',
  meta:   '69b13e8fb7ec241ddc5c5aa3',
  claims: '69b13ebbb7ec241ddc5c5b4b',
};

async function binRead(name) {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${BIN_IDS[name]}/latest`, {
    method: 'GET',
    headers: {
      'X-Master-Key': JSONBIN_KEY,
      'X-Bin-Versioning': 'false',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`JSONBin READ "${name}" → ${res.status}: ${text}`);
  }
  const result = await res.json();
  return result.record;
}

async function binWrite(name, data) {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${BIN_IDS[name]}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Master-Key': JSONBIN_KEY,
      'X-Bin-Versioning': 'false',
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`JSONBin WRITE "${name}" → ${res.status}: ${text}`);
  }
}

// ══════════════════════════════════════════
//  IN-MEMORY CACHE
//  Reads from JSONBin on demand, writes back
//  immediately. Cache prevents hammering the
//  API on every single message.
// ══════════════════════════════════════════
let cache = {
  users:  null,
  store:  null,
  meta:   null,
  claims: null,
};

// How long to hold cache before re-reading (ms)
const CACHE_TTL = { users: 0, store: 30_000, meta: 30_000, claims: 30_000 };
let cacheTime = { users: 0, store: 0, meta: 0, claims: 0 };

const BIN_DEFAULTS = {
  users:  {},
  store:  { robux: 0, divines: 0, celestials: 0 },
  meta:   { stockMsgId: null, claimCounter: 0 },
  claims: [],
};

async function read(name) {
  const now = Date.now();
  if (cache[name] !== null && (now - cacheTime[name]) < (CACHE_TTL[name] || 0)) {
    return cache[name];
  }
  let data = await binRead(name);
  // Handle placeholder {"a":"b"} that JSONBin forced us to use
  if (data && data.a === 'b') data = BIN_DEFAULTS[name];
  // Handle null/undefined
  if (data === null || data === undefined) data = BIN_DEFAULTS[name];
  // Unwrap empty wrapper
  if (data && data._empty === true) data = data._data;
  cache[name] = data;
  cacheTime[name] = now;
  return cache[name];
}

async function write(name, data) {
  cache[name] = data;
  cacheTime[name] = Date.now();
  // JSONBin rejects bare empty objects/arrays — wrap them
  let payload = data;
  if (Array.isArray(data) && data.length === 0) payload = { _empty: true, _data: [] };
  else if (typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0) payload = { _empty: true, _data: {} };
  await binWrite(name, payload);
}

// ── user helpers ──────────────────────────
async function getUser(userId, username) {
  const users = await read('users');
  if (!users[userId]) {
    users[userId] = {
      id: userId, username: username || 'Unknown',
      coins: 0, totalEarned: 0,
      lastDaily: null, lastWork: null,
      inventory: [], createdAt: Date.now()
    };
    await write('users', users);
  }
  return users[userId];
}

async function saveUser(user) {
  const users = await read('users');
  users[user.id] = user;
  await write('users', users);
}

async function getLeaderboard(n) {
  const users = await read('users');
  return Object.values(users).sort((a,b)=>b.coins-a.coins).slice(0,n);
}

// ── store helpers ─────────────────────────
async function getStore() { return read('store'); }
async function saveStore(s) { await write('store', s); }

// ── meta helpers (stockMsgId + claimCounter)
async function getMeta() { return read('meta'); }
async function saveMeta(m) { await write('meta', m); }

async function nextClaimId() {
  const meta = await getMeta();
  meta.claimCounter = (meta.claimCounter || 0) + 1;
  await saveMeta(meta);
  return `C${meta.claimCounter}`;
}

// ── claims helpers ────────────────────────
async function getClaims() { return read('claims'); }
async function saveClaims(c) { await write('claims', c); }

// ══════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════
function fmt(ms) {
  const s=Math.floor(ms/1000), m=Math.floor(s/60), h=Math.floor(m/60);
  return h>0?`${h}h ${m%60}m`:m>0?`${m}m ${s%60}s`:`${s}s`;
}

function buildStockEmbed(store) {
  return new EmbedBuilder()
    .setTitle('🏪 Current Stock')
    .setColor(0x5865F2)
    .setDescription('Use `/shop` to see prices and `/redeem` or `u!redeem` to purchase!')
    .addFields(
      { name: '💎 Robux',           value: store.robux>0      ? `**${store.robux}** available`      : '❌ Out of stock', inline: true },
      { name: '✨ ETFB Celestials', value: store.celestials>0 ? `**${store.celestials}x** available` : '❌ Out of stock', inline: true },
      { name: '🌟 ETFB Divines',   value: store.divines>0    ? `**${store.divines}x** available`    : '❌ Out of stock', inline: true }
    )
    .setFooter({ text: 'Stock is updated by admins' })
    .setTimestamp();
}

async function updateStockMessage(clientRef) {
  try {
    const ch = await clientRef.channels.fetch(STOCK_CHANNEL_ID);
    if (!ch) return;
    const store = await getStore();
    const embed = buildStockEmbed(store);
    const meta  = await getMeta();

    if (meta.stockMsgId) {
      try {
        const m = await ch.messages.fetch(meta.stockMsgId);
        await m.edit({ embeds: [embed] });
        return;
      } catch { /* message deleted — send new one */ }
    }
    const sent = await ch.send({ embeds: [embed] });
    meta.stockMsgId = sent.id;
    await saveMeta(meta);
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

// In-memory coin cooldown — 1 coin per minute per user
const coinCooldowns = new Map();

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  if (!GUILD_ID)    { console.error('❌ GUILD_ID missing from env'); process.exit(1); }
  if (!JSONBIN_KEY) { console.error('❌ JSONBIN_KEY missing from env'); process.exit(1); }

  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  try {
    // Clear global commands
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });

    // Wipe commands from every guild (removes duplicates from old guild IDs)
    for (const guild of client.guilds.cache.values()) {
      try {
        await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: [] });
        console.log(`✅ Cleared commands in: ${guild.name}`);
      } catch(e) { console.error(`Failed to clear ${guild.id}:`, e.message); }
    }

    // Register fresh to target guild only
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: slashCommands });
    console.log(`✅ Slash commands registered to guild ${GUILD_ID}`);
  } catch (e) { console.error('Command registration error:', e); }

  await updateStockMessage(client);
});

// ══════════════════════════════════════════
//  MESSAGE — coin tracking + prefix commands
// ══════════════════════════════════════════
client.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.guild) return;

  const uid = msg.author.id;
  const now = Date.now();

  // 1 coin per minute per user
  const last = coinCooldowns.get(uid) || 0;
  if (now - last >= COIN_COOLDOWN_MS) {
    coinCooldowns.set(uid, now);
    try {
      const u = await getUser(uid, msg.author.username);
      u.coins += 1;
      u.totalEarned = (u.totalEarned || 0) + 1;
      await saveUser(u);
    } catch(e) { console.error('Coin grant error:', e.message); }
  }

  if (!msg.content.startsWith(PREFIX)) return;

  const args    = msg.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();
  const reply   = p => msg.reply(p);
  const isAdmin = msg.member?.permissions.has(PermissionFlagsBits.Administrator);

  try {
    if (command==='balance'||command==='bal') return await cmdBalance(reply, msg.mentions.users.first()||msg.author);
    if (command==='daily')       return await cmdDaily(reply, uid, msg.author.username);
    if (command==='work')        return await cmdWork(reply, uid, msg.author.username);
    if (command==='shop')        return await cmdShop(reply);
    if (command==='inventory')   return await cmdInventory(reply, uid, msg.author.username);
    if (command==='lb'||command==='leaderboard') return await cmdLeaderboard(reply);
    if (command==='help')        return await cmdHelp(reply);
    if (command==='adminhelp' && isAdmin) return await cmdAdminHelp(reply);

    if (command==='coinflip'||command==='cf') {
      const amt=parseInt(args[0]);
      if (isNaN(amt)||amt<1) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Usage: \`${PREFIX}coinflip <amount>\``)] });
      return await cmdCoinflip(reply, uid, msg.author.username, amt);
    }
    if (command==='rain') {
      const amt=parseInt(args[0]);
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
      const u=await getUser(t.id,t.username); u.coins+=amt; u.totalEarned=(u.totalEarned||0)+amt; await saveUser(u);
      return reply({ embeds:[new EmbedBuilder().setColor(0x57F287).setDescription(`✅ Gave **${amt} coins** to <@${t.id}>. Balance: **${u.coins.toLocaleString()}**`)] });
    }
    if (command==='take' && isAdmin) {
      const t=msg.mentions.users.first(), amt=parseInt(args[1]);
      if (!t||isNaN(amt)||amt<1) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Usage: \`${PREFIX}take @user <amount>\``)] });
      const u=await getUser(t.id,t.username); u.coins=Math.max(0,u.coins-amt); await saveUser(u);
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
  const u = await getUser(targetUser.id, targetUser.username);
  return reply({ embeds:[new EmbedBuilder().setTitle(`🪙 ${targetUser.username}'s Balance`).setColor(0xF1C40F)
    .setThumbnail(targetUser.displayAvatarURL())
    .addFields(
      { name:'💰 Coins',        value:`**${u.coins.toLocaleString()}**`,              inline:true },
      { name:'📈 Total Earned', value:`${(u.totalEarned||0).toLocaleString()} coins`, inline:true },
      { name:'🎒 Inventory',    value:`${(u.inventory||[]).length} item(s)`,          inline:true }
    ).setTimestamp()] });
}

async function cmdDaily(reply, userId, username) {
  const u=await getUser(userId, username);
  const cd=24*60*60*1000, now=Date.now();
  if (u.lastDaily && now-u.lastDaily<cd)
    return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`⏰ Come back in **${fmt(cd-(now-u.lastDaily))}** for your daily!`)] });
  u.coins+=50; u.totalEarned=(u.totalEarned||0)+50; u.lastDaily=now; await saveUser(u);
  return reply({ embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('🎁 Daily Claimed!').setDescription(`You received **50 coins**!\nBalance: **${u.coins.toLocaleString()} coins**`).setTimestamp()] });
}

async function cmdWork(reply, userId, username) {
  const u=await getUser(userId, username);
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
  u.coins+=earned; u.totalEarned=(u.totalEarned||0)+earned; u.lastWork=now; await saveUser(u);
  return reply({ embeds:[new EmbedBuilder().setColor(0x57F287).setTitle(`${job.e} Work Complete!`).setDescription(`You worked as a **${job.name}** and earned **${earned} coins**!\nBalance: **${u.coins.toLocaleString()} coins**`).setTimestamp()] });
}

async function cmdCoinflip(reply, userId, username, amount) {
  const u=await getUser(userId, username);
  if (u.coins<amount) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ You only have **${u.coins} coins**!`)] });
  const win=Math.random()<0.5;
  u.coins+=win?amount:-amount;
  if(win) u.totalEarned=(u.totalEarned||0)+amount;
  await saveUser(u);
  return reply({ embeds:[new EmbedBuilder().setColor(win?0x57F287:0xED4245).setTitle(win?'🟡 Heads — You Win!':'⚫ Tails — You Lose!')
    .setDescription(win?`Won **${amount} coins**! 🎉\nBalance: **${u.coins.toLocaleString()}**`:`Lost **${amount} coins**. 💸\nBalance: **${u.coins.toLocaleString()}**`).setTimestamp()] });
}

async function cmdRain(reply, guild, senderId, senderUsername, amount) {
  const sender=await getUser(senderId, senderUsername);
  if (sender.coins<amount) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ You only have **${sender.coins} coins**!`)] });
  await guild.members.fetch();
  const pool=[...guild.members.cache.filter(m=>!m.user.bot&&m.user.id!==senderId).values()];
  const picks=pool.sort(()=>0.5-Math.random()).slice(0,Math.min(5,pool.length));
  if (!picks.length) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription('❌ No eligible members!')] });
  const per=Math.floor(amount/picks.length);
  sender.coins-=per*picks.length; await saveUser(sender);
  const names=[];
  for (const m of picks) {
    const u=await getUser(m.user.id,m.user.username);
    u.coins+=per; u.totalEarned=(u.totalEarned||0)+per;
    await saveUser(u);
    names.push(`<@${m.user.id}>`);
  }
  return reply({ embeds:[new EmbedBuilder().setColor(0x3498DB).setTitle('🌧️ Coin Rain!')
    .setDescription(`<@${senderId}> rained **${per*picks.length} coins** across **${picks.length} members**!\nEach got **${per} coins**: ${names.join(' ')}`).setTimestamp()] });
}

async function cmdShop(reply) {
  return reply({ embeds:[new EmbedBuilder().setTitle('🏪 Rewards Shop').setColor(0x9B59B6)
    .setDescription(`Use \`/redeem\` or \`${PREFIX}redeem <id>\` to buy. Items go to inventory, then \`/claim <id>\` to submit.`)
    .addFields(
      { name:'💎 Robux', value:SHOP.filter(i=>i.category==='Robux').map(i=>`${i.emoji} **${i.name}** — \`${i.cost} coins\`  ·  ID: \`${i.id}\``).join('\n'), inline:false },
      { name:'🎮 ETFB',  value:SHOP.filter(i=>i.category==='ETFB').map(i=>`${i.emoji} **${i.name}** — \`${i.cost} coins\`  ·  ID: \`${i.id}\``).join('\n'), inline:false },
      { name:'💡 Earn coins', value:`💬 1 msg/min = 1 coin\n📅 \`${PREFIX}daily\` = 50 coins\n💼 \`${PREFIX}work\` = 10–75 coins\n🪙 \`${PREFIX}coinflip\` = double or nothing`, inline:false }
    ).setTimestamp()] });
}

async function cmdInventory(reply, userId, username) {
  const u=await getUser(userId, username);
  const inv=u.inventory||[];
  if (!inv.length) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`🎒 Your inventory is empty! Use \`${PREFIX}redeem <id>\` or \`/redeem\` to buy items.`)] });
  const list=inv.map(item=>
    `${item.emoji} **${item.name}**\n> Claim ID: \`${item.claimId}\`  •  Bought <t:${Math.floor(item.purchasedAt/1000)}:R>\n> Type \`/claim ${item.claimId}\` to submit`
  ).join('\n\n');
  return reply({ embeds:[new EmbedBuilder().setColor(0x9B59B6).setTitle(`🎒 ${username}'s Inventory`)
    .setDescription(list).setFooter({text:`${inv.length} item(s) — use /claim <id> to submit`}).setTimestamp()] });
}

async function cmdLeaderboard(reply) {
  const top=await getLeaderboard(10);
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
      { name:'📦 Stock', value:`/update-robux <amount>\n/update-etfb <divines|celestials> <amount>`, inline:false },
      { name:'👥 Users', value:`/give @user <amount>  ·  \`${PREFIX}give @user <amount>\`\n/take @user <amount>  ·  \`${PREFIX}take @user <amount>\``, inline:false },
      { name:'📋 Claims', value:`/claims — see all pending\n/claimed <id> — mark fulfilled + DM user`, inline:false }
    ).setTimestamp()] });
}

async function cmdRedeem(reply, userId, username, itemId) {
  const item=SHOP.find(i=>i.id===itemId);
  const u=await getUser(userId, username);
  if (!item) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Invalid item ID. Use \`${PREFIX}shop\` to see valid IDs.`)] });
  if (u.coins<item.cost) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Need **${item.cost} coins**, you have **${u.coins}**!`)] });

  const store=await getStore();
  const robuxAmt=item.id.startsWith('robux') ? parseInt(item.id.replace('robux_','')) : 0;
  if (item.id==='etfb_cel' && store.celestials<=0) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription('❌ Celestials are out of stock!')] });
  if (item.id==='etfb_div' && store.divines<=0)    return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription('❌ Divines are out of stock!')] });
  if (item.id.startsWith('robux') && store.robux<robuxAmt) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Only **${store.robux}** in stock, not enough for ${item.name}!`)] });

  if (item.id==='etfb_cel')             store.celestials=Math.max(0,store.celestials-1);
  else if (item.id==='etfb_div')        store.divines=Math.max(0,store.divines-1);
  else if (item.id.startsWith('robux')) store.robux=Math.max(0,store.robux-robuxAmt);
  await saveStore(store);
  await updateStockMessage(client);

  u.coins-=item.cost;
  u.inventory=u.inventory||[];
  const claimId=await nextClaimId();
  u.inventory.push({ claimId, itemId:item.id, name:item.name, emoji:item.emoji, category:item.category, cost:item.cost, purchasedAt:Date.now() });
  await saveUser(u);

  return reply({ embeds:[new EmbedBuilder().setColor(0x57F287).setTitle(`${item.emoji} Added to Inventory!`)
    .setDescription(
      `**${item.name}** has been added to your inventory!\n`+
      `Remaining balance: **${u.coins.toLocaleString()} coins**\n\n`+
      `📬 Your Claim ID is \`${claimId}\`\nType \`/claim ${claimId}\` to submit your delivery request!`
    ).setTimestamp()] });
}

// ══════════════════════════════════════════
//  CLAIM MODAL
// ══════════════════════════════════════════
async function openClaimModal(interaction, claimIdArg) {
  const userId=interaction.user.id;
  const u=await getUser(userId, interaction.user.username);
  const invItem=(u.inventory||[]).find(i=>i.claimId===claimIdArg.toUpperCase());

  if (!invItem) {
    return interaction.reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ No item with ID \`${claimIdArg.toUpperCase()}\` in your inventory.\nUse \`/inventory\` to check.`)], ephemeral:true });
  }

  const modal=new ModalBuilder().setCustomId(`claim_modal_${invItem.claimId}`).setTitle(`Claim: ${invItem.name}`);
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('roblox_username').setLabel('Your Roblox Username').setStyle(TextInputStyle.Short).setPlaceholder('e.g. Builderman').setRequired(true)
  ));
  if (invItem.category==='Robux') {
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('gamepass_link').setLabel('Gamepass Link (set price to 1 Robux)').setStyle(TextInputStyle.Short).setPlaceholder('https://www.roblox.com/game-pass/...').setRequired(true)
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
    await interaction.deferReply({ ephemeral: true });

    const claimId=interaction.customId.replace('claim_modal_','');
    const userId=interaction.user.id;
    const u=await getUser(userId, interaction.user.username);
    const inv=u.inventory||[];
    const idx=inv.findIndex(i=>i.claimId===claimId);

    if (idx===-1) return interaction.editReply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription('❌ Item not found in your inventory.')] });

    const invItem=inv[idx];
    const robloxUsername=interaction.fields.getTextInputValue('roblox_username').trim();
    const gamepaskLink=invItem.category==='Robux' ? interaction.fields.getTextInputValue('gamepass_link').trim() : null;

    const claims=await getClaims();
    claims.push({ claimId, userId, username:interaction.user.username, itemId:invItem.itemId, itemName:invItem.name, category:invItem.category, robloxUsername, gamepaskLink:gamepaskLink||null, claimedAt:Date.now(), status:'pending' });
    await saveClaims(claims);

    u.inventory.splice(idx,1);
    await saveUser(u);

    return interaction.editReply({ embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('📬 Claim Submitted!')
      .setDescription(
        `Your claim for **${invItem.name}** has been submitted!\n\n`+
        `**Claim ID:** \`${claimId}\`\n`+
        `**Roblox Username:** \`${robloxUsername}\`\n`+
        (gamepaskLink?`**Gamepass:** ${gamepaskLink}\n`:'')+
        `\n✅ An admin will process your claim shortly!`
      ).setTimestamp()] });
  }

  if (!interaction.isChatInputCommand()) return;
  const cmd=interaction.commandName;
  const me=interaction.user;
  const reply=p=>interaction.reply(p);

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

    if (cmd==='claims') {
      await interaction.deferReply({ ephemeral: true });
      const pending=(await getClaims()).filter(c=>c.status==='pending');
      if (!pending.length) return interaction.editReply({ embeds:[new EmbedBuilder().setColor(0x57F287).setDescription('✅ No pending claims!')] });
      const lines=pending.map(c=>
        `\`${c.claimId}\` • **${c.itemName}** • <@${c.userId}> • Roblox: **${c.robloxUsername}**`+
        (c.gamepaskLink?`\n> 🔗 ${c.gamepaskLink}`:'')+
        `\n> Submitted <t:${Math.floor(c.claimedAt/1000)}:R>`
      );
      const chunks=[];
      let cur='';
      for (const l of lines) { if (cur.length+l.length+2>3800){chunks.push(cur);cur='';} cur+=l+'\n\n'; }
      if (cur) chunks.push(cur);
      const embeds=chunks.map((ch,i)=>new EmbedBuilder().setColor(0xFF6B35)
        .setTitle(i===0?`📋 Pending Claims (${pending.length})`:'📋 (continued)')
        .setDescription(ch).setFooter({text:'Use /claimed <id> to mark as fulfilled'}).setTimestamp()
      );
      return interaction.editReply({ embeds });
    }

    if (cmd==='claimed') {
      await interaction.deferReply({ ephemeral: true });
      const claimId=interaction.options.getString('id').toUpperCase();
      const claims=await getClaims();
      const idx=claims.findIndex(c=>c.claimId===claimId);
      if (idx===-1) return interaction.editReply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Claim \`${claimId}\` not found.`)] });
      if (claims[idx].status==='fulfilled') return interaction.editReply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Claim \`${claimId}\` is already fulfilled.`)] });

      claims[idx].status='fulfilled';
      claims[idx].fulfilledAt=Date.now();
      claims[idx].fulfilledBy=me.username;
      await saveClaims(claims);

      const claim=claims[idx];
      const dmText=claim.category==='Robux'
        ? `✅ Your **${claim.itemName}** reward has been sent! We purchased your gamepass — check your Roblox account!`
        : `✅ Your **${claim.itemName} (ETFB)** reward is ready!\n\n**vru4447** has sent you a friend request on Roblox. Accept it and they will join your game and send you the reward!`;

      let dmSent=false;
      try {
        const target=await client.users.fetch(claim.userId);
        await target.send({ embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('🎉 Reward Delivered!')
          .setDescription(dmText)
          .addFields(
            { name:'Claim ID',        value:`\`${claimId}\``,       inline:true },
            { name:'Item',            value:claim.itemName,          inline:true },
            { name:'Roblox Username', value:claim.robloxUsername,    inline:true }
          ).setTimestamp()] });
        dmSent=true;
      } catch(e) { console.error('DM failed:', e.message); }

      return interaction.editReply({ embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('✅ Claim Fulfilled')
        .setDescription(
          `Claim \`${claimId}\` marked as fulfilled.\n`+
          `**User:** <@${claim.userId}> (${claim.robloxUsername})\n`+
          `**Item:** ${claim.itemName}\n`+
          `**DM sent:** ${dmSent?'✅ Yes':'❌ Failed (DMs may be off)'}`
        ).setTimestamp()] });
    }

    if (cmd==='give') {
      const t=interaction.options.getUser('user'), amt=interaction.options.getInteger('amount');
      const u=await getUser(t.id,t.username); u.coins+=amt; u.totalEarned=(u.totalEarned||0)+amt; await saveUser(u);
      return reply({ embeds:[new EmbedBuilder().setColor(0x57F287).setDescription(`✅ Gave **${amt} coins** to <@${t.id}>. Balance: **${u.coins.toLocaleString()}**`)] });
    }
    if (cmd==='take') {
      const t=interaction.options.getUser('user'), amt=interaction.options.getInteger('amount');
      const u=await getUser(t.id,t.username); u.coins=Math.max(0,u.coins-amt); await saveUser(u);
      return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`✅ Took **${amt} coins** from <@${t.id}>. Balance: **${u.coins.toLocaleString()}**`)] });
    }
    if (cmd==='update-robux') {
      await interaction.deferReply();
      const amt=interaction.options.getInteger('amount');
      const store=await getStore(); store.robux=amt; await saveStore(store);
      await updateStockMessage(client);
      return interaction.editReply({ embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('✅ Stock Updated').setDescription(`💎 Robux stock set to **${amt}**. Embed refreshed.`).setTimestamp()] });
    }
    if (cmd==='update-etfb') {
      await interaction.deferReply();
      const type=interaction.options.getString('type'), amt=interaction.options.getInteger('amount');
      const store=await getStore(); store[type]=amt; await saveStore(store);
      await updateStockMessage(client);
      const label=type==='divines'?'🌟 Divines':'✨ Celestials';
      return interaction.editReply({ embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('✅ Stock Updated').setDescription(`${label} set to **${amt}x**. Embed refreshed.`).setTimestamp()] });
    }

  } catch(e) {
    console.error(`/${cmd} error:`, e);
    const err={ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription('❌ Something went wrong!')], ephemeral:true };
    try { interaction.replied||interaction.deferred ? await interaction.followUp(err) : await interaction.reply(err); } catch {}
  }
});

client.login(process.env.BOT_TOKEN);
