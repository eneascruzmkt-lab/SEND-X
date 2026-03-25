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

// Send media via Telegram Bot API directly (supports file_id up to 50MB)
async function sendViaTelegramBot(chatId, schedule, telegramToken) {
  const type = schedule.content_type;
  const fileId = schedule.content_file_id;
  const text = schedule.content_text || '';
  const buttons = schedule.buttons ? JSON.parse(schedule.buttons) : null;
  const replyMarkup = buttons && buttons.length > 0
    ? { inline_keyboard: [buttons.map(b => ({ text: b.text, url: b.url }))] }
    : undefined;

  const body = { chat_id: chatId };
  if (text) body.caption = text;
  if (replyMarkup) body.reply_markup = JSON.stringify(replyMarkup);

  let method;
  if (type === 'video') {
    method = 'sendVideo';
    body.video = fileId;
  } else if (type === 'photo') {
    method = 'sendPhoto';
    body.photo = fileId;
  } else {
    method = 'sendMessage';
    body.text = text;
    if (replyMarkup) body.reply_markup = JSON.stringify(replyMarkup);
  }

  await axios.post(`https://api.telegram.org/bot${telegramToken}/${method}`, body);
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

  // Check if we have a Telegram file_id — if so, send directly via Bot API
  const hasFileId = schedule.content_file_id && !schedule.content_file_id.startsWith('/') && !schedule.content_file_id.startsWith('http');
  const isMedia = schedule.content_type === 'video' || schedule.content_type === 'photo';

  if (hasFileId && isMedia) {
    console.log('[sendpulse] sending via Telegram Bot API with file_id:', schedule.content_file_id.slice(0, 40));

    // Get telegram token for sending
    const db = require('../db');
    const users = await db.getUsersWithTelegram();
    if (users.length === 0) throw new Error('Nenhum bot Telegram configurado');

    // Get Telegram chat_ids for SendPulse contacts
    // SendPulse contacts have channel_data.id which is the Telegram user ID
    const errors = [];
    for (const contact of subscribers) {
      try {
        const telegramChatId = contact.channel_data?.id || contact.id;
        await sendViaTelegramBot(telegramChatId, schedule, users[0].telegram_token);
      } catch (err) {
        console.error('[sendpulse] telegram send error:', contact.id, err.response?.data || err.message);
        errors.push(`${contact.id}: ${err.response?.data?.description || err.message}`);
      }
    }

    if (errors.length === subscribers.length) {
      throw new Error(`Falha em todos os envios: ${errors[0]}`);
    }
    console.log(`[sendpulse] Enviado via Bot API para ${subscribers.length - errors.length}/${subscribers.length} inscritos`);
    return;
  }

  // Standard SendPulse API dispatch (for text or media with URL)
  const message = buildMessage(schedule, credentials.webhook_domain);
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
