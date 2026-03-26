const sendpulse = require('../sendpulse');
const db = require('../db');

let io = null;
let pollingInterval = null;
const lastSeenMsg = {};

// Per-user Telegraf instances: { [userId]: Telegraf }
const userBots = {};

function start(socketIo) {
  io = socketIo;

  // Start bots for all users with telegram tokens
  refreshAllBots();

  // SendPulse API polling fallback (for users without Telegraf)
  pollingInterval = setInterval(async () => {
    try {
      const usersWithSP = await db.query(`
        SELECT DISTINCT p.user_id FROM pares p
        JOIN user_settings us ON us.user_id = p.user_id
        WHERE p.ativo=1 AND us.sendpulse_id IS NOT NULL AND us.sendpulse_secret IS NOT NULL
      `);

      for (const { user_id } of usersWithSP) {
        // Skip users that have a running Telegraf bot
        if (userBots[user_id]) continue;

        const settings = await db.getUserSettings(user_id);
        const credentials = {
          sendpulse_id: settings.sendpulse_id,
          sendpulse_secret: settings.sendpulse_secret,
        };
        const pares = await db.getAllPares(user_id);
        for (const par of pares) {
          await pollParMessages(par, credentials);
        }
      }
    } catch (err) {
      console.error('[feed] polling error:', err.message);
    }
  }, 15000);

  console.log('[feed] bot manager iniciado');
}

async function refreshAllBots() {
  const users = await db.getUsersWithTelegram();
  for (const { id, telegram_token } of users) {
    await startUserBot(id, telegram_token);
  }
}

async function refreshUser(userId) {
  // Stop existing bot
  if (userBots[userId]) {
    try { userBots[userId].stop(); } catch {}
    delete userBots[userId];
  }
  // Restart if token exists
  const settings = await db.getUserSettings(userId);
  if (settings.telegram_token) {
    await startUserBot(userId, settings.telegram_token);
  }
}

async function startUserBot(userId, telegramToken) {
  if (userBots[userId]) return; // already running

  try {
    const { Telegraf } = require('telegraf');
    const bot = new Telegraf(telegramToken);

    bot.on(['message', 'channel_post'], async (ctx) => {
      try {
        const groupId = String(ctx.chat.id);
        // Find matching pares for this user
        const pares = await db.getAllPares(userId);
        const par = pares.find(p => p.telegram_group_id === groupId);
        if (!par || !par.ativo) return;

        const msg = ctx.message || ctx.channelPost || ctx.update?.channel_post;
        if (!msg) return;

        const msgType = detectTelegrafType(msg);
        const fileId = extractTelegrafFileId(msg);
        const text = msg.text || msg.caption || null;

        let localPreview = null;
        let publicMediaUrl = null;
        if (fileId && (msgType === 'photo' || msgType === 'video')) {
          try {
            const result = await downloadTelegramFile(ctx, fileId, msgType, telegramToken);
            localPreview = result.localPath;
            publicMediaUrl = result.publicUrl;
          } catch (e) {
            console.error('[feed] download error:', e.message);
            // Fallback: try to get media URL from SendPulse chat history
            try {
              const settings = await db.getUserSettings(userId);
              if (settings.sendpulse_id && settings.sendpulse_secret) {
                const caption = msg.text || msg.caption || null;
                // Wait a moment for SendPulse to process the message
                await new Promise(r => setTimeout(r, 3000));
                const spUrl = await sendpulse.getMediaUrl(
                  par.sendpulse_bot_id,
                  { sendpulse_id: settings.sendpulse_id, sendpulse_secret: settings.sendpulse_secret },
                  caption
                );
                if (spUrl) {
                  publicMediaUrl = spUrl;
                  console.log('[feed] got media URL from SendPulse:', spUrl.slice(0, 80));
                }
              }
            } catch (e2) {
              console.error('[feed] SendPulse media fallback error:', e2.message);
            }
          }
        }

        const msgData = {
          par_id: par.id,
          text,
          from_user: ctx.from?.username || ctx.from?.first_name || ctx.chat?.title || 'canal',
          message_type: msgType,
          file_id: fileId || null,
          telegram_media_url: publicMediaUrl || localPreview || null,
        };

        // Dedup
        const existing = await db.getMessages(par.id, 30);
        const isDup = existing.some(e =>
          e.text === msgData.text &&
          e.file_id === msgData.file_id &&
          e.message_type === msgData.message_type &&
          e.created_at &&
          (Date.now() - new Date(e.created_at).getTime()) < 120000
        );
        if (isDup) return;

        const saved = await db.insertMessage(msgData);
        if (io) io.to(`par_${par.id}`).emit('new_message', saved);
      } catch (err) {
        console.error('[feed/telegraf] error:', err.message);
      }
    });

    bot.catch((err) => {
      console.error(`[feed] Telegraf runtime error (user ${userId}):`, err.message);
    });

    bot.launch({ dropPendingUpdates: true }).catch((err) => {
      console.error(`[feed] Telegraf launch error (user ${userId}):`, err.message);
      delete userBots[userId];
    });

    userBots[userId] = bot;
    console.log(`[feed] Telegraf bot iniciado para user ${userId}`);
  } catch (err) {
    console.error(`[feed] Telegraf error (user ${userId}):`, err.message);
  }
}

