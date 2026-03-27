/**
 * ============================================================
 *  SendPulse — Integração com a API do SendPulse
 * ============================================================
 *
 *  Funções:
 *  - getToken()     → autenticação OAuth2 (client_credentials)
 *  - listBots()     → lista bots Telegram conectados
 *  - listContacts() → lista contatos/grupos de um bot
 *  - getMediaUrl()  → busca URL de mídia do histórico de chat
 *  - dispatch()     → envia campanha para todos os inscritos de um bot
 *
 *  Fluxo de autenticação:
 *  1. POST /oauth/access_token com client_id + client_secret
 *  2. Token cacheado por 55 min (expira em 60 na API)
 *  3. Cache é per-user (chave = sendpulse_id)
 *  4. Se 401 no dispatch, renova token automaticamente e faz retry
 *
 *  Formatos de campanha SendPulse:
 *  - text:  { type: "text",  message: { text, reply_markup? } }
 *  - photo: { type: "photo", message: { photo: url, caption?, reply_markup? } }
 *  - video: { type: "video", message: { video: url, caption?, reply_markup? } }
 *
 *  reply_markup = inline_keyboard com botões URL (máx 3 botões)
 * ============================================================
 */

const axios = require('axios');

const BASE = 'https://api.sendpulse.com';

// Cache de tokens por usuário: { [sendpulse_id]: { value, expiresAt } }
// Evita re-autenticar a cada request (token dura ~60min, cacheamos 55min)
const tokenCache = {};

/**
 * Obtém token de acesso OAuth2 do SendPulse.
 * Usa cache para evitar chamadas desnecessárias.
 * @param {Object} credentials — { sendpulse_id, sendpulse_secret }
 * @returns {string} access_token
 */
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
    expiresAt: Date.now() + (55 * 60 * 1000), // 55 min de cache
  };
  return tokenCache[key].value;
}

