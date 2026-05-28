const { Router } = require('express');
const { randomUUID } = require('crypto');
const pdfParse = require('pdf-parse');
const db = require('../db');
const { executeTool } = require('../insights-tools');
const { executeResearchTool, RESEARCH_TOOLS } = require('../research-tools');
const { signAttachmentId } = require('./attachments');

const router = Router();

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://send-x-production.up.railway.app';

async function processAttachments(attachmentIds = [], sessionId, messageId) {
  if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) {
    return { images: [], textBlocks: [], mediaRefs: [], summary: '' };
  }
  const images = [];
  const textBlocks = [];
  const mediaRefs = []; // vídeos/áudios — vão como URL pro bridge (pode usar higgis / fetch_url)
  for (const id of attachmentIds) {
    try {
      const att = await db.getAttachment(Number(id));
      if (!att) continue;
      if (sessionId && !att.session_id) await db.updateAttachmentMessageId(att.id, messageId);

      if (att.mime_type.startsWith('image/')) {
        // Passamos imagem como base64 pro bridge — URLs do SEND-X exigem auth JWT,
        // não dá pra Claude baixar de fora. Sonnet aceita base64 nativo (vision).
        images.push({
          id: att.id,
          filename: att.filename,
          mime_type: att.mime_type,
          data_base64: att.data.toString('base64'),
          url: `${PUBLIC_BASE_URL}/api/attachments/${att.id}`,
        });
      } else if (att.mime_type.startsWith('video/') || att.mime_type.startsWith('audio/')) {
        // Vídeo/áudio é grande demais pra base64 + Claude não tem vision pra vídeo.
        // Vai como URL pública (rota /api/attachments/:id serve sem auth, ver attachments.js)
        // pro bridge baixar e processar via higgis (virality_predictor / media_upload) ou ffmpeg.
        // URL assinada (HMAC + expires 24h) — bridge baixa sem precisar de JWT
        const token = signAttachmentId(att.id);
        mediaRefs.push({
          id: att.id,
          filename: att.filename,
          mime_type: att.mime_type,
          size_bytes: att.data.length,
          kind: att.mime_type.startsWith('video/') ? 'video' : 'audio',
          url: `${PUBLIC_BASE_URL}/api/attachments/dl/${att.id}?token=${encodeURIComponent(token)}`,
        });
      } else if (att.mime_type === 'application/pdf') {
        try {
          const parsed = await pdfParse(att.data);
          const text = (parsed.text || '').slice(0, 50000);
          textBlocks.push({
            filename: att.filename,
            type: 'pdf',
            pages: parsed.numpages,
            content: text,
          });
        } catch (e) {
          textBlocks.push({ filename: att.filename, type: 'pdf', error: e.message });
        }
      } else {
        // texto/csv/json/md/html
        const text = att.data.toString('utf8').slice(0, 50000);
        textBlocks.push({
          filename: att.filename,
          type: att.mime_type,
          content: text,
        });
      }
    } catch (e) {
      console.error('[insights] attachment err:', e.message);
    }
  }
  const summary = `Anexos: ${images.length} imagem(ns), ${mediaRefs.length} mídia(s), ${textBlocks.length} arquivo(s) texto`;
  return { images, textBlocks, mediaRefs, summary };
}

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

async function getBridgeUrl() {
  // Prioridade: DB (atualizado em tempo real pelo start.sh do Mac) → env var (fallback)
  try {
    const reg = await db.getBridgeRegistry();
    if (reg?.url) return reg.url;
  } catch { /* DB sem tabela ainda — fallback */ }
  return process.env.BRIDGE_URL || null;
}

