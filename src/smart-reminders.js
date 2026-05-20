/**
 * Smart Reminders — lembretes inteligentes contextuais.
 *
 * Tipos implementados:
 *  - pos_live: quando uma live Google Meet termina, gera resumo dos
 *    principais momentos + sugestões de stories e Reels e envia pro
 *    grupo de gerenciamento do expert no WhatsApp.
 *
 * Próximos a implementar:
 *  - pos_disparo: mede engajamento -1h vs +1h após disparo SendPulse
 *  - churn_alert: detecta queda anormal no canal Telegram/WhatsApp
 *  - concorrente: novo criativo do Denerzim na Ad Library
 */

const { Pool } = require('pg');
const db = require('./db');
const { executeKlarvelTool } = require('./klarvel-tools');

// Mapa Klarvel user_id (UUID) → SEND-X expert tab
const KLARVEL_USER_TO_EXPERT = {
  '192028bd-9657-4fe8-a484-ca4ebe9b8eb6': 'DEIVID',
  'ccf5cbcf-7628-41f3-836c-06a620dd1150': 'DANI',
  'fe8e91a1-8e2c-4457-b03c-04eb326481fc': 'JUH',
  '16bc71c0-a45e-46a5-a507-4c62cf0f5100': 'AYTALO',
};

let _klarvelPool = null;
function klarvelPool() {
  if (_klarvelPool) return _klarvelPool;
  if (!process.env.KLARVEL_DATABASE_URL) throw new Error('KLARVEL_DATABASE_URL não configurada');
  _klarvelPool = new Pool({ connectionString: process.env.KLARVEL_DATABASE_URL, max: 2 });
  return _klarvelPool;
}

let _monitorPool = null;
function monitorPool() {
  if (_monitorPool) return _monitorPool;
  if (!process.env.MONITORGRUPO_DATABASE_URL) throw new Error('MONITORGRUPO_DATABASE_URL não configurada');
  _monitorPool = new Pool({ connectionString: process.env.MONITORGRUPO_DATABASE_URL, max: 2 });
  return _monitorPool;
}

/** Acha grupo de gerenciamento do expert no monitorgrupo. */
async function getGrupoManagement(expertName) {
  try {
    const r = await monitorPool().query(`
      SELECT eg.group_jid, g.name FROM expert_groups eg
      JOIN experts e ON e.id = eg.expert_id
      JOIN groups g ON g.group_jid = eg.group_jid
      WHERE eg.role = 'management' AND e.is_active = true
        AND (UPPER(e.name) = $1 OR UPPER(e.display_name) = $1)
      LIMIT 1
    `, [expertName.toUpperCase()]);
    return r.rows[0] || null;
  } catch (e) {
    console.error('[smart-reminders] getGrupoManagement:', e.message);
    return null;
  }
}

