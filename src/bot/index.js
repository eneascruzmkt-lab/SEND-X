/**
 * ============================================================
 *  Bot — Captura de mensagens dos grupos Telegram (Feed)
 * ============================================================
 *
 *  Estratégia de captura:
 *
 *  TELEGRAF: Se o usuário tem telegram_token,
 *     cria um bot Telegraf que recebe mensagens em tempo real.
 *
 *  Fluxo Telegraf:
 *  ┌───────────────────────────────────────────────────────────┐
 *  │  1. Mensagem chega no grupo Telegram                      │
 *  │  2. Telegraf recebe via webhook/polling                   │
 *  │  3. Identifica o par pelo chat.id (telegram_group_id)     │
 *  │  4. Detecta tipo: text, photo, video, document            │
 *  │  5. Se mídia: baixa do Telegram → upload catbox.moe       │
 *  │  6. Dedup: verifica se mensagem duplicada (2min window)   │
 *  │  7. Salva no banco (messages) + emite via Socket.io       │
 *  └───────────────────────────────────────────────────────────┘
 *
 *  IMPORTANTE: Este módulo NÃO afeta schedules. Apenas popula
 *  a tabela messages (feed ao vivo) que é limpa diariamente.
 * ============================================================
 */

const db = require('../db');

let io = null;              // Referência ao Socket.io (injetada via start)

// Instâncias Telegraf por usuário: { [userId]: Telegraf }
// Cada usuário com telegram_token tem seu próprio bot rodando
const userBots = {};

/**
 * Inicia o bot manager: cria bots Telegraf para todos os usuários
 * com telegram_token.
 */
function start(socketIo) {
  io = socketIo;

  // Inicia bots Telegraf para todos os usuários com token configurado
  refreshAllBots();

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

/**
 * Converte texto + entities do Telegram em HTML.
 * Preserva links, bold, italic, code. Se não há entities, retorna o texto puro.
 *
 * IMPORTANTE: Telegram entity offsets/lengths são em UTF-16 code units (igual a JS string.length).
 * Emojis contam como 2 unidades. Usamos string.substring() que opera em UTF-16.
 */
function telegramToHtml(text, entities) {
  if (!text) return null;
  if (!entities || entities.length === 0) return text;

  // Escape HTML chars in the original text first
  function escHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // Sort entities by offset ascending
  const sorted = [...entities].sort((a, b) => a.offset - b.offset || a.length - b.length);

  let result = '';
  let lastIdx = 0;

  for (const e of sorted) {
    const start = e.offset;
    const end = e.offset + e.length;

    // Add text before this entity
    if (start > lastIdx) {
      result += escHtml(text.substring(lastIdx, start));
    }

    const inner = escHtml(text.substring(start, end));

    switch (e.type) {
      case 'text_link':
        result += `<a href="${e.url}">${inner}</a>`;
        break;
      case 'bold':
        result += `<b>${inner}</b>`;
        break;
      case 'italic':
        result += `<i>${inner}</i>`;
        break;
      case 'underline':
        result += `<u>${inner}</u>`;
        break;
      case 'strikethrough':
        result += `<s>${inner}</s>`;
        break;
      case 'code':
        result += `<code>${inner}</code>`;
        break;
      case 'url':
        result += `<a href="${inner}">${inner}</a>`;
        break;
      default:
        result += inner;
        break;
    }
    lastIdx = end;
  }

  // Add remaining text after last entity
  if (lastIdx < text.length) {
    result += escHtml(text.substring(lastIdx));
  }

  return result;
}

/** Detecta tipo de conteúdo de uma mensagem Telegraf */
const VIDEO_EXTENSIONS = ['.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.3gp'];
const VIDEO_MIMES = ['video/'];

function detectTelegrafType(message) {
  if (message.photo && message.photo.length > 0) return 'photo';
  if (message.video) return 'video';
  if (message.document) {
    // Check if document is actually a video file (e.g. .mov sent as document)
    const doc = message.document;
    const mime = (doc.mime_type || '').toLowerCase();
    const name = (doc.file_name || '').toLowerCase();
    const ext = name.includes('.') ? '.' + name.split('.').pop() : '';
    if (mime.startsWith('video/') || VIDEO_EXTENSIONS.includes(ext)) return 'video';
    return 'document';
  }
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

/** Para todos os bots. Chamado no graceful shutdown. */
function stop() {
  for (const userId of Object.keys(userBots)) {
    try { userBots[userId].stop(); } catch {}
  }
}

module.exports = { start, stop, refreshUser };
