/**
 * AI Advisor — agente de recomendações de negócio.
 *
 * Fluxo:
 *  1. Coleta funil consolidado de cada expert (7d + 30d) via executeFunilTool
 *  2. Monta prompt estruturado pedindo JSON com top 5 ações
 *  3. Chama o bridge (Claude no Mac via assinatura Max)
 *  4. Parseia JSON da resposta
 *  5. Persiste em ai_recommendations
 *  6. Mede outcome 7 dias após "aplicado" comparando FTD/Net P&L
 */

const db = require('./db');
const { executeFunilTool } = require('./funil-tools');
const { executeTool } = require('./insights-tools');

const EXPERTS_DEFAULT = ['DANI', 'DEIVID', 'JUH'];

// Comissão (revshare) do operador sobre o Net P&L de cada expert.
// ⚠️ USO ESTRITAMENTE INTERNO — só entra no briefing matinal do operador
// (AI Advisor → AI_ADVISOR_PHONE). NUNCA pode aparecer nas mensagens dos
// experts. expert-messages.js NÃO importa isto e não deve importar.
const OPERATOR_PROFIT_SHARES = { JUH: 0.10, DEIVID: 0.18, DANI: 0.05 };

// Calcula o lucro do operador (share × net_pl de ONTEM) por expert + total.
// Computado em JS (não no LLM) pra garantir aritmética correta.
function calcularLucroOperador(dados) {
  const linhas = [];
  let total = 0;
  for (const [expert, d] of Object.entries(dados.experts || {})) {
    if (d.error || !d.diario_ontem) continue;
    const share = OPERATOR_PROFIT_SHARES[expert.toUpperCase()];
    if (share === undefined) continue;
    const netpl = Number(d.diario_ontem.net_pl || 0);
    const lucro = Math.round(netpl * share * 100) / 100;
    total += lucro;
    linhas.push({ expert, net_pl: netpl, share, lucro });
  }
  return { linhas, total: Math.round(total * 100) / 100 };
}

function buildSystemPrompt(slot) {
  const slotInfo = {
    manha: `# Slot: MANHÃ (08:00 BRT)
Foco: relatório de FECHAMENTO de ontem + PLANO de hoje.
- Use prioritariamente diario_ontem (planilha — dados reais da Apostatudo backoffice, não o postback que pode ter falhas)
- Resuma o que aconteceu ontem (gasto, FTDs planilha, Net P&L, ROI)
- Recomendações DE HOJE: o que fazer hoje pra reverter problemas ou capitalizar acertos de ontem
- Distribuição: 3 acoes hoje + 1 esta semana + 1 este mês`,
    tarde: `# Slot: TARDE (15:00 BRT)
Foco: performance até agora + ajustes pra resto do dia.
- Use semanal_7d + diario_ontem como referência
- Recomendações: ajustes finos pra final do dia, pausas urgentes, escalas
- Distribuição: 2 hoje + 2 esta semana + 1 este mês`,
    madrugada: `# Slot: MADRUGADA (00:00 BRT)
Foco: fechamento do dia que acabou + setup pra amanhã.
- Use diario_ontem (que é o dia que acabou) + tendências 7d
- Recomendações: o que preparar/agendar pra amanhã (criativos, disparos, lives)
- Distribuição: 2 esta semana + 2 hoje (=amanhã) + 1 este mês`,
  }[slot] || `# Foco geral\nDistribuição: 2 hoje + 2 esta_semana + 1 este_mes`;

  return `Você é um analista sênior de marketing digital especializado em iGaming/afiliados, gerando o relatório do slot atual para o operador.

${slotInfo}

# Dados que você recebe (3 horizontes por expert)
- diario_ontem: o dia anterior (FONTE OFICIAL = planilha. ftds_planilha é mais confiável que ftds_postback porque postbacks podem perder eventos)
- semanal_7d: últimos 7 dias (tendências de curto prazo)
- mensal_30d: últimos 30 dias (estrutura, sazonalidade)

# REGRA DE OURO
SEMPRE prefira métricas da planilha (ftds_planilha, gasto_meta, net_pl) sobre as do postback. Use postback apenas pra validar UTMs ou detectar divergências (que vire alerta).

# Formato da resposta
Retorne APENAS o JSON abaixo. Zero markdown. Zero texto antes ou depois. NUNCA faça perguntas. NUNCA peça confirmação. NUNCA escreva "deseja", "quer que eu", "posso", "se preferir".

{
  "fechamento_ontem": {
    "destaque": "1-2 frases sobre o que aconteceu ontem (use números da planilha)",
    "alerta": "se algo grave ontem (P&L negativo, gasto sem FTD), aponta aqui",
    "vitorias": ["o que funcionou (com números)"]
  },
  "plano_hoje": {
    "prioridades": ["3 ações concretas pra fazer HOJE (com números/horários)"],
    "foco_expert": "qual expert merece mais atenção hoje e por quê"
  },
  "recomendacoes": [
    {
      "expert": "DANI | DEIVID | JUH | NUCLEAR | GERAL",
      "categoria": "meta_ads | telegram | whatsapp | lives | copy | operacional | apostatudo",
      "urgencia": "hoje | esta_semana | este_mes",
      "acao": "ação concreta na 2ª pessoa, ex: 'Pause o adset X que gastou R$Y sem FTD' (max 140c)",
      "justificativa": "razão com números reais (max 280c)",
      "impacto_estimado": "+X FTDs/sem ou +R$Y/mês ou -Z% custo/FTD",
      "passos": ["passo 1 concreto", "passo 2", "passo 3"]
    }
  ]
}

# Regras finais
- 5 recomendações totais, ordenadas por impacto
- Use número específico em CADA recomendação (sem "considere", "talvez", "veja")
- Apenas o JSON. Sem perguntas. Sem disclaimers. Sem markdown.`;
}

