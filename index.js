const mongoose = require('mongoose');

// Central Identity Configuration
const SUPER_ADMIN = '919310314801@c.us'; 
const BOT_IMAGE_URL = 'https://githubusercontent.com';

// Connection String Management
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/mars16';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';

mongoose.connect(MONGO_URI)
    .then(() => console.log('📦 Connected to MongoDB shared cluster.'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// Database Operational Schemas
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

const AutoResponse = mongoose.model('AutoResponse', new mongoose.Schema({
    groupId: { type: String, index: true },
    triggerWord: { type: String, required: true },
    replyPayload: { type: String, required: true }
}));

// System Security Runtime Containers
let configCache = new Map();
let floodTracker = new Map(); 

const abuseBlacklist = [
    'abuse1', 'abuse2', 'badword', 'bastard', 'scam', 'puta', 'mierda',
    'chutiya', 'bhenchod', 'gandu', 'madarchod', 'laundu', 'harami'
];

async function loadCaches() {
    try {
        const allConfigs = await GroupConfig.find({});
        allConfigs.forEach(cfg => configCache.set(cfg.groupId, cfg));
    } catch (err) {
        console.error("Cache pre-load breakdown:", err);
    }
}
GroupConfig.find({}).then(() => loadCaches()).catch(() => {});

function getGroupCache(groupId) {
    if (!configCache.has(groupId)) {
        configCache.set(groupId, { rules: "", antiPromo: false, abuseDetect: false, mutedUsers: [], approved: false });
        GroupConfig.create({ groupId }).catch(() => {});
    }
    return configCache.get(groupId);
}

module.exports = {
    SUPER_ADMIN,
    BOT_IMAGE_URL,
    DISCORD_TOKEN,
    TELEGRAM_TOKEN,
    GroupConfig,
    Strike,
    AutoResponse,
    floodTracker,
    abuseBlacklist,
    getGroupCache
};
const { Strike, AutoResponse, floodTracker, abuseBlacklist, getGroupCache, SUPER_ADMIN } = require('./config');

async function handleStrikeAction(platform, groupId, userId, reason, replyContext, kickContext) {
    let record = await Strike.findOne({ groupId, userId });
    if (!record) record = new Strike({ groupId, userId, strikes: 0 });
    record.strikes += 1;
    record.lastViolation = new Date();
    await record.save();
    
    const cleanUser = userId.split('@')[0];
    if (record.strikes >= 3) {
        await replyContext(`🚫 *AUTOMATED BAN EXECUTION*\n\nUser @${cleanUser} has reached *3/3 STRIKES*. Evicting...`);
        await kickContext(userId);
        await Strike.deleteOne({ groupId, userId }); 
    } else {
        await replyContext(`⚠️ *SECURITY WARNING (Strike ${record.strikes}/3)*\n\n@${cleanUser}, message deleted for: *${reason}*.`);
    }
}

async function handleIncomingCommand(context, waClient) {
    const { platform, groupId, senderId, senderName, rawBody, replyContext, kickContext, deleteContext, hasMedia, msgObj, chatObj } = context;
    if (!rawBody) return;
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
    } else if (platform === 'whatsapp' && msgObj.mentionedIds.includes(waClient.info?.wid?._serialized)) {
        textMessage = textMessage.replace(new RegExp(`@${waClient.info.wid.user}`, 'gi'), '').trim();
        isTriggered = true;
    }

    if (!isTriggered || !textMessage) return;
    const args = textMessage.split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === 'help') {
        return replyContext(`==== MARS_16 DIRECTION ====\n\n.ping - Check speed\n.monster [number/name] - View lineups`);
    }
    
    if (command === 'ping') {
        return replyContext('🚀 Pong! Engine is fully operational.');
    }
}

module.exports = { handleIncomingCommand };
const { Client: WAClient, LocalAuth } = require('whatsapp-web.js');
const { Client: DiscordClient, GatewayIntentBits } = require('discord.js');
const { Telegraf: TelegramBot } = require('telegraf');
const qrcode = require('qrcode-terminal');
const express = require('express');

const { DISCORD_TOKEN, TELEGRAM_TOKEN } = require('./config');
const { handleIncomingCommand } = require('./handler');

const app = express();
const PORT = process.env.PORT || 3000;

// Shared state for streaming login data safely to web interface
let currentQrToken = "";

app.get('/', (req, res) => res.send('Mars_16 Cross-Platform Engine Active 24/7'));

// Clean visual web dashboard route for instant connection
app.get('/scan', (req, res) => {
    if (!currentQrToken) {
        return res.send(`
            <div style="text-align:center; margin-top:50px; font-family:sans-serif;">
                <h2>No QR code available yet.</h2>
                <p>The system engine is booting up. Please refresh this page in 10-15 seconds.</p>
            </div>
        `);
    }
    res.send(`
        <div style="text-align:center; margin-top:50px; font-family:sans-serif;">
            <h2 style="color:#075e54;">Scan with WhatsApp Linked Devices:</h2>
            <div style="margin:20px auto; padding:15px; display:inline-block; border:1px solid #ccc; border-radius:8px; background:#fff;">
                <img src="https://qrserver.com{encodeURIComponent(currentQrToken)}" alt="QR Code" />
            </div>
            <p style="color:#555; font-size:14px;">Once scanned successfully, your bot framework will instantly connect online.</p>
        </div>
    `);
});

app.listen(PORT, () => console.log(`Web portal online on port ${PORT}`));

// Initializing WhatsApp Client Core
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

waClient.on('qr', (qr) => { 
    currentQrToken = qr;
    qrcode.generate(qr, { small: true }); 
    console.log("👉 SCANNABLE IMAGE READY: Open your live website deployment link with '/scan' at the end to scan the code cleanly!");
});

waClient.on('ready', () => {
    currentQrToken = ""; // Clear token upon authorization
    console.log('📱 WhatsApp Network Gateway: Connected!');
});

// Structural Wrapper mapping WhatsApp message structure to universal handler context
waClient.on('message', async (msg) => {
    const chat = await msg.getChat();
    const contact = await msg.getContact();
    
    const context = {
        platform: 'whatsapp',
        groupId: chat.id._serialized,
        senderId: msg.author || msg.from,
        senderName: contact.pushname || 'User',
        rawBody: msg.body,
        replyContext: async (text) => msg.reply(text),
        kickContext: async (userId) => {
            if (chat.isGroup) await chat.removeParticipants([userId]);
        },
        deleteContext: async () => {
            if (msg.fromMe) return;
            try { await msg.delete(true); } catch {}
        },
        hasMedia: msg.hasMedia,
        msgObj: msg,
        chatObj: chat
    };
    
    await handleIncomingCommand(context, waClient);
});

waClient.initialize();

// Initializing Alternating Gateways
const discordClient = new DiscordClient({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});
if (DISCORD_TOKEN) discordClient.login(DISCORD_TOKEN);

const tgBot = TELEGRAM_TOKEN ? new TelegramBot(TELEGRAM_TOKEN) : null;
if (tgBot) tgBot.launch();