async function callBridge({ message, additionalSystem, history, images, signal }) {
  const url = await getBridgeUrl();
  const secret = process.env.BRIDGE_SECRET;
  if (!url || !secret) throw new Error('BRIDGE_URL/SECRET não configurados no servidor');
  const resp = await fetch(`${url}/chat`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secret}`,
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': '1',
    },
    body: JSON.stringify({ message, additional_system: additionalSystem, history, images }),
    signal,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Bridge HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

// Stream SSE: consome /chat/stream do bridge e dispara callbacks por evento.
// Retorna {text, session_id, tools_used, duration_ms} no final.
async function callBridgeStream({ message, additionalSystem, history, images, resumeId, callback, signal, onText, onToolUse, onToolResult, onSessionInit }) {
  const url = await getBridgeUrl();
  const secret = process.env.BRIDGE_SECRET;
  if (!url || !secret) throw new Error('BRIDGE_URL/SECRET não configurados no servidor');

  const resp = await fetch(`${url}/chat/stream`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secret}`,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'ngrok-skip-browser-warning': '1',
    },
    body: JSON.stringify({ message, additional_system: additionalSystem, history, images, resume_id: resumeId || undefined, callback: callback || undefined }),
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Bridge HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  if (!resp.body) throw new Error('Bridge SSE sem body');

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let assembled = '';
  let sessionId = null;
  const toolsUsed = [];
  let durationMs = 0;
  let bridgeError = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE parsing: eventos separados por \n\n, dados em linhas "data: "
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      // Comments (`: ...`) são heartbeats — ignora
      const dataLines = rawEvent.split('\n').filter(l => l.startsWith('data: '));
      if (dataLines.length === 0) continue;
      const dataStr = dataLines.map(l => l.slice(6)).join('\n');
      let evt;
      try { evt = JSON.parse(dataStr); } catch { continue; }

      if (evt.type === 'session_init') {
        onSessionInit?.(evt);
      } else if (evt.type === 'text') {
        assembled += evt.text;
        onText?.(evt.text);
      } else if (evt.type === 'tool_use') {
        toolsUsed.push({ name: evt.name, input: evt.input });
        onToolUse?.(evt);
      } else if (evt.type === 'tool_result') {
        onToolResult?.(evt);
      } else if (evt.type === 'done') {
        sessionId = evt.session_id || sessionId;
        durationMs = evt.duration_ms || 0;
      } else if (evt.type === 'error') {
        bridgeError = new Error(evt.error || 'Bridge error');
        bridgeError.partialText = assembled;
        bridgeError.durationMs = evt.duration_ms || 0;
        bridgeError.toolsUsed = toolsUsed;
      }
    }
  }

  if (bridgeError) throw bridgeError;

  return { text: assembled, session_id: sessionId, tools_used: toolsUsed, duration_ms: durationMs };
}

async function bridgeIsHealthy() {
  const url = await getBridgeUrl();
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
  const url = await getBridgeUrl();
  const online = await bridgeIsHealthy();
  res.json({ online, url });
});

