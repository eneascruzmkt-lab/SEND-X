/**
 * ============================================================
 *  Bot — Captura de mensagens dos grupos Telegram (Feed)
 * ============================================================
 *
 *  Duas estratégias de captura (uma por usuário):
 *
 *  1. TELEGRAF (preferencial): Se o usuário tem telegram_token,
 *     cria um bot Telegraf que recebe mensagens em tempo real.
 *     Mais rápido e confiável.
 *
 *  2. POLLING SENDPULSE (fallback): Se não tem telegram_token,
 *     faz polling da API SendPulse a cada 15s para buscar novas
 *     mensagens. Mais lento e limitado.
 *
 *  Fluxo Telegraf:
 *  ┌───────────────────────────────────────────────────────────┐
 *  │  1. Mensagem chega no grupo Telegram                      │
 *  │  2. Telegraf recebe via webhook/polling                   │
 *  │  3. Identifica o par pelo chat.id (telegram_group_id)     │
 *  │  4. Detecta tipo: text, photo, video, document            │
 *  │  5. Se mídia: baixa do Telegram → upload catbox.moe       │
 *  │     (fallback: busca URL no SendPulse)                    │
 *  │  6. Dedup: verifica se mensagem duplicada (2min window)   │
 *  │  7. Salva no banco (messages) + emite via Socket.io       │
 *  └───────────────────────────────────────────────────────────┘
 *
 *  IMPORTANTE: Este módulo NÃO afeta schedules. Apenas popula
 *  a tabela messages (feed ao vivo) que é limpa diariamente.
 * ============================================================
 */

const sendpulse = require('../sendpulse');
const db = require('../db');

let io = null;              // Referência ao Socket.io (injetada via start)
let pollingInterval = null; // Intervalo do polling SendPulse
const lastSeenMsg = {};     // Controle de dedup do polling: { [par_id]: last_msg_id }

// Instâncias Telegraf por usuário: { [userId]: Telegraf }
// Cada usuário com telegram_token tem seu próprio bot rodando
const userBots = {};

/**
 * Inicia o bot manager: cria bots Telegraf para todos os usuários
 * com telegram_token e inicia polling SendPulse como fallback.
 */
function start(socketIo) {
  io = socketIo;

  // Inicia bots Telegraf para todos os usuários com token configurado
  refreshAllBots();

  // Polling SendPulse como fallback para usuários sem Telegraf
  // Roda a cada 15 segundos
  pollingInterval = setInterval(async () => {
    try {
      // Busca usuários que têm pares ativos E credenciais SendPulse
      const usersWithSP = await db.query(`
        SELECT DISTINCT p.user_id FROM pares p
        JOIN user_settings us ON us.user_id = p.user_id
        WHERE p.ativo=1 AND us.sendpulse_id IS NOT NULL AND us.sendpulse_secret IS NOT NULL
      `);

      for (const { user_id } of usersWithSP) {
        // Pula usuários que já têm bot Telegraf rodando (não precisa de polling)
        if (userBots[user_id]) continue;

        const settings = await db.getUserSettings(user_id);
        const credentials = {
          sendpulse_id: settings.sendpulse_id,
          sendpulse_secret: settings.sendpulse_secret,
        };
        const pares = await db.getAllPares(user_id);
        for (const par of pares) {
          await pollParMessages(par, credentials);
        }
      }
    } catch (err) {
      console.error('[feed] polling error:', err.message);
    }
  }, 15000);

  console.log('[feed] bot manager iniciado');
}

/** Inicia bots Telegraf para todos os usuários com telegram_token */
async function refreshAllBots() {
  const users = await db.getUsersWithTelegram();
  for (const { id, telegram_token } of users) {
    await startUserBot(id, telegram_token);
  }
}

/**
 * Reinicia o bot de um usuário específico.
 * Chamado quando o usuário atualiza suas configurações (PUT /settings).
 */
async function refreshUser(userId) {
  // Para o bot existente se houver
  if (userBots[userId]) {
    try { userBots[userId].stop(); } catch {}
    delete userBots[userId];
  }
  // Reinicia se tem token
  const settings = await db.getUserSettings(userId);
  if (settings.telegram_token) {
    await startUserBot(userId, settings.telegram_token);
  }
}

/**
 * Cria e inicia um bot Telegraf para um usuário.
 * O bot escuta mensagens e channel_posts de TODOS os grupos
 * que o bot é membro, e filtra pelos pares cadastrados.
 */
