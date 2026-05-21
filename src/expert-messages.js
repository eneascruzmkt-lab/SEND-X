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
  const baseRules = `# DADOS DISPONÍVEIS (use só como referência interna — não cite os nomes técnicos)
- "novos_jogadores" = quantas pessoas novas se cadastraram E depositaram pela primeira vez
- "depositos_totais" = valor total depositado por todos
- "cadastros" = quantas pessoas se cadastraram (sem necessariamente depositar)
- "cliques" = quantas clicaram no link
- "lives.pico_max" / "lives.participantes" / "lives.engajamento" = audiência das lives
- "whatsapp.ativos" / "whatsapp.mensagens" = movimento do grupo
- "inscritos_telegram" = entradas no canal Telegram

# PALAVRAS PROIBIDAS (não pode usar NENHUMA destas)
funil, tráfego, conversão, taxa, métrica, engagement, engajamento (como número), CAC, CPA, CPF, CTR, FTD, FTDs, KPI, performance, anúncios, Meta Ads, ads, gasto, custo, verba, orçamento, campanha, aquisição, ativação, retenção, redeposit, redepósito, "base existente", "base ativa", "sua base", "seus leads", landing, otimizar, captação, qualificar, monitorar, analisar, diagnóstico, "fluxo de ativação", "ponto positivo", "preocupante", investigar.

# JEITO DE FALAR DOS DADOS (linguagem natural, sempre)
EM VEZ DE                          USE
"X FTDs"                       →   "X pessoas novas depositaram"
"taxa de conversão"            →   nada (não fale)
"sua base não está convertendo" →  "ainda não veio gente nova depositando"
"engajamento alto na live"     →   "rolou bastante movimento no chat da live"
"funil X→Y está furando"       →   (não fale de funil. fale do que o expert FAZ pra mudar)
"redeposit dominante"          →   (não mencione)
"base ativa depositou"         →   (não mencione)

# EXEMPLO DE MENSAGEM RUIM (NÃO faça assim)
"⚠️ 100% redeposit — toda a receita veio de base existente. Zero aquisição nova ontem. Vale investigar o funil de anúncios → landing → cadastro pra entender onde os 112 cliques estão se perdendo."

# EXEMPLO DE MENSAGEM BOA (faça assim)
"Ontem teve 112 pessoas clicando no seu link mas nenhuma fez cadastro ainda. Bora mudar isso:
- Grava 1 story em selfie falando 'oh galera nova, vem se cadastrar aqui que eu vou liberar uma dica de aviator só pra quem tá entrando hoje'
- Faz um reel rapidinho mostrando uma jogada vencedora e no final convida pra entrar no grupo
- Chama uma live curta às 19h com o título 'PRIMEIRO DIA — aviator do zero pra galera nova'"

# REGRAS DAS SUGESTÕES (sempre 3, sempre AÇÃO DE CONTEÚDO)
Cada sugestão deve ser uma frase imperativa começando com um verbo de gravação/publicação:
- "Grava um story..."
- "Posta um reel..."
- "Faz uma live..."
- "Manda áudio no grupo..."
- "Comenta no seu último post..."
- "Reposta o story do [X]..."

Cada sugestão deve ter um TEMA específico (não genérico):
✅ "Grava 1 story falando sobre 'os 3 sinais que o avião vai cair antes de 2x'"
❌ "Grave conteúdo de qualidade"
❌ "Mantenha a frequência de posts"

# TOM
- 2ª pessoa direto com ${expertName} ("você", "tu" se rolar natural)
- Amigo informal, energético — tipo um parceiro que tá te chamando no zap
- Português brasileiro coloquial
- Emojis pra rotular seções (🌅 🔥 💪 🎬 📱 ✨)
- NÃO use "Aytalo", "operador", "gestor", "afiliado", "equipe", "time"`;

  const slotInfo = {
    manha: `# Slot MANHÃ — Bom dia, ${expertName}!
ESTRUTURA OBRIGATÓRIA:
1. *Saudação curta* ("Bom dia, ${expertName}! 🌅" ou similar)
2. *Como foi ONTEM* em frase natural: "Ontem foi um dia [adjetivo]. Tiveram X pessoas novas depositando, [valor] em depósitos totais. A live [se teve] teve [X] pessoas no pico". Se algo foi baixo, fale natural: "ontem foi um dia mais devagar, não veio gente nova".
3. *3 sugestões de CONTEÚDO pra hoje* — cada uma uma frase imperativa começando com verbo (Grava/Posta/Faz). Cada uma com TEMA específico baseado em algo de ontem (dúvida do chat, momento da live, ausência de cadastros, etc).
4. Fechamento motivacional curto

Tamanho: 600-1000 caracteres.`,

    tarde: `# Slot TARDE — ${expertName}, como tá o dia?
ESTRUTURA OBRIGATÓRIA:
1. *Saudação rápida* ("E aí, ${expertName}! 🔥" ou similar)
2. *Como tá o dia até agora* em frase natural: "Hoje já entraram X pessoas novas, [valor] depositados. [Comentário sobre live de hoje]." Compara com o ritmo de ontem em linguagem natural ("tá mais animado que ontem", "tá igual ontem essa hora", "tá mais devagar").
3. *Reforço das sugestões da manhã* — relembra 1-2 ações: "já gravou aquele reel falando sobre [tema]?", "se ainda não fez a live, dá tempo até 19h"
4. *1 sugestão extra de conteúdo pra final do dia* — algo curto pra ${expertName} fazer agora ("grava um story falando 'última hora da live de hoje, quem tá curtindo manda figurinha'")
5. Energia pra fechar bem

Tamanho: 500-900 caracteres.`,

    noite: `# Slot NOITE — ${expertName}, fechando o dia
ESTRUTURA OBRIGATÓRIA:
1. *Saudação noturna* ("Boa noite, ${expertName} 🌙" ou similar)
2. *Resumo do dia* em frase natural: total de pessoas novas depositando, valor de depósitos, lives que rolaram, movimento do grupo. Destaca o melhor momento.
3. *Reconhecimento sincero* — algo positivo que ${expertName} fez hoje (live, conteúdo, presença)
4. *Pergunta de cuidado*: "Tem alguma coisa que tá faltando pra te deixar mais tranquilo amanhã? Equipamento, ideia de conteúdo, alguém pra te ajudar com edição? Pode falar." (essa é a ÚNICA pergunta permitida)
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