const SYSTEM_PROMPT = buildSystemPrompt(); // backward compat (sem slot)

async function coletarDados(userId = 1, experts = EXPERTS_DEFAULT) {
  const data = { gerado_em: new Date().toISOString(), experts: {} };
  for (const expert of experts) {
    try {
      const [funilOntem, funil7d, funil30d] = await Promise.all([
        executeFunilTool('get_funil_expert', { expert, periodo: 'ontem' }, userId),
        executeFunilTool('get_funil_expert', { expert, periodo: '7d' }, userId),
        executeFunilTool('get_funil_expert', { expert, periodo: '30d' }, userId),
      ]);
      data.experts[expert] = {
        diario_ontem: resumirFunil(funilOntem),
        semanal_7d: resumirFunil(funil7d),
        mensal_30d: resumirFunil(funil30d),
      };
    } catch (e) {
      data.experts[expert] = { error: e.message };
    }
  }
  return data;
}

function resumirFunil(f) {
  if (!f) return null;
  // FTDs vem APENAS da planilha (fonte oficial). Postback fica fora do contexto da IA.
  const ftds = f.detalhes?.planilha?.ftds || 0;
  const gasto = f.detalhes?.planilha?.gasto || 0;
  return {
    periodo: f.periodo,
    gasto_meta: gasto,
    cliques: f.detalhes?.planilha?.cliques || 0,
    cadastros: f.detalhes?.planilha?.cadastros || 0,
    telegram_joins: f.detalhes?.planilha?.telegram_joins || 0,
    ftds, // <- fonte única: planilha
    ftd_amount: f.detalhes?.planilha?.ftd_amount || 0,
    deposits_amount: f.detalhes?.planilha?.deposits || 0,
    net_pl: f.net_pl,
    roi: f.roi,
    custo_por_ftd: ftds > 0 && gasto > 0 ? Math.round((gasto / ftds) * 100) / 100 : null,
    custo_por_clique: f.detalhes?.planilha?.gasto && f.detalhes?.planilha?.cliques
      ? Math.round((f.detalhes.planilha.gasto / f.detalhes.planilha.cliques) * 100) / 100 : null,
    whatsapp: f.detalhes?.whatsapp || null,
    lives: f.detalhes?.lives || null,
    // alertas filtrados: removemos os de postback (não-aplicáveis dado o foco em planilha)
    alertas: (f.alertas || []).filter(a =>
      !/postback/i.test(a) && !/divergência na coleta/i.test(a)
    ),
  };
}

