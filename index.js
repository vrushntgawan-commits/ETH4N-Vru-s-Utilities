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
const COIN_COOLDOWN_MS = 60_000;

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
//  JSONBIN — hardcoded bin IDs, no creation
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

// Simple in-memory cache — users never expire (updated in place), rest 30s
const cache      = { users: null, store: null, meta: null, claims: null };
const cacheTime  = { users: 0,    store: 0,    meta: 0,    claims: 0    };
const CACHE_TTL  = { users: Infinity, store: 30_000, meta: 30_000, claims: 30_000 };

async function binRead(name) {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${BIN_IDS[name]}/latest`, {
    headers: { 'X-Master-Key': JSONBIN_KEY, 'X-Bin-Versioning': 'false' },
  });
  if (!res.ok) throw new Error(`READ ${name} → ${res.status}: ${await res.text()}`);
  const j = await res.json();
  // unwrap placeholder or wrapper
  const d = j.record;
  if (!d || d.a === 'b') return JSON.parse(JSON.stringify(DEFAULTS[name]));
  if (d._empty) return d._data;
  return d;
}

async function binWrite(name, data) {
  // JSONBin refuses empty {} and [] — wrap them
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
  if (!res.ok) throw new Error(`WRITE ${name} → ${res.status}: ${await res.text()}`);
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
    users[userId] = { id: userId, username: username || 'Unknown', coins: 0, totalEarned: 0, lastDaily: null, lastWork: null, inventory: [] };
    await dbWrite('users', users);
  }
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
  const s=Math.floor(ms/1000), m=Math.floor(s/60), h=Math.floor(m/60);
  return h>0?`${h}h ${m%60}m`:m>0?`${m}m ${s%60}s`:`${s}s`;
}

function stockEmbed(store) {
  return new EmbedBuilder()
    .setTitle('🏪 Current Stock')
    .setColor(0x5865F2)
    .setDescription('Use `/shop` to see prices and `/redeem` or `u!redeem` to purchase!')
    .addFields(
      { name: '💎 Robux',           value: store.robux      > 0 ? `**${store.robux}** available`      : '❌ Out of stock', inline: true },
      { name: '✨ ETFB Celestials', value: store.celestials > 0 ? `**${store.celestials}x** available` : '❌ Out of stock', inline: true },
      { name: '🌟 ETFB Divines',   value: store.divines    > 0 ? `**${store.divines}x** available`    : '❌ Out of stock', inline: true }
    )
    .setFooter({ text: 'Stock updated by admins' });
}

async function updateStockEmbed(clientRef) {
  try {
    const ch = await clientRef.channels.fetch(STOCK_CHANNEL_ID);
    if (!ch) return;
    const store = await getStore();
    const embed = stockEmbed(store);
    const meta  = await getMeta();
    if (meta.stockMsgId) {
      try { const m = await ch.messages.fetch(meta.stockMsgId); await m.edit({ embeds: [embed] }); return; }
      catch { /* deleted */ }
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
  new SlashCommandBuilder().setName('balance').setDescription('Check your coin balance').addUserOption(o=>o.setName('user').setDescription('Check someone else').setRequired(false)),
  new SlashCommandBuilder().setName('daily').setDescription('Claim 50 coins (24h cooldown)'),
  new SlashCommandBuilder().setName('work').setDescription('Work a job and earn coins (1h cooldown)'),
  new SlashCommandBuilder().setName('coinflip').setDescription('Bet coins on a coinflip').addIntegerOption(o=>o.setName('amount').setDescription('Coins to bet').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('rain').setDescription('Rain coins on random members').addIntegerOption(o=>o.setName('amount').setDescription('Total coins to rain').setRequired(true).setMinValue(10)),
  new SlashCommandBuilder().setName('shop').setDescription('View all items and prices'),
  new SlashCommandBuilder().setName('redeem').setDescription('Buy an item — it goes to your inventory').addStringOption(o=>
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
  new SlashCommandBuilder().setName('inventory').setDescription('View your unclaimed items'),
  new SlashCommandBuilder().setName('claim').setDescription('Submit a claim for an item').addStringOption(o=>o.setName('id').setDescription('Claim ID from /inventory e.g. C1').setRequired(true)),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Top 10 richest members'),
  new SlashCommandBuilder().setName('help').setDescription('View all commands'),
  new SlashCommandBuilder().setName('adminhelp').setDescription('View admin commands').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('claims').setDescription('[ADMIN] View all pending claims').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('claimed').setDescription('[ADMIN] Mark a claim as fulfilled').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o=>o.setName('id').setDescription('Claim ID e.g. C1').setRequired(true)),
  new SlashCommandBuilder().setName('update-robux').setDescription('[ADMIN] Update Robux stock').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addIntegerOption(o=>o.setName('amount').setDescription('New amount').setRequired(true).setMinValue(0)),
  new SlashCommandBuilder().setName('update-etfb').setDescription('[ADMIN] Update ETFB stock').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o=>o.setName('type').setDescription('Which item').setRequired(true).addChoices({name:'Divines',value:'divines'},{name:'Celestials',value:'celestials'}))
    .addIntegerOption(o=>o.setName('amount').setDescription('New amount').setRequired(true).setMinValue(0)),
  new SlashCommandBuilder().setName('give').setDescription('[ADMIN] Give coins to a user').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o=>o.setName('user').setDescription('Target').setRequired(true))
    .addIntegerOption(o=>o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('take').setDescription('[ADMIN] Take coins from a user').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o=>o.setName('user').setDescription('Target').setRequired(true))
    .addIntegerOption(o=>o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)),
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
  ],
});

// Coin cooldown — in memory only, resets on restart (fine)
const coinCD = new Map();

client.once('ready', async () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  if (!GUILD_ID)    { console.error('❌ GUILD_ID missing'); process.exit(1); }
  if (!JSONBIN_KEY) { console.error('❌ JSONBIN_KEY missing'); process.exit(1); }

  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
    for (const g of client.guilds.cache.values()) {
      try { await rest.put(Routes.applicationGuildCommands(client.user.id, g.id), { body: [] }); }
      catch(e) { console.error(`Clear ${g.id}:`, e.message); }
    }
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: slashDefs });
    console.log('✅ Slash commands registered');
  } catch(e) { console.error('Command reg error:', e); }

  // Warm the users cache so coin tracking never cold-reads on first message
  try { await dbRead('users'); console.log('✅ Users cache warmed'); } catch(e) { console.error('Cache warmup error:', e.message); }
  await updateStockEmbed(client);
  console.log('✅ Ready');
});

// ══════════════════════════════════════════
//  MESSAGE — coin per message + prefix cmds
// ══════════════════════════════════════════
client.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.guild) return;

  // ── Coin tracking ──
  const uid = msg.author.id;
  const now = Date.now();
  const last = coinCD.get(uid) || 0;
  if (now - last >= COIN_COOLDOWN_MS) {
    coinCD.set(uid, now);
    // Mutate cache directly — only write to JSONBin, never re-read
    // This avoids any race conditions from concurrent reads
    if (cache.users && cache.users[uid]) {
      // Fast path: user already in cache, just increment and save
      cache.users[uid].coins = (cache.users[uid].coins || 0) + 1;
      cache.users[uid].totalEarned = (cache.users[uid].totalEarned || 0) + 1;
      binWrite('users', cache.users).catch(e => console.error('Coin write error:', e.message));
    } else {
      // Slow path: user not cached yet, do full read-modify-write
      getUser(uid, msg.author.username).then(u => {
        u.coins = (u.coins || 0) + 1;
        u.totalEarned = (u.totalEarned || 0) + 1;
        saveUser(u).catch(e => console.error('Coin save error:', e.message));
      }).catch(e => console.error('Coin user error:', e.message));
    }
  }

  // ── Prefix commands ──
  if (!msg.content.startsWith(PREFIX)) return;
  const args    = msg.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd     = args.shift().toLowerCase();
  const reply   = p => msg.reply(p);
  const isAdmin = msg.member?.permissions.has(PermissionFlagsBits.Administrator);

  try {
    if (cmd==='balance'||cmd==='bal')        return await cmdBalance(reply, msg.mentions.users.first()||msg.author);
    if (cmd==='daily')                       return await cmdDaily(reply, uid, msg.author.username);
    if (cmd==='work')                        return await cmdWork(reply, uid, msg.author.username);
    if (cmd==='shop')                        return await cmdShop(reply);
    if (cmd==='inventory')                   return await cmdInventory(reply, uid, msg.author.username);
    if (cmd==='lb'||cmd==='leaderboard')     return await cmdLeaderboard(reply);
    if (cmd==='help')                        return await cmdHelp(reply);
    if (cmd==='adminhelp' && isAdmin)        return await cmdAdminHelp(reply);
    if (cmd==='coinflip'||cmd==='cf') {
      const amt = parseInt(args[0]);
      if (isNaN(amt)||amt<1) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Usage: \`${PREFIX}coinflip <amount>\``)] });
      return await cmdCoinflip(reply, uid, msg.author.username, amt);
    }
    if (cmd==='rain') {
      const amt = parseInt(args[0]);
      if (isNaN(amt)||amt<10) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Usage: \`${PREFIX}rain <amount>\` (min 10)`)] });
      return await cmdRain(reply, msg.guild, uid, msg.author.username, amt);
    }
    if (cmd==='redeem') {
      if (!args[0]) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Usage: \`${PREFIX}redeem <itemId>\` — see \`${PREFIX}shop\``)] });
      return await cmdRedeem(reply, uid, msg.author.username, args[0].toLowerCase());
    }
    if (cmd==='give' && isAdmin) {
      const t=msg.mentions.users.first(), amt=parseInt(args[1]);
      if (!t||isNaN(amt)||amt<1) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Usage: \`${PREFIX}give @user <amount>\``)] });
      const u=await getUser(t.id,t.username); u.coins+=amt; u.totalEarned=(u.totalEarned||0)+amt; await saveUser(u);
      return reply({ embeds:[new EmbedBuilder().setColor(0x57F287).setDescription(`✅ Gave **${amt} coins** to <@${t.id}>. New balance: **${u.coins.toLocaleString()}**`)] });
    }
    if (cmd==='take' && isAdmin) {
      const t=msg.mentions.users.first(), amt=parseInt(args[1]);
      if (!t||isNaN(amt)||amt<1) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Usage: \`${PREFIX}take @user <amount>\``)] });
      const u=await getUser(t.id,t.username); u.coins=Math.max(0,u.coins-amt); await saveUser(u);
      return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`✅ Took **${amt} coins** from <@${t.id}>. New balance: **${u.coins.toLocaleString()}**`)] });
    }
  } catch(e) {
    console.error(`Prefix ${cmd}:`, e);
    reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription('❌ Something went wrong!')] }).catch(()=>{});
  }
});

