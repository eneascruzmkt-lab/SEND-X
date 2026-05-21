/**
 * Image Generator — chamada por trigger `/img <prompt>` em grupo de gerenciamento.
 *
 * Fluxo:
 *  1. monitorgrupo webhook detecta msg `/img` em grupo role='management' do expert
 *  2. Se houve imagem anexada: monitorgrupo baixa via Evolution + manda base64
 *  3. SEND-X recebe base64 → salva como arquivo público em /public/uploads/
 *  4. Bridge recebe URL pública → MCP Higgsfield gera com Nano Banana
 *  5. SEND-X recebe URL da imagem gerada → envia via Evolution sendMedia
 */

const db = require('./db');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function saveBase64Image(base64Data, mimeType = 'image/jpeg') {
  const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
  const filename = `imggen-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const filepath = path.join(UPLOADS_DIR, filename);
  // Remove data:image/xxx;base64, prefix se existir
  const clean = base64Data.replace(/^data:image\/[a-z]+;base64,/, '');
  fs.writeFileSync(filepath, Buffer.from(clean, 'base64'));
  return `/uploads/${filename}`;
}

async function callBridge(message, mode = 'chat') {
  const url = (await db.getBridgeRegistry().catch(() => null))?.url || process.env.BRIDGE_URL;
  const secret = process.env.BRIDGE_SECRET;
  if (!url || !secret) throw new Error('Bridge não configurada');
  const resp = await fetch(`${url}/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1' },
    body: JSON.stringify({ message, mode }),
  });
  if (!resp.ok) throw new Error(`Bridge ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

function extractUrl(text) {
  if (!text) return null;
  // Procura URL de imagem (https://...)
  const matches = String(text).match(/https?:\/\/[^\s\)\]]+\.(jpg|jpeg|png|webp)(\?[^\s\)\]]*)?/gi);
  return matches?.[0] || null;
}

async function sendWhatsappImage(toJid, imageUrl, caption = '') {
  const url = process.env.EVOLUTION_API_URL;
  const key = process.env.EVOLUTION_API_KEY;
  const instance = process.env.AI_ADVISOR_INSTANCE;
  if (!url || !key || !instance) throw new Error('Evolution envs ausentes');
  const resp = await fetch(`${url}/message/sendMedia/${instance}`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      number: toJid,
      mediatype: 'image',
      media: imageUrl,
      caption,
      fileName: 'imagem.png',
    }),
  });
  if (!resp.ok) throw new Error(`Evolution ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function sendWhatsappText(toJid, text) {
  const url = process.env.EVOLUTION_API_URL;
  const key = process.env.EVOLUTION_API_KEY;
  const instance = process.env.AI_ADVISOR_INSTANCE;
  const resp = await fetch(`${url}/message/sendText/${instance}`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: toJid, text }),
  });
  if (!resp.ok) throw new Error(`Evolution ${resp.status}: ${await resp.text()}`);
}

/**
 * Processa solicitação de geração de imagem.
 * @param {Object} opts { group_jid, prompt, image_urls, sender_name, expert }
 */
async function processarSolicitacao({ group_jid, prompt, image_urls = [], image_base64_list = [], sender_name = '', expert = '' }) {
  if (!group_jid || !prompt) throw new Error('group_jid e prompt obrigatórios');

  console.log(`[img-gen] start group=${group_jid} expert=${expert} prompt="${prompt.slice(0, 60)}..." refs=${image_urls.length}+${image_base64_list.length}`);

  // Salva base64 vindo do WhatsApp em arquivos públicos
  const publicHost = process.env.PUBLIC_URL || 'https://send-x-production.up.railway.app';
  const savedRefs = [];
  for (const b64 of image_base64_list) {
    try {
      const relPath = saveBase64Image(b64);
      const publicUrl = `${publicHost}${relPath}`;
      savedRefs.push(publicUrl);
      console.log(`[img-gen] ref salva: ${publicUrl}`);
    } catch (e) { console.error('[img-gen] save base64 falhou:', e.message); }
  }
  const allRefs = [...image_urls, ...savedRefs];

  // Feedback inicial
  await sendWhatsappText(group_jid,
    `🎨 *Gerando imagem...*\n` +
    `Prompt: _"${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}"_\n` +
    (allRefs.length ? `Referências: ${allRefs.length} imagem(ns)\n` : '') +
    `Modelo: Nano Banana\n` +
    `_Demora ~30-60s_`
  ).catch((e) => console.error('[img-gen] feedback inicial falhou:', e.message));

  // Monta prompt pro Claude usar o MCP Higgsfield
  const refsTxt = allRefs.length > 0
    ? `\n\nVocê tem ${allRefs.length} imagens de referência (passe como reference_images no generate_image):\n` +
      allRefs.map((u, i) => `${i + 1}. ${u}`).join('\n')
    : '';

  const bridgePrompt = `Gere uma imagem usando o MCP Higgsfield seguindo EXATAMENTE estes passos:

1. Use mcp__claude_ai_higgis__generate_image com:
   - model: "nano-banana" (ou similar gratuito ilimitado)
   - prompt: "${prompt.replace(/"/g, '\\"')}"${allRefs.length > 0 ? `
   - reference_images: ${JSON.stringify(allRefs)}` : ''}

2. Se retornar job_id, use mcp__claude_ai_higgis__job_status (loop ~10s até completed)

3. Retorne APENAS a URL da imagem final no formato exato:
   IMAGEM_GERADA: <url>

Sem explicações. Sem texto extra. Apenas a URL no formato acima.${refsTxt}`;

  let imageUrl = null;
  let bridgeText = '';
  try {
    const resp = await callBridge(bridgePrompt, 'chat');
    bridgeText = resp.text || '';
    console.log(`[img-gen] bridge resp len=${bridgeText.length} first500="${bridgeText.slice(0, 500)}"`);
    // Tenta primeiro o formato IMAGEM_GERADA: <url>
    const match = bridgeText.match(/IMAGEM_GERADA:\s*(\S+)/);
    if (match) imageUrl = match[1].replace(/[<>]/g, ''); // remove < > se vier
    if (!imageUrl) imageUrl = extractUrl(bridgeText);
    console.log(`[img-gen] imageUrl extraído: ${imageUrl}`);
    if (!imageUrl) {
      await sendWhatsappText(group_jid,
        `❌ *Não consegui gerar a imagem.*\n\n_${bridgeText.slice(0, 400)}_`
      );
      return { ok: false, error: 'sem url na resposta', bridge_text: bridgeText };
    }
  } catch (e) {
    console.error('[img-gen] bridge falhou:', e.message);
    await sendWhatsappText(group_jid, `❌ Erro ao gerar imagem: ${e.message}`).catch(() => {});
    return { ok: false, error: e.message };
  }

  // Envia a imagem gerada pro grupo
  try {
    const sendResult = await sendWhatsappImage(group_jid, imageUrl,
      sender_name ? `✨ Pronto, @${sender_name.split('@')[0]}` : '✨ Imagem gerada'
    );
    console.log(`[img-gen] sendMedia OK:`, JSON.stringify(sendResult).slice(0, 200));
    return { ok: true, image_url: imageUrl };
  } catch (e) {
    console.error('[img-gen] sendMedia falhou:', e.message);
    await sendWhatsappText(group_jid, `✨ *Imagem gerada* (não consegui mandar como mídia):\n${imageUrl}`);
    return { ok: true, image_url: imageUrl, fallback_text: true, send_error: e.message };
  }
}

module.exports = { processarSolicitacao };