async function callBridge(userMessage, additionalSystem) {
  // Prioridade: DB (atualizado em tempo real pelo start.sh) → env var fallback
  const url = (await db.getBridgeRegistry().catch(() => null))?.url || process.env.BRIDGE_URL;
  const secret = process.env.BRIDGE_SECRET;
  if (!url || !secret) throw new Error('Bridge não configurada (BRIDGE_URL/SECRET ausentes)');

  const resp = await fetch(`${url}/chat`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secret}`,
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': '1',
    },
    body: JSON.stringify({ message: userMessage, additional_system: additionalSystem, mode: 'task' }),
  });
  if (!resp.ok) throw new Error(`Bridge ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

function extractJson(text) {
  // Tenta achar JSON dentro de qualquer texto que o Claude retornar
  if (!text) return null;
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); }
  catch { return null; }
}

async function gerarRecomendacoes(userId = 1, experts = EXPERTS_DEFAULT, slot = '') {
  const dados = await coletarDados(userId, experts);
  const dadosTxt = Object.entries(dados.experts).map(([exp, d]) => {
    if (d.error) return `### ${exp}\nERRO: ${d.error}`;
    return `### ${exp}\nDIÁRIO (ontem): ${JSON.stringify(d.diario_ontem)}\n` +
           `SEMANAL (7d): ${JSON.stringify(d.semanal_7d)}\n` +
           `MENSAL (30d): ${JSON.stringify(d.mensal_30d)}`;
  }).join('\n\n');

  const userMsg = dadosTxt;
  const systemPrompt = buildSystemPrompt(slot);
  const bridgeResp = await callBridge(userMsg, systemPrompt);
  const parsed = extractJson(bridgeResp.text);
  if (!parsed || !Array.isArray(parsed.recomendacoes)) {
    throw new Error('Resposta do bridge não veio em JSON válido. text=' + (bridgeResp.text || '').slice(0, 400));
  }

  // Persiste cada recomendação — aceita variações de nome de campo
  const inserted = [];
  for (const rec of parsed.recomendacoes) {
    try {
      // Normaliza campos (Claude pode usar sinônimos)
      const acao = rec.acao || rec.action || rec.titulo || rec.title || '(sem ação)';
      const urgencia = (rec.urgencia || rec.urgency || rec.prioridade || rec.priority || 'esta_semana').toLowerCase();
      const urgNorm = urgencia.includes('hoje') || urgencia === 'urgent' ? 'hoje'
        : urgencia.includes('semana') || urgencia === 'high' ? 'esta_semana'
        : urgencia.includes('mes') || urgencia.includes('mês') || urgencia === 'medium' ? 'este_mes'
        : 'esta_semana';
      const justif = rec.justificativa || rec.justification || rec.razao || rec.reason || rec.por_que || rec.why || '';
      const impacto = rec.impacto_estimado || rec.impacto || rec.impact || rec.estimated_impact || '';
      let passos = rec.passos || rec.passos_concretos || rec.steps || rec.how || rec.como || rec.como_fazer || [];
      if (typeof passos === 'string') passos = passos.split(/\n|;/).map(s => s.trim()).filter(Boolean);
      if (!Array.isArray(passos)) passos = [String(passos)];

      const row = await db.insertRecommendation({
        user_id: userId,
        expert: rec.expert || rec.target || 'GERAL',
        categoria: rec.categoria || rec.category || rec.tipo || rec.type,
        urgencia: urgNorm,
        acao,
        justificativa: justif,
        impacto_estimado: impacto,
        passos,
        raw_data_snapshot: dados,
      });
      inserted.push(row);
    } catch (e) { console.error('[ai-advisor] insert falhou:', e.message); }
  }
  return inserted;
}

