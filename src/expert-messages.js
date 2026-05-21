/**
 * Mensagens diárias para os EXPERTS (não pro operador).
 *
 * Slots:
 *  - manha (09:00 BRT): resumo ontem sem citar gasto + 3 sugestões pra hoje
 *  - tarde (16:00 BRT): parcial do dia atual + reforço das sugestões da manhã
 *  - noite (22:00 BRT): resumo do dia + pergunta se precisa de algo
 *
 * Modos:
 *  - teste: envia tudo pro privado do Aytalo (5584996856193) com prefixo [TESTE | EXPERT]
 *  - prod: envia pro grupo de gerenciamento do expert (monitorgrupo)
 *
 * Dados intencionalmente OMITIDOS do contexto do Claude:
 *  - gasto_meta, custo_por_ftd, custo_por_clique, roi
 *  - alertas técnicos de campanha
 *
 * Dados que o expert vê:
 *  - FTDs (em linguagem natural: "novos jogadores")
 *  - ftd_amount / deposits_amount (depósitos totais)
 *  - Telegram joins, WhatsApp engajamento, Lives métricas
 */

const { Pool } = require('pg');
const db = require('./db');
const { executeFunilTool } = require('./funil-tools');

const EXPERTS_DEFAULT = ['DANI', 'DEIVID', 'JUH'];

// --- conexão monitorgrupo (pra achar grupo management de cada expert) ---
let _monitorPool = null;
function monitorPool() {
  if (_monitorPool) return _monitorPool;
  if (!process.env.MONITORGRUPO_DATABASE_URL) throw new Error('MONITORGRUPO_DATABASE_URL não configurada');
  _monitorPool = new Pool({ connectionString: process.env.MONITORGRUPO_DATABASE_URL, max: 2 });
  return _monitorPool;
}

async function getGrupoManagement(expertName) {
  try {
    const r = await monitorPool().query(`
      SELECT eg.group_jid, g.name FROM expert_groups eg
      JOIN experts e ON e.id = eg.expert_id
      JOIN groups g ON g.group_jid = eg.group_jid
      WHERE eg.role='management' AND e.is_active=true
        AND (UPPER(e.name)=$1 OR UPPER(e.display_name)=$1)
      LIMIT 1
    `, [expertName.toUpperCase()]);
    return r.rows[0] || null;
  } catch (e) { console.error('[expert-msg] getGrupoManagement:', e.message); return null; }
}

// --- coleta de dados (SEM gasto/CAC/ROI) ---

function resumirParaExpert(f) {
  if (!f) return null;
  return {
    periodo: f.periodo,
    novos_jogadores: f.detalhes?.planilha?.ftds || 0,
    ftd_amount: f.detalhes?.planilha?.ftd_amount || 0,
    depositos_totais: f.detalhes?.planilha?.deposits || 0,
    cadastros: f.detalhes?.planilha?.cadastros || 0,
    inscritos_telegram: f.detalhes?.planilha?.telegram_joins || 0,
    cliques: f.detalhes?.planilha?.cliques || 0,
    whatsapp: f.detalhes?.whatsapp ? {
      grupos: f.detalhes.whatsapp.grupos_leads,
      membros: f.detalhes.whatsapp.membros_total,
      ativos: f.detalhes.whatsapp.membros_ativos,
      engajamento: f.detalhes.whatsapp.engajamento,
      mensagens: f.detalhes.whatsapp.mensagens_total,
    } : null,
    lives: f.detalhes?.lives ? {
      total: f.detalhes.lives.total,
      pico_max: f.detalhes.lives.pico_max,
      participantes: f.detalhes.lives.participantes_unicos,
      mensagens_chat: f.detalhes.lives.mensagens,
      engajamento: f.detalhes.lives.engajamento,
    } : null,
  };
}

async function coletarDadosExpert(expert, userId = 1) {
  const [ontem, hoje, sete] = await Promise.all([
    executeFunilTool('get_funil_expert', { expert, periodo: 'ontem' }, userId).catch(() => null),
    executeFunilTool('get_funil_expert', { expert, periodo: 'hoje' }, userId).catch(() => null),
    executeFunilTool('get_funil_expert', { expert, periodo: '7d' }, userId).catch(() => null),
  ]);
  return {
    diario_ontem: resumirParaExpert(ontem),
    parcial_hoje: resumirParaExpert(hoje),
    semanal_7d: resumirParaExpert(sete),
  };
}

// --- prompts por slot ---

