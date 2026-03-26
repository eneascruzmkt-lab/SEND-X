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

// Fetch media URL from SendPulse chat history (for large files that Bot API can't download)
async function getMediaUrl(botId, credentials, messageText) {
  try {
    const token = await getToken(credentials);
    const contacts = await listContacts(botId, credentials);
    const groupContact = contacts.find(c => c.type === 3);
    if (!groupContact) return null;

    const res = await axios.get(
      `${BASE}/telegram/chats/messages?contact_id=${groupContact.id}&size=20&order=desc`,
      { headers: headers(token) }
    );

    const msgs = res.data.data || res.data;
    for (const m of msgs) {
      const data = m.data;
      if (!data) continue;
      if (messageText && data.text !== messageText && data.caption !== messageText) continue;
      if (data.video && typeof data.video === 'string' && data.video.startsWith('http')) return data.video;
      if (data.video?.url) return data.video.url;
      if (data.photo && typeof data.photo === 'string' && data.photo.startsWith('http')) return data.photo;
      if (data.photo?.url) return data.photo.url;
      if (!messageText) {
        if (data.video) return typeof data.video === 'string' ? data.video : (data.video.url || null);
        if (data.photo) return typeof data.photo === 'string' ? data.photo : (data.photo.url || null);
      }
    }
  } catch (err) {
    console.error('[sendpulse] getMediaUrl error:', err.message);
  }
  return null;
}

// Disparo via campanha SendPulse — envia para todos os inscritos do bot de uma vez
async function dispatch(schedule, par, credentials) {
  const token = await getToken(credentials);
  const botId = schedule.sendpulse_bot_id || (par && par.sendpulse_bot_id);
  if (!botId) throw new Error('Bot ID não encontrado');

  const message = buildCampaignMessage(schedule, credentials.webhook_domain);
  const type = schedule.content_type || 'text';
  console.log('[dispatch] type:', type, 'media_url:', schedule.content_media_url?.slice?.(0, 60), 'file_id:', schedule.content_file_id?.slice?.(0, 40));

  const title = `dispatch-${schedule.id || Date.now()}`;
  const body = {
    title,
    bot_id: botId,
    messages: [message],
  };

  console.log('[sendpulse] campaign body:', JSON.stringify(body).slice(0, 500));

  try {
    const res = await axios.post(`${BASE}/telegram/campaigns/send`, body, {
      headers: headers(token),
    });
    console.log('[sendpulse] campaign response:', JSON.stringify(res.data).slice(0, 300));
  } catch (err) {
    // Retry com novo token se 401 (token expirado/revogado)
    if (err.response?.status === 401) {
      console.warn('[sendpulse] token expirado, renovando...');
      delete tokenCache[credentials.sendpulse_id];
      const newToken = await getToken(credentials);
      const retry = await axios.post(`${BASE}/telegram/campaigns/send`, body, {
        headers: headers(newToken),
      });
      console.log('[sendpulse] campaign response (retry):', JSON.stringify(retry.data).slice(0, 300));
      return;
    }
    const errData = err.response?.data;
    console.error('[sendpulse] campaign error:', JSON.stringify(errData || err.message).slice(0, 500));
    throw new Error(errData?.message || err.message);
  }

  console.log(`[sendpulse] Campanha "${title}" enviada para bot ${botId}`);
}

function resolveMediaUrl(url, webhookDomain) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  if (url.startsWith('/')) {
    const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null;
    const domain = webhookDomain || railwayDomain || `http://localhost:${process.env.PORT || 3000}`;
    return domain.replace(/\/$/, '') + url;
  }
  // Telegram file_ids and other non-URL values — reject
  return '';
}

// Constrói mensagem no formato de campanha SendPulse
// Formato: { type: "text|photo|video", message: { ... } }
function buildCampaignMessage(schedule, webhookDomain) {
  let buttons = null;
  if (schedule.buttons) {
    try {
      buttons = typeof schedule.buttons === 'string' ? JSON.parse(schedule.buttons) : schedule.buttons;
    } catch (e) {
      console.error('[sendpulse] JSON inválido em buttons:', e.message);
    }
  }
  const validButtons = buttons?.filter(b => b.text && b.url && /^https?:\/\/.+/i.test(b.url));
  const replyMarkup = validButtons && validButtons.length > 0
    ? { inline_keyboard: [validButtons.map(b => ({ text: b.text, type: 'web_url', url: b.url }))] }
    : undefined;

  const type = schedule.content_type || 'text';
  const mediaValue = schedule.content_media_url || '';
  const resolvedMedia = resolveMediaUrl(mediaValue, webhookDomain);

  console.log('[sendpulse] buildCampaignMessage:', { type, resolvedMedia: resolvedMedia?.slice?.(0, 80) });

  if (type === 'photo' && resolvedMedia) {
    const inner = { photo: resolvedMedia };
    if (schedule.content_text) inner.caption = schedule.content_text;
    if (replyMarkup) inner.reply_markup = replyMarkup;
    return { type: 'photo', message: inner };
  }

  if (type === 'video' && resolvedMedia) {
    const inner = { video: resolvedMedia };
    if (schedule.content_text) inner.caption = schedule.content_text;
    if (replyMarkup) inner.reply_markup = replyMarkup;
    return { type: 'video', message: inner };
  }

  // text (or fallback when no media)
  const inner = { text: schedule.content_text || '' };
  if (replyMarkup) inner.reply_markup = replyMarkup;
  return { type: 'text', message: inner };
}


module.exports = { getToken, listBots, listContacts, dispatch, getMediaUrl };
