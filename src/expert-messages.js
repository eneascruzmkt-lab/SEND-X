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
  };
}

async function coletarDadosExpert(expert, userId = 1) {
  const { executeMonitorgrupoTool } = require('./monitorgrupo-tools');
  const ig = require('./instagram-tools');

  // Janelas pra atividade IG do DB
  const now = new Date();
  const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
  const startYesterday = new Date(startToday); startYesterday.setDate(startYesterday.getDate() - 1);
  const endYesterday = new Date(startToday); endYesterday.setMilliseconds(-1);

  const [ontem, hoje, gruposOntem, gruposHoje, igOntem, igHoje, igAtivOntem, igAtivHoje] = await Promise.all([
    executeFunilTool('get_funil_expert', { expert, periodo: 'ontem' }, userId).catch(() => null),
    executeFunilTool('get_funil_expert', { expert, periodo: 'hoje' }, userId).catch(() => null),
    executeMonitorgrupoTool('get_engajamento_por_grupo', { expert, periodo: 'ontem' }).catch(() => null),
    executeMonitorgrupoTool('get_engajamento_por_grupo', { expert, periodo: 'hoje' }).catch(() => null),
    ig.getInstagramMetrics(userId, expert, 'ontem').catch(() => null),
    ig.getInstagramMetrics(userId, expert, 'hoje').catch(() => null),
    db.getInstagramAtividadeFromDB(userId, expert, startYesterday, endYesterday).catch(() => null),
    db.getInstagramAtividadeFromDB(userId, expert, startToday, now).catch(() => null),
  ]);

  // Resumir grupos por slot (lista de cada grupo com suas métricas)
  function resumirGrupos(g) {
    if (!g || !g.grupos) return null;
    return g.grupos.map(x => ({
      nome: x.nome,
      total_membros: x.total_membros,
      ativos: x.ativos,
      mensagens: x.total_mensagens,
      novos_membros: x.novos_membros,
      saidas: x.saidas,
      saldo: x.saldo,
    }));
  }
  function resumirIg(i) {
    if (!i || i.error) return null;
    return {
      seguidores_atual: i.seguidores_atual,
      novos_seguidores: i.novos_seguidores_periodo,
      unfollows: i.unfollows_periodo,
      saldo: i.saldo_seguidores_periodo,
    };
  }
  function resumirIgAtividade(a) {
    if (!a) return null;
    return {
      stories_postados: a.stories?.length || 0,
      posts_publicados: a.posts?.length || 0,
      total_comentarios: a.total_comments || 0,
      autores_unicos_comentaram: a.autores_unicos_comments || 0,
      posts: (a.posts || []).slice(0, 5).map(p => ({
        legenda: (p.caption || '').slice(0, 200),
        likes: p.like_count, comentarios: p.comments_count,
      })),
      top_comentarios: (a.top_comments || []).slice(0, 8).map(c => ({
        autor: c.autor_username, texto: (c.texto || '').slice(0, 200),
      })),
      dms_recentes: (a.dms_recentes || []).slice(0, 5).map(d => ({
        ultima_msg: (d.last_msg_text || '').slice(0, 150),
      })),
    };
  }

  return {
    diario_ontem: {
      ...resumirParaExpert(ontem),
      grupos_whatsapp: resumirGrupos(gruposOntem),
      instagram: resumirIg(igOntem),
      instagram_atividade: resumirIgAtividade(igAtivOntem),
    },
    parcial_hoje: {
      ...resumirParaExpert(hoje),
      grupos_whatsapp: resumirGrupos(gruposHoje),
      instagram: resumirIg(igHoje),
      instagram_atividade: resumirIgAtividade(igAtivHoje),
    },
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
- "resultado": cadastros, novos_jogadores_depositaram (FTDs), valor_total_depositado, valor_primeiro_deposito
- "lives": como foram (quantas, pico, assistiram, msgs chat)
- "grupos_whatsapp": LISTA — UM ITEM POR GRUPO. Cada item tem nome, total_membros, ativos, mensagens, novos_membros, saidas, saldo. SEMPRE comente CADA GRUPO SEPARADAMENTE (alguns experts têm múltiplos grupos com leads sobrepostos).
- "instagram": seguidores_atual, novos_seguidores, unfollows, saldo (entradas - saídas)

Linguagem natural:
- "novos_jogadores_depositaram" → "X pessoas novas depositaram pela primeira vez"
- "valor_total_depositado" → "R$ Y em depósitos no total"
- "cadastros" → "X pessoas se cadastraram"
- "instagram.novos_seguidores" → "X pessoas novas te seguiram"
- "instagram.unfollows" → "Y pessoas deixaram de te seguir"
- "instagram.saldo" → "saldo de Z seguidores" (positivo=ganho líquido)
- grupos_whatsapp: SEMPRE mencione cada grupo pelo NOME e seu movimento separado.

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
2. *Resumo COMPLETO de ONTEM com TODOS os números* (4-5 frases):
   - *Resultado*: cadastros, novos depositantes, R$ depositados
   - *Lives*: quantas, pico, assistiram, msgs chat
   - *Instagram*: X pessoas novas te seguiram, Y deixaram de seguir, saldo Z
   - *Grupos WhatsApp* (CADA GRUPO SEPARADAMENTE pelo NOME): pra cada grupo, mencione o nome e o movimento dele (quantas pessoas ativas, quantas msgs, quantas entraram, quantas saíram)
3. *3 sugestões de CONTEÚDO pra hoje* — frases imperativas (Grava/Posta/Faz/Manda) com TEMA específico.
4. Fechamento motivacional curto

Tamanho: 1200-1700 caracteres.`,

    tarde: `# Slot TARDE — ${expertName}, como tá indo?
ESTRUTURA OBRIGATÓRIA:
1. *Saudação rápida* ("E aí, ${expertName}! 🔥" ou similar)
2. *Comparação HOJE até agora vs ONTEM dia inteiro com TODOS os números*:
   - Resultado: cadastros e depositantes hoje vs ontem, R$ depositados
   - Lives: hoje vs ontem (qtd, pico, msgs chat)
   - Instagram: seguidores ganhos hoje vs ontem
   - Grupos WhatsApp: CADA GRUPO pelo nome, comparando hoje vs ontem (ex: "No COMUNIDADE DA RAINHA: 15 ativos hoje (ontem 23), no DANI - RAINHA DA ROLETA 22 ativos (ontem 18)")
3. *Reforço de 1-2 sugestões da manhã* — perguntas tipo "já gravou aquele reel?"
4. *1 sugestão extra de conteúdo pra fazer agora* — ação curta
5. Energia pra fechar o dia

Tamanho: 1100-1500 caracteres.`,

    noite: `# Slot NOITE — ${expertName}, fechando o dia
ESTRUTURA OBRIGATÓRIA:
1. *Saudação noturna* ("Boa noite, ${expertName} 🌙" ou similar)
2. *Resumo numérico do DIA COMPLETO* com TODOS os números:
   - Resultado: cadastros, novos depositantes, R$ depositados
   - Lives: quantas, pico, msgs chat
   - Instagram: novos seguidores - unfollows = saldo
   - Grupos WhatsApp: CADA GRUPO pelo nome com seu movimento (ativos, msgs, entradas, saídas)
3. *Reconhecimento sincero* — destaca o melhor momento real do dia
4. *Checagem das sugestões da manhã* — "conseguiu gravar aquele reel?", "rolou a live?"
5. *Pergunta de cuidado*: "Tem alguma coisa que tá faltando pra te deixar mais tranquilo amanhã?"
6. Boa noite com afeto

Tamanho: 1100-1500 caracteres.`,
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
