const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const sharp = require('sharp');
const axios = require('axios');
const ytDlp = require('yt-dlp-exec');
const fs = require('fs');
const path = require('path');

const pendingSelections = new Map();
const platformHosts = new Set([
    'x.com', 'www.x.com', 'twitter.com', 'www.twitter.com',
    'instagram.com', 'www.instagram.com',
    'facebook.com', 'www.facebook.com', 'fb.watch'
]);

if (!ffmpegPath) {
    throw new Error('FFmpeg binary is not available from the ffmpeg-static package.');
}

ffmpeg.setFfmpegPath(ffmpegPath);

function cleanupFiles(inPath, outPath) {
    if (inPath && fs.existsSync(inPath)) fs.unlinkSync(inPath);
    if (outPath && fs.existsSync(outPath)) fs.unlinkSync(outPath);
}

function extensionFromContentType(contentType) {
    const type = contentType?.split(';')[0].toLowerCase();
    const extensions = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/webp': '.webp',
        'image/gif': '.gif',
        'video/mp4': '.mp4',
        'video/quicktime': '.mov',
        'video/webm': '.webm',
        'video/x-matroska': '.mkv'
    };

    return extensions[type];
}

function isPlatformUrl(url) {
    return platformHosts.has(new URL(url).hostname.toLowerCase());
}

function getMediaEntries(info) {
    const entries = (info.entries || []).flatMap(entry => entry.entries || entry);
    const mediaEntries = entries.length ? entries : [info];
    return mediaEntries.filter(entry => entry.url || entry.original_url);
}

async function extractXMedia(url) {
    const match = new URL(url).pathname.match(/\/status\/(\d+)/);
    if (!match) {
        return [];
    }

    const response = await axios.get(`https://api.fxtwitter.com/status/${match[1]}`, {
        timeout: 15000,
        validateStatus: status => status >= 200 && status < 300
    });
    const media = response.data?.tweet?.media?.all || [];

    return media
        .filter(item => item.url)
        .map(item => ({
            url: item.url,
            ext: item.type === 'video' ? 'mp4' : path.extname(new URL(item.url).pathname).slice(1) || 'jpg'
        }));
}

async function extractPlatformMedia(url) {
    try {
        const info = await ytDlp(url, {
            dumpSingleJson: true,
            noWarnings: true,
            skipDownload: true,
            quiet: true
        });

        return getMediaEntries(info);
    } catch (error) {
        const hostname = new URL(url).hostname.toLowerCase();
        if (hostname === 'x.com' || hostname === 'www.x.com' ||
            hostname === 'twitter.com' || hostname === 'www.twitter.com') {
            return extractXMedia(url);
        }

        throw error;
    }
}

