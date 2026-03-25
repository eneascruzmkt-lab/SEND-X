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

  const message = buildMessage(schedule, credentials.webhook_domain);
  const type = schedule.content_type || 'text';
  console.log('[dispatch] type:', type, 'media_url:', schedule.content_media_url?.slice?.(0, 60), 'file_id:', schedule.content_file_id?.slice?.(0, 40));

  // For video/photo: always use Telegram Bot API directly
  // SendPulse rejects file_ids and external URLs are blocked by Telegram
  if (type === 'video' || type === 'photo') {
    const localFilePath = schedule.content_media_url?.startsWith?.('/uploads/')
      ? require('path').join(__dirname, '..', '..', 'public', schedule.content_media_url)
      : null;
    const fileId = schedule.content_file_id && isTelegramFileId(schedule.content_file_id)
      ? schedule.content_file_id
      : null;

    if (localFilePath || fileId) {
      return await dispatchViaTelegram(schedule, subscribers, contacts, credentials, localFilePath, message, fileId);
    }
  }

  // Text messages (and fallback): use SendPulse API
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
  // Telegram file_ids and other non-URL values — reject
  return '';
}

function buildMessage(schedule, webhookDomain) {
  const buttons = schedule.buttons ? JSON.parse(schedule.buttons) : null;
  const validButtons = buttons?.filter(b => b.text && b.url && /^https?:\/\/.+/i.test(b.url));
  const replyMarkup = validButtons && validButtons.length > 0
    ? { inline_keyboard: [validButtons.map(b => ({ text: b.text, type: 'web_url', url: b.url }))] }
    : undefined;

  const type = schedule.content_type || 'text';

  // Prefer Telegram file_id (always works) over external URLs
  const fileId = schedule.content_file_id || '';
  const isTelegramFileId = fileId && !fileId.startsWith('/') && !fileId.startsWith('http');

  if ((type === 'video' || type === 'photo') && isTelegramFileId) {
    const msg = { type, [type]: fileId };
    if (schedule.content_text) msg.caption = schedule.content_text;
    if (replyMarkup) msg.reply_markup = replyMarkup;
    console.log(`[sendpulse] buildMessage ${type} (file_id):`, fileId.slice(0, 40) + '...');
    return msg;
  }

  // Fallback to URL
  const mediaValue = schedule.content_media_url || fileId || '';
  const resolvedMedia = resolveMediaUrl(mediaValue, webhookDomain);
  console.log('[sendpulse] buildMessage input:', { type, mediaValue: mediaValue?.slice?.(0, 80) || mediaValue, resolvedMedia: resolvedMedia?.slice?.(0, 80) || resolvedMedia });

  if (type === 'photo' && resolvedMedia) {
    const msg = { type: 'photo', photo: resolvedMedia };
    if (schedule.content_text) msg.caption = schedule.content_text;
    if (replyMarkup) msg.reply_markup = replyMarkup;
    return msg;
  }

  if (type === 'video' && resolvedMedia) {
    const msg = { type: 'video', video: resolvedMedia };
    if (schedule.content_text) msg.caption = schedule.content_text;
    if (replyMarkup) msg.reply_markup = replyMarkup;
    return msg;
  }

  // text (or fallback when no media)
  const msg = { type: 'text', text: schedule.content_text || '' };
  if (replyMarkup) msg.reply_markup = replyMarkup;
  return msg;
}

function isTelegramFileId(val) {
  return val && typeof val === 'string' && !val.startsWith('/') && !val.startsWith('http') && val.length > 20;
}

async function dispatchViaTelegram(schedule, subscribers, contacts, credentials, localFilePath, message, existingFileId) {
  const fs = require('fs');
  const FormData = require('form-data');

  if (localFilePath && !fs.existsSync(localFilePath)) {
    throw new Error('Arquivo local não encontrado: ' + localFilePath);
  }

  const db = require('../db');
  const settings = await db.getUserSettings(schedule.user_id);
  if (!settings.telegram_token) {
    throw new Error('Token do Telegram não configurado');
  }

  const botUrl = `https://api.telegram.org/bot${settings.telegram_token}`;
  const type = schedule.content_type || message.type;
  const method = type === 'video' ? 'sendVideo' : 'sendPhoto';
  const field = type === 'video' ? 'video' : 'photo';
  const caption = schedule.content_text || message.caption || undefined;
  const errors = [];
  let fileId = existingFileId || null;

  console.log(`[telegram-direct] starting: type=${type}, fileId=${fileId?.slice?.(0, 30) || 'none'}, localFile=${!!localFilePath}`);

  for (const contact of subscribers) {
    const chatId = contact.channel_data?.id;
    if (!chatId) {
      console.error('[telegram-direct] no chat_id for contact:', contact.id);
      errors.push(`${contact.id}: no telegram chat_id`);
      continue;
    }

    try {
      let result;
      if (fileId) {
        // Send using file_id (fast, no re-upload)
        const body = { chat_id: chatId, [field]: fileId };
        if (caption) body.caption = caption;
        const res = await axios.post(`${botUrl}/${method}`, body);
        result = res.data?.result;
      } else if (localFilePath) {
        // First send: upload the file
        const form = new FormData();
        form.append('chat_id', String(chatId));
        form.append(field, fs.createReadStream(localFilePath));
        if (caption) form.append('caption', caption);

        const res = await axios.post(`${botUrl}/${method}`, form, {
          headers: form.getHeaders(),
          timeout: 120000,
          maxContentLength: 210 * 1024 * 1024,
        });
        result = res.data?.result;

        // Extract file_id for subsequent sends
        if (result?.video?.file_id) fileId = result.video.file_id;
        else if (result?.photo?.length > 0) fileId = result.photo[result.photo.length - 1].file_id;
        console.log('[telegram-direct] got file_id:', fileId?.slice?.(0, 30));
      }
      console.log('[telegram-direct] sent to:', chatId);
    } catch (err) {
      console.error('[telegram-direct] send error:', chatId, err.response?.data?.description || err.message);
      errors.push(`${chatId}: ${err.response?.data?.description || err.message}`);
    }
  }

  if (errors.length === subscribers.length) {
    throw new Error(`Falha em todos os envios: ${errors[0]}`);
  }

  console.log(`[telegram-direct] Enviado para ${subscribers.length - errors.length}/${subscribers.length} inscritos`);
}

module.exports = { getToken, listBots, listContacts, dispatch, getMediaUrl };
