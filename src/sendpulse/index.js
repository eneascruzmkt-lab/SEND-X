const axios = require('axios');

const BASE = 'https://api.sendpulse.com';

// Per-user token cache: { [userId]: { value, expiresAt } }
const tokenCache = {};

async function getToken(credentials) {
  const key = credentials.sendpulse_id;
  const cached = tokenCache[key];
  if (cached && cached.value && Date.now() < cached.expiresAt) {
    return cached.value;
  }
  const res = await axios.post(`${BASE}/oauth/access_token`, {
    grant_type: 'client_credentials',
    client_id: credentials.sendpulse_id,
    client_secret: credentials.sendpulse_secret,
  });
  tokenCache[key] = {
    value: res.data.access_token,
    expiresAt: Date.now() + (55 * 60 * 1000),
  };
  return tokenCache[key].value;
}

function headers(token) {
  return { Authorization: `Bearer ${token}` };
}

// GET /telegram/bots
async function listBots(credentials) {
  const token = await getToken(credentials);
  const res = await axios.get(`${BASE}/telegram/bots`, { headers: headers(token) });
  console.log('[listBots] raw response:', JSON.stringify(res.data).slice(0, 500));
  const raw = Array.isArray(res.data) ? res.data : (res.data.data || res.data.result || []);
  return raw.map(b => ({
    id: b.id,
    name: b.channel_data?.name || b.channel_data?.full_name || b.id,
    username: b.channel_data?.username || null,
    status: b.status,
    subscribers: b.inbox?.total || 0,
  }));
}

// GET /telegram/contacts — lista contatos de um bot
async function listContacts(botId, credentials) {
  const token = await getToken(credentials);
  const res = await axios.get(`${BASE}/telegram/contacts?bot_id=${botId}`, {
    headers: headers(token),
  });
  return res.data.data || res.data;
}

// Upload video/photo to Telegram via Bot API and get file_id
async function uploadToTelegram(filePath, type, credentials) {
  const db = require('../db');
  const FormData = require('form-data');
  const fs = require('fs');
  const path = require('path');

  const users = await db.getUsersWithTelegram();
  if (users.length === 0) return null;
  const telegramToken = users[0].telegram_token;

  // We need a chat_id to send to — use the bot's own saved messages or a dummy
  // Instead, get the bot's chat_id by calling getMe
  const meRes = await axios.get(`https://api.telegram.org/bot${telegramToken}/getMe`);
  const botChatId = meRes.data.result.id;

  const localFile = path.join(__dirname, '..', '..', 'public', filePath);
  if (!fs.existsSync(localFile)) return null;

  const form = new FormData();
  form.append('chat_id', botChatId);
  if (type === 'video') {
    form.append('video', fs.createReadStream(localFile));
  } else {
    form.append('photo', fs.createReadStream(localFile));
  }

  const method = type === 'video' ? 'sendVideo' : 'sendPhoto';
  const res = await axios.post(
    `https://api.telegram.org/bot${telegramToken}/${method}`,
    form,
    { headers: form.getHeaders(), timeout: 120000, maxContentLength: 55 * 1024 * 1024 }
  );

  if (res.data?.ok && res.data.result) {
    const msg = res.data.result;
    if (type === 'video' && msg.video) return msg.video.file_id;
    if (type === 'photo' && msg.photo) return msg.photo[msg.photo.length - 1].file_id;
  }
  return null;
}