/** Helper: monta header Authorization */
function headers(token) {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Lista bots Telegram conectados à conta SendPulse.
 * Retorna array normalizado: { id, name, username, status, subscribers }
 */
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

/**
 * Lista contatos de um bot Telegram no SendPulse.
 * Usado para encontrar o contato do grupo (type === 3).
 */
async function listContacts(botId, credentials) {
  const token = await getToken(credentials);
  const res = await axios.get(`${BASE}/telegram/contacts?bot_id=${botId}`, {
    headers: headers(token),
  });
  return res.data.data || res.data;
}

/**
 * Busca URL de mídia (foto/vídeo) do histórico de chat no SendPulse.
 * Usado como fallback quando o download direto do Telegram falha
 * (arquivos > 20MB que o Bot API não consegue baixar).
 *
 * @param {string} botId — ID do bot no SendPulse
 * @param {Object} credentials — credenciais do usuário
 * @param {string|null} messageText — texto/caption para filtrar a mensagem específica
 * @returns {string|null} URL da mídia ou null
 */
async function getMediaUrl(botId, credentials, messageText) {
  try {
    const token = await getToken(credentials);
    const contacts = await listContacts(botId, credentials);
    const groupContact = contacts.find(c => c.type === 3); // type 3 = grupo
    if (!groupContact) return null;

    const res = await axios.get(
      `${BASE}/telegram/chats/messages?contact_id=${groupContact.id}&size=20&order=desc`,
      { headers: headers(token) }
    );

    const msgs = res.data.data || res.data;
    for (const m of msgs) {
      const data = m.data;
      if (!data) continue;
      // Se messageText fornecido, filtra pela mensagem específica
      if (messageText && data.text !== messageText && data.caption !== messageText) continue;
      // Tenta extrair URL de vídeo
      if (data.video && typeof data.video === 'string' && data.video.startsWith('http')) return data.video;
      if (data.video?.url) return data.video.url;
      // Tenta extrair URL de foto
      if (data.photo && typeof data.photo === 'string' && data.photo.startsWith('http')) return data.photo;
      if (data.photo?.url) return data.photo.url;
      // Se não tem filtro de texto, retorna qualquer mídia encontrada
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

/**
 * Dispara campanha via SendPulse — envia para TODOS os inscritos do bot.
 * Esta é a função principal de envio do SEND-X.
 *
 * @param {Object} schedule — schedule do banco (content_type, content_text, content_media_url, buttons, etc)
 * @param {Object|null} par — par vinculado (para fallback do bot_id)
 * @param {Object} credentials — { sendpulse_id, sendpulse_secret, webhook_domain }
 * @throws {Error} se o envio falhar (capturado pelo scheduler)
 */
async function dispatch(schedule, par, credentials) {
  const token = await getToken(credentials);
  const botId = schedule.sendpulse_bot_id || (par && par.sendpulse_bot_id);
  if (!botId) throw new Error('Bot ID não encontrado');

  // Monta mensagem no formato de campanha SendPulse
  const message = await buildCampaignMessage(schedule, credentials.webhook_domain);
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
    // Se 401 (token expirado), renova e faz retry automaticamente
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
    // Outros erros: propaga para o scheduler tratar
    const errData = err.response?.data;
    console.error('[sendpulse] campaign error:', JSON.stringify(errData || err.message).slice(0, 500));
    throw new Error(errData?.message || err.message);
  }

  console.log(`[sendpulse] Campanha "${title}" enviada para bot ${botId}`);
}

/**
 * Resolve URL de mídia para formato absoluto.
 * - URLs http/https: retorna como está
 * - Paths locais (/uploads/...): prepend domínio Railway ou webhook_domain
 * - Telegram file_ids ou outros: retorna '' (rejeitado)
 */
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

/**
 * Downloads a remote video, converts to mp4 via ffmpeg, re-uploads to catbox.moe.
 * Returns the new mp4 URL.
 */
async function convertRemoteVideoToMp4(url) {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const axios = require('axios');
  const { execSync } = require('child_process');
  const FormData = require('form-data');

  const uploadsDir = path.join(__dirname, '..', '..', 'public', 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

  const baseName = crypto.randomBytes(12).toString('hex');
  const origExt = path.extname(new URL(url).pathname) || '.mov';
  const origPath = path.join(uploadsDir, baseName + origExt);
  const mp4Path = path.join(uploadsDir, baseName + '.mp4');

  // Download
  console.log(`[sendpulse] Downloading video for conversion: ${url.slice(0, 80)}`);
  const resp = await axios.get(url, { responseType: 'stream', timeout: 120000 });
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(origPath);
    resp.data.pipe(file);
    file.on('finish', () => { file.close(); resolve(); });
    file.on('error', reject);
  });

  // Convert
  console.log(`[sendpulse] Converting ${origExt} to .mp4...`);
  execSync(`ffmpeg -i "${origPath}" -c:v libx264 -c:a aac -movflags +faststart -y "${mp4Path}"`, {
    timeout: 120000,
    stdio: 'pipe',
  });
  fs.unlinkSync(origPath);

  // Upload to catbox
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', fs.createReadStream(mp4Path));
  const res = await axios.post('https://catbox.moe/user/api.php', form, {
    headers: form.getHeaders(),
    timeout: 120000,
    maxContentLength: 210 * 1024 * 1024,
  });
  fs.unlinkSync(mp4Path);

  if (res.data && res.data.startsWith('https://')) {
    console.log(`[sendpulse] Converted video uploaded: ${res.data.trim()}`);
    return res.data.trim();
  }
  throw new Error('Catbox upload failed');
}

/**
 * Constrói mensagem no formato de campanha SendPulse.
 *
 * Formato final: { type: "text|photo|video", message: { ... } }
 *
 * Buttons são parseados de JSON string e validados:
 * - Cada botão precisa de text + url válida (http/https)
 * - Máximo 3 botões (validado na rota, mas tolerante aqui)
 * - Formato SendPulse: inline_keyboard com type: 'web_url'
 */
async function buildCampaignMessage(schedule, webhookDomain) {
  // Parse buttons (pode ser JSON string ou array)
  let buttons = null;
  if (schedule.buttons) {
    try {
      buttons = typeof schedule.buttons === 'string' ? JSON.parse(schedule.buttons) : schedule.buttons;
    } catch (e) {
      console.error('[sendpulse] JSON inválido em buttons:', e.message);
    }
  }
  // Valida: cada botão deve ter text + url http(s)
  const validButtons = buttons?.filter(b => b.text && b.url && /^https?:\/\/.+/i.test(b.url));
  const replyMarkup = validButtons && validButtons.length > 0
    ? { inline_keyboard: [validButtons.map(b => ({ text: b.text, type: 'web_url', url: b.url }))] }
    : undefined;

  const type = schedule.content_type || 'text';
  const mediaValue = schedule.content_media_url || '';
  const resolvedMedia = resolveMediaUrl(mediaValue, webhookDomain);

  console.log('[sendpulse] buildCampaignMessage:', { type, resolvedMedia: resolvedMedia?.slice?.(0, 80) });

  // Photo: { type: "photo", message: { photo: url, caption?, reply_markup? } }
  if (type === 'photo' && resolvedMedia) {
    const inner = { photo: resolvedMedia };
    if (schedule.content_text) inner.caption = schedule.content_text;
    if (replyMarkup) inner.reply_markup = replyMarkup;
    return { type: 'photo', message: inner };
  }

  // Video: { type: "video", message: { video: url, caption?, reply_markup? } }
  if (type === 'video' && resolvedMedia) {
    let videoUrl = resolvedMedia;
    if (!resolvedMedia.toLowerCase().endsWith('.mp4') && resolvedMedia.startsWith('http')) {
      videoUrl = await convertRemoteVideoToMp4(resolvedMedia);
    }
    const inner = { video: videoUrl };
    if (schedule.content_text) inner.caption = schedule.content_text;
    if (replyMarkup) inner.reply_markup = replyMarkup;
    return { type: 'video', message: inner };
  }

  // Text (ou fallback quando mídia não disponível)
  const inner = { text: schedule.content_text || '' };
  if (replyMarkup) inner.reply_markup = replyMarkup;
  return { type: 'text', message: inner };
}


module.exports = { getToken, listBots, listContacts, dispatch, getMediaUrl };
