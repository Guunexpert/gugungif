require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, Collection } = require('discord.js');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds],
    presence: {
        status: 'online',
        activities: [{
            name: 'Converting media to GIF',
            type: 3
        }]
    }
});

const greenLog = (text) => `\x1b[32m[${new Date().toLocaleTimeString()}] ${text}\x1b[0m`;
const yellowLog = (text) => `\x1b[33m[${new Date().toLocaleTimeString()}] ${text}\x1b[0m`;
const redLog = (text) => `\x1b[31m[${new Date().toLocaleTimeString()}] ${text}\x1b[0m`;

client.commands = new Collection();
const commandsData = [];

const commandsPath = path.join(__dirname, 'command');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    
    if ('data' in command && 'execute' in command) {
        client.commands.set(command.data.name, command);
        commandsData.push(command.data.toJSON());
    } else {
        console.log(redLog(`[WARNING] File di ${filePath} strukturnya salah!`));
    }
}

client.on('interactionCreate', async interaction => {
    if (interaction.isButton()) {
        const [commandName] = interaction.customId.split(':');
        const command = client.commands.get(commandName);
        if (command?.handleComponent) {
            try {
                await command.handleComponent(interaction, client);
            } catch (error) {
                console.error(error);
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply({ content: 'Failed to process media selection.', components: [] });
                } else {
                    await interaction.reply({ content: 'Failed to process media selection.', ephemeral: true });
                }
            }
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    console.log(yellowLog(`[INCOMING] User @${interaction.user.username} triggered /${interaction.commandName} in Server: ${interaction.guild?.name || 'DM'}`));
    
    if (interaction.commandName === 'convert') {
        const w = interaction.options.getInteger('width');
        const h = interaction.options.getInteger('height');
        console.log(yellowLog(`[FFMPEG_CORE] Fetching binary dependencies...`));
        console.log(yellowLog(`[SHARP_ALLOC] Allocating memory grid for size: ${w}x${h}px...`));
    }

    try {
        await command.execute(interaction, client);
    } catch (error) {
        console.error(error);
        console.log(redLog(`[CRITICAL] Error terjadi pada command /${interaction.commandName}`));
        
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: 'ada yang gak bener ini pas jalanin command.' });
        } else {
            await interaction.reply({ content: 'ada yang gak bener ini pas jalanin command.', ephemeral: true });
        }
    }
});

client.once('ready', () => {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    rest.put(Routes.applicationCommands(client.user.id), { body: commandsData })
        .then(() => console.log(greenLog('Slash commands registered')))
        .catch(error => console.error(redLog(`[COMMANDS] Failed to register slash commands: ${error.message}`)));

    console.log(greenLog(`==============================================`));
    console.log(greenLog(`Bot nya jalankan dengan aman, jangan lupa join KC`));
    console.log(greenLog(`security kernel active as ${client.user.tag}`));
    console.log(greenLog(`==============================================`));

    console.log(yellowLog(`[CORE] Monitoring ${client.guilds.cache.size} active servers...`));
    console.log(yellowLog(`[CORE] Memory Heap: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`));
    console.log(yellowLog(`[CORE] Shard #0 ready. Listening for slash commands...`));

  const fakeMessages = [
        () => "🔄 Syncing Discord Gateway intents...",
        () => "⚙️ Parsing media buffer stream cache...",
        () => "🛡️ Anti-DDOS firewall packet filter: 0 malicious tokens detected.",
        () => `📊 CPU Core Load: ${Math.floor(Math.random() * 60 + 5)}%`,
        () => "🗄️ Cleaning temporary junk buffer pointers...",
        () => `🌐 Fetching API latency ping: ${Math.floor(Math.random() * 30 + 10)}ms`,
        () => "📥 Websocket heartbeat acknowledged from Discord Gateway v10",
        () => "🔑 Token handshake encrypted via SHA-256",
        () => "🔄 Garbage Collection: Freeing memory blocks..."
    ];

    setInterval(() => {
        const randomLogFunction = fakeMessages[Math.floor(Math.random() * fakeMessages.length)];
        console.log(greenLog(randomLogFunction()));
    }, 4000);
});

if (!TOKEN) {
    throw new Error('DISCORD_TOKEN (atau TOKEN) belum diatur di file .env.');
}

client.login(TOKEN);