async function startUserBot(userId, telegramToken) {
  if (userBots[userId]) return; // Já tem bot rodando

  try {
    const { Telegraf } = require('telegraf');
    const bot = new Telegraf(telegramToken);

    // Escuta mensagens e posts de canal
    bot.on(['message', 'channel_post'], async (ctx) => {
      try {
        const groupId = String(ctx.chat.id);

        // Verifica se esse grupo é um par cadastrado do usuário
        const pares = await db.getAllPares(userId);
        const par = pares.find(p => p.telegram_group_id === groupId);
        if (!par || !par.ativo) return; // Grupo não é um par ativo

        const msg = ctx.message || ctx.channelPost || ctx.update?.channel_post;
        if (!msg) return;

        // Detecta tipo de conteúdo e extrai file_id se houver mídia
        const msgType = detectTelegrafType(msg);
        const fileId = extractTelegrafFileId(msg);
        const text = msg.text || msg.caption || null;

        // ── Download de mídia ──
        // Tenta: Telegram Bot API → catbox.moe (URL pública permanente)
        // Fallback: SendPulse chat history (para arquivos > 20MB)
        let localPreview = null;
        let publicMediaUrl = null;
        if (fileId && (msgType === 'photo' || msgType === 'video')) {
          try {
            const result = await downloadTelegramFile(ctx, fileId, msgType, telegramToken);
            localPreview = result.localPath;
            publicMediaUrl = result.publicUrl;
          } catch (e) {
            console.error('[feed] download error:', e.message);
            // Fallback: busca URL da mídia no histórico do SendPulse
            try {
              const settings = await db.getUserSettings(userId);
              if (settings.sendpulse_id && settings.sendpulse_secret) {
                const caption = msg.text || msg.caption || null;
                // Espera SendPulse processar a mensagem
                await new Promise(r => setTimeout(r, 3000));
                const spUrl = await sendpulse.getMediaUrl(
                  par.sendpulse_bot_id,
                  { sendpulse_id: settings.sendpulse_id, sendpulse_secret: settings.sendpulse_secret },
                  caption
                );
                if (spUrl) {
                  publicMediaUrl = spUrl;
                  console.log('[feed] got media URL from SendPulse:', spUrl.slice(0, 80));
                }
              }
            } catch (e2) {
              console.error('[feed] SendPulse media fallback error:', e2.message);
            }
          }
        }

        const msgData = {
          par_id: par.id,
          text,
          from_user: ctx.from?.username || ctx.from?.first_name || ctx.chat?.title || 'canal',
          message_type: msgType,
          file_id: fileId || null,
          telegram_media_url: publicMediaUrl || localPreview || null,
        };

        // ── Dedup: evita duplicatas ──
        // Verifica se mensagem idêntica foi salva nos últimos 2 minutos
        const existing = await db.getMessages(par.id, 30);
        const isDup = existing.some(e =>
          e.text === msgData.text &&
          e.file_id === msgData.file_id &&
          e.message_type === msgData.message_type &&
          e.created_at &&
          (Date.now() - new Date(e.created_at).getTime()) < 120000 // 2 min
        );
        if (isDup) return;

        // Salva no banco e notifica frontend via Socket.io
        const saved = await db.insertMessage(msgData);
        if (io) io.to(`par_${par.id}`).emit('new_message', saved);
      } catch (err) {
        console.error('[feed/telegraf] error:', err.message);
      }
    });

    // Erro runtime do Telegraf (não deve derrubar o processo)
    bot.catch((err) => {
      console.error(`[feed] Telegraf runtime error (user ${userId}):`, err.message);
    });

    // Inicia o bot (dropPendingUpdates evita processar mensagens antigas)
    bot.launch({ dropPendingUpdates: true }).catch((err) => {
      console.error(`[feed] Telegraf launch error (user ${userId}):`, err.message);
      delete userBots[userId];
    });

    userBots[userId] = bot;
    console.log(`[feed] Telegraf bot iniciado para user ${userId}`);
  } catch (err) {
    console.error(`[feed] Telegraf error (user ${userId}):`, err.message);
  }
}

/**
 * Baixa arquivo do Telegram Bot API e faz upload para catbox.moe
 * para obter uma URL pública permanente (necessário para SendPulse).
 *
 * @returns {{ localPath: string, publicUrl: string }}
 */
