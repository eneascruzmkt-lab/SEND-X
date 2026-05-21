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

/** Chama Claude no bridge em modo 'task' (isolado, sem CLAUDE.md/skills locais). */
async function callBridge(message, additionalSystem) {
  const url = (await db.getBridgeRegistry().catch(() => null))?.url || process.env.BRIDGE_URL;
  const secret = process.env.BRIDGE_SECRET;
  if (!url || !secret) throw new Error('Bridge não configurada');
  const resp = await fetch(`${url}/chat`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${secret}`, 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1' },
    body: JSON.stringify({ message, additional_system: additionalSystem, mode: 'task' }),
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

function buildLivePromptUser(expertName, contextoLive) {
  return `# Tarefa
Gerar mensagem WhatsApp que vai DIRETO pra ${expertName} agora, logo após a live dele terminar. É pra ele, não pra um gestor.

# Regras inegociáveis
- 2ª pessoa, falando com ${expertName} ("você", "tua live", "manda esse story", "grava esse reel")
- Tom de coach/parceiro: motivacional, prático, energético
- NUNCA fazer perguntas no output
- NUNCA escrever "quer que eu", "deseja", "posso registrar", "se preferir", "gostaria"
- NUNCA explicar o que vai fazer ou pedir confirmação
- NUNCA mencionar "Aytalo", "operador", "gestor"
- Sem despedida no final ("Bora!" no final é ok, mas nada de "qualquer coisa me chama" ou "fico à disposição")

# Estrutura OBRIGATÓRIA da resposta (texto markdown pronto pra WhatsApp)

📊 *Resumo da live*
[1-2 frases sobre como foi a live: tema principal, momento alto, clima]

🔥 *Destaques do chat*
[3-5 bullets com momentos marcantes: wins de membros, hits altos, frases-chave que rolaram, perguntas frequentes. Cite nomes dos membros e números quando relevantes.]

💬 *Engajamento*
[1-2 bullets sobre clima/movimento do chat]

📱 *Posta esses 3 stories agora:*
1. *Story 1:* [hook curto]
   _O que postar:_ [o que escrever/mostrar — concreto, baseado em momento da live]
   _CTA:_ [call-to-action]
2. *Story 2:* [...]
3. *Story 3:* [...]

🎙️ *Story de bastidor (grava em selfie/voz AGORA, com energia da live):*
*Tema:* [ideia conectada ao melhor momento]
*Fala sugerida:* [frase pronta pra falar no story]
*CTA:* [call-to-action]

🎥 *Reel pra gravar ainda hoje*
*Tema:* [baseado em momento ou pergunta recorrente da live]
*Hook (3s):* [frase pra fisgar logo no início]
*Estrutura:* [abertura → desenvolvimento → fechamento+CTA, separado por →]
*Duração:* [15s, 30s ou 60s]

# Regras das sugestões
- TODAS as 3 sugestões de story + bastidor + reel devem ser CONCRETAS, baseadas em algo que ROLOU NA LIVE (frase, momento, win, pergunta)
- Cite números reais da live nos hooks quando fizer sentido
- Foco: viralizar nas próximas 2 horas + chamar mais gente pra próxima live

# Dados da live recém-terminada
${contextoLive}

Escreva AGORA a mensagem WhatsApp pra ${expertName} seguindo TODA a estrutura acima. Comece com "📊 *Resumo da live*" — sem saudação, sem intro. Termine no Reel — sem despedida, sem pergunta.`;
}

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

  // 4) Monta contexto + prompt num único user message (system prompt do bridge é ignorado)
  const contextoLive = `Duração: ${duracaoMin} minutos
Pico simultâneo: ${pico} pessoas
Total mensagens chat: ${messages}

Mensagens do chat (autor: texto):
${msgsTxt || '(sem mensagens significativas)'}`;

  const userMsg = buildLivePromptUser(expert, contextoLive);
  const bridgeResp = await callBridge(userMsg, '');
  const textoLimpo = stripPerguntasOffer(String(bridgeResp.text || '').trim());

  return {
    meeting_id: meetingId,
    expert,
    metricas: { duracao_min: duracaoMin, pico_simultaneo: pico, total_mensagens: messages },
    texto_pronto: textoLimpo,
  };
}

function stripPerguntasOffer(text) {
  if (!text) return '';
  // Remove blocos finais que contém perguntas/ofertas (3-5 últimos parágrafos suspeitos)
  let lines = String(text).split('\n');
  const offerRegex = /^(quer que|deseja|posso (?:registrar|salvar|comparar|gerar)|se você|se preferir|caso queira|gostaria|fico à dispos)/i;
  // Itera de trás pra frente e remove linhas suspeitas no final
  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim();
    if (!last) { lines.pop(); continue; }
    if (last.endsWith('?')) { lines.pop(); continue; }
    if (offerRegex.test(last)) { lines.pop(); continue; }
    if (/^---+$/.test(last)) { lines.pop(); continue; }
    break;
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function formatarMensagemWhatsapp({ expert, metricas, analise, fallback_text }) {
  // Fallback: Claude não retornou JSON → manda texto bruto
  if (!analise && fallback_text) {
    return `🎬 *Acabou sua live, ${expert}! 🔥*\n` +
      `⏱️ ${metricas.duracao_min || '?'} min · 👥 pico ${metricas.pico_simultaneo} · 💬 ${metricas.total_mensagens} msgs\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      String(fallback_text).slice(0, 3500);
  }

  const lines = [];
  lines.push(`🎬 *Acabou sua live, ${expert}! 🔥*`);
  lines.push(`⏱️ ${metricas.duracao_min || '?'} min · 👥 pico de ${metricas.pico_simultaneo} ao vivo · 💬 ${metricas.total_mensagens} msgs`);
  lines.push('━━━━━━━━━━━━━━━━━━');
  lines.push('');
  lines.push('📌 *O que arrebentou:*');
  for (const h of (analise?.highlights || [])) lines.push(`• ${h}`);
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
