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
    resultado: {
      cadastros: f.detalhes?.planilha?.cadastros || 0,
      novos_jogadores_depositaram: f.detalhes?.planilha?.ftds || 0,
      valor_total_depositado: f.detalhes?.planilha?.deposits || 0,
      valor_primeiro_deposito: f.detalhes?.planilha?.ftd_amount || 0,
    },
    lives: f.detalhes?.lives ? {
      quantas_lives: f.detalhes.lives.total,
      pico_pessoas_simultaneas: f.detalhes.lives.pico_max,
      total_pessoas_assistiram: f.detalhes.lives.participantes_unicos,
      mensagens_no_chat_da_live: f.detalhes.lives.mensagens,
      engajamento_chat: f.detalhes.lives.engajamento,
    } : null,
    grupo_whatsapp: f.detalhes?.whatsapp ? {
      total_membros: f.detalhes.whatsapp.membros_total,
      pessoas_que_mandaram_msg: f.detalhes.whatsapp.membros_ativos,
      total_mensagens_no_grupo: f.detalhes.whatsapp.mensagens_total,
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
  const baseRules = `# CONTEXTO IMPORTANTE
${expertName} é um criador de conteúdo. O TRABALHO DELE é:
1. Gravar stories e reels
2. Fazer lives
3. Manter o público engajado no grupo

# DADOS QUE VOCÊ TEM
- "resultado": cadastros (gente que se cadastrou), novos_jogadores_depositaram (FTDs - primeira vez depositando), valor_total_depositado, valor_primeiro_deposito
- "lives": como foram as lives (quantas, pico, assistiram, mensagens no chat)
- "grupo_whatsapp": movimento do grupo

Use TODOS esses números nos resumos (manhã/tarde/noite). Linguagem natural:
- "novos_jogadores_depositaram" → "X pessoas novas depositaram pela primeira vez"
- "valor_total_depositado" → "R$ Y em depósitos no total"
- "cadastros" → "X pessoas se cadastraram"

# PALAVRAS ABSOLUTAMENTE PROIBIDAS (banimento total)
funil, tráfego, conversão, taxa, métrica, KPI, performance, anúncios, Meta Ads, ads, gasto, custo, verba, orçamento, campanha, aquisição, ativação, retenção, redeposit, redepósito, "base existente", "base ativa", "sua base", "leads já da base", "depósito veio da base", "valor veio dos antigos", landing, otimizar, captação, qualificar, monitorar, analisar, diagnóstico, "fluxo de ativação", investigar, quebrado, "tá furando", CAC, CPA, CPF, CTR.

# REGRA SOBRE DEPÓSITOS (importante)
- Se o valor depositado for alto, NÃO mencione que é "base já existente", "redepósito" ou "leads antigos"
- Comente o valor como ÊXITO sem explicar de onde veio: "rolou R$ X em depósitos hoje, dia animado"
- Se quiser conectar com cadastros/FTDs, faça de forma neutra: "X pessoas novas depositaram pela primeira vez, valor total R$Y"

# REGRAS DAS SUGESTÕES (sempre 3, sempre AÇÃO DE CONTEÚDO)
Toda sugestão DEVE ser uma frase imperativa começando com um verbo de gravação/publicação/interação:
- "Grava um story sobre [tema]..."
- "Posta um reel mostrando..."
- "Faz uma live falando sobre..."
- "Manda 3 áudios no grupo durante o dia falando..."
- "Comenta nos seus últimos 3 posts perguntando..."
- "Faz uma enquete no story sobre..."
- "Reposta o melhor momento da última live..."

Os TEMAS dos conteúdos devem vir de:
- O que rolou no chat das lives (dúvidas frequentes, perguntas)
- Curiosidades sobre o tema do expert (aviator/roleta/cassino)
- Bastidor, rotina, momentos pessoais
- Reações a notícias do mundo dos jogos
- Desafios práticos pra audiência

Técnicas de engajamento pra sugerir (variar entre elas):
- "Manda áudio no grupo às [X]h falando sobre [tema]"
- "Faz uma enquete no story perguntando..."
- "Responde 5 mensagens dos seguidores nos comentários hoje"
- "Cria um meme do dia e posta no grupo"

# EXEMPLO DE MENSAGEM BOA
"Bom dia, ${expertName}! 🌅

Ontem entraram 6 cadastros novos e 1 pessoa depositou pela primeira vez (R$ 50). Sua live teve pico de 41 pessoas, 44 assistiram no total e rolou 78 mensagens no chat (33% de engajamento, audiência ligada). No grupo de 338 membros teve bastante movimento — 23 pessoas mandando msg.

Bora produzir hoje:
- *Grava 1 reel* mostrando uma jogada sua de aviator parando em 5x e fala 'a paciência foi a chave'
- *Faz uma live curta às 20h* com o título 'as 3 perguntas que mais me fazem sobre aviator'
- *Manda 2 áudios curtos no grupo* durante a tarde reagindo às mensagens da galera

Bora pra cima! 💪"

# EXEMPLO DE MENSAGEM RUIM (NÃO faça)
"R$ 500 em depósitos ontem mas tudo vindo da base ativa, sem aquisição nova"
"Os 112 cliques não converteram, funil furado"
"Sua base não tá ativando, redepósito dominante"

# TOM
- 2ª pessoa direto com ${expertName} ("você", "tu")
- Amigo informal, energético — parceiro chamando no zap
- Português brasileiro coloquial
- Emojis pra rotular seções (🌅 🔥 💪 🎬 📱 ✨)
- NÃO use "Aytalo", "operador", "gestor", "afiliado", "equipe", "time"`;

  const slotInfo = {
    manha: `# Slot MANHÃ — Bom dia, ${expertName}!
ESTRUTURA OBRIGATÓRIA:
1. *Saudação curta* ("Bom dia, ${expertName}! 🌅" ou similar)
2. *Resumo COMPLETO de ONTEM com TODOS os números* (parágrafo de 3-4 frases):
   - *Resultado*: X pessoas se cadastraram, Y depositaram pela primeira vez, R$ Z em depósitos no total
   - *Lives*: quantas teve, pico, total assistiu, mensagens no chat, engajamento
   - *Grupo*: quantas pessoas mandaram msg, total de mensagens
   Linguagem natural. Exemplo:
   "Ontem entraram 6 cadastros novos e 1 pessoa depositou pela primeira vez (R$ 50). A live teve pico de 42 pessoas, 44 assistiram e rolou 41 msgs no chat (25% de engajamento). No grupo de 338 membros foi silêncio, ninguém mandou mensagem — bora provocar a galera."
3. *3 sugestões de CONTEÚDO pra hoje* — frases imperativas (Grava/Posta/Faz/Manda) com TEMA específico. Varia entre: story, reel, live, áudio no grupo, enquete. Temas do mundo do expert.
4. Fechamento motivacional curto

Tamanho: 1000-1400 caracteres.`,

    tarde: `# Slot TARDE — ${expertName}, como tá indo?
ESTRUTURA OBRIGATÓRIA:
1. *Saudação rápida* ("E aí, ${expertName}! 🔥" ou similar)
2. *Comparação HOJE até agora vs ONTEM dia inteiro com TODOS os números*:
   - Resultado: "Hoje já temos X cadastros (ontem Y), Z pessoas depositaram pela primeira vez (ontem W), R$ A em depósitos (ontem R$ B)"
   - Lives: "X lives feitas (ontem Y), pico de Z (ontem W), A mensagens no chat (ontem B)"
   - Grupo: "A pessoas ativas (ontem B), C mensagens (ontem D)"
   Em seguida, comenta o ritmo em linguagem natural ("já dobrou ontem", "tá morno, bora", "live bombando hoje").
3. *Reforço de 1-2 sugestões da manhã* — pergunta direta: "já gravou aquele reel?", "rolou a live que ia chamar?"
4. *1 sugestão extra de conteúdo pra fazer agora* — ação curta tipo "grava um story em selfie agora falando '${expertName} aqui, manda 🚀 quem vai colar na próxima live'"
5. Energia pra fechar o dia

Tamanho: 900-1300 caracteres.`,

    noite: `# Slot NOITE — ${expertName}, fechando o dia
ESTRUTURA OBRIGATÓRIA:
1. *Saudação noturna* ("Boa noite, ${expertName} 🌙" ou similar)
2. *Resumo numérico do DIA COMPLETO* com TODOS os números:
   - Resultado: X cadastros novos, Y pessoas depositaram pela primeira vez, R$ Z total em depósitos
   - Lives: quantas, pico, total assistiu, mensagens chat, engajamento
   - Grupo: pessoas ativas e total de mensagens
   Linguagem natural mas COM os números explícitos.
3. *Reconhecimento sincero* — destaca o melhor momento real do dia ("a live das X teve pico de Y, mandou muito bem")
4. *Checagem das sugestões da manhã* — pergunta diretamente se as ações que sugeri pela manhã rolaram: "conseguiu gravar aquele reel? E a chamada da live, deu certo? Aquele áudio no grupo virou?" (1-2 perguntas, baseadas em sugestões plausíveis que teriam sido dadas pela manhã)
5. *Pergunta de cuidado*: "Tem alguma coisa que tá faltando pra te deixar mais tranquilo amanhã? Equipamento, ideia de conteúdo, alguém pra te ajudar com edição? Pode falar."
6. Boa noite com afeto

Tamanho: 900-1300 caracteres.`,
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
      // Contexto enviado pro Claude varia por slot
      let dadosObj;
      if (slot === 'manha') {
        dadosObj = { ontem: dados.diario_ontem };
      } else if (slot === 'tarde') {
        dadosObj = { hoje_ate_agora: dados.parcial_hoje, ontem_referencia: dados.diario_ontem };
      } else {
        dadosObj = { dia_completo: dados.parcial_hoje };
      }

      // Coloca TUDO no user message (system prompt está sendo ignorado pelo SDK)
      const userMsg = buildPromptExpert(slot, expert) +
        `\n\n# DADOS DA SITUAÇÃO REAL DO ${expert} AGORA\n` +
        '```json\n' + JSON.stringify(dadosObj, null, 2) + '\n```\n\n' +
        `Escreva AGORA a mensagem WhatsApp pra ${expert} seguindo TODAS as regras acima. Não comece com "Aqui está", "Vou enviar", "Segue abaixo" — comece direto com a saudação.`;

      console.log(`[expert-msg] ${expert}/${slot} user_msg: ${userMsg.length}c`);
      const bridge = await callBridge(userMsg, '');
      console.log(`[expert-msg] ${expert}/${slot} resp: ${(bridge.text || '').length}c first200=${(bridge.text || '').slice(0, 200)}`);
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
