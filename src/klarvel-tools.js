/**
 * Integração com Klarvel (meet-attendance-dashboard) — monitora lives dos experts.
 * DB próprio do Klarvel em KLARVEL_DATABASE_URL (read-only).
 *
 * Mapeamento Klarvel user_id → SEND-X expert (tab):
 *   192028bd-9657-4fe8-a484-ca4ebe9b8eb6 → DEIVID (Deivid Novo)
 *   ccf5cbcf-7628-41f3-836c-06a620dd1150 → DANI   (Dani Roleta)
 *   fe8e91a1-8e2c-4457-b03c-04eb326481fc → JUH    (Juliana Bueno)
 *   16bc71c0-a45e-46a5-a507-4c62cf0f5100 → AYTALO (operador)
 */

const { Pool } = require('pg');

const EXPERT_MAP = {
  DEIVID: '192028bd-9657-4fe8-a484-ca4ebe9b8eb6',
  DANI:   'ccf5cbcf-7628-41f3-836c-06a620dd1150',
  JUH:    'fe8e91a1-8e2c-4457-b03c-04eb326481fc',
  AYTALO: '16bc71c0-a45e-46a5-a507-4c62cf0f5100',
};

let _pool = null;
function pool() {
  if (_pool) return _pool;
  const url = process.env.KLARVEL_DATABASE_URL;
  if (!url) throw new Error('KLARVEL_DATABASE_URL não configurado no servidor');
  _pool = new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 30_000 });
  return _pool;
}

function expertToUserId(expert) {
  const k = (expert || '').toUpperCase();
  const id = EXPERT_MAP[k];
  if (!id) throw new Error(`Expert desconhecido para Klarvel: ${expert}. Disponíveis: ${Object.keys(EXPERT_MAP).join(', ')}`);
  return id;
}

// Resolver período (mesmo padrão do resto do SEND-X mas BRT)
function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}
function pad(n) { return String(n).padStart(2, '0'); }
function brt(y, m, d, h = 0, mi = 0, s = 0) {
  return new Date(`${y}-${pad(m+1)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}-03:00`);
}
function parseBR(s) {
  if (!s) return null;
  const [d, m, y] = s.split('/').map(Number);
  if (!d || !m || !y) return null;
  return brt(y, m - 1, d);
}
function resolvePeriodo(periodo, de, ate) {
  const now = nowBRT();
  const y = now.getFullYear(), m = now.getMonth(), today = now.getDate();
  let s, e;
  switch (periodo) {
    case 'hoje':  s = brt(y, m, today);             e = brt(y, m, today, 23, 59, 59); break;
    case 'ontem': s = brt(y, m, today - 1);         e = brt(y, m, today - 1, 23, 59, 59); break;
    case '7d':    s = brt(y, m, today - 6);         e = brt(y, m, today, 23, 59, 59); break;
    case '14d':   s = brt(y, m, today - 13);        e = brt(y, m, today, 23, 59, 59); break;
    case '30d':   s = brt(y, m, today - 29);        e = brt(y, m, today, 23, 59, 59); break;
    case '1m':
    case 'mtd':   s = brt(y, m, 1);                 e = brt(y, m, today, 23, 59, 59); break;
    case 'lastm': s = brt(y, m - 1, 1);             e = new Date(brt(y, m, 1) - 1); break;
    case '3m':    s = brt(y, m - 2, 1);             e = brt(y, m, today, 23, 59, 59); break;
    case 'custom':
      s = parseBR(de); e = parseBR(ate);
      if (!s || !e) throw new Error('custom requer de+ate (DD/MM/YYYY)');
      e = new Date(e.getTime() + 86_399_000);
      break;
    default: throw new Error(`Período inválido: ${periodo}`);
  }
  return { start: s, end: e, label: `${s.toISOString().slice(0,10)} — ${e.toISOString().slice(0,10)}` };
}

// ─── Handlers ──────────────────────────────────────────────────────────────