/**
 * Pra cada recomendação status='aplicado' há 7+ dias e sem outcome ainda,
 * mede delta de FTDs e Net P&L vs 7 dias anteriores ao "aplicado".
 */
async function medirOutcomesAtrasados(userId = 1) {
  const pending = await db.query(
    `SELECT * FROM ai_recommendations
     WHERE user_id=$1 AND status='aplicado' AND outcome_measured_at IS NULL
       AND status_at < NOW() - INTERVAL '7 days'
     LIMIT 50`,
    [userId]
  );
  const results = [];
  for (const r of pending) {
    try {
      if (!r.expert || r.expert === 'GERAL') continue;
      const apliedAt = new Date(r.status_at);
      const before = await executeTool('get_metricas_expert', {
        expert: r.expert, periodo: 'custom',
        de: fmtBR(new Date(apliedAt.getTime() - 7 * 86_400_000)),
        ate: fmtBR(new Date(apliedAt.getTime() - 1)),
        comparar: false,
      }, userId);
      const after = await executeTool('get_metricas_expert', {
        expert: r.expert, periodo: 'custom',
        de: fmtBR(apliedAt),
        ate: fmtBR(new Date(apliedAt.getTime() + 7 * 86_400_000)),
        comparar: false,
      }, userId);
      const ftdsDelta = (after.ftds || 0) - (before.ftds || 0);
      const netplDelta = (after.netPL || 0) - (before.netPL || 0);
      // Score: 1=positivo, 0=neutro, -1=negativo (com peso pelo magnitude)
      let score = 0;
      if (ftdsDelta > 0 && netplDelta > 0) score = 1;
      else if (ftdsDelta < 0 || netplDelta < 0) score = -1;
      await db.updateRecommendationOutcome(r.id, { ftds_delta: ftdsDelta, netpl_delta: netplDelta, score });
      results.push({ id: r.id, expert: r.expert, ftds_delta: ftdsDelta, netpl_delta: netplDelta, score });
    } catch (e) { results.push({ id: r.id, error: e.message }); }
  }
  return results;
}

function fmtBR(d) {
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth()+1)}/${d.getFullYear()}`;
}

async function notificarTop3(userId = 1, slot = '') {
  const pending = await db.listRecommendations(userId, { status: 'pendente', limit: 3 });
  if (pending.length === 0) return { sent: false, reason: 'sem recomendações pendentes' };

  const slotLabel = { manha: '☀️ MANHÃ', tarde: '🌇 TARDE', madrugada: '🌙 FECHAMENTO' }[slot] || '🧠';
  const text =
    `${slotLabel} *— Recomendações IA*\n` +
    `📅 ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })}\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    pending.map((r, i) => {
      const emoji = r.urgencia === 'hoje' ? '🚨' : r.urgencia === 'esta_semana' ? '⚡' : '📅';
      return `${emoji} *${i + 1}. ${r.expert}* (${r.categoria || '-'})\n` +
             `${r.acao}\n` +
             `_${r.justificativa}_\n` +
             `📈 ${r.impacto_estimado}\n` +
             `→ https://send-x-production.up.railway.app/ aba AI Advisor`;
    }).join('\n\n');

  // Envia via Evolution (precisa REPORT_INSTANCE + REPORT_PHONE configurados)
  const phone = process.env.AI_ADVISOR_PHONE;
  const instance = process.env.AI_ADVISOR_INSTANCE || process.env.REPORT_INSTANCE;
  const evoUrl = process.env.EVOLUTION_API_URL;
  const evoKey = process.env.EVOLUTION_API_KEY;
  if (!phone || !instance || !evoUrl || !evoKey) {
    return { sent: false, reason: 'AI_ADVISOR_PHONE/INSTANCE ou EVOLUTION_* não configurados', preview: text.slice(0, 200) };
  }
  try {
    const resp = await fetch(`${evoUrl}/message/sendText/${instance}`, {
      method: 'POST',
      headers: { apikey: evoKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: phone, text }),
    });
    if (!resp.ok) throw new Error(`Evolution ${resp.status}: ${await resp.text()}`);
    return { sent: true, phone, recommendations: pending.length };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

