const { Router } = require('express');
const db = require('../db');
const { executeTool } = require('../insights-tools');
const { executeResearchTool, RESEARCH_TOOLS } = require('../research-tools');

const router = Router();

const MAX_HISTORY = 20;
const FACTS_LIMIT = 30;

// Pre-fetch heurístico (todas as tools rodam server-side e injetam contexto)
const EXPERT_NAMES = ['DANI', 'DEIVID', 'JUH', 'NUCLEAR'];

const FACT_LINE_RE = /^MEMORIZE:\s*([a-z_]+)\s*\|\s*([^|]+?)\s*\|\s*(.+)$/gim;

async function extractAndPersistFacts(userId, sourceMessageId, responseText) {
  if (!responseText) return responseText;
  const validTypes = new Set(['user', 'project', 'feedback', 'decision']);
  const matches = [...responseText.matchAll(FACT_LINE_RE)];
  for (const m of matches) {
    const [, type, key, value] = m;
    if (!validTypes.has(type)) continue;
    try {
      await db.upsertChatFact(userId, type, key.trim().toLowerCase(), value.trim(), sourceMessageId);
    } catch (err) {
      console.error('[insights] upsertChatFact falhou:', err.message);
    }
  }
  return responseText.replace(FACT_LINE_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

function buildFactsContext(facts) {
  if (!facts || facts.length === 0) return '';
  const grouped = facts.reduce((acc, f) => {
    (acc[f.type] = acc[f.type] || []).push(f);
    return acc;
  }, {});
  const sections = [];
  if (grouped.user)     sections.push('### Sobre o operador\n' + grouped.user.map(f => `- ${f.fact_key}: ${f.fact_value}`).join('\n'));
  if (grouped.project)  sections.push('### Contexto do projeto/negócio\n' + grouped.project.map(f => `- ${f.fact_key}: ${f.fact_value}`).join('\n'));
  if (grouped.feedback) sections.push('### Feedback acumulado (siga essas regras)\n' + grouped.feedback.map(f => `- ${f.fact_key}: ${f.fact_value}`).join('\n'));
  if (grouped.decision) sections.push('### Decisões anteriores (audit trail)\n' + grouped.decision.map(f => `- ${f.fact_key}: ${f.fact_value}`).join('\n'));
  return '\n\n## Memória persistente\n' + sections.join('\n\n');
}

async function prefetchContextForBridge(message, userId) {
  const ctx = [];
  const upper = (message || '').toUpperCase();
  const wantsToday = /\bhoje\b|atual|agora|neste momento|tempo real|real[-\s]?time/i.test(message);

  // 1) Sempre: dashboard overview (custo trivial, dá panorama com ontem/7d)
  try {
    const ov = await executeTool('get_dashboard_overview', {}, userId);
    ctx.push('### Dashboard overview (snapshot ontem + 7d)\n```json\n' + JSON.stringify(ov, null, 2) + '\n```');
  } catch (e) {
    ctx.push('### Dashboard overview\nFalha: ' + e.message);
  }

  // 2) Para cada expert: postbacks HOJE (real-time) + planilha HOJE/MTD/lastm
  try {
    const accounts = await db.getAdAccounts(userId);
    const postbacksHoje = [];
    const planilhaHoje = [];
    const planilhaMTD = [];
    const planilhaLastM = [];
    const wantsMonthScope = /m[êe]s|mtd|month|30\s*dias|últim/i.test(message);
    for (const acc of accounts) {
      try {
        const u = await executeTool('get_postbacks_por_utm', { expert: acc.tab, periodo: 'hoje' }, userId);
        postbacksHoje.push({ expert: acc.tab, ...u });
      } catch (e) { /* ignora */ }
      try {
        const m = await executeTool('get_metricas_expert', { expert: acc.tab, periodo: 'hoje', comparar: false }, userId);
        planilhaHoje.push(m);
      } catch (e) { /* ignora */ }
      try {
        const m = await executeTool('get_metricas_expert', { expert: acc.tab, periodo: '1m', comparar: false }, userId);
        planilhaMTD.push(m);
      } catch (e) { /* ignora */ }
      if (wantsMonthScope) {
        try {
          const m = await executeTool('get_metricas_expert', { expert: acc.tab, periodo: 'lastm', comparar: false }, userId);
          planilhaLastM.push(m);
        } catch (e) { /* ignora */ }
      }
    }
    ctx.push('### Postbacks HOJE em tempo real (Apostatudo)\n```json\n' + JSON.stringify(postbacksHoje, null, 2) + '\n```');
    ctx.push('### Planilha HOJE (gasto/cliques/cadastros/FTDs/Net P&L; atualiza ~09h BRT)\n```json\n' + JSON.stringify(planilhaHoje, null, 2) + '\n```');
    ctx.push('### Planilha MÊS ATUAL (mtd, todas as métricas)\n```json\n' + JSON.stringify(planilhaMTD, null, 2) + '\n```');
    if (planilhaLastM.length > 0) {
      ctx.push('### Planilha MÊS PASSADO\n```json\n' + JSON.stringify(planilhaLastM, null, 2) + '\n```');
    }
  } catch (e) { /* ignora */ }

  // 3) Expert mencionado → métricas + diário 7d
  const mentioned = EXPERT_NAMES.filter(n => upper.includes(n));
  for (const expert of mentioned) {
    try {
      const m = await executeTool('get_metricas_expert', { expert, periodo: 'ontem' }, userId);
      ctx.push(`### Métricas ${expert} ontem\n\`\`\`json\n${JSON.stringify(m, null, 2)}\n\`\`\``);
    } catch (e) {}
    try {
      const d = await executeTool('get_metricas_diario', { expert, periodo: '7d' }, userId);
      ctx.push(`### Série diária ${expert} 7d\n\`\`\`json\n${JSON.stringify(d, null, 2)}\n\`\`\``);
    } catch (e) {}
  }

  // 4) UTM/postback expandido por expert
  if ((wantsToday || /utm|postback|campanha|criativo|adset/i.test(message)) && mentioned.length > 0) {
    for (const expert of mentioned) {
      try {
        const u = await executeTool('get_postbacks_por_utm', { expert, periodo: '7d' }, userId);
        ctx.push(`### Postbacks UTM ${expert} 7d\n\`\`\`json\n${JSON.stringify(u, null, 2)}\n\`\`\``);
      } catch (e) {}
    }
  }

  // 5) Disparos
  if (/disparo|schedule|agend|envio|sendpulse/i.test(message)) {
    try {
      const ds = await executeTool('get_disparos_status', { status: 'todos', periodo: '7d' }, userId);
      ctx.push('### Status disparos 7d\n```json\n' + JSON.stringify(ds, null, 2) + '\n```');
    } catch (e) {}
  }

  // 6) Telegram
  if (/telegram|inscrito|canal/i.test(message) && mentioned.length > 0) {
    for (const expert of mentioned) {
      try {
        const t = await executeTool('get_telegram_growth', { expert, periodo: '7d' }, userId);
        ctx.push(`### Telegram growth ${expert} 7d\n\`\`\`json\n${JSON.stringify(t, null, 2)}\n\`\`\``);
      } catch (e) {}
    }
  }

  // 7) Concorrentes Instagram (URL, @username, alias conhecido)
  const igUsernames = new Set();
  [...message.matchAll(/instagram\.com\/([A-Za-z0-9._]+)/gi)].forEach(m => igUsernames.add(m[1].toLowerCase()));
  [...message.matchAll(/@([A-Za-z0-9._]{3,30})/g)].forEach(m => igUsernames.add(m[1].toLowerCase()));
  const KNOWN_COMPETITORS = { 'denerzim': 'denerzimofc', 'denerzimofc': 'denerzimofc' };
  const lowerMsg = (message || '').toLowerCase();
  Object.entries(KNOWN_COMPETITORS).forEach(([alias, uname]) => {
    if (new RegExp('\\b' + alias + '\\b').test(lowerMsg)) igUsernames.add(uname);
  });
  for (const uname of igUsernames) {
    try {
      const profile = await executeResearchTool('analisar_concorrente_instagram', { ig_username: uname });
      ctx.push(`### Perfil Instagram @${uname} (concorrente)\n\`\`\`json\n${JSON.stringify(profile, null, 2)}\n\`\`\``);
    } catch (e) {}
  }

  // 8) Meta Ad Library
  if (/biblioteca de an[úu]ncios|ads library|an[úu]ncios? (do|da|de)/i.test(message)) {
    const m = message.match(/an[úu]ncios? (?:do|da|de) ([A-Za-zÀ-ú0-9_@. ]{3,40})/i);
    const term = m ? m[1].trim() : Array.from(igUsernames)[0];
    if (term) {
      try {
        const ads = await executeResearchTool('meta_ads_library_search', { search_terms: term, limit: 10 });
        ctx.push(`### Meta Ad Library — busca "${term}"\n\`\`\`json\n${JSON.stringify(ads, null, 2)}\n\`\`\``);
      } catch (e) {}
    }
  }

  return ctx.length > 0
    ? '\n\n## Dados pré-carregados pelo SEND-X (use estes números, não invente)\n\nIMPORTANTE: dados de "hoje" via postbacks Apostatudo (tempo real). Planilha começa em ontem. Tudo abaixo:\n\n' + ctx.join('\n\n')
    : '';
}

// ─── Bridge (Mac via ngrok com sua assinatura Max) ────────────────────────

async function callBridge({ message, additionalSystem, signal }) {
  const url = process.env.BRIDGE_URL;
  const secret = process.env.BRIDGE_SECRET;
  if (!url || !secret) throw new Error('BRIDGE_URL/SECRET não configurados no servidor');
  const resp = await fetch(`${url}/chat`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secret}`,
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': '1',
    },
    body: JSON.stringify({ message, additional_system: additionalSystem }),
    signal,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Bridge HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

async function bridgeIsHealthy() {
  const url = process.env.BRIDGE_URL;
  if (!url) return false;
  try {
    const resp = await fetch(`${url}/health`, {
      headers: { 'ngrok-skip-browser-warning': '1' },
      signal: AbortSignal.timeout(3000),
    });
    return resp.ok;
  } catch { return false; }
}

// ─── Rotas ─────────────────────────────────────────────────────────────────

router.get('/insights/bridge-status', async (_req, res) => {
  const online = await bridgeIsHealthy();
  res.json({ online, url: process.env.BRIDGE_URL || null });
});

router.post('/insights', async (req, res) => {
  try {
    const { message, tab, periodo, de, ate, session_id: clientSessionId } = req.body;
    if (!message) return res.status(400).json({ error: 'message é obrigatório' });

    const online = await bridgeIsHealthy();
    if (!online) {
      return res.status(503).json({
        error: 'Bridge offline. Ligue o Mac e rode ~/claude-bridge/start.sh para o chat funcionar com sua assinatura Max.',
      });
    }

    // Sessão persistente
    let session;
    if (clientSessionId) {
      const found = await db.query('SELECT * FROM chat_sessions WHERE id=$1 AND user_id=$2', [clientSessionId, req.userId]);
      session = found[0];
    }
    if (!session) {
      session = await db.getOrCreateChatSession(req.userId, { backend: 'bridge' });
    }

    const facts = await db.getChatFacts(req.userId);
    const recentMessages = await db.getChatMessages(session.id, MAX_HISTORY);

    const contextoTela = (tab && periodo)
      ? `\n\n## Contexto da tela\nO operador está vendo a aba "${tab}" no período "${periodo}"${de && ate ? ` (${de} — ${ate})` : ''}.`
      : '';

    const factsContext = buildFactsContext(facts);

    await db.addChatMessage(session.id, 'user', message);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ type: 'session', id: session.id, backend: 'bridge' });

    const ac = new AbortController();
    req.on('close', () => ac.abort());

    let assistantText = '';

    try {
      const historyContext = recentMessages.length > 0
        ? '\n\n## Histórico recente da conversa\n' +
          recentMessages.slice(-6).map(m => `**${m.role === 'user' ? 'Operador' : 'Você'}**: ${m.content.slice(0, 1500)}`).join('\n\n')
        : '';

      // Sem pre-fetch heurístico: Claude no Mac chama as tools mcp__bridge__* sob demanda
      const result = await callBridge({
        message,
        additionalSystem: factsContext + contextoTela + historyContext,
        signal: ac.signal,
      });
      assistantText = result.text || '';
      // Stream simulado pra UX
      for (let i = 0; i < assistantText.length; i += 50) {
        send({ type: 'text', text: assistantText.slice(i, i + 50) });
      }
    } catch (err) {
      console.error('[insights] bridge erro:', err.message);
      send({ type: 'error', error: err.message });
      res.end();
      return;
    }

    const cleanText = assistantText.replace(FACT_LINE_RE, '').replace(/\n{3,}/g, '\n\n').trim();
    const assistantMsg = await db.addChatMessage(session.id, 'assistant', cleanText, { backend: 'bridge' });
    await extractAndPersistFacts(req.userId, assistantMsg.id, assistantText);

    send({ type: 'done', session_id: session.id, backend: 'bridge' });
    res.end();
  } catch (err) {
    console.error('[insights] error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Erro: ' + err.message });
    }
  }
});

router.get('/insights/usage', async (req, res) => {
  try {
    const usage = await db.getInsightsUsage(req.userId);
    res.json(usage);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/insights/sessions', async (req, res) => {
  try {
    const sessions = await db.listChatSessions(req.userId);
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/insights/messages/:sessionId', async (req, res) => {
  try {
    const msgs = await db.getChatMessages(Number(req.params.sessionId), 100);
    res.json(msgs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/insights/facts', async (req, res) => {
  try {
    const facts = await db.getChatFacts(req.userId);
    res.json(facts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/insights/facts/:type/:key', async (req, res) => {
  try {
    await db.deleteChatFact(req.userId, req.params.type, req.params.key);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/insights/sessions', async (req, res) => {
  try {
    const session = await db.createChatSession(req.userId, { title: req.body.title });
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