async function get_lives_resumo({ expert, periodo, de, ate }) {
  const userId = expertToUserId(expert);
  const { start, end, label } = resolvePeriodo(periodo, de, ate);
  const db = pool();

  const meetings = await db.query(
    `SELECT id, meet_url, display_name, status, joined_at, stopped_at, created_at
     FROM meetings WHERE user_id=$1 AND created_at BETWEEN $2 AND $3
     ORDER BY created_at DESC`,
    [userId, start, end]
  );
  const meetingIds = meetings.rows.map(m => m.id);

  if (meetingIds.length === 0) {
    return { expert, periodo: label, total_lives: 0, msg: 'Sem lives no período' };
  }

  // Pico de participantes (max simultâneo) por meeting via running count de join-left
  // Atalho: count distinct de participantes via participantJoined
  const participantsAgg = await db.query(
    `SELECT meeting_id,
       COUNT(*) FILTER (WHERE event='participantJoined') AS joins,
       COUNT(DISTINCT data->>'participantId') FILTER (WHERE event='participantJoined') AS unicos
     FROM events WHERE meeting_id = ANY($1) GROUP BY meeting_id`,
    [meetingIds]
  );

  const msgsAgg = await db.query(
    `SELECT meeting_id,
       COUNT(*) FILTER (WHERE event='messageSent') AS msgs,
       COUNT(DISTINCT data->>'authorId') FILTER (WHERE event='messageSent') AS autores
     FROM events WHERE meeting_id = ANY($1) GROUP BY meeting_id`,
    [meetingIds]
  );

  // Pico real: para cada meeting, calcular curva join/left e pegar max simultâneos
  const picos = await db.query(
    `WITH delta AS (
       SELECT meeting_id, timestamp,
         CASE WHEN event='participantJoined' THEN 1
              WHEN event='participantLeft' THEN -1 ELSE 0 END AS d
       FROM events WHERE meeting_id = ANY($1) AND event IN ('participantJoined','participantLeft','participantsBaseline')
     ),
     running AS (
       SELECT meeting_id, SUM(d) OVER (PARTITION BY meeting_id ORDER BY timestamp) AS conc
       FROM delta
     )
     SELECT meeting_id, MAX(conc) AS pico FROM running GROUP BY meeting_id`,
    [meetingIds]
  );

  const parMap = Object.fromEntries(participantsAgg.rows.map(r => [r.meeting_id, r]));
  const msgMap = Object.fromEntries(msgsAgg.rows.map(r => [r.meeting_id, r]));
  const picoMap = Object.fromEntries(picos.rows.map(r => [r.meeting_id, r.pico]));

  const lives = meetings.rows.map(m => {
    const duracaoMin = (m.stopped_at && m.joined_at)
      ? Math.round((new Date(m.stopped_at) - new Date(m.joined_at)) / 60000)
      : null;
    return {
      meeting_id: m.id,
      data: m.created_at,
      joined_at: m.joined_at,
      stopped_at: m.stopped_at,
      status: m.status,
      duracao_minutos: duracaoMin,
      pico_simultaneos: Number(picoMap[m.id] || 0),
      participantes_unicos: Number(parMap[m.id]?.unicos || 0),
      total_joins: Number(parMap[m.id]?.joins || 0),
      total_mensagens: Number(msgMap[m.id]?.msgs || 0),
      autores_unicos: Number(msgMap[m.id]?.autores || 0),
    };
  });

  // Agregados do período
  const totalLives = lives.length;
  const sum = (k) => lives.reduce((a, l) => a + (l[k] || 0), 0);
  const avg = (k) => totalLives > 0 ? Math.round(sum(k) / totalLives) : 0;

  return {
    expert,
    periodo: label,
    total_lives: totalLives,
    duracao_total_minutos: sum('duracao_minutos'),
    duracao_media_minutos: avg('duracao_minutos'),
    pico_simultaneos_medio: avg('pico_simultaneos'),
    pico_simultaneos_max: Math.max(...lives.map(l => l.pico_simultaneos), 0),
    participantes_unicos_soma: sum('participantes_unicos'),
    mensagens_total: sum('total_mensagens'),
    autores_unicos_soma: sum('autores_unicos'),
    taxa_engajamento_media: totalLives > 0
      ? Math.round((sum('autores_unicos') / Math.max(sum('participantes_unicos'), 1)) * 1000) / 10 + '%'
      : '0%',
    lives,
  };
}

