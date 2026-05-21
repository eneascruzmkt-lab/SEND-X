/**
 * Image Generator — chamada por trigger `/img <prompt>` em grupo de gerenciamento.
 *
 * Fluxo:
 *  1. monitorgrupo webhook detecta msg `/img` em grupo role='management' do expert
 *     → chama POST /api/img-generator/process com {group_jid, prompt, image_urls, sender}
 *  2. Este módulo monta prompt pro bridge (Claude com MCP higgis)
 *  3. Claude no Mac usa mcp__claude_ai_higgis__media_upload + generate_image
 *  4. Aguarda job COMPLETED via job_status, pega URL final
 *  5. Envia imagem gerada pro grupo via Evolution sendMedia
 */

const db = require('./db');

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
async function processarSolicitacao({ group_jid, prompt, image_urls = [], sender_name = '', expert = '' }) {
  if (!group_jid || !prompt) throw new Error('group_jid e prompt obrigatórios');

  // Feedback inicial
  await sendWhatsappText(group_jid,
    `🎨 *Gerando imagem...*\n` +
    `Prompt: _"${prompt}"_\n` +
    (image_urls.length ? `Referências: ${image_urls.length} imagem(ns)\n` : '') +
    `Modelo: Nano Banana\n` +
    `_Demora ~30-60s_`
  ).catch(() => {});

  // Monta prompt pro Claude usar o MCP Higgsfield
  const refsTxt = image_urls.length > 0
    ? `\n\nVocê tem ${image_urls.length} imagens de referência (passe como reference_images no generate_image):\n` +
      image_urls.map((u, i) => `${i + 1}. ${u}`).join('\n')
    : '';

  const bridgePrompt = `Gere uma imagem usando o MCP Higgsfield seguindo EXATAMENTE estes passos:

1. Use mcp__claude_ai_higgis__generate_image com:
   - model: "nano-banana" (ou similar gratuito ilimitado)
   - prompt: "${prompt.replace(/"/g, '\\"')}"${image_urls.length > 0 ? `
   - reference_images: ${JSON.stringify(image_urls)}` : ''}

2. Quando retornar um job_id, use mcp__claude_ai_higgis__job_status pra acompanhar (loop a cada ~10s até status="completed")

3. Quando completar, retorne APENAS a URL da imagem final num formato:
   IMAGEM_GERADA: <url>

NÃO escreva explicações, dialogo ou texto extra. Apenas siga os passos e retorne a URL no formato acima.${refsTxt}`;

  let imageUrl = null;
  try {
    const resp = await callBridge(bridgePrompt, 'chat');
    imageUrl = extractUrl(resp.text);
    if (!imageUrl) {
      // Tenta fallback: o texto pode ter a URL sem o prefixo
      const match = String(resp.text || '').match(/IMAGEM_GERADA:\s*(\S+)/);
      if (match) imageUrl = match[1];
    }
    if (!imageUrl) {
      await sendWhatsappText(group_jid,
        `❌ *Não consegui gerar a imagem.*\n\n` +
        `Resposta do gerador:\n_${(resp.text || '').slice(0, 500)}_`
      );
      return { ok: false, error: 'sem url na resposta', bridge_text: resp.text };
    }
  } catch (e) {
    await sendWhatsappText(group_jid, `❌ Erro ao gerar imagem: ${e.message}`).catch(() => {});
    return { ok: false, error: e.message };
  }

  // Envia a imagem gerada pro grupo
  try {
    await sendWhatsappImage(group_jid, imageUrl,
      sender_name ? `✨ Pronto, @${sender_name.split('@')[0]}` : '✨ Imagem gerada'
    );
    return { ok: true, image_url: imageUrl };
  } catch (e) {
    // Fallback: manda só o link
    await sendWhatsappText(group_jid, `✨ Imagem gerada (não consegui mandar como mídia, segue link):\n${imageUrl}`);
    return { ok: true, image_url: imageUrl, fallback_text: true };
  }
}

module.exports = { processarSolicitacao };
