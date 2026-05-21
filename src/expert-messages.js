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
  const baseRules = `# FONTE DE DADOS
- "novos_jogadores" = jogadores que fizeram primeiro depósito (FTDs)
- "depositos_totais" = quanto foi depositado no total
- "inscritos_telegram" = quantos entraram no canal Telegram
- "cliques" = quantos clicaram no link do expert
- "whatsapp.ativos" = quantos seguidores mandaram mensagem no grupo
- "lives.pico_max" = maior nº de pessoas ao vivo simultaneamente
- "lives.engajamento" = % de quem assistiu que mandou mensagem

# REGRA INVIOLÁVEL — NÃO MENCIONE
- NUNCA mencione gasto, custo, CPA, CPF, CAC, ROI, anúncios, Meta Ads, orçamento
- Não fale de "investimento", "verba", "campanha paga"
- O expert NÃO TEM CONTEXTO de quanto custou. Fale só do resultado dele.

# TOM
- 2ª pessoa, falando direto com ${expertName} ("você")
- Amigo/coach motivacional, energético, prático
- Português brasileiro informal
- Use emojis pra rotular seções (📈 🎯 🔥 💪 🎬 📊)
- NUNCA escreva "Aytalo", "operador", "gestor", "afiliado"`;

  const slotInfo = {
    manha: `# Slot MANHÃ — Bom dia, ${expertName}!
ESTRUTURA OBRIGATÓRIA:
1. *Saudação curta* ("Bom dia, ${expertName}! 🌅" ou similar)
2. *Resumo de ONTEM* (use diario_ontem): quantos novos jogadores, depósitos totais, lives, engajamento do grupo. Em linguagem natural, sem números frios.
3. *3 sugestões CONCRETAS pra hoje* — coisas que ${expertName} pode FAZER (postar story X, gravar reel Y, comentar no grupo, fazer live em horário Z). NÃO sugira coisas que dependem de anúncios.
4. Fechamento motivacional curto

Tamanho: 600-1000 caracteres.`,

    tarde: `# Slot TARDE — ${expertName}, como tá indo o dia?
ESTRUTURA OBRIGATÓRIA:
1. *Saudação rápida* ("E aí, ${expertName}! 🔥" ou similar)
2. *Como está o dia até agora* (use parcial_hoje): mencionar novos jogadores parciais, lives feitas hoje, atividade do grupo. Comparar com o ritmo de ontem quando relevante.
3. *Pergunta de reforço* — relembrar 1-2 das sugestões da manhã ("já gravou aquele story?", "se ainda não fez X, ainda dá tempo até as 20h").
4. Energia pra fechar o dia bem

Tamanho: 400-800 caracteres.`,

    noite: `# Slot NOITE — ${expertName}, fechando o dia
ESTRUTURA OBRIGATÓRIA:
1. *Saudação noturna* ("Boa noite, ${expertName} 🌙" ou similar)
2. *Resumo geral do dia* (use parcial_hoje como dia completo): novos jogadores, depósitos, lives, engajamento. Destaque o que foi melhor.
3. *Reconhecimento* — algo positivo que ${expertName} fez hoje
4. *Pergunta sincera de cuidado*: "tem algo que eu posso fazer pra te ajudar amanhã / pra deixar mais fácil pra você?" (essa é a ÚNICA pergunta permitida)
5. Boa noite com afeto

Tamanho: 400-700 caracteres.`,
  }[slot] || 'Briefing geral.';

  return `Você é um parceiro/coach do influenciador ${expertName} (mercado iGaming/cassino), enviando mensagem WhatsApp direta pra ele.

${slotInfo}

${baseRules}

# Formato — WhatsApp
- Markdown WhatsApp (*negrito*, _itálico_)
- NUNCA tabelas ascii — use frases naturais
- Não invente números que não estão nos dados

# Regras de saída
- ${slot === 'noite' ? 'PERMITIDO fazer 1 pergunta no item 4 (cuidado/oferta de ajuda)' : 'PROIBIDO fazer perguntas'}
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
      // dadosTxt: só do expert dele (não compara com outros)
      const dadosTxt = `Dados do expert ${expert}:\n` +
        `\nDIÁRIO ONTEM: ${JSON.stringify(dados.diario_ontem)}` +
        `\nPARCIAL HOJE: ${JSON.stringify(dados.parcial_hoje)}` +
        `\nSEMANAL 7d: ${JSON.stringify(dados.semanal_7d)}`;

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