// Disparo seguro: envia SOMENTE para inscritos diretos (type != 3)
async function dispatch(schedule, par, credentials) {
  const token = await getToken(credentials);
  const botId = schedule.sendpulse_bot_id || (par && par.sendpulse_bot_id);
  if (!botId) throw new Error('Bot ID não encontrado');

  const contacts = await listContacts(botId, credentials);
  const subscribers = contacts.filter(c => c.type !== 3 && c.status === 1);

  if (subscribers.length === 0) {
    throw new Error('Nenhum inscrito direto encontrado neste bot');
  }

  let message = buildMessage(schedule, credentials.webhook_domain);

  // If video/photo from local upload, try to get a Telegram file_id first
  // This avoids the 20MB URL download limit
  const mediaUrl = schedule.content_media_url || schedule.content_file_id || '';
  if (mediaUrl.startsWith('/uploads/') && (schedule.content_type === 'video' || schedule.content_type === 'photo')) {
    try {
      console.log('[sendpulse] uploading to Telegram to get file_id...');
      const fileId = await uploadToTelegram(mediaUrl, schedule.content_type, credentials);
      if (fileId) {
        console.log('[sendpulse] got Telegram file_id:', fileId.slice(0, 40));
        // Rebuild message with file_id instead of URL
        const buttons = schedule.buttons ? JSON.parse(schedule.buttons) : null;
        const replyMarkup = buttons && buttons.length > 0
          ? { inline_keyboard: [buttons.map(b => ({ text: b.text, type: 'web_url', url: b.url }))] }
          : undefined;
        message = { type: schedule.content_type };
        message[schedule.content_type] = fileId;
        if (schedule.content_text) message.caption = schedule.content_text;
        if (replyMarkup) message.reply_markup = replyMarkup;
      }
    } catch (err) {
      console.error('[sendpulse] upload to Telegram failed:', err.message, '— falling back to URL');
    }
  }

  console.log('[sendpulse] dispatch message:', JSON.stringify(message).slice(0, 500));
  const errors = [];

  for (const contact of subscribers) {
    try {
      await axios.post(`${BASE}/telegram/contacts/send`, {
        contact_id: contact.id,
        message,
      }, { headers: headers(token) });
    } catch (err) {
      console.error('[sendpulse] send error:', contact.id, err.response?.data || err.message);
      errors.push(`${contact.id}: ${err.response?.data?.message || err.message}`);
    }
  }

  if (errors.length === subscribers.length) {
    throw new Error(`Falha em todos os envios: ${errors[0]}`);
  }

  console.log(`[sendpulse] Enviado para ${subscribers.length - errors.length}/${subscribers.length} inscritos`);
}

function resolveMediaUrl(url, webhookDomain) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  if (url.startsWith('/')) {
    const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null;
    const domain = webhookDomain || railwayDomain || `http://localhost:${process.env.PORT || 3000}`;
    return domain.replace(/\/$/, '') + url;
  }
  // Return as-is (could be Telegram file_id — SendPulse may accept it)
  return url;
}

function buildMessage(schedule, webhookDomain) {
  const buttons = schedule.buttons ? JSON.parse(schedule.buttons) : null;
  const replyMarkup = buttons && buttons.length > 0
    ? { inline_keyboard: [buttons.map(b => ({ text: b.text, type: 'web_url', url: b.url }))] }
    : undefined;

  const type = schedule.content_type || 'text';
  const mediaValue = schedule.content_media_url || schedule.content_file_id || '';
  const resolvedMedia = resolveMediaUrl(mediaValue, webhookDomain);

  if (type === 'photo' && resolvedMedia) {
    const msg = { type: 'photo', photo: resolvedMedia };
    if (schedule.content_text) msg.caption = schedule.content_text;
    if (replyMarkup) msg.reply_markup = replyMarkup;
    console.log('[sendpulse] buildMessage photo:', resolvedMedia.slice(0, 80));
    return msg;
  }

  if (type === 'video' && resolvedMedia) {
    const msg = { type: 'video', video: resolvedMedia };
    if (schedule.content_text) msg.caption = schedule.content_text;
    if (replyMarkup) msg.reply_markup = replyMarkup;
    console.log('[sendpulse] buildMessage video:', resolvedMedia.slice(0, 80));
    return msg;
  }

  // text (or fallback when no media)
  const msg = { type: 'text', text: schedule.content_text || '' };
  if (replyMarkup) msg.reply_markup = replyMarkup;
  return msg;
}

module.exports = { getToken, listBots, listContacts, dispatch };