// ══════════════════════════════════════════
//  COMMAND FUNCTIONS
// ══════════════════════════════════════════
async function cmdBalance(reply, target) {
  const u = await getUser(target.id, target.username);
  return reply({ embeds:[new EmbedBuilder()
    .setTitle(`🪙 ${target.username}'s Balance`)
    .setColor(0xF1C40F)
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name:'💰 Coins',        value:`**${u.coins.toLocaleString()}**`,              inline:true },
      { name:'📈 Total Earned', value:`${(u.totalEarned||0).toLocaleString()} coins`, inline:true },
      { name:'🎒 Inventory',    value:`${(u.inventory||[]).length} item(s)`,          inline:true }
    )] });
}

async function cmdDaily(reply, userId, username) {
  const u=await getUser(userId, username);
  const cd=24*60*60*1000, now=Date.now();
  if (u.lastDaily && now-u.lastDaily<cd)
    return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`⏰ Come back in **${fmt(cd-(now-u.lastDaily))}** for your daily!`)] });
  u.coins+=50; u.totalEarned=(u.totalEarned||0)+50; u.lastDaily=now;
  await saveUser(u);
  return reply({ embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('🎁 Daily Claimed!').setDescription(`You received **50 coins**!\nBalance: **${u.coins.toLocaleString()} coins**`)] });
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
  u.coins+=earned; u.totalEarned=(u.totalEarned||0)+earned; u.lastWork=now;
  await saveUser(u);
  return reply({ embeds:[new EmbedBuilder().setColor(0x57F287).setTitle(`${job.e} Work Complete!`).setDescription(`You worked as a **${job.name}** and earned **${earned} coins**!\nBalance: **${u.coins.toLocaleString()} coins**`)] });
}