async function downloadTelegramFile(ctx, fileId, type, telegramToken) {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const https = require('https');
  const axios = require('axios');
  const FormData = require('form-data');

  const fileInfo = await ctx.telegram.getFile(fileId);
  const filePath = fileInfo.file_path;
  const ext = path.extname(filePath) || (type === 'photo' ? '.jpg' : '.mp4');
  const filename = crypto.randomBytes(12).toString('hex') + ext;
  const localPath = path.join(__dirname, '..', '..', 'public', 'uploads', filename);

  const telegramUrl = `https://api.telegram.org/file/bot${telegramToken}/${filePath}`;

  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(localPath);
    https.get(telegramUrl, (res) => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
  });

  let publicUrl = telegramUrl;
  try {
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', fs.createReadStream(localPath));
    const res = await axios.post('https://catbox.moe/user/api.php', form, {
      headers: form.getHeaders(),
      timeout: 120000,
      maxContentLength: 210 * 1024 * 1024,
    });
    if (res.data && res.data.startsWith('https://')) {
      publicUrl = res.data.trim();
      console.log('[feed] catbox.moe URL:', publicUrl);
    }
  } catch (e) {
    console.error('[feed] catbox upload failed, using telegram URL:', e.message);
  }

  return { localPath: `/uploads/${filename}`, publicUrl };
}

function detectTelegrafType(message) {
  if (message.photo && message.photo.length > 0) return 'photo';
  if (message.video) return 'video';
  if (message.document) return 'document';
  if (message.animation) return 'photo';
  return 'text';
}

function extractTelegrafFileId(message) {
  if (message.photo && message.photo.length > 0) return message.photo[message.photo.length - 1].file_id;
  if (message.video) return message.video.file_id;
  if (message.document) return message.document.file_id;
  if (message.animation) return message.animation.file_id;
  return null;
}

async function pollParMessages(par, credentials) {
  try {
    const contacts = await sendpulse.listContacts(par.sendpulse_bot_id, credentials);
    const groupContact = contacts.find(c => c.type === 3);
    if (!groupContact) return;

    const token = await sendpulse.getToken(credentials);
    const axios = require('axios');
    const res = await axios.get(
      `https://api.sendpulse.com/telegram/chats/messages?contact_id=${groupContact.id}&size=20&order=desc`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
    );

    const msgs = (res.data.data || res.data).filter(m => m.direction === 1);
    if (msgs.length === 0) return;

    const lastSeen = lastSeenMsg[par.id];
    const newMsgs = lastSeen
      ? msgs.filter(m => m.id > lastSeen)
      : msgs.slice(0, 10);

    if (newMsgs.length === 0) return;
    lastSeenMsg[par.id] = msgs[0].id;

    for (const m of newMsgs.reverse()) {
      const media = extractMedia(m.data);
      const msgData = {
        par_id: par.id,
        text: m.data?.text || m.data?.caption || null,
        from_user: groupContact.channel_data?.name || 'grupo',
        message_type: media.type,
        file_id: media.url || null,
        created_at: m.created_at ? m.created_at.replace('+00:00', '').replace('T', ' ') : undefined,
      };

      const existing = await db.getMessages(par.id, 50);
      const isDuplicate = existing.some(e =>
        e.text === msgData.text &&
        e.file_id === msgData.file_id &&
        e.created_at &&
        Math.abs(new Date(e.created_at).getTime() - new Date(m.created_at).getTime()) < 60000
      );
      if (isDuplicate) continue;

      const saved = await db.insertMessage(msgData);
      if (io) io.to(`par_${par.id}`).emit('new_message', saved);
    }
  } catch (err) {
    if (!err.message.includes('429')) {
      console.error(`[feed] poll error for par ${par.id}:`, err.message);
    }
  }
}

function extractMedia(data) {
  if (!data) return { type: 'text', url: null };
  if (data.photo) {
    if (typeof data.photo === 'string') return { type: 'photo', url: data.photo };
    if (Array.isArray(data.photo) && data.photo.length > 0) return { type: 'photo', url: data.photo[data.photo.length - 1].file_id || null };
    return { type: 'photo', url: data.photo.file_id || data.photo.url || null };
  }
  if (data.video) {
    if (typeof data.video === 'string') return { type: 'video', url: data.video };
    return { type: 'video', url: data.video.file_id || data.video.url || null };
  }
  if (data.document) {
    if (typeof data.document === 'string') return { type: 'document', url: data.document };
    return { type: 'document', url: data.document.file_id || data.document.url || null };
  }
  return { type: 'text', url: null };
}

function stop() {
  if (pollingInterval) clearInterval(pollingInterval);
  for (const userId of Object.keys(userBots)) {
    try { userBots[userId].stop(); } catch {}
  }
}

module.exports = { start, stop, refreshUser };
