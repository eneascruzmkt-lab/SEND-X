/**
 * Tools de WhatsApp Groups (monitorgrupo-v2) integradas ao SEND-X.
 * DB próprio do monitorgrupo em MONITORGRUPO_DATABASE_URL (read-only).
 *
 * Mapeamento expert SEND-X → expert_id do monitorgrupo é feito por NAME (string match):
 *   SEND-X tab "DANI" → monitorgrupo experts WHERE name='DANI'
 * O operador deve cadastrar experts com mesmo nome em ambos os sistemas.
 */

const { Pool } = require('pg');

let _pool = null;
function pool() {
  if (_pool) return _pool;
  const url = process.env.MONITORGRUPO_DATABASE_URL;
  if (!url) throw new Error('MONITORGRUPO_DATABASE_URL não configurado no servidor');
  _pool = new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 30_000 });
  return _pool;
}

function nowBRT() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })); }
function pad(n) { return String(n).padStart(2, '0'); }
function brt(y, m, d, h = 0, mi = 0, s = 0) { return new Date(`${y}-${pad(m+1)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}-03:00`); }
function parseBR(s) {
  if (!s) return null;
  const [d, m, y] = s.split('/').map(Number);
  return brt(y, m - 1, d);
}
function resolvePeriodo(periodo, de, ate) {
  const now = nowBRT();
  const y = now.getFullYear(), m = now.getMonth(), today = now.getDate();
  let s, e;
  switch (periodo) {
    case 'hoje':  s = brt(y, m, today);         e = brt(y, m, today, 23, 59, 59); break;
    case 'ontem': s = brt(y, m, today - 1);     e = brt(y, m, today - 1, 23, 59, 59); break;
    case '7d':    s = brt(y, m, today - 6);     e = brt(y, m, today, 23, 59, 59); break;
    case '14d':   s = brt(y, m, today - 13);    e = brt(y, m, today, 23, 59, 59); break;
    case '30d':   s = brt(y, m, today - 29);    e = brt(y, m, today, 23, 59, 59); break;
    case '1m':
    case 'mtd':   s = brt(y, m, 1);             e = brt(y, m, today, 23, 59, 59); break;
    case 'lastm': s = brt(y, m - 1, 1);         e = new Date(brt(y, m, 1) - 1); break;
    case '3m':    s = brt(y, m - 2, 1);         e = brt(y, m, today, 23, 59, 59); break;
    case 'custom':
      s = parseBR(de); e = parseBR(ate);
      if (!s || !e) throw new Error('custom requer de+ate (DD/MM/YYYY)');
      e = new Date(e.getTime() + 86_399_000);
      break;
    default: throw new Error(`Período inválido: ${periodo}`);
  }
  return { start: s, end: e, label: `${s.toISOString().slice(0,10)} — ${e.toISOString().slice(0,10)}` };
}

async function getExpertId(name) {
  const db = pool();
  // Busca por name OU display_name (case-insensitive) — operador pode cadastrar
  // com qualquer dos dois (ex: name='MALVADEZA', display_name='DEIVID').
  const upper = name.toUpperCase();
  const r = await db.query(
    `SELECT id FROM experts WHERE is_active=true AND (UPPER(name)=$1 OR UPPER(display_name)=$1) LIMIT 1`,
    [upper]
  );
  return r.rows[0]?.id || null;
}

async function getExpertLeadsJids(expertId) {
  if (!expertId) return [];
  const db = pool();
  const r = await db.query(`SELECT group_jid FROM expert_groups WHERE expert_id=$1 AND role='leads'`, [expertId]);
  return r.rows.map(x => x.group_jid);
}

// ─── Handlers ──────────────────────────────────────────────────────────────

async function get_grupos_expert({ expert }) {
  const expertId = await getExpertId(expert);
  if (!expertId) return { error: `Expert '${expert}' não encontrado no monitorgrupo`, hint: 'Cadastre em https://monitorgrupo-production.up.railway.app/' };
  const db = pool();
  const r = await db.query(`
    SELECT eg.role, g.group_jid, g.name, g.member_count
    FROM expert_groups eg JOIN groups g ON g.group_jid = eg.group_jid
    WHERE eg.expert_id=$1 ORDER BY eg.role, g.name
  `, [expertId]);
  return { expert, total_grupos: r.rows.length, grupos: r.rows };
}

/**
 * Métricas SEPARADAS por grupo de leads do expert. Retorna array com 1 item por grupo.
 * Cada item: nome, total_membros, ativos, mensagens, novos_membros, saidas, saldo.
 * Use quando expert tem múltiplos grupos com leads sobrepostos (ex: DANI).
 */
