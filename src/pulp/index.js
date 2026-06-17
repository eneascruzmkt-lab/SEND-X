/**
 * ============================================================
 *  Pulp — Integracao com o MCP do Pulp
 * ============================================================
 *
 *  Funcoes:
 *  - listBots()  — lista bots cadastrados no Pulp
 *  - dispatch()  — cria broadcast e dispara via Pulp
 *
 *  Comunicacao via MCP JSON-RPC 2.0:
 *  POST <PULP_URL>/mcp com Authorization: Bearer <PULP_API_KEY>
 * ============================================================
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const FormData = require('form-data');

/**
 * Chama uma tool do MCP do Pulp via HTTP.
 * @param {string} pulpUrl — URL base do Pulp (ex: https://pulp.up.railway.app)
 * @param {string} apiKey — MCP API key
 * @param {string} toolName — nome da tool MCP
 * @param {Object} args — argumentos da tool
 * @returns {Object} resultado parseado da tool
 */
async function callMcpTool(pulpUrl, apiKey, toolName, args) {
  const body = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  };

  const res = await axios.post(`${pulpUrl}/mcp`, body, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    timeout: 30000,
  });

  // MCP retorna resultado em res.data.result.content[0].text
  const data = res.data;
  if (data.error) throw new Error(data.error.message || 'Erro MCP');
  const content = data.result?.content?.[0];
  if (!content) throw new Error('Resposta MCP vazia');
  if (content.type === 'text') {
    try { return JSON.parse(content.text); } catch { return content.text; }
  }
  return content;
}

/**
 * Lista bots cadastrados no Pulp.
 * @returns {Array} [{ id, name, username, active }]
 */
async function listBots(pulpUrl, apiKey) {
  return callMcpTool(pulpUrl, apiKey, 'list_bots', {});
}

/**
 * Resolve URL de midia para formato absoluto.
 * - URLs http/https: retorna como esta
 * - Paths locais (/uploads/...): prepend dominio Railway
 * - Outros: retorna '' (rejeitado)
 */
function resolveMediaUrl(url) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  if (url.startsWith('/')) {
    const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null;
    const domain = railwayDomain || `http://localhost:${process.env.PORT || 3000}`;
    return domain.replace(/\/$/, '') + url;
  }
  return '';
}

/**
 * Baixa video remoto, converte para mp4 via ffmpeg, re-upa para catbox.moe.
 * @param {string} url — URL do video original
 * @returns {string} URL do video convertido em mp4
 */
async function convertRemoteVideoToMp4(url) {
  const uploadsDir = path.join(__dirname, '..', '..', 'public', 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

  const baseName = crypto.randomBytes(12).toString('hex');
  const origExt = path.extname(new URL(url).pathname) || '.mov';
  const origPath = path.join(uploadsDir, baseName + origExt);
  const mp4Path = path.join(uploadsDir, baseName + '.mp4');

  console.log(`[pulp] Downloading video for conversion: ${url.slice(0, 80)}`);
  const resp = await axios.get(url, { responseType: 'stream', timeout: 120000 });
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(origPath);
    resp.data.pipe(file);
    file.on('finish', () => { file.close(); resolve(); });
    file.on('error', reject);
  });

  console.log(`[pulp] Converting ${origExt} to .mp4...`);
  execSync(`ffmpeg -i "${origPath}" -c:v libx264 -c:a aac -movflags +faststart -y "${mp4Path}"`, {
    timeout: 120000,
    stdio: 'pipe',
  });
  fs.unlinkSync(origPath);

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
    console.log(`[pulp] Converted video uploaded: ${res.data.trim()}`);
    return res.data.trim();
  }
  throw new Error('Catbox upload failed');
}

/**
 * Dispara campanha via Pulp — cria broadcast e envia.
 *
 * @param {Object} schedule — schedule do banco (content_type, content_text, content_media_url, buttons)
 * @param {Object|null} par — par vinculado (para fallback do bot_id)
 * @param {string} pulpUrl — URL do Pulp
 * @param {string} apiKey — MCP API key
 */
async function dispatch(schedule, par, pulpUrl, apiKey) {
  const botId = schedule.sendpulse_bot_id || (par && par.sendpulse_bot_id);
  if (!botId) throw new Error('Bot ID nao encontrado');

  const type = schedule.content_type || 'text';
  const mediaValue = schedule.content_media_url || '';
  let resolvedMedia = resolveMediaUrl(mediaValue);

  // Converte video nao-mp4 se necessario
  if (type === 'video' && resolvedMedia && !resolvedMedia.toLowerCase().endsWith('.mp4') && resolvedMedia.startsWith('http')) {
    resolvedMedia = await convertRemoteVideoToMp4(resolvedMedia);
  }

  // Parse buttons
  let buttons = null;
  if (schedule.buttons) {
    try {
      buttons = typeof schedule.buttons === 'string' ? JSON.parse(schedule.buttons) : schedule.buttons;
    } catch (e) {
      console.error('[pulp] JSON invalido em buttons:', e.message);
    }
  }
  const validButtons = buttons?.filter(b => b.text && b.url && /^https?:\/\/.+/i.test(b.url));

  const args = {
    bot_id: Number(botId),
    content_type: type,
    content_text: schedule.content_text || '',
  };
  if ((type === 'photo' || type === 'video') && resolvedMedia) {
    args.content_media_url = resolvedMedia;
  }
  if (validButtons && validButtons.length > 0) {
    args.buttons = validButtons.map(b => ({ text: b.text, url: b.url }));
  }

  console.log('[pulp] dispatch args:', JSON.stringify(args).slice(0, 500));

  // Tentativa com 1 retry
  try {
    const result = await callMcpTool(pulpUrl, apiKey, 'create_and_send_broadcast', args);
    console.log(`[pulp] Broadcast criado: id=${result.id}, status=${result.status}`);
    return result;
  } catch (err) {
    console.warn(`[pulp] Primeira tentativa falhou: ${err.message}. Retentando em 2s...`);
    await new Promise(r => setTimeout(r, 2000));
    const result = await callMcpTool(pulpUrl, apiKey, 'create_and_send_broadcast', args);
    console.log(`[pulp] Broadcast criado (retry): id=${result.id}, status=${result.status}`);
    return result;
  }
}

module.exports = { listBots, dispatch };