function buildPromptExpert(slot, expertName) {
  const baseRules = `# DADOS DISPONÍVEIS (use só como referência interna)
- "novos_jogadores" = jogadores que fizeram primeiro depósito ontem/hoje
- "depositos_totais" = valor total depositado
- "lives.pico_max" / "lives.participantes" / "lives.engajamento" = audiência das lives
- "whatsapp.ativos" / "whatsapp.mensagens" = movimento do grupo
- "inscritos_telegram" / "cadastros" / "cliques" = entradas

# REGRAS DO QUE NÃO MENCIONAR (inviolável)
- NUNCA fale de anúncios, Meta Ads, gasto, custo, CPA, CPF, CAC, ROI, verba, orçamento, campanha paga, tráfego pago
- NUNCA dê sugestão relacionada a anúncios ou gestão de campanha
- NUNCA fale "sua base", "seus leads", "captação", "funil", "qualificar leads", "responda os leads"
- NUNCA mencione "Aytalo", "operador", "gestor", "afiliado", "equipe"
- NUNCA escreva métricas frias de funil ("conversão de X%", "engagement rate"). Traduza pra realidade do expert.

# REGRAS DAS SUGESTÕES (foco em CONTEÚDO/PRESENÇA)
As sugestões devem ser AÇÕES DE CONTEÚDO que ${expertName} pode produzir/publicar:
✅ "Grave 3 stories falando sobre [tema específico]"
✅ "Faça uma chamada de live pras 20h com o gancho [X]"
✅ "Posta um reel mostrando [bastidor/resultado/dica]"
✅ "Comenta no seu post do feed convidando todo mundo pra próxima live"
✅ "Grava um story em selfie respondendo a dúvida mais comum que rolou ontem"
❌ "Monitore sua base"
❌ "Responda os leads"
❌ "Analise o engajamento"
❌ "Otimize sua captação"

# TOM
- 2ª pessoa direto com ${expertName} ("você")
- Amigo motivacional, energético, prático — não corporativo
- Português informal
- Emojis pra rotular seções (🌅 🔥 💪 🎬 📱 ✨)`;

  const slotInfo = {
    manha: `# Slot MANHÃ — Bom dia, ${expertName}!
ESTRUTURA OBRIGATÓRIA:
1. *Saudação curta* ("Bom dia, ${expertName}! 🌅" ou similar)
2. *Como foi ONTEM* (USE APENAS diario_ontem — nada de "essa semana"): em frases naturais conte quantos novos jogadores, valor de depósitos, como foi a live (se teve), movimento do grupo. Tom de "ó como foi seu dia ontem".
3. *3 sugestões de CONTEÚDO pra hoje* — cada uma deve ser uma ação de gravar/postar/fazer live/conversar. Use temas ligados ao que rolou ontem (ex: "Ontem teve 41 mensagens no chat da live perguntando sobre X — grava um reel respondendo essa dúvida"). NÃO repita estrutura, varie entre story / reel / live / engajamento direto.
4. Frase de fechamento curta motivacional

Tamanho: 600-1000 caracteres.`,

    tarde: `# Slot TARDE — ${expertName}, como tá o dia?
ESTRUTURA OBRIGATÓRIA:
1. *Saudação rápida* ("E aí, ${expertName}! 🔥" ou similar)
2. *Como está o dia até agora* (use parcial_hoje): conte quantos novos jogadores parciais, movimento das lives de hoje, atividade do grupo. Comparar com o ritmo de ontem se fizer sentido.
3. *Reforço das sugestões da manhã* — pergunte/lembre 1-2 ações que sugeri de manhã ("já gravou aquele reel sobre X?", "se ainda não fez a chamada da live, dá tempo até as 19h"). PERMITIDO fazer 1-2 perguntas SÓ desse tipo de reforço.
4. Energia pra fechar o dia

Tamanho: 400-800 caracteres.`,

    noite: `# Slot NOITE — ${expertName}, fechando o dia
ESTRUTURA OBRIGATÓRIA:
1. *Saudação noturna* ("Boa noite, ${expertName} 🌙" ou similar)
2. *Resumo geral do dia* (use parcial_hoje como dia completo): novos jogadores, depósitos, lives, engajamento. Destaque o que foi melhor.
3. *Reconhecimento sincero* — algo positivo que ${expertName} fez hoje
4. *Pergunta de cuidado*: "tem algo que eu posso fazer pra te ajudar amanhã / pra deixar mais leve pra você?" (essa é a PERGUNTA permitida)
5. Boa noite com afeto

Tamanho: 400-700 caracteres.`,
  }[slot] || 'Briefing geral.';

  return `Você é um parceiro/coach do influenciador ${expertName} (criador de conteúdo iGaming/cassino), enviando mensagem WhatsApp direta pra ele.

${slotInfo}

${baseRules}

# Formato — WhatsApp
- Markdown WhatsApp (*negrito*, _itálico_)
- NUNCA tabelas ascii — use frases naturais
- Não invente números que não estão nos dados

# Regras de saída
- ${slot === 'noite' ? 'PERMITIDO fazer 1 pergunta de cuidado no item 4' : (slot === 'tarde' ? 'PERMITIDO 1-2 perguntas curtas de reforço ("já fez X?")' : 'PROIBIDO fazer perguntas')}
- NUNCA escreva disclaimers ("analisei seus dados...", "espero que ajude")
- NUNCA peça pra confirmar/salvar/comparar
- Comece direto na saudação. Termine na última frase. Sem despedida extra.`;
}