async function cmdCoinflip(reply, userId, username, amount) {
  const u=await getUser(userId, username);
  if (u.coins<amount) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ You only have **${u.coins} coins**!`)] });
  const win=Math.random()<0.5;
  u.coins+=win?amount:-amount;
  if (win) u.totalEarned=(u.totalEarned||0)+amount;
  await saveUser(u);
  return reply({ embeds:[new EmbedBuilder()
    .setColor(win?0x57F287:0xED4245)
    .setTitle(win?'🟡 Heads — You Win!':'⚫ Tails — You Lose!')
    .setDescription(win?`Won **${amount} coins**! 🎉\nBalance: **${u.coins.toLocaleString()}**`:`Lost **${amount} coins**. 💸\nBalance: **${u.coins.toLocaleString()}**`)] });
}

async function cmdRain(reply, guild, senderId, senderName, amount) {
  const sender=await getUser(senderId, senderName);
  if (sender.coins<amount) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ You only have **${sender.coins} coins**!`)] });
  await guild.members.fetch();
  const pool=[...guild.members.cache.filter(m=>!m.user.bot&&m.user.id!==senderId).values()];
  const picks=pool.sort(()=>0.5-Math.random()).slice(0,Math.min(5,pool.length));
  if (!picks.length) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription('❌ No eligible members!')] });
  const per=Math.floor(amount/picks.length);
  sender.coins-=per*picks.length;
  await saveUser(sender);
  const names=[];
  for (const m of picks) {
    const u=await getUser(m.user.id, m.user.username);
    u.coins+=per; u.totalEarned=(u.totalEarned||0)+per;
    await saveUser(u);
    names.push(`<@${m.user.id}>`);
  }
  return reply({ embeds:[new EmbedBuilder().setColor(0x3498DB).setTitle('🌧️ Coin Rain!')
    .setDescription(`<@${senderId}> rained **${per*picks.length} coins** across **${picks.length} members**!\nEach got **${per} coins**: ${names.join(' ')}`)] });
}

