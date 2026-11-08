const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const sharp = require('sharp');
const axios = require('axios');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const pendingSelections = new Map();
const platformHosts = new Set([
    'x.com', 'www.x.com', 'twitter.com', 'www.twitter.com',
    'instagram.com', 'www.instagram.com',
    'facebook.com', 'www.facebook.com', 'fb.watch',
    'pin.it', 'www.pin.it', 'pinterest.com', 'www.pinterest.com'
]);
const ytDlpPath = path.join(__dirname, '../', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

if (!ffmpegPath) {
    throw new Error('FFmpeg binary is not available from the ffmpeg-static package.');
}

ffmpeg.setFfmpegPath(ffmpegPath);

function withTimeout(promise, milliseconds, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function sendResult(interaction, payload) {
    if (payload && (payload.files || payload.components) && interaction.channel?.send) {
        try {
            await withTimeout(
                interaction.channel.send(payload),
                30000,
                'Channel file upload timed out'
            );
            console.log('[CONVERT] Result sent to channel');
            return;
        } catch (error) {
            console.error('[CONVERT] Channel result failed:', error.message);
        }
    }

    try {
        await withTimeout(interaction.followUp({ content: payload, ephemeral: true }), 30000, 'Discord follow-up timed out');
    } catch (error) {
        console.error('[CONVERT] Follow-up failed:', error.message);
    }
}

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

function decodeHtml(value) {
    return value
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'");
}

function getMetaContent(html, property) {
    const pattern = new RegExp(
        `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`,
        'i'
    );
    const reversePattern = new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`,
        'i'
    );
    const match = html.match(pattern) || html.match(reversePattern);
    return match ? decodeHtml(match[1]) : null;
}

async function extractPinterestMedia(url) {
    const response = await axios.get(url, {
        timeout: 15000,
        maxRedirects: 5,
        headers: { 'User-Agent': 'Mozilla/5.0' },
        validateStatus: status => status >= 200 && status < 300
    });
    const media = [
        { url: getMetaContent(response.data, 'og:video'), ext: 'mp4' },
        { url: getMetaContent(response.data, 'og:video:secure_url'), ext: 'mp4' },
        { url: getMetaContent(response.data, 'og:image'), ext: 'jpg' }
    ];
    const uniqueUrls = new Set();

    return media.filter(item => {
        if (!item.url || uniqueUrls.has(item.url)) {
            return false;
        }
        uniqueUrls.add(item.url);
        return true;
    });
}

function downloadFile(url, destination) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, response => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                downloadFile(response.headers.location, destination).then(resolve, reject);
                return;
            }

            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`yt-dlp download failed with HTTP ${response.statusCode}`));
                return;
            }

            fs.mkdirSync(path.dirname(destination), { recursive: true });
            const writer = fs.createWriteStream(destination);
            response.pipe(writer);
            writer.on('finish', () => writer.close(resolve));
            writer.on('error', reject);
        });
        request.setTimeout(30000, () => {
            request.destroy(new Error('yt-dlp download timed out'));
        });
        request.on('error', reject);
    });
}

async function ensureYtDlp() {
    if (!fs.existsSync(ytDlpPath)) {
        const filename = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
        await downloadFile(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${filename}`, ytDlpPath);
        if (process.platform !== 'win32') {
            fs.chmodSync(ytDlpPath, 0o755);
        }
    }

    return ytDlpPath;
}

function runYtDlp(url) {
    return ensureYtDlp().then(executable => new Promise((resolve, reject) => {
            const child = execFile(executable, [url, '--dump-single-json', '--no-warnings', '--skip-download', '--quiet'],
                { maxBuffer: 10 * 1024 * 1024, timeout: 60000 },
                (error, stdout, stderr) => {
                    if (error) {
                        reject(new Error(stderr.trim() || error.message));
                        return;
                    }
                    resolve(JSON.parse(stdout));
                });
            child.on('error', reject);
        }));
}

async function extractXMedia(url) {
    const match = new URL(url).pathname.match(/\/status\/(\d+)/);
    if (!match) {
        return [];
    }

    const response = await axios.get(`https://api.fxtwitter.com/status/${match[1]}`, {
        timeout: 15000,
        validateStatus: status => (status >= 200 && status < 300) || status === 404
    });
    if (response.status === 404 || response.data?.code === 404) {
        return [];
    }

    const media = response.data?.tweet?.media?.all || [];

    return media
        .filter(item => item.url)
        .map(item => ({
            url: item.url,
            ext: item.type === 'video' ? 'mp4' : path.extname(new URL(item.url).pathname).slice(1) || 'jpg'
        }));
}

