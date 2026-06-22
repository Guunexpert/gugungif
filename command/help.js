const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Menampilkan menu bantuan dan cara pakai bot'),
        
    async execute(interaction, client) {
        const helpEmbed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle('GugunKC')
            .setDescription('ayo join KC')
            .addFields(
                { name: 'How to Use:', value: 'tinggal /convert' },
                { name: 'Supported Formats:', value: '(`.png`, `.jpg`, `.jpeg`, `.webp`) (`.mp4`, `.mov`, `.webm`, `.mkv`).' },
                { name: 'Size Rules:', value: 'masukkin pixel' },
                { name: 'Stretch Tips:', value: 'asal aja' }
            )
            .setTimestamp()
            .setFooter({ text: 'Gugun', iconURL: client.user.displayAvatarURL() });

        await interaction.reply({ embeds: [helpEmbed] });
    }
};