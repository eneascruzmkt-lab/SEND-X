const sendpulse = require('../sendpulse');
const db = require('../db');

let io = null;
let pollingInterval = null;
let telegrafBot = null;
const lastSeenMsg = {}; // par_id -> last message id

function start(socketIo) {
  io = socketIo;

  // Method 1: Telegraf (if TELEGRAM_TOKEN is set) — captures ALL messages including media
  if (process.env.TELEGRAM_TOKEN) {
    startTelegraf();
  }

  // Method 2: SendPulse API polling — fallback for text messages
  pollingInterval = setInterval(async () => {
    try {
      const pares = db.getAllPares();
      for (const par of pares) {
        await pollParMessages(par);
      }
    } catch (err) {
      console.error('[feed] polling error:', err.message);
    }
  }, 15000);

  setTimeout(async () => {
    const pares = db.getAllPares();
    for (const par of pares) {
      await pollParMessages(par);
    }
  }, 3000);

  console.log('[feed] polling SendPulse iniciado (15s)');
}

// ── Telegraf listener ───────────────────────────
function startTelegraf() {
  try {
    const { Telegraf } = require('telegraf');
    telegrafBot = new Telegraf(process.env.TELEGRAM_TOKEN);

    // 'message' for groups, 'channel_post' for channels
    telegrafBot.on(['message', 'channel_post'], async (ctx) => {
      try {
        const groupId = String(ctx.chat.id);
        const par = db.getParByGroupId(groupId);
        if (!par || !par.ativo) return;

        const msg = ctx.message || ctx.channelPost || ctx.update?.channel_post;
        if (!msg) return;

        const msgType = detectTelegrafType(msg);
        const fileId = extractTelegrafFileId(msg);
        const text = msg.text || msg.caption || null;


        // Download media to local uploads + get telegram public URL
        let localPreview = null;
        let publicMediaUrl = null;
        if (fileId && (msgType === 'photo' || msgType === 'video')) {
          try {
            const result = await downloadTelegramFile(ctx, fileId, msgType);
            localPreview = result.localPath;
            publicMediaUrl = result.publicUrl;
          } catch (e) {
            console.error('[feed] download error:', e.message);
            // For large videos (>20MB), use t.me link from the public channel directly
            const channelUsername = (par.channel_username || process.env.MEDIA_CHANNEL_USERNAME || '').replace('@', '');
            if (channelUsername && msg.message_id) {
              publicMediaUrl = `https://t.me/${channelUsername}/${msg.message_id}`;
              console.log('[feed] large media — using channel link:', publicMediaUrl);
            }
          }
        }

        const msgData = {
          par_id: par.id,
          text,
          from_user: ctx.from?.username || ctx.from?.first_name || ctx.chat?.title || 'canal',
          message_type: msgType,
          // file_id = local path for UI preview; store telegram URL in a data attribute
          file_id: localPreview || fileId || null,
          telegram_media_url: publicMediaUrl || null,
          telegram_message_id: msg.message_id || null,
          telegram_chat_id: groupId,
        };

        // Dedup by message_id
        const existing = db.getMessages(par.id, 30);
        const isDup = existing.some(e =>
          e.text === msgData.text &&
          e.file_id === msgData.file_id &&
          e.message_type === msgData.message_type &&
          e.created_at &&
          (Date.now() - new Date(e.created_at).getTime()) < 120000
        );
        if (isDup) return;

        const saved = db.insertMessage(msgData);
        if (io) io.to(`par_${par.id}`).emit('new_message', saved);
      } catch (err) {
        console.error('[feed/telegraf] error:', err.message);
      }
    });

    telegrafBot.launch({ dropPendingUpdates: true });
    console.log('[feed] Telegraf bot iniciado — captura de midia ativa');
  } catch (err) {
    console.error('[feed] Telegraf error:', err.message);
  }
}

async function downloadTelegramFile(ctx, fileId, type) {
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

  const telegramUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${filePath}`;

  // Download locally for UI preview
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(localPath);
    https.get(telegramUrl, (res) => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
  });

  // Upload to public host (SendPulse needs publicly accessible URL)
  // Telegra.ph only supports images; for video use catbox.moe
  let publicUrl = telegramUrl; // fallback
  try {
    const form = new FormData();
    if (type === 'video') {
      // catbox.moe supports video up to 200MB, no expiration (retry once)
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const vForm = new FormData();
          vForm.append('reqtype', 'fileupload');
          vForm.append('fileToUpload', fs.createReadStream(localPath));
          const res = await axios.post(
            'https://catbox.moe/user/api.php',
            vForm, { headers: vForm.getHeaders(), timeout: 120000, maxContentLength: 200 * 1024 * 1024 }
          );
          if (res.data && typeof res.data === 'string' && res.data.startsWith('https://')) {
            publicUrl = res.data.trim();
            console.log('[feed] video uploaded to catbox:', publicUrl);
            break;
          }
          console.error(`[feed] catbox unexpected response (attempt ${attempt}):`, res.data);
        } catch (uploadErr) {
          console.error(`[feed] catbox upload attempt ${attempt} failed:`, uploadErr.message);
          if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
        }
      }
    } else {
      // Telegra.ph for images (fast, reliable)
      form.append('file', fs.createReadStream(localPath));
      const res = await axios.post(
        'https://telegra.ph/upload',
        form, { headers: form.getHeaders(), timeout: 30000 }
      );
      if (Array.isArray(res.data) && res.data[0]?.src) {
        publicUrl = 'https://telegra.ph' + res.data[0].src;
        console.log('[feed] image uploaded to telegra.ph:', publicUrl);
      }
    }
  } catch (e) {
    console.error(`[feed] public upload failed (${type}), using telegram URL:`, e.message);
  }

  return { localPath: `/uploads/${filename}`, publicUrl };
}

function detectTelegrafType(message) {
  if (message.photo && message.photo.length > 0) return 'photo';
  if (message.video) return 'video';
  if (message.document) return 'document';
  if (message.animation) return 'photo'; // GIFs
  return 'text';
}

function extractTelegrafFileId(message) {
  if (message.photo && message.photo.length > 0) return message.photo[message.photo.length - 1].file_id;
  if (message.video) return message.video.file_id;
  if (message.document) return message.document.file_id;
  if (message.animation) return message.animation.file_id;
  return null;
}

// ── SendPulse API polling (text fallback) ───────
async function pollParMessages(par) {
  // Skip if Telegraf is active for this group — it handles everything
  if (telegrafBot) return;

  try {
    const contacts = await sendpulse.listContacts(par.sendpulse_bot_id);
    const groupContact = contacts.find(c => c.type === 3);
    if (!groupContact) return;

    const token = await sendpulse.getToken();
    const axios = require('axios');
    const res = await axios.get(
      `https://api.sendpulse.com/telegram/chats/messages?contact_id=${groupContact.id}&size=20&order=desc`,
      { headers: { Authorization: `Bearer ${token}` } }
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

      const existing = db.getMessages(par.id, 50);
      const isDuplicate = existing.some(e =>
        e.text === msgData.text &&
        e.file_id === msgData.file_id &&
        e.created_at &&
        Math.abs(new Date(e.created_at).getTime() - new Date(m.created_at).getTime()) < 60000
      );
      if (isDuplicate) continue;

      const saved = db.insertMessage(msgData);
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
  if (telegrafBot) telegrafBot.stop();
}

module.exports = { start, stop };