// ─── Relatório WhatsApp direto (markdown, sem JSON estruturado) ───────────

function buildRelatorioPrompt(slot) {
  const slotInfo = {
    manha: `# Slot MANHÃ (08:00 BRT) — BRIEFING DO DIA
Você está enviando o briefing matinal pelo WhatsApp para o operador (Aytalo).

⚠️ REGRA INVIOLÁVEL DE AGREGAÇÃO:
- Os resultados de cada expert (DANI, DEIVID, JUH) são OPERAÇÕES SEPARADAS, com ad accounts e financeiros distintos.
- NUNCA some FTDs, gasto, Net P&L, depósitos entre experts.
- NUNCA crie linha "Total" / "Consolidado" / "Geral" de métricas operacionais.
- A ÚNICA soma permitida é o *TOTAL do lucro do operador* (item 2 abaixo), porque ali é a comissão dele.

CONTEÚDO OBRIGATÓRIO (nessa ordem):
1. *Fechamento de ONTEM — por expert* — uma linha por expert ativo com: FTDs, Gasto Meta, Net P&L, ROI. NADA de linha consolidada.
2. *💰 Seu lucro de ONTEM* — use o bloco "LUCRO DO OPERADOR (INTERNO)" que já vem CALCULADO nos dados. Mostre o lucro por expert (ex: "JUH: R$ X") e o *TOTAL* (só esse total é permitido, pois é a comissão do operador). NÃO recalcule, use os números prontos. Essa info é CONFIDENCIAL do operador — ela já está nos dados só porque é o briefing interno dele.
3. *3 ações pra HOJE* (concretas, com expert/quantidade/horário se possível)
4. *Sugestões de conteúdo pra HOJE* (1 story por expert ativo + 1 reel pro expert que mais precisa)
5. *Alerta* se P&L de algum expert ontem foi negativo ou houver problema crítico`,
    tarde: `# Slot TARDE (15:00 BRT) — CHECK-IN
1. *Performance até agora vs ontem* (mesma hora aproximada)
2. *2 ajustes pra final do dia* (pausar/escalar adsets)
3. *Lives previstas hoje à noite* — preparação`,
    madrugada: `# Slot MADRUGADA (00:00 BRT) — FECHAMENTO + SETUP
1. *Resumo do dia que acabou* (gasto, FTDs planilha, Net P&L por expert)
2. *2 preparações pra amanhã* (criativos, disparos)
3. *Top destaque positivo do dia*`,
  }[slot] || `Briefing operacional: resumo + 3 ações.`;

  return `Você é um analista sênior de marketing iGaming gerando briefing operacional via WhatsApp pro operador Aytalo.

${slotInfo}

# FONTE DE DADOS — REGRA INVIOLÁVEL
- O campo *ftds* é a FONTE OFICIAL DE FTDs (vem da planilha/Backoffice Apostatudo)
- NÃO mencione "postback", "FTDs reais", "FTDs reais vs planilha", divergências de fonte
- Net P&L já considera FTDs e depósitos da planilha — confie nele
- ftd_amount e deposits_amount complementam o valor monetário
- *Cada expert é uma operação financeira separada* — não há totais consolidados de FTDs/gasto/P&L entre experts. Só o lucro do operador é somado (comissão dele).

# Formato — WhatsApp
- Markdown que renderiza no WhatsApp (*negrito*, _itálico_)
- Emojis pra rotular (📊 🎯 🚨 💡 🎬 📈 📉)
- Direto e prático, fala com Aytalo
- Números específicos dos dados (R$, FTDs, %)
- Sem tabela ascii pesada, sem listas aninhadas profundas
- Tamanho ideal: 800-1500 caracteres

# Regras absolutas
- NUNCA faça perguntas (sem "quer que", "deseja", "posso", "se preferir", "?")
- NUNCA peça confirmação ou ofereça salvar/comparar/enviar
- NUNCA escreva disclaimers ("analisei os dados", "espero que ajude")
- NUNCA mencione postback, divergência de dados ou fontes secundárias
- Comece direto, ex: "📊 *Briefing — 20/05*"
- Termine na última recomendação. Sem despedida.`;
}

