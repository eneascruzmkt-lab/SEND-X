const sendpulse = require('../sendpulse');
const db = require('../db');

let io = null;
let pollingInterval = null;
const lastSeenMsg = {}; // par_id -> last message id

function start(socketIo) {
  io = socketIo;

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

  // First poll immediately
  setTimeout(async () => {
    const pares = db.getAllPares();
    for (const par of pares) {
      await pollParMessages(par);
    }
  }, 3000);

  console.log('[feed] polling iniciado (15s interval)');
}

async function pollParMessages(par) {
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

      // Dedup
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

// Extract media URL from Telegram Bot API message structure
// data.photo = array of PhotoSize (pick largest) or string URL
// data.video = Video object with file_id or string URL
// data.document = Document object
function extractMedia(data) {
  if (!data) return { type: 'text', url: null };

  // Photo: can be array (Telegram format) or string URL (SendPulse stored)
  if (data.photo) {
    if (typeof data.photo === 'string') return { type: 'photo', url: data.photo };
    if (Array.isArray(data.photo) && data.photo.length > 0) {
      const largest = data.photo[data.photo.length - 1];
      return { type: 'photo', url: largest.file_id || largest.url || null };
    }
    if (data.photo.file_id) return { type: 'photo', url: data.photo.file_id };
    if (data.photo.url) return { type: 'photo', url: data.photo.url };
    return { type: 'photo', url: null };
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
}

module.exports = { start, stop };
