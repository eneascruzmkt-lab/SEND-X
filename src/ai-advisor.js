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

const SYSTEM_PROMPT = `Você é um analista sênior de marketing digital especializado em iGaming/afiliados.
Sua tarefa: analisar os dados consolidados dos experts e gerar EXATAMENTE 5 recomendações
priorizadas para aumentar Net P&L e FTDs.

VOCÊ RECEBE 3 HORIZONTES POR EXPERT:
- diario_ontem: o que aconteceu ontem (granularidade fina, picos/quedas pontuais)
- semanal_7d: últimos 7 dias (tendências de curto prazo, padrões semanais)
- mensal_30d: últimos 30 dias (visão estrutural, sazonalidade, comparação)

DISTRIBUIÇÃO IDEAL DAS 5 RECOMENDAÇÕES (não rígida, mas mire isso):
- 2 com urgencia="hoje" (acionáveis em 24h, baseadas no diário ou em alertas críticos)
- 2 com urgencia="esta_semana" (semanais, ajustes de campanha/conteúdo)
- 1 com urgencia="este_mes" (estratégica, baseada no mensal)

REGRAS DA RESPOSTA:
- Retorne APENAS um JSON válido (sem markdown, sem texto antes ou depois).
- Schema obrigatório:
{
  "recomendacoes": [
    {
      "expert": "DANI | DEIVID | JUH | NUCLEAR | GERAL",
      "categoria": "meta_ads | telegram | whatsapp | lives | copy | operacional | apostatudo",
      "urgencia": "hoje | esta_semana | este_mes",
      "acao": "descrição curta e concreta (max 120 chars)",
      "justificativa": "razão com números reais dos 3 horizontes quando relevante (max 280 chars)",
      "impacto_estimado": "+X FTDs/sem ou +R$Y/mês ou redução -Z% custo/FTD",
      "passos": ["passo 1 concreto", "passo 2", "passo 3"]
    }
    // ... 5 itens totais, ordenados por impacto estimado descendente
  ]
}
- Use os 3 horizontes pra detectar: 'ontem fugiu da média' OU 'tendência caindo há 7d' OU 'sazonal mensal'.
- Compare experts entre si quando relevante.
- Ações concretas com NÚMEROS de referência. Sem conselhos genéricos.`;

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
  return {
    periodo: f.periodo,
    gasto_meta: f.detalhes?.planilha?.gasto || 0,
    cliques: f.detalhes?.planilha?.cliques || 0,
    cadastros: f.detalhes?.planilha?.cadastros || 0,
    telegram_joins: f.detalhes?.planilha?.telegram_joins || 0,
    ftds_planilha: f.detalhes?.planilha?.ftds || 0,
    ftds_postback: f.detalhes?.postbacks_real?.ftds || 0,
    net_pl: f.net_pl,
    roi: f.roi,
    custo_por_ftd: f.custo_por_ftd,
    custo_por_clique: f.detalhes?.planilha?.gasto && f.detalhes?.planilha?.cliques
      ? Math.round((f.detalhes.planilha.gasto / f.detalhes.planilha.cliques) * 100) / 100 : null,
    whatsapp: f.detalhes?.whatsapp || null,
    lives: f.detalhes?.lives || null,
    alertas: f.alertas || [],
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
    body: JSON.stringify({ message: userMessage, additional_system: additionalSystem }),
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

async function gerarRecomendacoes(userId = 1, experts = EXPERTS_DEFAULT) {
  const dados = await coletarDados(userId, experts);
  const dadosTxt = `## DADOS CONSOLIDADOS POR EXPERT\n\n` +
    Object.entries(dados.experts).map(([exp, d]) => {
      if (d.error) return `### ${exp}\nERRO: ${d.error}`;
      return `### ${exp}\nDIÁRIO (ontem): ${JSON.stringify(d.diario_ontem)}\n` +
             `SEMANAL (7d): ${JSON.stringify(d.semanal_7d)}\n` +
             `MENSAL (30d): ${JSON.stringify(d.mensal_30d)}`;
    }).join('\n\n');

  const userMsg = `Analise os dados abaixo e me retorne o JSON com 5 recomendações conforme o schema do system prompt.\n\n${dadosTxt}`;

  const bridgeResp = await callBridge(userMsg, SYSTEM_PROMPT);
  const parsed = extractJson(bridgeResp.text);
  if (!parsed || !Array.isArray(parsed.recomendacoes)) {
    throw new Error('Resposta do bridge não veio em JSON válido. text=' + (bridgeResp.text || '').slice(0, 400));
  }

  // Persiste cada recomendação
  const inserted = [];
  for (const rec of parsed.recomendacoes) {
    try {
      const row = await db.insertRecommendation({
        user_id: userId,
        expert: rec.expert || 'GERAL',
        categoria: rec.categoria,
        urgencia: rec.urgencia,
        acao: rec.acao,
        justificativa: rec.justificativa,
        impacto_estimado: rec.impacto_estimado,
        passos: rec.passos,
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

module.exports = { gerarRecomendacoes, medirOutcomesAtrasados, notificarTop3, coletarDados };