/** Chama Claude no bridge com prompt estruturado. */
async function callBridge(message, additionalSystem) {
  const url = (await db.getBridgeRegistry().catch(() => null))?.url || process.env.BRIDGE_URL;
  const secret = process.env.BRIDGE_SECRET;
  if (!url || !secret) throw new Error('Bridge não configurada');
  const resp = await fetch(`${url}/chat`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${secret}`, 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1' },
    body: JSON.stringify({ message, additional_system: additionalSystem }),
  });
  if (!resp.ok) throw new Error(`Bridge ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

function extractJson(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

/** Envia mensagem WhatsApp via Evolution API. */
async function sendWhatsapp(toJid, text) {
  const url = process.env.EVOLUTION_API_URL;
  const key = process.env.EVOLUTION_API_KEY;
  const instance = process.env.AI_ADVISOR_INSTANCE || process.env.EVOLUTION_INSTANCE_NAME;
  if (!url || !key || !instance) throw new Error('EVOLUTION_API_URL/KEY/INSTANCE não configurados');
  const resp = await fetch(`${url}/message/sendText/${instance}`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: toJid, text }),
  });
  if (!resp.ok) throw new Error(`Evolution ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// ─── Processar lives terminadas ────────────────────────────────────────────

const LIVE_PROMPT = `Você é um analista sênior de marketing iGaming. Acabou de terminar uma live (Google Meet) do expert que você gerencia. Analise os dados e gere um resumo + sugestões pra POSTAR AGORA enquanto a audiência ainda está quente.

RETORNE EXATAMENTE este JSON (sem markdown, sem texto extra):
{
  "highlights": [
    "frase curta de 1 momento marcante da live (com número quando relevante)",
    "outro highlight",
    "..."  // 3-5 itens
  ],
  "stories_para_postar_agora": [
    {
      "hook": "frase de abertura para o story (max 80 chars)",
      "conteudo": "o que mostrar/escrever no story (max 200 chars)",
      "cta": "call-to-action"
    }
    // 3 itens
  ],
  "reel_para_gravar": {
    "tema": "tema do reel baseado no que rolou na live",
    "hook_primeiros_3s": "frase pra fisgar nos 3 primeiros segundos",
    "estrutura": ["abertura", "desenvolvimento", "fechamento com CTA"],
    "duracao_sugerida": "15s | 30s | 60s"
  },
  "urgencia": "alta | media | baixa",
  "razao_urgencia": "por que postar agora vs depois (max 150 chars)"
}

Use números concretos da live. Foque em momentos virais (pico de participantes, dúvidas frequentes, frases-chave).`;

async function gerarAnaliseLive(meetingId, userId = 1) {
  // 1) Detalhes da live + resumo
  const details = await executeKlarvelTool('get_live_detalhes', { meeting_id: meetingId });
  const msgs = await executeKlarvelTool('get_mensagens_live', { meeting_id: meetingId, limit: 100 });

  if (!details.meeting) throw new Error(`Meeting ${meetingId} não encontrada`);
  const klarvelUserId = details.meeting.user_id;
  const expert = KLARVEL_USER_TO_EXPERT[klarvelUserId];
  if (!expert) throw new Error(`Klarvel user_id ${klarvelUserId} não mapeado para expert`);

  // 2) Métricas resumidas
  const events = details.eventos || [];
  const picos = events.filter(e => e.event === 'participantJoined' || e.event === 'participantLeft');
  const baseline = events.find(e => e.event === 'participantsBaseline');
  const messages = events.filter(e => e.event === 'messageSent').length;
  const duracaoMin = details.meeting.stopped_at && details.meeting.joined_at
    ? Math.round((new Date(details.meeting.stopped_at) - new Date(details.meeting.joined_at)) / 60000)
    : null;
  // Calcula pico simultâneo
  let conc = baseline?.data?.participants?.length || 0;
  let pico = conc;
  for (const e of picos) {
    if (e.event === 'participantJoined') conc++;
    if (e.event === 'participantLeft') conc--;
    if (conc > pico) pico = conc;
  }

  // 3) Mensagens (primeiras 50 textos pra análise semântica)
  const msgsTxt = (msgs.mensagens || [])
    .filter(m => m.texto && m.texto.length > 2)
    .slice(0, 50)
    .map(m => `${m.autor}: ${m.texto.slice(0, 150)}`)
    .join('\n');

  // 4) Monta contexto pro Claude
  const ctx = `## LIVE TERMINADA
Expert: ${expert}
Duração: ${duracaoMin} minutos
Pico simultâneo: ${pico} pessoas
Total mensagens chat: ${messages}

## MENSAGENS DO CHAT
${msgsTxt || '(sem mensagens significativas)'}

Gere o resumo + sugestões conforme o schema do system prompt.`;

  const bridgeResp = await callBridge(ctx, LIVE_PROMPT);
  const parsed = extractJson(bridgeResp.text);

  // Fallback: se Claude não respondeu JSON, usa o texto bruto como conteúdo
  // (perde estrutura mas pelo menos manda análise pro WhatsApp)
  return {
    meeting_id: meetingId,
    expert,
    metricas: { duracao_min: duracaoMin, pico_simultaneo: pico, total_mensagens: messages },
    analise: parsed,
    fallback_text: parsed ? null : bridgeResp.text,
  };
}

function formatarMensagemWhatsapp({ expert, metricas, analise, fallback_text }) {
  // Se análise veio sem estrutura (fallback), manda só o texto bruto com header
  if (!analise && fallback_text) {
    return `🎬 *LIVE FINALIZADA — ${expert}*\n` +
      `⏱️ ${metricas.duracao_min || '?'} min · 👥 pico ${metricas.pico_simultaneo} · 💬 ${metricas.total_mensagens} msgs\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      String(fallback_text).slice(0, 3500);
  }

  const lines = [];
  lines.push(`🎬 *LIVE FINALIZADA — ${expert}*`);
  lines.push(`⏱️ ${metricas.duracao_min || '?'} min · 👥 pico ${metricas.pico_simultaneo} · 💬 ${metricas.total_mensagens} msgs`);
  lines.push('━━━━━━━━━━━━━━━━━━');
  lines.push('');
  lines.push('📌 *Highlights*');
  for (const h of analise.highlights || []) lines.push(`• ${h}`);
  lines.push('');

  if (analise?.stories_para_postar_agora?.length) {
    lines.push('📱 *POSTE AGORA — Stories*');
    analise.stories_para_postar_agora.forEach((s, i) => {
      lines.push(`*Story ${i + 1}:*`);
      lines.push(`Hook: _${s.hook}_`);
      lines.push(`Conteúdo: ${s.conteudo}`);
      lines.push(`CTA: ${s.cta}`);
      lines.push('');
    });
  }

  if (analise?.reel_para_gravar) {
    const r = analise.reel_para_gravar;
    lines.push('🎥 *REEL PARA GRAVAR*');
    lines.push(`Tema: ${r.tema}`);
    lines.push(`Hook (3s): _${r.hook_primeiros_3s}_`);
    lines.push(`Duração: ${r.duracao_sugerida}`);
    if (r.estrutura) lines.push(`Estrutura: ${(r.estrutura || []).join(' → ')}`);
    lines.push('');
  }

  if (analise?.urgencia) {
    const emoji = analise.urgencia === 'alta' ? '🚨' : analise.urgencia === 'media' ? '⚡' : '📅';
    lines.push(`${emoji} Urgência ${analise.urgencia}: _${analise.razao_urgencia || ''}_`);
  }
  return lines.join('\n');
}

