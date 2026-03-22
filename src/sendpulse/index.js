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

  const message = buildMessage(schedule);
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
function resolveMediaUrl(url) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  // Local upload — needs public URL via WEBHOOK_DOMAIN or localhost
  const domain = process.env.WEBHOOK_DOMAIN || `http://localhost:${process.env.PORT || 3000}`;
  return domain.replace(/\/$/, '') + url;
}

// Estrutura de mensagem para /contacts/send:
// text:  { type: "text", text: "...", reply_markup: {...} }
// photo: { type: "photo", photo: "URL", caption: "...", reply_markup: {...} }
// video: { type: "video", video: "URL", caption: "...", reply_markup: {...} }
function buildMessage(schedule) {
  const buttons = schedule.buttons ? JSON.parse(schedule.buttons) : null;
  const replyMarkup = buttons && buttons.length > 0
    ? { inline_keyboard: [buttons.map(b => ({ text: b.text, type: 'web_url', url: b.url }))] }
    : undefined;

  const type = schedule.content_type || 'text';

  if (type === 'photo') {
    const msg = { type: 'photo' };
    msg.photo = resolveMediaUrl(schedule.content_media_url || schedule.content_file_id || '');
    if (schedule.content_text) msg.caption = schedule.content_text;
    if (replyMarkup) msg.reply_markup = replyMarkup;
    return msg;
  }

  if (type === 'video') {
    const msg = { type: 'video' };
    msg.video = resolveMediaUrl(schedule.content_media_url || schedule.content_file_id || '');
    if (schedule.content_text) msg.caption = schedule.content_text;
    if (replyMarkup) msg.reply_markup = replyMarkup;
    return msg;
  }

  // text
  const msg = { type: 'text', text: schedule.content_text || '' };
  if (replyMarkup) msg.reply_markup = replyMarkup;
  return msg;
}

module.exports = { getToken, listBots, listContacts, dispatch };
