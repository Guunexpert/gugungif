const { SlashCommandBuilder } = require('discord.js');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

function cleanupFiles(inPath, outPath) {
    if (inPath && fs.existsSync(inPath)) fs.unlinkSync(inPath);
    if (outPath && fs.existsSync(outPath)) fs.unlinkSync(outPath);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('convert')
        .setDescription('Convert image/video to GIF with stretch/resize')
        .addAttachmentOption(option => option.setName('file').setDescription('Send image/video').setRequired(true))
        .addIntegerOption(option => option.setName('width').setDescription('lebar nya canvas').setRequired(true))
        .addIntegerOption(option => option.setName('height').setDescription('tinggi nya canvas').setRequired(true))
        .addStringOption(option => option.setName('name').setDescription('nama file output (tanpa ekstensi)').setRequired(false)),
    
    async execute(interaction) {
        await interaction.deferReply();
        const attachment = interaction.options.getAttachment('file');
        const width = interaction.options.getInteger('width');
        const height = interaction.options.getInteger('height');
        let customName = interaction.options.getString('name');

        if (customName) {
            customName = customName.replace(/[^a-zA-Z0-9_-]/g, '');
        }
        const finalFileName = customName ? `${customName}.gif` : 'output.gif';

        const fileUrl = attachment.url;
        const fileExt = path.extname(attachment.name).toLowerCase();
        
        const inputPath = path.join(__dirname, '../', `input${fileExt}`);
        const outputPath = path.join(__dirname, '../', finalFileName);

        try {
            const response = await axios({ url: fileUrl, responseType: 'stream' });
            const writer = fs.createWriteStream(inputPath);
            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            if (['.mp4', '.mov', '.webm', '.mkv', '.gif'].includes(fileExt)) {
                ffmpeg(inputPath)
                    .duration(10)
                    .size(`${width}x${height}`)
                    .videoFilters('setsar=1')
                    .output(outputPath)
                    .on('end', async () => {
                        await interaction.editReply({ files: [outputPath] });
                        cleanupFiles(inputPath, outputPath);
                    })
                    .on('error', (err) => {
                        console.error(err);
                        interaction.editReply('Failed converting video. Make sure FFmpeg is installed.');
                        cleanupFiles(inputPath, outputPath);
                    })
                    .run();
            } 
            else if (['.png', '.jpg', '.jpeg', '.webp'].includes(fileExt)) {
                await sharp(inputPath)
                    .resize(width, height, { fit: 'fill' })
                    .toFile(outputPath);
                    
                await interaction.editReply({ files: [outputPath] });
                cleanupFiles(inputPath, outputPath);
            } else {
                await interaction.editReply('Format not supported !');
                cleanupFiles(inputPath, null);
            }
        } catch (error) {
            console.error(error);
            await interaction.editReply('Error.');
        }
    }
};