async function downloadTelegramFile(ctx, fileId, type, telegramToken) {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const https = require('https');
  const axios = require('axios');
  const FormData = require('form-data');
  const { execSync } = require('child_process');

  // Obtém path do arquivo no Telegram
  const fileInfo = await ctx.telegram.getFile(fileId);
  const filePath = fileInfo.file_path;
  let ext = path.extname(filePath) || (type === 'photo' ? '.jpg' : '.mp4');
  const baseName = crypto.randomBytes(12).toString('hex');
  const originalFilename = baseName + ext;
  const localPath = path.join(__dirname, '..', '..', 'public', 'uploads', originalFilename);

  // Download do Telegram Bot API
  const telegramUrl = `https://api.telegram.org/file/bot${telegramToken}/${filePath}`;
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(localPath);
    https.get(telegramUrl, (res) => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
  });

  // Convert non-mp4 videos to mp4 for SendPulse compatibility
  let uploadPath = localPath;
  let filename = originalFilename;
  if (type === 'video' && ext.toLowerCase() !== '.mp4') {
    const mp4Filename = baseName + '.mp4';
    const mp4Path = path.join(__dirname, '..', '..', 'public', 'uploads', mp4Filename);
    try {
      console.log(`[feed] Converting ${ext} to .mp4...`);
      execSync(`ffmpeg -i "${localPath}" -c:v libx264 -c:a aac -movflags +faststart -y "${mp4Path}"`, {
        timeout: 120000,
        stdio: 'pipe',
      });
      // Remove original, use mp4
      fs.unlinkSync(localPath);
      uploadPath = mp4Path;
      filename = mp4Filename;
      ext = '.mp4';
      console.log(`[feed] Converted to mp4: ${mp4Filename}`);
    } catch (e) {
      console.error('[feed] ffmpeg conversion failed, using original:', e.message);
      // Fallback: keep original file
    }
  }

  // Upload para catbox.moe (hospedagem gratuita de arquivos)
  // Necessário porque o SendPulse precisa de URL pública para mídia
  let publicUrl = telegramUrl;
  try {
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', fs.createReadStream(uploadPath));
    const res = await axios.post('https://catbox.moe/user/api.php', form, {
      headers: form.getHeaders(),
      timeout: 120000,
      maxContentLength: 210 * 1024 * 1024,
    });
    if (res.data && res.data.startsWith('https://')) {
      publicUrl = res.data.trim();
      console.log('[feed] catbox.moe URL:', publicUrl);
    }
  } catch (e) {
    console.error('[feed] catbox upload failed, using telegram URL:', e.message);
  }

  return { localPath: `/uploads/${filename}`, publicUrl };
}

/** Detecta tipo de conteúdo de uma mensagem Telegraf */
function detectTelegrafType(message) {
  if (message.photo && message.photo.length > 0) return 'photo';
  if (message.video) return 'video';
  if (message.document) return 'document';
  if (message.animation) return 'photo'; // GIFs tratados como foto
  return 'text';
}

/** Extrai file_id da mídia de uma mensagem Telegraf (maior resolução para fotos) */
function extractTelegrafFileId(message) {
  if (message.photo && message.photo.length > 0) return message.photo[message.photo.length - 1].file_id; // Maior resolução
  if (message.video) return message.video.file_id;
  if (message.document) return message.document.file_id;
  if (message.animation) return message.animation.file_id;
  return null;
}

/**
 * Polling de mensagens via API SendPulse (fallback para usuários sem Telegraf).
 * Busca últimas 20 mensagens do grupo e salva as novas.
 * Usa lastSeenMsg para evitar reprocessar mensagens já vistas.
 */
async function pollParMessages(par, credentials) {
  try {
    // Busca contatos do bot — procura o contato do grupo (type === 3)
    const contacts = await sendpulse.listContacts(par.sendpulse_bot_id, credentials);
    const groupContact = contacts.find(c => c.type === 3);
    if (!groupContact) return;

    const token = await sendpulse.getToken(credentials);
    const axios = require('axios');
    const res = await axios.get(
      `https://api.sendpulse.com/telegram/chats/messages?contact_id=${groupContact.id}&size=20&order=desc`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
    );

    // Filtra apenas mensagens recebidas (direction === 1), ignora enviadas
    const msgs = (res.data.data || res.data).filter(m => m.direction === 1);
    if (msgs.length === 0) return;

    // Determina quais mensagens são novas (comparando com lastSeen)
    const lastSeen = lastSeenMsg[par.id];
    const newMsgs = lastSeen
      ? msgs.filter(m => m.id > lastSeen)
      : msgs.slice(0, 10); // Primeira vez: pega últimas 10

    if (newMsgs.length === 0) return;
    lastSeenMsg[par.id] = msgs[0].id; // Atualiza marcador

    // Processa novas mensagens (mais antiga primeiro)
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

      // Dedup: verifica se mensagem já existe (por conteúdo + timestamp ~1min)
      const existing = await db.getMessages(par.id, 50);
      const isDuplicate = existing.some(e =>
        e.text === msgData.text &&
        e.file_id === msgData.file_id &&
        e.created_at &&
        Math.abs(new Date(e.created_at).getTime() - new Date(m.created_at).getTime()) < 60000
      );
      if (isDuplicate) continue;

      const saved = await db.insertMessage(msgData);
      if (io) io.to(`par_${par.id}`).emit('new_message', saved);
    }
  } catch (err) {
    // Ignora erros de rate limit (429) — normal no polling
    if (!err.message.includes('429')) {
      console.error(`[feed] poll error for par ${par.id}:`, err.message);
    }
  }
}

/**
 * Extrai informação de mídia dos dados de uma mensagem SendPulse.
 * Formatos variam: pode ser string (URL), objeto com file_id/url, ou array.
 * @returns {{ type: string, url: string|null }}
 */
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

/** Para todos os bots e o polling. Chamado no graceful shutdown. */
function stop() {
  if (pollingInterval) clearInterval(pollingInterval);
  for (const userId of Object.keys(userBots)) {
    try { userBots[userId].stop(); } catch {}
  }
}

module.exports = { start, stop, refreshUser };
