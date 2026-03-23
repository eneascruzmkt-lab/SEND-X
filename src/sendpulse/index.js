const axios = require('axios');

const BASE = 'https://api.sendpulse.com';

// Cache do token OAuth2 (55 min TTL)
let tokenCache = { value: null, expiresAt: 0 };

async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) {
    return tokenCache.value;
  }
  const res = await axios.post(`${BASE}/oauth/access_token`, {
    grant_type: 'client_credentials',
    client_id: process.env.SENDPULSE_ID,
    client_secret: process.env.SENDPULSE_SECRET,
  });
  tokenCache = {
    value: res.data.access_token,
    expiresAt: Date.now() + (55 * 60 * 1000),
  };
  return tokenCache.value;
}

function headers(token) {
  return { Authorization: `Bearer ${token}` };
}

// GET /telegram/bots
async function listBots() {
  const token = await getToken();
  const res = await axios.get(`${BASE}/telegram/bots`, { headers: headers(token) });
  const raw = res.data.data || res.data;
  return raw.map(b => ({
    id: b.id,
    name: b.channel_data?.name || b.channel_data?.full_name || b.id,
    username: b.channel_data?.username || null,
    status: b.status,
    subscribers: b.inbox?.total || 0,
  }));
}

// GET /telegram/contacts — lista contatos de um bot
async function listContacts(botId) {
  const token = await getToken();
  const res = await axios.get(`${BASE}/telegram/contacts?bot_id=${botId}`, {
    headers: headers(token),
  });
  return res.data.data || res.data;
}

// Disparo seguro: envia SOMENTE para inscritos diretos (type != 3)
// Usa POST /contacts/send para cada contato individualmente
async function dispatch(schedule, par) {
  const token = await getToken();
  const botId = schedule.sendpulse_bot_id || (par && par.sendpulse_bot_id);
  if (!botId) throw new Error('Bot ID não encontrado');

  // Buscar contatos e filtrar — type 3 = grupo/canal
  const contacts = await listContacts(botId);
  const subscribers = contacts.filter(c => c.type !== 3 && c.status === 1);

  if (subscribers.length === 0) {
    throw new Error('Nenhum inscrito direto encontrado neste bot');
  }

  const message = await buildMessage(schedule);

  // If media couldn't be resolved (fell back to text), give clear error
  const type = schedule.content_type || 'text';
  if (message.type === 'text' && type !== 'text') {
    throw new Error('Video/imagem sem URL publica. Faca upload do arquivo pelo feed antes de enviar.');
  }

  const errors = [];

  for (const contact of subscribers) {
    try {
      await axios.post(`${BASE}/telegram/contacts/send`, {
        contact_id: contact.id,
        message,
      }, { headers: headers(token) });
    } catch (err) {
      errors.push(`${contact.id}: ${err.response?.data?.message || err.message}`);
    }
  }

  if (errors.length === subscribers.length) {
    throw new Error(`Falha em todos os envios: ${errors[0]}`);
  }

  console.log(`[sendpulse] Enviado para ${subscribers.length - errors.length}/${subscribers.length} inscritos`);
}

// Resolve local /uploads/... paths to full public URL
// If WEBHOOK_DOMAIN is set, uses it. Otherwise, uploads local files to a public host.
async function resolveMediaUrl(url, mediaType, localFallback) {
  if (!url) return '';

  // Public URLs (t.me links, telegra.ph, etc) — use directly
  if (url.startsWith('http') && !url.startsWith('https://api.telegram.org/file/')) return url;

  // Local /uploads/ path — need to get a public URL
  let localRef = null;
  if (url.startsWith('/uploads/')) {
    localRef = url;
  } else if (localFallback && localFallback.startsWith('/uploads/')) {
    const path = require('path');
    const fs = require('fs');
    if (fs.existsSync(path.join(__dirname, '..', '..', 'public', localFallback))) {
      localRef = localFallback;
    }
  }

  if (!localRef) {
    console.error('[sendpulse] no usable media source for:', url.slice(0, 50));
    return '';
  }

  // If WEBHOOK_DOMAIN is set, use it directly
  const domain = process.env.WEBHOOK_DOMAIN;
  if (domain) return domain.replace(/\/$/, '') + localRef;

  // Upload local file to public host
  const path = require('path');
  const fs = require('fs');
  const FormData = require('form-data');
  const localPath = path.join(__dirname, '..', '..', 'public', localRef);

  if (!fs.existsSync(localPath)) {
    console.error('[sendpulse] local file not found:', localPath);
    return '';
  }

  try {
    if (mediaType === 'photo') {
      // Telegra.ph for images
      const form = new FormData();
      form.append('file', fs.createReadStream(localPath));
      const res = await axios.post('https://telegra.ph/upload', form, {
        headers: form.getHeaders(), timeout: 30000,
      });
      if (Array.isArray(res.data) && res.data[0]?.src) {
        const pubUrl = 'https://telegra.ph' + res.data[0].src;
        console.log('[sendpulse] image uploaded to telegra.ph:', pubUrl);
        return pubUrl;
      }
    }
    // Videos: no external hosting works with Telegram/SendPulse
    // Videos must use t.me/ links from the public channel (set automatically at capture time)
    if (mediaType === 'video') {
      console.warn('[sendpulse] video sem URL t.me — envie um novo video no canal publico');
    }
  } catch (e) {
    console.error(`[sendpulse] public upload failed (${mediaType}):`, e.message);
  }

  return '';
}

// Estrutura de mensagem para /contacts/send:
// text:  { type: "text", text: "...", reply_markup: {...} }
// photo: { type: "photo", photo: "URL", caption: "...", reply_markup: {...} }
// video: { type: "video", video: "URL", caption: "...", reply_markup: {...} }
async function buildMessage(schedule) {
  const buttons = schedule.buttons ? JSON.parse(schedule.buttons) : null;
  const replyMarkup = buttons && buttons.length > 0
    ? { inline_keyboard: [buttons.map(b => ({ text: b.text, type: 'web_url', url: b.url }))] }
    : undefined;

  const type = schedule.content_type || 'text';

  const localFallback = schedule.content_file_id || null;

  if (type === 'photo') {
    const photoUrl = await resolveMediaUrl(schedule.content_media_url || schedule.content_file_id || '', 'photo', localFallback);
    if (photoUrl) {
      const msg = { type: 'photo', photo: photoUrl };
      if (schedule.content_text) msg.caption = schedule.content_text;
      if (replyMarkup) msg.reply_markup = replyMarkup;
      return msg;
    }
    // Fallback to text if media URL could not be resolved
    console.warn('[sendpulse] photo URL not resolved, falling back to text');
  }

  if (type === 'video') {
    const videoUrl = await resolveMediaUrl(schedule.content_media_url || schedule.content_file_id || '', 'video', localFallback);
    if (videoUrl) {
      const msg = { type: 'video', video: videoUrl };
      if (schedule.content_text) msg.caption = schedule.content_text;
      if (replyMarkup) msg.reply_markup = replyMarkup;
      return msg;
    }
    // Fallback to text if media URL could not be resolved
    console.warn('[sendpulse] video URL not resolved, falling back to text');
  }

  // text
  const msg = { type: 'text', text: schedule.content_text || '' };
  if (replyMarkup) msg.reply_markup = replyMarkup;
  return msg;
}

module.exports = { getToken, listBots, listContacts, dispatch, __resolveMediaUrl: resolveMediaUrl };