async function convertMedia(interaction, { fileUrl, fileExt, width, height, customName }) {
    let inputPath;
    const finalFileName = customName ? `${customName}.gif` : 'output.gif';
    const outputPath = path.join(__dirname, '../', finalFileName);

    try {
        const response = await axios({
            url: fileUrl,
            responseType: 'stream',
            timeout: 30000,
            maxContentLength: 100 * 1024 * 1024,
            maxBodyLength: 100 * 1024 * 1024,
            validateStatus: status => status >= 200 && status < 300
        });

        if (!fileExt) {
            fileExt = extensionFromContentType(response.headers['content-type']);
        }

        if (!fileExt) {
            await interaction.editReply('Format not supported.');
            return;
        }

        inputPath = path.join(__dirname, '../', `input-${Date.now()}-${Math.random().toString(36).slice(2)}${fileExt}`);
        const writer = fs.createWriteStream(inputPath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        if (['.mp4', '.mov', '.webm', '.mkv', '.gif'].includes(fileExt)) {
            await new Promise((resolve, reject) => {
                ffmpeg(inputPath)
                    .duration(10)
                    .size(`${width}x${height}`)
                    .videoFilters('setsar=1')
                    .output(outputPath)
                    .on('end', resolve)
                    .on('error', reject)
                    .run();
            });
        } else if (['.png', '.jpg', '.jpeg', '.webp'].includes(fileExt)) {
            await sharp(inputPath)
                .resize(width, height, { fit: 'fill' })
                .toFile(outputPath);
        } else {
            await interaction.editReply('Format not supported!');
            return;
        }

        await interaction.editReply({ content: 'Done.', files: [outputPath], components: [] });
    } finally {
        cleanupFiles(inputPath, outputPath);
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('convert')
        .setDescription('Convert image/video to GIF with stretch/resize')
        .addIntegerOption(option => option.setName('width').setDescription('canvas width').setRequired(true))
        .addIntegerOption(option => option.setName('height').setDescription('canvas height').setRequired(true))
        .addAttachmentOption(option => option.setName('file').setDescription('Send image/video').setRequired(false))
        .addStringOption(option => option.setName('url').setDescription('Send image/video link').setRequired(false))
        .addStringOption(option => option.setName('name').setDescription('file output name (without extension)').setRequired(false)),
    
    async execute(interaction) {
        await interaction.deferReply();
        const attachment = interaction.options.getAttachment('file');
        const url = interaction.options.getString('url')?.trim();
        const width = interaction.options.getInteger('width');
        const height = interaction.options.getInteger('height');
        let customName = interaction.options.getString('name');

        if (!attachment && !url) {
            await interaction.editReply('Send files or fill in image/video links in the `file` or `url` options.');
            return;
        }

        if (attachment && url) {
            await interaction.editReply('Choose one: file or url.');
            return;
        }

        if (customName) {
            customName = customName.replace(/[^a-zA-Z0-9_-]/g, '');
        }
        let fileUrl = attachment?.url;
        let fileExt = attachment ? path.extname(attachment.name).toLowerCase() : '';

        try {
            if (url) {
                let parsedUrl;
                try {
                    parsedUrl = new URL(url);
                } catch {
                    await interaction.editReply('Link not valid.');
                    return;
                }

                if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                    await interaction.editReply('Link must use http or https.');
                    return;
                }

                fileUrl = parsedUrl.toString();
                if (isPlatformUrl(fileUrl)) {
                    await interaction.editReply('Wait for a moment...');
                    const media = await extractPlatformMedia(fileUrl);

                    if (!media.length) {
                        await interaction.editReply('No media was found in the post.');
                        return;
                    }

                    if (media.length > 1) {
                        const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
                        pendingSelections.set(token, {
                            userId: interaction.user.id,
                            media,
                            width,
                            height,
                            customName
                        });
                        setTimeout(() => pendingSelections.delete(token), 120000);

                        const buttons = media.slice(0, 25).map((_, index) =>
                            new ButtonBuilder()
                                .setCustomId(`convert_media:${token}:${index}`)
                                .setLabel(`Media ${index + 1}`)
                                .setStyle(ButtonStyle.Primary)
                        );
                        const rows = [];
                        for (let index = 0; index < buttons.length; index += 5) {
                            rows.push(new ActionRowBuilder().addComponents(buttons.slice(index, index + 5)));
                        }
                        await interaction.editReply({
                            content: `The post has ${media.length} media. Select the media you want to convert:`,
                            components: rows
                        });
                        return;
                    }

                    fileUrl = media[0].url || media[0].original_url;
                    fileExt = media[0].ext ? `.${media[0].ext}` : '';
                }
            }

            await convertMedia(interaction, { fileUrl, fileExt, width, height, customName });
        } catch (error) {
            console.error(error);
            await interaction.editReply('Failed to fetch or convert media.');
        }
    },

    async handleComponent(interaction) {
        const [, token, indexText] = interaction.customId.split(':');
        const selection = pendingSelections.get(token);

        if (!selection) {
            await interaction.reply({ content: 'Media options are out of date.', ephemeral: true });
            return;
        }
        if (selection.userId !== interaction.user.id) {
            await interaction.reply({ content: 'Only the user running the command can select.', ephemeral: true });
            return;
        }

        const media = selection.media[Number(indexText)];
        pendingSelections.delete(token);
        await interaction.deferUpdate();
        await convertMedia(interaction, {
            fileUrl: media.url || media.original_url,
            fileExt: media.ext ? `.${media.ext}` : '',
            width: selection.width,
            height: selection.height,
            customName: selection.customName
        });
    }
};