async function extractPlatformMedia(url) {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname === 'x.com' || hostname === 'www.x.com' ||
        hostname === 'twitter.com' || hostname === 'www.twitter.com') {
        return extractXMedia(url);
    }
    const isPinterest = hostname === 'pin.it' || hostname === 'www.pin.it' ||
        hostname === 'pinterest.com' || hostname === 'www.pinterest.com';

    try {
        const info = await runYtDlp(url);
        return getMediaEntries(info);
    } catch (error) {
        if (hostname === 'x.com' || hostname === 'www.x.com' ||
            hostname === 'twitter.com' || hostname === 'www.twitter.com') {
            return extractXMedia(url);
        }
        if (isPinterest) {
            return extractPinterestMedia(url);
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
            await sendResult(interaction, 'Format not supported.');
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
            await sendResult(interaction, 'Format not supported!');
            return;
        }

        console.log(`[CONVERT] Media converted: ${outputPath}`);
        await sendResult(interaction, { content: 'Done.', files: [outputPath], components: [] });
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
        console.log(`[CONVERT] Starting interaction ${interaction.id}`);
        await interaction.reply({ content: 'Processing media...', ephemeral: true });
        console.log(`[CONVERT] Interaction acknowledged ${interaction.id}`);
        if (interaction.channel?.send) {
            await interaction.channel.send(
                `<@${interaction.user.id}> running a \`/convert\`. Processing...`
            );
        }
        const attachment = interaction.options.getAttachment('file');
        const url = interaction.options.getString('url')?.trim();
        const width = interaction.options.getInteger('width');
        const height = interaction.options.getInteger('height');
        let customName = interaction.options.getString('name');

        if (!attachment && !url) {
            await sendResult(interaction, 'Send files or fill in image/video links in the `file` or `url` options.');
            return;
        }

        if (attachment && url) {
            await sendResult(interaction, 'Choose one: file or url.');
            return;
        }

        if (customName) {
            customName = customName.replace(/[^a-zA-Z0-9_-]/g, '');
        }
        let fileUrl = attachment?.url;
        let fileExt = attachment ? path.extname(attachment.name).toLowerCase() : '';

        try {
            if (url) {
                console.log(`[CONVERT] URL received for ${interaction.id}`);
                let parsedUrl;
                try {
                    parsedUrl = new URL(url);
                } catch {
                    await sendResult(interaction, 'Link not valid.');
                    return;
                }

                if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                    await sendResult(interaction, 'Link must use http or https.');
                    return;
                }

                fileUrl = parsedUrl.toString();
                if (isPlatformUrl(fileUrl)) {
                    console.log(`[CONVERT] Platform URL detected: ${parsedUrl.hostname}`);
                    console.log(`[CONVERT] Fetching platform media for ${interaction.id}`);
                    const media = await withTimeout(
                        extractPlatformMedia(fileUrl),
                        45000,
                        'Platform media extraction timed out'
                    );
                    console.log(`[CONVERT] Platform media found: ${media.length}`);

                    if (!media.length) {
                        await sendResult(interaction, 'No media was found in the post.');
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
                        await sendResult(interaction, {
                            content: `The post has ${media.length} media. Select the media you want to convert:`,
                            components: rows
                        });
                        return;
                    }

                    fileUrl = media[0].url || media[0].original_url;
                    fileExt = media[0].ext ? `.${media[0].ext}` : '';
                }
            }

            await withTimeout(
                convertMedia(interaction, { fileUrl, fileExt, width, height, customName }),
                90000,
                'Media conversion timed out'
            );
        } catch (error) {
            if (error.response?.status !== 404) {
                console.error(error);
            }
            await sendResult(interaction, 'Failed to fetch or convert media. Please try a direct media link or upload the file.');
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
        await interaction.reply({ content: 'Processing selected media...', ephemeral: true });
        await convertMedia(interaction, {
            fileUrl: media.url || media.original_url,
            fileExt: media.ext ? `.${media.ext}` : '',
            width: selection.width,
            height: selection.height,
            customName: selection.customName
        });
    }
};