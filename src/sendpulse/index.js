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

  const message = await buildMessage(schedule, credentials.webhook_domain, credentials);
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

function resolveLocalUrl(url, webhookDomain) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  if (url.startsWith('/')) {
    const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null;
    const domain = webhookDomain || railwayDomain || `http://localhost:${process.env.PORT || 3000}`;
    return domain.replace(/\/$/, '') + url;
  }
  return '';
}

// Resolve a Telegram file_id to a public URL via Telegram Bot API
async function resolveTelegramFileUrl(fileId, credentials) {
  try {
    const db = require('../db');
    // Get telegram token from user settings (we need it to call Telegram API)
    // Try to find any user with a telegram token configured
    const users = await db.getUsersWithTelegram();
    if (users.length === 0) return '';
    const telegramToken = users[0].telegram_token;
    const res = await axios.get(`https://api.telegram.org/bot${telegramToken}/getFile?file_id=${fileId}`);
    if (res.data?.ok && res.data.result?.file_path) {
      return `https://api.telegram.org/file/bot${telegramToken}/${res.data.result.file_path}`;
    }
  } catch (err) {
    console.error('[sendpulse] resolveTelegramFileUrl error:', err.message);
  }
  return '';
}

async function resolveMediaUrl(url, webhookDomain, credentials) {
  if (!url) return '';
  // Already a full URL
  if (url.startsWith('http')) return url;
  // Local upload path
  if (url.startsWith('/')) {
    const resolved = resolveLocalUrl(url, webhookDomain);
    console.log('[sendpulse] resolveMediaUrl local:', url, '->', resolved);
    return resolved;
  }
  // Likely a Telegram file_id — try to resolve via Bot API
  console.log('[sendpulse] resolveMediaUrl: trying Telegram file_id:', url.slice(0, 40));
  const telegramUrl = await resolveTelegramFileUrl(url, credentials);
  if (telegramUrl) {
    console.log('[sendpulse] resolveMediaUrl telegram:', telegramUrl.slice(0, 80));
    return telegramUrl;
  }
  console.log('[sendpulse] resolveMediaUrl: could not resolve:', url.slice(0, 40));
  return '';
}

async function buildMessage(schedule, webhookDomain, credentials) {
  const buttons = schedule.buttons ? JSON.parse(schedule.buttons) : null;
  const replyMarkup = buttons && buttons.length > 0
    ? { inline_keyboard: [buttons.map(b => ({ text: b.text, type: 'web_url', url: b.url }))] }
    : undefined;

  const type = schedule.content_type || 'text';

  if (type === 'photo') {
    const photoUrl = await resolveMediaUrl(schedule.content_media_url || schedule.content_file_id || '', webhookDomain, credentials);
    if (photoUrl) {
      const msg = { type: 'photo', photo: photoUrl };
      if (schedule.content_text) msg.caption = schedule.content_text;
      if (replyMarkup) msg.reply_markup = replyMarkup;
      return msg;
    }
    console.log('[sendpulse] photo sem URL valida, enviando como texto');
  }

  if (type === 'video') {
    const videoUrl = await resolveMediaUrl(schedule.content_media_url || schedule.content_file_id || '', webhookDomain, credentials);
    if (videoUrl) {
      const msg = { type: 'video', video: videoUrl };
      if (schedule.content_text) msg.caption = schedule.content_text;
      if (replyMarkup) msg.reply_markup = replyMarkup;
      return msg;
    }
    console.log('[sendpulse] video sem URL valida, enviando como texto');
  }

  // text
  const msg = { type: 'text', text: schedule.content_text || '' };
  if (replyMarkup) msg.reply_markup = replyMarkup;
  return msg;
}

module.exports = { getToken, listBots, listContacts, dispatch };