async function get_engajamento_por_grupo({ expert, periodo, de, ate }) {
  const expertId = await getExpertId(expert);
  if (!expertId) return { error: `Expert '${expert}' não encontrado` };

  const db = pool();
  const groupsRes = await db.query(`
    SELECT eg.group_jid, g.name, g.member_count
    FROM expert_groups eg JOIN groups g ON g.group_jid = eg.group_jid
    WHERE eg.expert_id=$1 AND eg.role='leads'
    ORDER BY g.member_count DESC NULLS LAST
  `, [expertId]);

  if (groupsRes.rows.length === 0) return { expert, total_grupos: 0, grupos: [] };

  const { start, end, label } = resolvePeriodo(periodo, de, ate);
  const grupos = [];

  for (const g of groupsRes.rows) {
    const msgsRes = await db.query(`
      SELECT
        COUNT(*) AS total_msgs,
        COUNT(DISTINCT remote_jid) AS senders,
        COUNT(*) FILTER (WHERE message_type IN ('image','video','document','audio','sticker')) AS media,
        COUNT(*) FILTER (WHERE is_reply=true) AS replies
      FROM messages WHERE group_jid=$1 AND timestamp BETWEEN $2 AND $3
    `, [g.group_jid, start, end]);
    const msgs = msgsRes.rows[0];

    const churnRes = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE is_active=true AND joined_at BETWEEN $2 AND $3) AS novos,
        COUNT(*) FILTER (WHERE is_active=false AND updated_at BETWEEN $2 AND $3) AS saidas
      FROM members WHERE group_jid=$1
    `, [g.group_jid, start, end]);
    const churn = churnRes.rows[0];

    const ativos = Number(msgs.senders);
    const total = Number(g.member_count) || 0;
    grupos.push({
      group_jid: g.group_jid,
      nome: g.name,
      total_membros: total,
      ativos,
      taxa_engajamento: total > 0 ? Math.round((ativos / total) * 1000) / 10 + '%' : '0%',
      total_mensagens: Number(msgs.total_msgs),
      mensagens_media: Number(msgs.media),
      mensagens_replies: Number(msgs.replies),
      novos_membros: Number(churn.novos),
      saidas: Number(churn.saidas),
      saldo: Number(churn.novos) - Number(churn.saidas),
    });
  }

  return { expert, periodo: label, total_grupos: grupos.length, grupos };
}

async function get_engajamento_grupos({ expert, periodo, de, ate }) {
  const expertId = await getExpertId(expert);
  if (!expertId) return { error: `Expert '${expert}' não encontrado` };
  const leadsJids = await getExpertLeadsJids(expertId);
  if (leadsJids.length === 0) return { expert, total_grupos_leads: 0, msg: 'Sem grupos de leads vinculados' };

  const { start, end, label } = resolvePeriodo(periodo, de, ate);
  const db = pool();

  const totals = await db.query(`
    SELECT
      COUNT(*) AS total_messages,
      COUNT(DISTINCT remote_jid) AS unique_senders,
      COUNT(*) FILTER (WHERE message_type IN ('image','video','document','audio','sticker')) AS total_media,
      COUNT(*) FILTER (WHERE is_reply=true) AS total_replies
    FROM messages WHERE group_jid = ANY($1) AND timestamp BETWEEN $2 AND $3
  `, [leadsJids, start, end]);

  const totalMembersRow = await db.query(`SELECT COALESCE(SUM(member_count),0) AS total FROM groups WHERE group_jid = ANY($1)`, [leadsJids]);
  const totalMembers = Number(totalMembersRow.rows[0]?.total || 0);
  const t = totals.rows[0];
  const activeSenders = Number(t.unique_senders);
  const engagementRate = totalMembers > 0
    ? Math.round((activeSenders / totalMembers) * 1000) / 10 + '%'
    : '0%';

  // Top engagers
  const top = await db.query(`
    SELECT push_name, remote_jid,
      COUNT(*) AS msgs,
      COUNT(*) FILTER (WHERE message_type IN ('image','video','document','audio','sticker')) AS media,
      COUNT(*) FILTER (WHERE is_reply=true) AS replies
    FROM messages WHERE group_jid = ANY($1) AND timestamp BETWEEN $2 AND $3
    GROUP BY push_name, remote_jid
    ORDER BY msgs DESC LIMIT 10
  `, [leadsJids, start, end]);

  return {
    expert,
    periodo: label,
    total_grupos_leads: leadsJids.length,
    total_membros: totalMembers,
    total_mensagens: Number(t.total_messages),
    membros_ativos: activeSenders,
    mensagens_media: Number(t.total_media),
    mensagens_replies: Number(t.total_replies),
    taxa_engajamento: engagementRate,
    top_engagers: top.rows.map(r => ({
      nome: r.push_name, msgs: Number(r.msgs), media: Number(r.media), replies: Number(r.replies),
    })),
  };
}

async function get_mensagens_grupos_expert({ expert, periodo, de, ate, limit = 100 }) {
  const expertId = await getExpertId(expert);
  if (!expertId) return { error: `Expert '${expert}' não encontrado` };
  const leadsJids = await getExpertLeadsJids(expertId);
  if (leadsJids.length === 0) return { expert, total: 0, mensagens: [] };

  const { start, end, label } = resolvePeriodo(periodo, de, ate);
  const db = pool();
  const r = await db.query(`
    SELECT g.name AS grupo, m.push_name, m.message_type, m.timestamp, m.content_preview, m.is_reply
    FROM messages m JOIN groups g ON g.group_jid = m.group_jid
    WHERE m.group_jid = ANY($1) AND m.timestamp BETWEEN $2 AND $3
    ORDER BY m.timestamp DESC LIMIT $4
  `, [leadsJids, start, end, limit]);
  return {
    expert, periodo: label,
    total: r.rows.length,
    mensagens: r.rows.map(x => ({
      grupo: x.grupo,
      ts: x.timestamp,
      autor: x.push_name,
      tipo: x.message_type,
      texto: x.content_preview,
      is_reply: x.is_reply,
    })),
  };
}

async function get_churn_grupos_expert({ expert, dias = 7 }) {
  const expertId = await getExpertId(expert);
  if (!expertId) return { error: `Expert '${expert}' não encontrado` };
  const leadsJids = await getExpertLeadsJids(expertId);
  if (leadsJids.length === 0) return { expert, msg: 'Sem grupos de leads' };

  const db = pool();
  const r = await db.query(`
    SELECT g.name AS grupo, g.member_count AS atual,
      COALESCE(SUM(CASE WHEN m.is_active=true AND m.joined_at > NOW() - ($2 || ' days')::interval AND m.joined_at != m.created_at THEN 1 ELSE 0 END), 0) AS new_count,
      COALESCE(SUM(CASE WHEN m.is_active=false AND m.updated_at > NOW() - ($2 || ' days')::interval THEN 1 ELSE 0 END), 0) AS exits_count
    FROM groups g LEFT JOIN members m ON m.group_jid = g.group_jid
    WHERE g.group_jid = ANY($1)
    GROUP BY g.name, g.member_count
  `, [leadsJids, String(dias)]);

  return {
    expert,
    janela_dias: dias,
    grupos: r.rows.map(x => ({
      grupo: x.grupo,
      membros_atual: Number(x.atual),
      novos: Number(x.new_count),
      saidas: Number(x.exits_count),
      saldo: Number(x.new_count) - Number(x.exits_count),
    })),
    total: {
      novos: r.rows.reduce((a, x) => a + Number(x.new_count), 0),
      saidas: r.rows.reduce((a, x) => a + Number(x.exits_count), 0),
    },
  };
}

const MONITORGRUPO_TOOLS = [
  {
    name: 'get_grupos_expert',
    description: 'Lista os grupos WhatsApp vinculados a um expert (separados entre management e leads).',
    input_schema: {
      type: 'object',
      properties: { expert: { type: 'string', description: 'DANI, DEIVID, JUH, etc.' } },
      required: ['expert'],
    },
  },
  {
    name: 'get_engajamento_por_grupo',
    description: 'Métricas SEPARADAS por cada grupo de leads do expert. Retorna lista onde cada item tem: nome, total membros, ativos, mensagens, novos_membros no período, saidas, saldo. Use quando o expert tem múltiplos grupos com leads sobrepostos (DANI tem vários).',
    input_schema: {
      type: 'object',
      properties: {
        expert: { type: 'string' },
        periodo: { type: 'string', enum: ['hoje','ontem','7d','14d','30d','1m','mtd','lastm','3m','custom'] },
        de: { type: 'string' }, ate: { type: 'string' },
      },
      required: ['expert','periodo'],
    },
  },
  {
    name: 'get_engajamento_grupos',
    description: 'Métricas de engajamento agregadas dos grupos de leads do expert: total mensagens, membros ativos, taxa engajamento, top engagers. Use pra avaliar qualidade da lista WhatsApp.',
    input_schema: {
      type: 'object',
      properties: {
        expert: { type: 'string' },
        periodo: { type: 'string', enum: ['hoje','ontem','7d','14d','30d','1m','mtd','lastm','3m','custom'] },
        de: { type: 'string' }, ate: { type: 'string' },
      },
      required: ['expert','periodo'],
    },
  },
  {
    name: 'get_mensagens_grupos_expert',
    description: 'Mensagens reais dos grupos de leads do expert no período. Use pra análise semântica: dúvidas, sentimento, padrões. Limit default 100.',
    input_schema: {
      type: 'object',
      properties: {
        expert: { type: 'string' },
        periodo: { type: 'string', enum: ['hoje','ontem','7d','14d','30d','1m','mtd','lastm','3m','custom'] },
        de: { type: 'string' }, ate: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['expert','periodo'],
    },
  },
  {
    name: 'get_churn_grupos_expert',
    description: 'Entrada e saída de membros dos grupos do expert nos últimos N dias. Detecta grupos saudáveis (crescendo) vs sangrando (perdendo gente).',
    input_schema: {
      type: 'object',
      properties: {
        expert: { type: 'string' },
        dias: { type: 'number', description: 'Default 7' },
      },
      required: ['expert'],
    },
  },
];

const HANDLERS = {
  get_grupos_expert,
  get_engajamento_grupos,
  get_engajamento_por_grupo,
  get_mensagens_grupos_expert,
  get_churn_grupos_expert,
};

async function executeMonitorgrupoTool(name, input) {
  const h = HANDLERS[name];
  if (!h) throw new Error(`monitorgrupo tool desconhecida: ${name}`);
  return await h(input || {});
}

module.exports = { MONITORGRUPO_TOOLS, executeMonitorgrupoTool };
