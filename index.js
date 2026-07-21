const { Client: WAClient, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { Client: DiscordClient, GatewayIntentBits } = require('discord.js');
const { Telegraf: TelegramBot } = require('telegraf');
const qrcode = require('qrcode-terminal');
const express = require('express');
const mongoose = require('mongoose');
const cron = require('node-cron');
const tr = require('googletrans').default;
const moment = require('moment-timezone');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Mars_16 Cross-Platform Engine Active 24/7'));
app.listen(PORT, () => console.log(`Web portal online on port ${PORT}`));

// ==========================================
// CENTRAL SYSTEM CONFIGURATIONS
// ==========================================
const SUPER_ADMIN = '919310314801@c.us'; 
const BOT_IMAGE_URL = 'https://githubusercontent.com';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/mars16';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';

mongoose.connect(MONGO_URI).then(() => console.log('📦 Connected to MongoDB shared cluster.')).catch(err => console.error(err));

// Database Schemas
const GroupConfig = mongoose.model('GroupConfig', new mongoose.Schema({
    groupId: { type: String, unique: true, index: true },
    rules: { type: String, default: "" },
    antiPromo: { type: Boolean, default: false },
    abuseDetect: { type: Boolean, default: false },
    mutedUsers: { type: [String], default: [] },
    approved: { type: Boolean, default: false }
}));

const Strike = mongoose.model('Strike', new mongoose.Schema({
    groupId: { type: String, index: true },
    userId: { type: String, index: true },
    strikes: { type: Number, default: 0 },
    lastViolation: { type: Date, default: Date.now }
}));

const Task = mongoose.model('Task', new mongoose.Schema({
    chatId: { type: String, index: true },          
    creatorId: String,       
    creatorName: String,     
    createdAt: { type: Date, default: Date.now }, 
    type: { type: String, enum: ['reminder', 'schedule'] },
    cronPattern: String,     
    targetTimestamp: Number, 
    payload: String,
    isRecurring: { type: Boolean, default: false }
}));

const TrustLease = mongoose.model('TrustLease', new mongoose.Schema({
    groupId: { type: String, index: true },
    userId: { type: String, index: true },
    expiresAt: Number
}));

const AutoResponse = mongoose.model('AutoResponse', new mongoose.Schema({
    groupId: { type: String, index: true },
    triggerWord: { type: String, required: true },
    replyPayload: { type: String, required: true }
}));

let configCache = new Map();
let floodTracker = new Map(); 

const abuseBlacklist = [
    'abuse1', 'abuse2', 'badword', 'bastard', 'scam', 'puta', 'mierda',
    'chutiya', 'bhenchod', 'gandu', 'madarchod', 'laundu', 'harami'
];

async function loadCaches() {
    const allConfigs = await GroupConfig.find({});
    allConfigs.forEach(cfg => configCache.set(cfg.groupId, cfg));
}
GroupConfig.find({}).then(() => loadCaches());

function getGroupCache(groupId) {
    if (!configCache.has(groupId)) {
        configCache.set(groupId, { rules: "", antiPromo: false, abuseDetect: false, mutedUsers: [], approved: false });
        GroupConfig.create({ groupId }).catch(() => {});
    }
    return configCache.get(groupId);
}
const waClient = new WAClient({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});
waClient.on('qr', (qr) => { qrcode.generate(qr, { small: true }); });
waClient.on('ready', () => console.log('📱 WhatsApp Network Gateway: Connected!'));

const discordClient = new DiscordClient({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});
if(DISCORD_TOKEN) discordClient.login(DISCORD_TOKEN);

const tgBot = TELEGRAM_TOKEN ? new TelegramBot(TELEGRAM_TOKEN) : null;
if(tgBot) tgBot.launch();

async function handleStrikeAction(platform, groupId, userId, reason, replyContext, kickContext) {
    let record = await Strike.findOne({ groupId, userId });
    if (!record) record = new Strike({ groupId, userId, strikes: 0 });
    record.strikes += 1;
    record.lastViolation = new Date();
    await record.save();
    const cleanUser = userId.split('@');
    if (record.strikes >= 3) {
        await replyContext(`🚫 *AUTOMATED BAN EXECUTION*\n\nUser @${cleanUser} has reached *3/3 STRIKES*. Evicting...`);
        await kickContext(userId);
        await Strike.deleteOne({ groupId, userId }); 
    } else {
        await replyContext(`⚠️ *SECURITY WARNING (Strike ${record.strikes}/3)*\n\n@${cleanUser}, message deleted for: *${reason}*.`);
    }
}
async function handleIncomingCommand(context) {
    const { platform, groupId, senderId, senderName, rawBody, replyContext, kickContext, deleteContext, hasMedia, msgObj, chatObj } = context;
    let textMessage = rawBody.trim();
    const cache = getGroupCache(groupId);

    if (cache.mutedUsers.includes(senderId)) {
        await deleteContext();
        return;
    }

    const matchedRule = await AutoResponse.findOne({ groupId, triggerWord: textMessage.toLowerCase() });
    if (matchedRule) {
        if (matchedRule.replyPayload.trim().startsWith('.')) textMessage = matchedRule.replyPayload.trim();
        else return replyContext(matchedRule.replyPayload);
    }

    if (platform === 'whatsapp' && senderId !== SUPER_ADMIN) {
        const now = Date.now();
        if (!floodTracker.has(senderId)) floodTracker.set(senderId, []);
        let userTimestamps = floodTracker.get(senderId);
        userTimestamps.push(now);
        userTimestamps = userTimestamps.filter(ts => now - ts < 3000);
        floodTracker.set(senderId, userTimestamps);
        if (userTimestamps.length > 5) {
            await deleteContext();
            await handleStrikeAction(platform, groupId, senderId, "Chat Flood / Spam Detected", replyContext, kickContext);
            return;
        }
        if (cache.antiPromo && (textMessage.includes('http://') || textMessage.includes('https://') || textMessage.includes('wa.me/'))) {
            await deleteContext();
            await handleStrikeAction(platform, groupId, senderId, "Anti-Promo Link Injection", replyContext, kickContext);
            return;
        }
    }

    if (platform === 'whatsapp' && senderId !== SUPER_ADMIN && cache.abuseDetect) {
        let normalizedText = textMessage.toLowerCase()
            .replace(/@/g, 'a').replace(/\$/g, 's').replace(/1/g, 'i')
            .replace(/3/g, 'e').replace(/0/g, 'o').replace(/7/g, 't');
        const containsAbuse = abuseBlacklist.some(word => normalizedText.includes(word));
        if (containsAbuse) {
            await deleteContext();
            await handleStrikeAction(platform, groupId, senderId, "Universal Language Profanity Violation", replyContext, kickContext);
            return;
        }
    }

    let isTriggered = false;
    if (textMessage.startsWith('.')) {
        textMessage = textMessage.slice(1);
        isTriggered = true;
    } else if (platform === 'whatsapp' && msgObj.mentionedIds.includes(waClient.info.wid._serialized)) {
        textMessage = textMessage.replace(new RegExp(`@${waClient.info.wid.user}`, 'gi'), '').trim();
        isTriggered = true;
    }

    if (!isTriggered || !textMessage) return;
    const args = textMessage.split(/ +/);
    const command = args.shift().toLowerCase();
    const isAuthorized = (senderId === SUPER_ADMIN) || (platform === 'whatsapp' && chatObj?.isGroup ? chatObj.participants.find(p => p.id._serialized === senderId)?.isAdmin : true);

    if (command === 'help') {
        return replyContext(`==== MARS_16 DIRECTION ====\n\n.ping - Check speed\n.monster [number/name] - View lineups ⚔️\n.form [848/569/947/7112] - Formations ratio 📊\n.da [country] - IGG Time converter 🏟️\n.trans - Translate\n.sticker - Create sticker\n.addreply [key] [text] - Add auto-reply`);
    }
    if (command === 'ping') return replyContext(`Pong! Engine running cleanly over [${platform.toUpperCase()}].`);

    if (command === 'monster' || command === 'hunt') {
        const userInput = args.join(' ').trim().toLowerCase();
        const GITHUB_POSTER_BASE = 'https://githubusercontent.com';
        const monsterIndex = {
            '1': { name: 'BON APPETI', image: '1.jpg', keywords: ['bon', 'appeti'] },
            '2': { name: 'Arctic Flipper', image: '2.jpg', keywords: ['arctic', 'flipper'] },
            '3': { name: 'Blackwing', image: '3.jpg', keywords: ['blackwing'] },
            '4': { name: 'Frostwing', image: '4.jpg', keywords: ['frostwing'] },
            '5': { name: 'Gargantua', image: '5.jpg', keywords: ['gargantua'] },
            '6': { name: 'Gawrilla', image: '6.jpg', keywords: ['gawrilla'] },
            '7': { name: 'Grim Reaper', image: '7.jpg', keywords: ['grim', 'reaper'] },
            '8': { name: 'Gryphon', image: '8.jpg', keywords: ['gryphon'] },
            '9': { name: 'Hardrox', image: '9.jpg', keywords: ['hardrox'] },
            '10': { name: 'Hell Drider', image: '10.jpg', keywords: ['hell', 'drider'] },
            '11': { name: 'Jade Wyrm', image: '11.jpg', keywords: ['jade', 'wyrm'] },
            '12': { name: 'Hootclaw', image: '12.jpg', keywords: ['hootclaw'] },
            '13': { name: 'Mecha Trojan', image: '13.jpg', keywords: ['mecha', 'trojan'] },
            '14': { name: 'Mega Maggot', image: '14.jpg', keywords: ['mega', 'maggot'] },
            '15': { name: 'Necrosis', image: '15.jpg', keywords: ['necrosis'] },
            '16': { name: 'Noceros', image: '16.jpg', keywords: ['noceros'] },
            '17': { name: 'Queen Bee', image: '17.jpg', keywords: ['queen', 'bee'] },
            '18': { name: 'Saberfang', image: '18.jpg', keywords: ['saberfang'] },
            '19': { name: 'Serpent Gladiator', image: '19.jpg', keywords: ['serpent'] },
            '20': { name: 'Snow Beast', image: '20.jpg', keywords: ['snow', 'beast'] },
            '21': { name: 'Terrorthorn', image: '21.jpg', keywords: ['terrorthorn'] },
            '22': { name: 'Tidal Titan', image: '22.jpg', keywords: ['tidal', 'titan'] },
            '23': { name: 'Voodoo Shaman', image: '23.jpg', keywords: ['voodoo', 'shaman'] },
            '24': { name: 'Cottageroar', image: '24.jpg', keywords: ['cottageroar'] }
        };

        if (!userInput) {
            let indexMenu = `==== LORDS MOBILE MONSTER HUNTER REGISTRY ====\n\nType .monster [Number/Name] to see the lineup poster!\n\n`;
            Object.keys(monsterIndex).forEach(k => { indexMenu += `${k}. ${monsterIndex[k].name}\n`; });
            return replyContext(indexMenu);
        }

        let matchedMonster = monsterIndex[userInput] || Object.values(monsterIndex).find(m => m.keywords.some(key => userInput.includes(key)));
        if (matchedMonster) {
            const posterUrl = `${GITHUB_POSTER_BASE}${matchedMonster.image}`;
            try {
                const mediaFile = await MessageMedia.fromUrl(posterUrl);
                if (platform === 'whatsapp') {
                    await chatObj.sendMessage(mediaFile, { caption: `⚔️ *Target:* ${matchedMonster.name.toUpperCase()}` });
                } else { return replyContext(`⚔️ *Target:* ${matchedMonster.name.toUpperCase()}\nPoster: ${posterUrl}`); }
            } catch { return replyContext(`❌ Error streaming poster image file. Check "${matchedMonster.image}" in images folder.`); }
        } else { return replyContext('❌ Monster match failed.'); }
        return;
    }
    if (command === 'form' || command === 'formation' || command === 'comp') {
        const typeInput = args.join(' ').trim().toLowerCase();
        const formationDatabase = {
            '848': { name: '848 Wonder Comp ⚔️', mix: '40% Inf \| 20% Rng \| 40% Cav', ex: 'Send 80k Inf, 40k Rng, 80k Cav.' },
            '569': { name: '569 Counter Comp 🔮', mix: '25% Inf \| 30% Rng \| 45% Cav', ex: 'Send 50k Inf, 60k Rng, 90k Cav.' },
            '947': { name: '947 Counter Comp 🔥', mix: '45% Inf \| 20% Rng \| 35% Cav', ex: 'Send 90k Inf, 40k Rng, 70k Cav.' },
            '7112': { name: '7-11-2 Balanced Comp 🛡️', mix: '35% Inf \| 55% Rng \| 10% Cav', ex: 'Send 70k Inf, 110k Rng, 20k Cav.' }
        };
        if (!typeInput) return replyContext(`==== MARS_16 FORMATION DIRECTORY ====\n\n👉 .form 848 \| .form 569 \| .form 947 \| .form 7112\n👉 .form split \| .form donate`);
        if (typeInput.includes('split')) return replyContext(`🛡️ *T5 / T4 FILL RATIOS (Out of 200k):\n\n💎 80/20:* 160k T5 & 40k T4\n⚡ *60/40:* 120k T5 & 80k T4\n🟢 *50/50:* 100k T5 & 100k T4`);
        if (typeInput.includes('donate')) return replyContext(`🌾 *GUILD DONATION RULES:*\n\n1. Shields: 1x 24h shield weekly to bank.\n2. War RSS: Send Gold & Ore to active Rally leads.`);
        
        let cleanKey = typeInput.replace(/[^0-9]/g, '');
        const matched = formationDatabase[cleanKey];
        if (matched) return replyContext(`⚔️ *MARS_16 DEPLOYMENT: [${cleanKey}]*\n\n📈 *Ratio:* ${matched.mix}\n📐 *Example:* ${matched.ex}`);
        else return replyContext('❌ Formation not found.');
    }

    if (command === 'da' || command === 'showdown' || command === 'arena') {
        const countryInput = args.join(' ').trim().toLowerCase();
        const countryTimezones = { 'india': 'Asia/Kolkata', 'in': 'Asia/Kolkata', 'usa': 'America/New_York', 'us': 'America/New_York', 'brazil': 'America/Sao_Paulo', 'br': 'America/Sao_Paulo', 'uk': 'Europe/London' };
        if (!countryInput) return replyContext('❌ Usage: `.da [country]` (e.g., `.da india`)');
        const tz = countryTimezones[countryInput];
        if (tz) {
        const baseSlotsUtc =[5, 8, 11, 14, 17, 20, 23, 2];
            let listStr = `🏟️ *IGG EVENT LOCAL SLOTS FOR: ${countryInput.toUpperCase()}*\n\n`;
            baseSlotsUtc.forEach((hour, i) => {
                let slot = moment.utc().hours(hour).minutes(0).seconds(0);
                if (hour === 2) slot.add(1, 'day');
                listStr += `├→ Slot ${i + 1}: *${slot.tz(tz).format('hh:mm A')}* (${slot.tz(tz).format('dddd')})\n`;
            });
            return replyContext(listStr);
        } else { return replyContext('❌ Country timezone not mapped.'); }
    }

    if (command === 'trans' || command === 'translate') {
        let targetLang = 'en'; let text = args.join(' ');
        if (platform === 'whatsapp' && msgObj.hasQuotedMsg) {
            const q = await msgObj.getQuotedMessage();
            if (args.length > 0) targetLang = args.toLowerCase();
            text = q.body;
        }
        if (!text) return replyContext('❌ Provide text or reply to a message with `.trans [lang]`');
        try {
            const res = await tr(text, { to: targetLang });
            return replyContext(`🌐 *Translation [${targetLang.toUpperCase()}]:*\n"${res.text}"`);
        } catch { return replyContext('❌ Translation engine timeout.'); }
    }

    if (platform === 'whatsapp' && chatObj?.isGroup) {
        if (command === 'addmember' && isAuthorized) {
            const targetPhone = args[0];
            if (!targetPhone) return replyContext('❌ Usage: `.addmember 91XXXXXXXXXX`');
            try {
                await chatObj.addParticipants([`${targetPhone}@c.us`]);
                return replyContext('✅ Target member added successfully.');
            } catch { return replyContext('❌ Action failed: Check formatting parameters.'); }
        }

        if (command === 'kick' && isAuthorized && msgObj.hasQuotedMsg) {
            const target = (await msgObj.getQuotedMessage()).author;
            if (target === SUPER_ADMIN) return replyContext('❌ Absolute Authority bypass active.');
            await chatObj.removeParticipants([target]);
            return replyContext('🚫 Target successfully evicted.');
        }

        if (command === 'mute' && isAuthorized && msgObj.hasQuotedMsg) {
            const target = (await msgObj.getQuotedMessage()).author;
            if (target === SUPER_ADMIN) return replyContext('❌ Cancelled: Super Admin immunity.');
            await GroupConfig.findOneAndUpdate({ groupId }, { $addToSet: { mutedUsers: target } }, { upsert: true });
            getGroupCache(groupId).mutedUsers.push(target);
            return replyContext('🔇 User text transmission muted.');
        }

        if (command === 'unmute' && isAuthorized && msgObj.hasQuotedMsg) {
            const target = (await msgObj.getQuotedMessage()).author;
            await GroupConfig.findOneAndUpdate({ groupId }, { $pull: { mutedUsers: target } });
            let localCache = getGroupCache(groupId);
            localCache.mutedUsers = localCache.mutedUsers.filter(id => id !== target);
            return replyContext('🔊 User allowed to text again.');
        }

        if (command === 'del' && isAuthorized && msgObj.hasQuotedMsg) {
            await (await msgObj.getQuotedMessage()).delete(true);
            return;
        }
    }

    if (command === 'sticker' || command === 's') {
        if (platform !== 'whatsapp') return replyContext('❌ Supported on WhatsApp only.');
        let targetMedia = msgObj; if (msgObj.hasQuotedMsg) targetMedia = await msgObj.getQuotedMessage();
        if (targetMedia.hasMedia && targetMedia.type === 'image') {
            try {
                const attachment = await targetMedia.downloadMedia();
                const sticker = new Sticker(attachment.data, { pack: 'Mars_16 Pack', author: 'Bot', type: StickerTypes.FULL, quality: 60 });
                await chatObj.sendMessage(await sticker.toMessageMedia(), { sendMediaAsSticker: true });
            } catch { return replyContext('❌ Sticker engine crash.'); }
        } else { return replyContext('💡 Reply to an image with `.sticker`.'); }
        return;
    }

    if (command === 'addreply') {
        if (!isAuthorized) return replyContext('❌ Admin access required.');
        const trig = args.shift()?.toLowerCase(); const payloadStr = args.join(' ');
        if (!trig || !payloadStr) return replyContext('❌ Usage: `.addreply [keyword] [text]`');
        await AutoResponse.findOneAndUpdate({ groupId, triggerWord: trig }, { replyPayload: payloadStr }, { upsert: true });
        return replyContext(`✅ Auto-reply set for: "${trig}".`);
    }

    if (command === 'replylist') {
        const list = await AutoResponse.find({ groupId });
        if (list.length === 0) return replyContext('📭 No auto-responders configured.');
        let rulesDisplay = `📋 *ACTIVE AUTO-RESPONDERS:* \n\n`;
        list.forEach(r => rulesDisplay += `├→ "${r.triggerWord}": ${r.replyPayload}\n`);
        return replyContext(rulesDisplay);
    }
}

waClient.on('message', async (msg) => {
    const chat = await msg.getChat();
    handleIncomingCommand({
        platform: 'whatsapp',
        groupId: chat.id._serialized,
        senderId: msg.author || msg.from,
        senderName: msg._data.notifyName || 'WA_User',
        rawBody: msg.body,
        replyContext: async (t) => msg.reply(t),
        kickContext: async (u) => chat.removeParticipants([u]),
        deleteContext: async () => msg.delete(true),
        msgObj: msg,
        chatObj: chat
    });
});

function startGlobalScheduler() {
    cron.schedule('* * * * *', async () => {
        let istNow = moment().tz('Asia/Kolkata');
        const activeTasks = await Task.find({});
        if (istNow.hours() === 3 && istNow.minutes() === 0) {
            try {
                await Task.deleteMany({ isRecurring: false, targetTimestamp: { $lt: istNow.valueOf() } });
                await Strike.deleteMany({ lastViolation: { $lt: new Date(istNow.clone().subtract(7, 'days').valueOf()) } });
                await TrustLease.deleteMany({ expiresAt: { $lt: istNow.valueOf() } });
            } catch (e) { console.error(e); }
        }
    });
}

waClient.initialize();