async function cmdShop(reply) {
  return reply({ embeds:[new EmbedBuilder()
    .setTitle('🏪 Rewards Shop')
    .setColor(0x9B59B6)
    .setDescription(`Buy with \`/redeem\` or \`${PREFIX}redeem <id>\` → goes to inventory → \`/claim <id>\` to submit`)
    .addFields(
      { name:'💎 Robux', value:SHOP.filter(i=>i.category==='Robux').map(i=>`${i.emoji} **${i.name}** — \`${i.cost} coins\`  ·  \`${i.id}\``).join('\n'), inline:false },
      { name:'🎮 ETFB',  value:SHOP.filter(i=>i.category==='ETFB').map(i=>`${i.emoji} **${i.name}** — \`${i.cost} coins\`  ·  \`${i.id}\``).join('\n'), inline:false },
      { name:'💡 Earn coins', value:`💬 1 msg/min = 1 coin  •  📅 \`${PREFIX}daily\` = 50  •  💼 \`${PREFIX}work\` = 10–75  •  🪙 \`${PREFIX}coinflip\``, inline:false }
    )] });
}

async function cmdInventory(reply, userId, username) {
  const u=await getUser(userId, username);
  const inv=u.inventory||[];
  if (!inv.length) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`🎒 Your inventory is empty! Use \`/redeem\` or \`${PREFIX}redeem <id>\` to buy items.`)] });
  const list=inv.map(item=>`${item.emoji} **${item.name}** — Claim ID: \`${item.claimId}\`\n> Use \`/claim ${item.claimId}\` to submit`).join('\n\n');
  return reply({ embeds:[new EmbedBuilder()
    .setTitle(`🎒 ${username}'s Inventory`)
    .setColor(0x9B59B6)
    .setDescription(list)
    .setFooter({text:`${inv.length} item(s) waiting — /claim <id> to submit`})] });
}

async function cmdLeaderboard(reply) {
  const top=await getLeaderboard(10);
  const medals=['🥇','🥈','🥉'];
  const list=top.map((u,i)=>`${medals[i]||`**${i+1}.**`} <@${u.id}> — **${u.coins.toLocaleString()} coins**`).join('\n');
  return reply({ embeds:[new EmbedBuilder().setTitle('🏆 Coin Leaderboard').setColor(0xF1C40F).setDescription(list||'No data yet!')] });
}