async function get_live_detalhes({ meeting_id }) {
  if (!meeting_id) throw new Error('meeting_id obrigatório');
  const db = pool();
  const m = await db.query('SELECT * FROM meetings WHERE id=$1', [meeting_id]);
  if (m.rows.length === 0) return { error: `Meeting ${meeting_id} não encontrada` };
  const events = await db.query(
    `SELECT event, timestamp, data FROM events WHERE meeting_id=$1 ORDER BY timestamp ASC LIMIT 500`,
    [meeting_id]
  );
  return {
    meeting: m.rows[0],
    eventos_totais: events.rows.length,
    eventos: events.rows,
  };
}

async function get_mensagens_live({ meeting_id, limit = 100 }) {
  if (!meeting_id) throw new Error('meeting_id obrigatório');
  const db = pool();
  const r = await db.query(
    `SELECT timestamp, data FROM events
     WHERE meeting_id=$1 AND event='messageSent'
     ORDER BY timestamp ASC LIMIT $2`,
    [meeting_id, limit]
  );
  return {
    meeting_id,
    total: r.rows.length,
    mensagens: r.rows.map(x => ({
      ts: x.timestamp,
      autor: x.data?.authorName || x.data?.authorId || '?',
      texto: x.data?.text || '',
    })),
  };
}

async function listar_lives({ expert, periodo, de, ate, limit = 30 }) {
  const userId = expertToUserId(expert);
  const { start, end, label } = resolvePeriodo(periodo, de, ate);
  const db = pool();
  const r = await db.query(
    `SELECT id, meet_url, display_name, status, joined_at, stopped_at, created_at
     FROM meetings WHERE user_id=$1 AND created_at BETWEEN $2 AND $3
     ORDER BY created_at DESC LIMIT $4`,
    [userId, start, end, limit]
  );
  return {
    expert,
    periodo: label,
    total: r.rows.length,
    lives: r.rows,
  };
}

const KLARVEL_TOOLS = [
  {
    name: 'get_lives_resumo',
    description: 'Resumo agregado das lives (Google Meet) de um expert num período. Retorna total de lives, duração média, pico de simultâneos, participantes únicos, mensagens, taxa de engajamento. Use quando o operador perguntar sobre lives, audiência, engajamento.',
    input_schema: {
      type: 'object',
      properties: {
        expert: { type: 'string', description: 'DANI, DEIVID, JUH ou AYTALO' },
        periodo: { type: 'string', enum: ['hoje','ontem','7d','14d','30d','1m','mtd','lastm','3m','custom'] },
        de: { type: 'string' }, ate: { type: 'string' },
      },
      required: ['expert','periodo'],
    },
  },
  {
    name: 'listar_lives',
    description: 'Lista as últimas lives de um expert no período (sem agregação). Use pra ver quais lives aconteceram.',
    input_schema: {
      type: 'object',
      properties: {
        expert: { type: 'string' },
        periodo: { type: 'string', enum: ['hoje','ontem','7d','14d','30d','1m','mtd','lastm','3m','custom'] },
        de: { type: 'string' }, ate: { type: 'string' },
        limit: { type: 'number', description: 'default 30' },
      },
      required: ['expert','periodo'],
    },
  },
  {
    name: 'get_live_detalhes',
    description: 'Detalhes de uma live específica: timeline de eventos (joins/lefts/mensagens). Use após listar_lives para entender uma live específica.',
    input_schema: {
      type: 'object',
      properties: { meeting_id: { type: 'string', description: 'UUID da meeting' } },
      required: ['meeting_id'],
    },
  },
  {
    name: 'get_mensagens_live',
    description: 'Retorna todas as mensagens enviadas pelos participantes durante uma live (até 100). Use pra análise semântica de dúvidas, sentimento, padrões.',
    input_schema: {
      type: 'object',
      properties: {
        meeting_id: { type: 'string' },
        limit: { type: 'number', description: 'default 100' },
      },
      required: ['meeting_id'],
    },
  },
];

const HANDLERS = {
  get_lives_resumo,
  listar_lives,
  get_live_detalhes,
  get_mensagens_live,
};

async function executeKlarvelTool(name, input) {
  const h = HANDLERS[name];
  if (!h) throw new Error(`Klarvel tool desconhecida: ${name}`);
  return await h(input || {});
}

module.exports = { KLARVEL_TOOLS, executeKlarvelTool, EXPERT_MAP };