function stripPerguntas(text) {
  if (!text) return '';
  const banned = /^(quer que|deseja|posso|se você|se preferir|caso queira|posso te ajudar|gostaria|posso salvar|me avise|fique à vontade)/i;
  return String(text)
    .split('\n')
    .filter(line => {
      const t = line.trim();
      if (!t) return true;
      if (t.endsWith('?')) return false;
      if (banned.test(t)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function gerarRelatorioWhatsapp(userId = 1, slot = 'manha', experts = EXPERTS_DEFAULT) {
  const dados = await coletarDados(userId, experts);
  let dadosTxt = Object.entries(dados.experts).map(([exp, d]) => {
    if (d.error) return `## ${exp}\nERRO: ${d.error}`;
    return `## ${exp}\nDIÁRIO ONTEM: ${JSON.stringify(d.diario_ontem)}\nSEMANAL 7d: ${JSON.stringify(d.semanal_7d)}\nMENSAL 30d: ${JSON.stringify(d.mensal_30d)}`;
  }).join('\n\n');

  // Lucro do operador — SÓ no briefing matinal (interno). Calculado em JS.
  if (slot === 'manha') {
    const lucro = calcularLucroOperador(dados);
    if (lucro.linhas.length > 0) {
      const det = lucro.linhas.map(l =>
        `- ${l.expert}: ${(l.share * 100).toFixed(0)}% de R$ ${l.net_pl.toFixed(2)} (net P&L ontem) = R$ ${l.lucro.toFixed(2)}`
      ).join('\n');
      dadosTxt += `\n\n## LUCRO DO OPERADOR (INTERNO) — JÁ CALCULADO, NÃO RECALCULE\n${det}\nTOTAL: R$ ${lucro.total.toFixed(2)}`;
    }
  }

  const bridgeResp = await callBridge(dadosTxt, buildRelatorioPrompt(slot));
  return stripPerguntas(String(bridgeResp.text || '').trim());
}

async function enviarRelatorioWhatsapp(userId = 1, slot = 'manha') {
  const phone = process.env.AI_ADVISOR_PHONE;
  const instance = process.env.AI_ADVISOR_INSTANCE || process.env.REPORT_INSTANCE;
  const evoUrl = process.env.EVOLUTION_API_URL;
  const evoKey = process.env.EVOLUTION_API_KEY;
  if (!phone || !instance || !evoUrl || !evoKey) return { sent: false, reason: 'envs Evolution/AI_ADVISOR ausentes' };

  const texto = await gerarRelatorioWhatsapp(userId, slot);
  if (!texto || texto.length < 60) return { sent: false, reason: 'relatório muito curto', preview: texto };

  try {
    const resp = await fetch(`${evoUrl}/message/sendText/${instance}`, {
      method: 'POST',
      headers: { apikey: evoKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: phone, text: texto }),
    });
    if (!resp.ok) throw new Error(`Evolution ${resp.status}: ${await resp.text()}`);
    return { sent: true, phone, slot, length: texto.length, preview: texto.slice(0, 200) };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

module.exports = {
  gerarRecomendacoes, medirOutcomesAtrasados, notificarTop3, coletarDados,
  gerarRelatorioWhatsapp, enviarRelatorioWhatsapp,
  calcularLucroOperador, OPERATOR_PROFIT_SHARES,
};