async function cmdHelp(reply) {
  return reply({ embeds:[new EmbedBuilder()
    .setTitle(`📖 Help — Prefix: \`${PREFIX}\``)
    .setColor(0x5865F2)
    .addFields(
      { name:'─────── 💰 Economy ───────', value:
        `\`${PREFIX}balance\` \`${PREFIX}bal\` — check your coins\n`+
        `\`${PREFIX}daily\` — 50 coins every 24h\n`+
        `\`${PREFIX}work\` — 10–75 coins every 1h\n`+
        `\`${PREFIX}coinflip <amount>\` — double or nothing\n`+
        `\`${PREFIX}rain <amount>\` — rain coins on members\n`+
        `\`${PREFIX}leaderboard\` — top 10 richest`,
        inline:false },
      { name:'─────── 🛒 Shop ───────', value:
        `\`${PREFIX}shop\` — view all items & prices\n`+
        `\`${PREFIX}redeem <itemId>\` — buy an item\n`+
        `\`${PREFIX}inventory\` — view your items\n`+
        `\`/claim <id>\` — submit a claim`,
        inline:false },
      { name:'─────── 💡 Tips ───────', value:
        `• Chatting earns 1 coin per minute\n`+
        `• All commands work as \`/slash\` commands too\n`+
        `• After redeeming, use \`/claim <id>\` to get your reward`,
        inline:false }
    )] });
}

async function cmdAdminHelp(reply) {
  return reply({ embeds:[new EmbedBuilder()
    .setTitle('🔒 Admin Commands')
    .setColor(0xFF6B35)
    .addFields(
      { name:'─────── 📦 Stock ───────', value:
        `/update-robux <amount>\n`+
        `/update-etfb <divines|celestials> <amount>`,
        inline:false },
      { name:'─────── 👥 Coins ───────', value:
        `/give @user <amount>  ·  \`${PREFIX}give @user <amount>\`\n`+
        `/take @user <amount>  ·  \`${PREFIX}take @user <amount>\``,
        inline:false },
      { name:'─────── 📋 Claims ───────', value:
        `/claims — view all pending claims\n`+
        `/claimed <id> — mark fulfilled & DM user`,
        inline:false }
    )] });
}

async function cmdRedeem(reply, userId, username, itemId) {
  const item=SHOP.find(i=>i.id===itemId);
  const u=await getUser(userId, username);
  if (!item) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Unknown item ID. Use \`${PREFIX}shop\` to see valid IDs.`)] });
  if (u.coins<item.cost) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Need **${item.cost} coins**, you only have **${u.coins}**!`)] });

  const store=await getStore();
  const robuxAmt=item.id.startsWith('robux') ? parseInt(item.id.replace('robux_','')) : 0;
  if (item.id==='etfb_cel' && store.celestials<=0) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription('❌ Celestials are out of stock!')] });
  if (item.id==='etfb_div' && store.divines<=0)    return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription('❌ Divines are out of stock!')] });
  if (item.id.startsWith('robux') && store.robux<robuxAmt) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Only **${store.robux}** Robux in stock, not enough for ${item.name}!`)] });

  if (item.id==='etfb_cel')             store.celestials=Math.max(0,store.celestials-1);
  else if (item.id==='etfb_div')        store.divines=Math.max(0,store.divines-1);
  else if (item.id.startsWith('robux')) store.robux=Math.max(0,store.robux-robuxAmt);
  await saveStore(store);
  await updateStockEmbed(client);

  const claimId=await nextClaimId();
  u.coins-=item.cost;
  u.inventory=u.inventory||[];
  u.inventory.push({ claimId, itemId:item.id, name:item.name, emoji:item.emoji, category:item.category, cost:item.cost });
  await saveUser(u);

  return reply({ embeds:[new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle(`${item.emoji} Added to Inventory!`)
    .setDescription(
      `**${item.name}** is now in your inventory!\n`+
      `Remaining balance: **${u.coins.toLocaleString()} coins**\n\n`+
      `📬 Claim ID: \`${claimId}\`\nUse \`/claim ${claimId}\` to submit your delivery request!`
    )] });
}

