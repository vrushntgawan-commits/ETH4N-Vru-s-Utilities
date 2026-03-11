// ============================================
// RUN THIS ONCE ON YOUR LOCAL PC:
//   node register-commands.js
// Then delete it. Commands stay registered forever.
// ============================================

const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID; // Add CLIENT_ID to your .env
const GUILD_ID  = process.env.GUILD_ID;

if (!BOT_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing BOT_TOKEN, CLIENT_ID, or GUILD_ID in .env');
  process.exit(1);
}

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

const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

(async () => {
  try {
    console.log(`Registering ${slashDefs.length} commands to guild ${GUILD_ID}...`);
    const data = await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: slashDefs }
    );
    console.log(`✅ Successfully registered ${data.length} commands!`);
    console.log('Commands:', data.map(c => c.name).join(', '));
  } catch (e) {
    console.error('❌ Failed:', e.message);
    if (e.rawError) console.error(JSON.stringify(e.rawError, null, 2));
  }
})();