async function processarLive(meetingId, userId = 1) {
  if (await db.existsReminder('pos_live', meetingId)) {
    return { skipped: 'já processado', meeting_id: meetingId };
  }
  const result = await gerarAnaliseLive(meetingId, userId);
  const grupoMgmt = await getGrupoManagement(result.expert);

  const mensagem = formatarMensagemWhatsapp(result);
  const rem = await db.insertReminder({
    user_id: userId,
    tipo: 'pos_live',
    expert: result.expert,
    trigger_id: meetingId,
    trigger_data: { metricas: result.metricas, meeting_id: meetingId },
    conteudo: mensagem,
    sugestoes: result.analise,
    status: 'pendente',
  });

  if (!grupoMgmt) {
    await db.markReminderError(rem.id, `Sem grupo management cadastrado pro expert ${result.expert}`);
    // Fallback: manda pro telefone do AI Advisor se configurado
    if (process.env.AI_ADVISOR_PHONE) {
      try {
        await sendWhatsapp(process.env.AI_ADVISOR_PHONE, '⚠️ Lembrete sem grupo management:\n\n' + mensagem);
      } catch (e) { /* ignora */ }
    }
    return { reminder_id: rem.id, error: 'sem grupo management', expert: result.expert };
  }

  try {
    await sendWhatsapp(grupoMgmt.group_jid, mensagem);
    await db.markReminderSent(rem.id, grupoMgmt.group_jid);
    return { reminder_id: rem.id, sent_to: grupoMgmt.name, expert: result.expert };
  } catch (e) {
    await db.markReminderError(rem.id, e.message);
    return { reminder_id: rem.id, error: e.message };
  }
}

async function processarLivesTerminadas(userId = 1, minutesBack = 60) {
  try {
    const r = await klarvelPool().query(`
      SELECT id, user_id, stopped_at FROM meetings
      WHERE status='stopped' AND stopped_at IS NOT NULL
        AND stopped_at >= NOW() - ($1 || ' minutes')::interval
      ORDER BY stopped_at DESC LIMIT 20
    `, [String(minutesBack)]);

    const results = [];
    for (const m of r.rows) {
      try {
        const out = await processarLive(m.id, userId);
        results.push(out);
      } catch (e) {
        results.push({ meeting_id: m.id, error: e.message });
      }
    }
    return results;
  } catch (e) {
    console.error('[smart-reminders] processarLivesTerminadas:', e.message);
    return { error: e.message };
  }
}

module.exports = { processarLive, processarLivesTerminadas, gerarAnaliseLive, formatarMensagemWhatsapp };