// ══════════════════════════════════════════
//  INTERACTION HANDLER
// ══════════════════════════════════════════
client.on('interactionCreate', async interaction => {

  // ── MODAL SUBMIT ──────────────────────
  if (interaction.isModalSubmit()) {
    if (!interaction.customId.startsWith('claim_modal_')) return;
    await interaction.deferReply({ ephemeral: true });

    const claimId = interaction.customId.replace('claim_modal_', '');
    const u       = await getUser(interaction.user.id, interaction.user.username);
    const inv     = u.inventory || [];
    const idx     = inv.findIndex(i => i.claimId === claimId);
    if (idx === -1) return interaction.editReply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription('❌ Item not found in your inventory.')] });

    const item         = inv[idx];
    const robloxUser   = interaction.fields.getTextInputValue('roblox_username').trim();
    const gamepassLink = item.category === 'Robux' ? interaction.fields.getTextInputValue('gamepass_link').trim() : null;

    // Save claim
    const claims = await getClaims();
    const claimsArr = Array.isArray(claims) ? claims : [];
    claimsArr.push({ claimId, userId:interaction.user.id, username:interaction.user.username, itemId:item.itemId, itemName:item.name, category:item.category, robloxUsername:robloxUser, gamepaskLink:gamepassLink||null, claimedAt:Date.now(), status:'pending' });
    await saveClaims(claimsArr);

    // Remove from inventory
    u.inventory.splice(idx, 1);
    await saveUser(u);

    return interaction.editReply({ embeds:[new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle('📬 Claim Submitted!')
      .setDescription(
        `Your claim for **${item.name}** has been submitted!\n\n`+
        `**Claim ID:** \`${claimId}\`\n`+
        `**Roblox Username:** \`${robloxUser}\`\n`+
        (gamepassLink ? `**Gamepass:** ${gamepassLink}\n` : '')+
        `\nAn admin will process this shortly!`
      )] });
  }

  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;
  const me  = interaction.user;
  const reply = p => interaction.reply(p);

  try {
    if (cmd==='balance')     return await cmdBalance(reply, interaction.options.getUser('user')||me);
    if (cmd==='daily')       return await cmdDaily(reply, me.id, me.username);
    if (cmd==='work')        return await cmdWork(reply, me.id, me.username);
    if (cmd==='shop')        return await cmdShop(reply);
    if (cmd==='inventory')   return await cmdInventory(reply, me.id, me.username);
    if (cmd==='leaderboard') return await cmdLeaderboard(reply);
    if (cmd==='help')        return await cmdHelp(reply);
    if (cmd==='adminhelp')   return await cmdAdminHelp(reply);
    if (cmd==='coinflip')    return await cmdCoinflip(reply, me.id, me.username, interaction.options.getInteger('amount'));
    if (cmd==='rain')        return await cmdRain(reply, interaction.guild, me.id, me.username, interaction.options.getInteger('amount'));
    if (cmd==='redeem') {
      await interaction.deferReply();
      return await cmdRedeem(p => interaction.editReply(p), me.id, me.username, interaction.options.getString('item'));
    }

    // /claim — shows modal
    if (cmd==='claim') {
      const idArg = interaction.options.getString('id').toUpperCase();
      const u     = await getUser(me.id, me.username);
      const item  = (u.inventory||[]).find(i=>i.claimId===idArg);
      if (!item) return reply({ embeds:[new EmbedBuilder().setColor(0xED4245).setDescription(`❌ No item with ID \`${idArg}\` in your inventory. Use \`/inventory\` to check.`)], ephemeral:true });
      const modal = new ModalBuilder().setCustomId(`claim_modal_${item.claimId}`).setTitle(`Claim: ${item.name}`);
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('roblox_username').setLabel('Your Roblox Username').setStyle(TextInputStyle.Short).setPlaceholder('e.g. Builderman').setRequired(true)
      ));
      if (item.category==='Robux') {
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('gamepass_link').setLabel('Gamepass Link (set price to 1 Robux)').setStyle(TextInputStyle.Short).setPlaceholder('https://www.roblox.com/game-pass/...').setRequired(true)
        ));
      }
      return interaction.showModal(modal);
    }

    // /claims — visible plain message, easy to copy IDs
    if (cmd==='claims') {
      await interaction.deferReply();
      const allClaims = await getClaims();
      const pending = (Array.isArray(allClaims) ? allClaims : []).filter(c => c.status === 'pending');
      if (!pending.length) return interaction.editReply({ content: '✅ No pending claims right now!' });

      // Build plain readable lines — no embeds, no buttons, easy to copy
      const header = `📋 **Pending Claims — ${pending.length} total**\n`;
      const footer = `\nUse \`/claimed <id>\` to mark as fulfilled`;
      let msg = header;
      for (const c of pending) {
        const line = `**${c.claimId}** • ${c.itemName} • ${c.username} • \`${c.robloxUsername}\``
          + (c.gamepaskLink ? `\n↳ ${c.gamepaskLink}` : '') + '\n';
        if (msg.length + line.length + footer.length > 1980) {
          await interaction.followUp({ content: msg });
          msg = '';
        }
        msg += line;
      }
      msg += footer;
      return interaction.editReply({ content: msg });
    }

    // /claimed
    if (cmd==='claimed') {
      await interaction.deferReply({ ephemeral: true });
      const claimId = interaction.options.getString('id').toUpperCase();
      const allClaims = await getClaims();
      const claimsArr = Array.isArray(allClaims) ? allClaims : [];
      const idx = claimsArr.findIndex(c=>c.claimId===claimId);
      if (idx===-1) return interaction.editReply({ content: `❌ Claim \`${claimId}\` not found.` });
      if (claimsArr[idx].status==='fulfilled') return interaction.editReply({ content: `❌ Claim \`${claimId}\` already fulfilled.` });

      claimsArr[idx].status    = 'fulfilled';
      claimsArr[idx].fulfilledAt = Date.now();
      claimsArr[idx].fulfilledBy = me.username;
      await saveClaims(claimsArr);

      const claim = claimsArr[idx];
      const dmText = claim.category==='Robux'
        ? `✅ Your **${claim.itemName}** reward has been sent! We purchased your gamepass — check your Roblox account!`
        : `✅ Your **${claim.itemName} (ETFB)** reward is ready!\n\n**vru4447** has sent you a friend request on Roblox. Accept it and they will join your game and send your reward!`;

      let dmSent = false;
      try {
        const target = await client.users.fetch(claim.userId);
        await target.send({ embeds:[new EmbedBuilder()
          .setColor(0x57F287)
          .setTitle('🎉 Reward Delivered!')
          .setDescription(dmText)
          .addFields(
            { name:'Claim ID', value:`\`${claimId}\``, inline:true },
            { name:'Item',     value:claim.itemName,   inline:true },
            { name:'Roblox',   value:claim.robloxUsername, inline:true }
          )] });
        dmSent = true;
      } catch(e) { console.error('DM failed:', e.message); }

      return interaction.editReply({ embeds:[new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('✅ Claim Fulfilled')
        .setDescription(
          `Claim \`${claimId}\` done.\n`+
          `**User:** <@${claim.userId}> (${claim.robloxUsername})\n`+
          `**Item:** ${claim.itemName}\n`+
          `**DM:** ${dmSent?'✅ Sent':'❌ Failed (DMs off)'}`
        )] });
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
      await updateStockEmbed(client);
      return interaction.editReply({ embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('✅ Stock Updated').setDescription(`💎 Robux stock set to **${amt}**. Embed refreshed.`)] });
    }
    if (cmd==='update-etfb') {
      await interaction.deferReply();
      const type=interaction.options.getString('type'), amt=interaction.options.getInteger('amount');
      const store=await getStore(); store[type]=amt; await saveStore(store);
      await updateStockEmbed(client);
      const label=type==='divines'?'🌟 Divines':'✨ Celestials';
      return interaction.editReply({ embeds:[new EmbedBuilder().setColor(0x57F287).setTitle('✅ Stock Updated').setDescription(`${label} set to **${amt}x**. Embed refreshed.`)] });
    }

  } catch(e) {
    console.error(`/${cmd} error:`, e);
    const err = { embeds:[new EmbedBuilder().setColor(0xED4245).setDescription('❌ Something went wrong!')], ephemeral:true };
    try { interaction.replied||interaction.deferred ? await interaction.followUp(err) : await interaction.reply(err); } catch {}
  }
});

client.login(process.env.BOT_TOKEN);