router.post('/insights', async (req, res) => {
  try {
    const { message, tab, periodo, de, ate, session_id: clientSessionId, attachment_ids } = req.body;
    if (!message && (!attachment_ids || attachment_ids.length === 0)) {
      return res.status(400).json({ error: 'message ou attachment_ids obrigatórios' });
    }

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

    // ID único deste turno. O bridge devolve junto no callback durável, e a
    // gente acha a mensagem certa pra atualizar (sem duplicar) mesmo que o
    // streaming tenha caído no meio.
    const bridgeRequestId = randomUUID();

    const facts = await db.getChatFacts(req.userId);
    const recentMessages = await db.getChatMessages(session.id, MAX_HISTORY);

    const contextoTela = (tab && periodo)
      ? `\n\n## Contexto da tela\nO operador está vendo a aba "${tab}" no período "${periodo}"${de && ate ? ` (${de} — ${ate})` : ''}.`
      : '';

    const factsContext = buildFactsContext(facts);

    // Processa anexos antes de salvar mensagem (precisamos do messageId pra associar)
    const userMsg = await db.addChatMessage(session.id, 'user', message || '(arquivo anexado)');
    const { images, textBlocks, mediaRefs } = await processAttachments(attachment_ids || [], session.id, userMsg.id);
    // Liga os attachments ao session_id também
    for (const att of [...images, ...textBlocks, ...mediaRefs]) {
      if (att.id) {
        try { await db.query('UPDATE chat_attachments SET session_id=$1, message_id=$2 WHERE id=$3', [session.id, userMsg.id, att.id]); } catch {}
      }
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };
    send({ type: 'session', id: session.id, backend: 'bridge' });

    const ac = new AbortController();
    let clientDisconnected = false;
    // Safety net longo (6h) — não vai abortar trabalho real, só pega
    // processo realmente travado/zumbi. Override via env (SEM hardtimeout
    // se TIMEOUT_MS=0).
    const TIMEOUT_MS = Number.isFinite(Number(process.env.INSIGHTS_TIMEOUT_MS))
      ? Number(process.env.INSIGHTS_TIMEOUT_MS)
      : 6 * 60 * 60 * 1000;
    const hardTimeout = TIMEOUT_MS > 0 ? setTimeout(() => {
      console.log(`[insights] safety timeout ${TIMEOUT_MS}ms, aborting`);
      ac.abort();
    }, TIMEOUT_MS) : null;
    // Cliente desconectou (mobile foi pra background, trocou de device, etc):
    // NÃO abortamos. O bridge segue trabalhando, resposta é persistida no DB.
    // Quando o cliente reconecta (qualquer dispositivo da mesma conta),
    // loadChatHistory() pega a sessão mais recente automaticamente.
    res.on('close', () => {
      if (!res.writableEnded) {
        clientDisconnected = true;
        console.log(`[insights] cliente desconectou — session=${session.id}, processamento continua em background`);
      }
    });

    let assistantText = '';
    let bridgeErrored = false;
    let bridgeErrorMsg = '';

    try {
      // Texto dos arquivos vai como contexto adicional. Imagens vão como URL no prompt
      // (Sonnet baixa e analisa nativamente via vision).
      let attachmentContext = '';
      if (textBlocks.length > 0) {
        attachmentContext += '\n\n## Arquivos anexados pelo operador\n';
        for (const tb of textBlocks) {
          attachmentContext += `\n### ${tb.filename} (${tb.type}${tb.pages ? `, ${tb.pages} páginas` : ''})\n`;
          attachmentContext += tb.error ? `Erro ao processar: ${tb.error}` : '```\n' + tb.content + '\n```';
        }
      }
      let imagesPrompt = '';
      if (images.length > 0) {
        imagesPrompt = '\n\n[Imagens anexadas pelo operador nesta mensagem — use mcp__bridge__fetch_url ou Read para analisar se precisar:]\n' +
          images.map(im => `- ${im.filename}: ${im.url}`).join('\n');
      }
      let mediaPrompt = '';
      if (mediaRefs.length > 0) {
        const fmtSize = (n) => n > 1024*1024 ? `${(n/1024/1024).toFixed(1)}MB` : `${Math.round(n/1024)}KB`;
        mediaPrompt = '\n\n[Mídia (vídeo/áudio) anexada pelo operador — baixe via WebFetch/curl da URL pública abaixo. Pra vídeo: use mcp__claude_ai_higgis__media_upload + virality_predictor pra análise, ou ffmpeg pra extrair frames/áudio:]\n' +
          mediaRefs.map(m => `- ${m.kind.toUpperCase()} ${m.filename} (${m.mime_type}, ${fmtSize(m.size_bytes)}): ${m.url}`).join('\n');
      }

      const result = await callBridgeStream({
        message: (message || '') + imagesPrompt + mediaPrompt,
        additionalSystem: factsContext + contextoTela + attachmentContext,
        history: recentMessages.slice(-10).map(m => ({ role: m.role, content: m.content })),
        images,
        // Resume: se a session já trocou mensagens antes, passa o session_id
        // Claude pra SDK reconstruir a conversa do disco. Bridge faz fallback
        // automático sem resume se a sessão expirou.
        resumeId: session.bridge_session_id || null,
        // Callback durável: quando o bridge terminar, ele POSTa o resultado
        // aqui — independente do streaming. Se a conexão SSE cair, o resultado
        // não se perde: o bridge entrega via callback e o polling do front pega.
        callback: {
          url: `${PUBLIC_BASE_URL}/api/insights/bridge-result`,
          request_id: bridgeRequestId,
          chat_session_id: session.id,
        },
        signal: ac.signal,
        onText: (chunk) => send({ type: 'text', text: chunk }),
        onToolUse: (evt) => send({ type: 'tool_use', name: evt.name, input: evt.input }),
        onToolResult: (evt) => send({ type: 'tool_result', tool_use_id: evt.tool_use_id, is_error: evt.is_error, summary: evt.summary }),
      });
      assistantText = result.text || '';
      // Atualiza bridge_session_id com o session_id devolvido pela SDK.
      // Pode ser o mesmo (resume bem-sucedido) ou novo (sessão criada).
      if (result.session_id && result.session_id !== session.bridge_session_id) {
        try { await db.updateChatSessionBridgeId(session.id, result.session_id); } catch (e) { console.error('[insights] update bridge_session_id falhou:', e.message); }
      }
    } catch (err) {
      console.error('[insights] bridge erro:', err.message);
      bridgeErrored = true;
      bridgeErrorMsg = err.message;
      // Resgata texto parcial se o bridge mandou via SSE antes de erroar
      if (err.partialText) assistantText = err.partialText;
    } finally {
      if (hardTimeout) clearTimeout(hardTimeout);
    }

    // Persiste mensagem do assistente SEMPRE que tiver algum texto — mesmo em erro.
    // Marca com flag de erro pra UI poder destacar.
    const cleanText = (assistantText || '').replace(FACT_LINE_RE, '').replace(/\n{3,}/g, '\n\n').trim();
    // Persiste via helper idempotente (mesmo caminho do callback durável) pra
    // não duplicar se o callback do bridge chegar quase junto.
    if (cleanText) {
      try {
        await upsertAssistantByRequestId({
          sessionId: session.id, userId: req.userId, requestId: bridgeRequestId,
          content: cleanText + (bridgeErrored ? `\n\n_[interrompido: ${bridgeErrorMsg}]_` : ''),
          errored: bridgeErrored, empty: false,
          extractFactsFrom: bridgeErrored ? null : assistantText,
        });
      } catch (dbErr) {
        console.error('[insights] persist parcial falhou:', dbErr.message);
      }
    } else if (bridgeErrored) {
      // Aborto antes de qualquer texto: placeholder pra UI não ficar órfã.
      // O callback durável do bridge SOBRESCREVE este placeholder com a
      // resposta real (por bridge_request_id) se o trabalho concluiu.
      try {
        await upsertAssistantByRequestId({
          sessionId: session.id, userId: req.userId, requestId: bridgeRequestId,
          content: `_[interrompido antes da resposta: ${bridgeErrorMsg || 'sem detalhes'}]_`,
          errored: true, empty: true, extractFactsFrom: null,
        });
      } catch (dbErr) {
        console.error('[insights] persist placeholder erro:', dbErr.message);
      }
    }

    if (bridgeErrored) {
      send({ type: 'error', error: bridgeErrorMsg, partial_saved: !!cleanText });
    } else {
      send({ type: 'done', session_id: session.id, backend: 'bridge' });
    }
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

// Upsert idempotente da mensagem do assistente por bridge_request_id.
// Usado pelos DOIS caminhos (streaming e callback durável) — convergem na
// mesma linha, então não duplica mesmo que cheguem quase juntos.
// Regra: insere se não existe; se existe placeholder e o novo é real,
// sobrescreve; senão ignora (dedup).
async function upsertAssistantByRequestId({ sessionId, userId, requestId, content, errored, empty, extractFactsFrom }) {
  const meta = { backend: 'bridge', errored: !!errored, empty: !!empty, bridge_request_id: requestId };
  let existing = null;
  if (requestId) {
    const rows = await db.query(
      `SELECT * FROM chat_messages WHERE session_id=$1 AND metadata->>'bridge_request_id'=$2 ORDER BY created_at DESC LIMIT 1`,
      [sessionId, requestId]
    );
    existing = rows[0] || null;
  }

  if (existing) {
    const md = existing.metadata || {};
    const existingIsPlaceholder = md.errored || md.empty
      || /^_\[interrompido/.test(existing.content || '') || (existing.content || '').length < 40;
    const newIsReal = content && content.length >= 40 && !empty;
    if (newIsReal && existingIsPlaceholder) {
      await db.query(`UPDATE chat_messages SET content=$2, metadata=$3 WHERE id=$1`,
        [existing.id, content, JSON.stringify(meta)]);
      if (extractFactsFrom) await extractAndPersistFacts(userId, existing.id, extractFactsFrom);
      return { updated: true, message_id: existing.id };
    }
    return { deduped: true, message_id: existing.id };
  }

  if (!content) return { skipped: 'sem conteúdo' };
  const msg = await db.addChatMessage(sessionId, 'assistant', content, meta);
  if (extractFactsFrom) await extractAndPersistFacts(userId, msg.id, extractFactsFrom);
  return { inserted: true, message_id: msg.id };
}

// ─── Callback durável: bridge entrega resultado final aqui ──────────────────
// Chamado server-to-server pelo bridge quando a task termina, INDEPENDENTE do
// streaming SSE. Garante que o resultado não se perca se a conexão cair no meio.
async function persistBridgeResult({ request_id, chat_session_id, text, claude_session_id, status }) {
  if (!chat_session_id) throw new Error('chat_session_id obrigatório');
  const sessRows = await db.query('SELECT * FROM chat_sessions WHERE id=$1', [chat_session_id]);
  const session = sessRows[0];
  if (!session) throw new Error('sessão não encontrada: ' + chat_session_id);

  if (claude_session_id && claude_session_id !== session.bridge_session_id) {
    try { await db.updateChatSessionBridgeId(chat_session_id, claude_session_id); } catch {}
  }

  const cleanText = (text || '').replace(FACT_LINE_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  return upsertAssistantByRequestId({
    sessionId: chat_session_id, userId: session.user_id, requestId: request_id,
    content: cleanText, errored: status !== 'done', empty: false,
    extractFactsFrom: status === 'done' ? text : null,
  });
}

router.persistBridgeResult = persistBridgeResult;
module.exports = router;