// --- chamada ao bridge (mesmo padrão de ai-advisor) ---

async function callBridge(message, additionalSystem) {
  const url = (await db.getBridgeRegistry().catch(() => null))?.url || process.env.BRIDGE_URL;
  const secret = process.env.BRIDGE_SECRET;
  if (!url || !secret) throw new Error('Bridge não configurada');
  const resp = await fetch(`${url}/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1' },
    body: JSON.stringify({ message, additional_system: additionalSystem, mode: 'task' }),
  });
  if (!resp.ok) throw new Error(`Bridge ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

function stripPerguntas(text, allowOneQuestion = false) {
  if (!text) return '';
  const banned = /^(quer que|deseja|posso|se você|se preferir|caso queira|posso te ajudar|gostaria|posso salvar|me avise|fique à vontade)/i;
  let removed = 0;
  return String(text)
    .split('\n')
    .filter(line => {
      const t = line.trim();
      if (!t) return true;
      if (allowOneQuestion && t.endsWith('?')) { removed++; return removed > 1 ? false : true; }
      if (t.endsWith('?')) return false;
      if (banned.test(t)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- envio Evolution ---

async function sendWhatsapp(toJid, text) {
  const url = process.env.EVOLUTION_API_URL;
  const key = process.env.EVOLUTION_API_KEY;
  const instance = process.env.AI_ADVISOR_INSTANCE;
  if (!url || !key || !instance) throw new Error('Evolution envs ausentes');
  const resp = await fetch(`${url}/message/sendText/${instance}`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: toJid, text }),
  });
  if (!resp.ok) throw new Error(`Evolution ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// --- função principal ---

/**
 * Gera e envia mensagem pra cada expert.
 * @param {Object} opts { userId, slot: manha|tarde|noite, modo: teste|prod, experts: [] }
 */
async function enviarMensagensExperts({ userId = 1, slot = 'manha', modo = 'teste', experts = EXPERTS_DEFAULT } = {}) {
  const results = [];
  const allowQuestion = slot === 'noite';

  for (const expert of experts) {
    try {
      const dados = await coletarDadosExpert(expert, userId);
      // Contexto enviado pro Claude varia por slot — não passa dados que não vai usar
      let dadosTxt;
      if (slot === 'manha') {
        // Manhã: SÓ ontem (sem 7d/semanal/hoje)
        dadosTxt = `Dados de ${expert} — ONTEM apenas:\n${JSON.stringify(dados.diario_ontem)}`;
      } else if (slot === 'tarde') {
        // Tarde: parcial de hoje + ontem como referência de ritmo
        dadosTxt = `Dados de ${expert}:\nHOJE até agora: ${JSON.stringify(dados.parcial_hoje)}\nONTEM (referência de ritmo): ${JSON.stringify(dados.diario_ontem)}`;
      } else {
        // Noite: dia completo (parcial_hoje no fechamento = o dia inteiro)
        dadosTxt = `Dados de ${expert} — DIA HOJE:\n${JSON.stringify(dados.parcial_hoje)}`;
      }

      const bridge = await callBridge(dadosTxt, buildPromptExpert(slot, expert));
      const texto = stripPerguntas(String(bridge.text || '').trim(), allowQuestion);
      if (!texto || texto.length < 60) {
        results.push({ expert, error: 'msg muito curta', preview: texto });
        continue;
      }

      // Destino: teste → privado do Aytalo, prod → grupo management
      let destino, prefixo = '';
      if (modo === 'teste') {
        destino = process.env.AI_ADVISOR_PHONE;
        prefixo = `🧪 *[TESTE | mensagem que seria enviada pro grupo de ${expert}]*\n━━━━━━━━━━━━━━━━━━\n\n`;
      } else {
        const grupo = await getGrupoManagement(expert);
        if (!grupo) { results.push({ expert, error: 'sem grupo management cadastrado' }); continue; }
        destino = grupo.group_jid;
      }

      await sendWhatsapp(destino, prefixo + texto);
      results.push({ expert, modo, destino, length: texto.length });
    } catch (e) {
      results.push({ expert, error: e.message });
    }
  }
  return results;
}

module.exports = { enviarMensagensExperts, coletarDadosExpert };
