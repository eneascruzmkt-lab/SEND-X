/**
 * Apostatudo Admin API — integração focada em leads por expert.
 *
 * A API expõe TUDO sobre cadastros, FTDs, transações e atividade dos
 * usuários da casa. O foco aqui é cruzar com nosso mapping expert↔afiliado
 * pra responder perguntas tipo:
 *  - "quais leads da DANI já depositaram hoje?"
 *  - "quem é o lead mais ativo do DEIVID?"
 *  - "quantos FTDs vieram via aff_link X esta semana?"
 *
 * Auth: X-Admin-Key (env APO_ADMIN_KEY).
 * Base: http://187.77.33.58:3000
 */

const db = require('./db');

const APO_BASE = process.env.APO_BASE_URL || 'http://187.77.33.58:3000';

function getKey() {
  const k = process.env.APO_ADMIN_KEY;
  if (!k) throw new Error('APO_ADMIN_KEY não configurada');
  return k;
}

async function apo(path, init = {}) {
  const r = await fetch(`${APO_BASE}${path}`, {
    ...init,
    headers: {
      'X-Admin-Key': getKey(),
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`Apostatudo ${path} ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}

function brlFromCents(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

// ─── Resolve UTM/aff_link → expert ─────────────────────────────────────────

async function resolveExpertFromLead(userId, lead) {
  const affId = lead.recommended_by;
  const affLink = lead.reg_aff_link;
  if (!affId && !affLink) return null;
  // Remove query string do aff_link pra normalizar
  const linkBase = affLink ? affLink.split('?')[0] : null;
  const map = await db.getApostatudoMapByAffiliate(userId, affId, linkBase);
  return map?.expert || null;
}

// ─── Tools genéricas (apenas leitura da API) ───────────────────────────────

async function getStats() {
  return apo('/admin/stats');
}

async function listAffiliates() {
  return apo('/admin/affiliates');
}

async function listAffiliatesByLink() {
  return apo('/admin/affiliates-by-link');
}

async function getAffiliateMetrics(from, to) {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const qs = params.toString();
  return apo(`/admin/affiliate-metrics${qs ? '?' + qs : ''}`);
}

// ─── Tools por expert (cruzam mapping) ─────────────────────────────────────

async function getApostatudoMapeamento({ user_id = 1 } = {}) {
  const map = await db.listApostatudoMap(user_id);
  return {
    total: map.length,
    mapeamentos: map.map(m => ({
      expert: m.expert,
      affiliate_id: m.affiliate_id,
      aff_link: m.aff_link,
      utm_source: m.utm_source,
      label: m.label,
    })),
  };
}

async function listarAfiliadosDescoberta() {
  // Lista os top afiliados com volume — pra o operador identificar quais são de cada expert
  const [byId, byLink] = await Promise.all([
    listAffiliates(),
    listAffiliatesByLink(),
  ]);
  return {
    top_por_affiliate_id: (byId.data || []).slice(0, 30),
    top_por_aff_link: (byLink.data || []).slice(0, 30),
  };
}

async function getFtdsExpert({ expert, user_id = 1, limit = 50 }) {
  const mapping = await db.listApostatudoMap(user_id);
  const expertMap = mapping.filter(m => m.expert.toUpperCase() === expert.toUpperCase());
  if (expertMap.length === 0) {
    return { error: `Expert '${expert}' não tem afiliado Apostatudo mapeado. Use mapear_apostatudo_expert primeiro.` };
  }
  const affIds = new Set(expertMap.map(m => m.affiliate_id).filter(Boolean));

  // Coleta FTDs por afiliado: percorre cada mapeamento e busca leads
  const ftdsMap = new Map(); // player_id → ftd info (dedup)

  // Via aff_link (busca leads do link e filtra quem tem ftd_value_cents)
  for (const m of expertMap) {
    if (m.aff_link) {
      try {
        const r = await apo(`/admin/affiliates-by-link/leads?aff_link=${encodeURIComponent(m.aff_link)}&limit=500`);
        for (const lead of r.data || []) {
          if (lead.ftd_value_cents && !ftdsMap.has(lead.id)) {
            ftdsMap.set(lead.id, {
              player_id: lead.id, email: lead.email, name: lead.name,
              ftd_at_str: lead.ftd_date,
              ftd_amount_cents: lead.ftd_value_cents,
              recommended_by: lead.recommended_by,
              affiliation_code: lead.reg_affiliation_code,
            });
          }
        }
      } catch (e) { /* skip */ }
    }
  }

  // Via affiliate_id (busca FTDs globais e filtra)
  if (affIds.size > 0) {
    try {
      const all = await apo(`/admin/ftds?limit=500`);
      for (const f of all.data || []) {
        if (f.recommended_by && affIds.has(f.recommended_by) && !ftdsMap.has(f.player_id)) {
          ftdsMap.set(f.player_id, f);
        }
      }
    } catch (e) { /* skip */ }
  }

  const allFtds = [...ftdsMap.values()].sort((a, b) =>
    new Date(b.ftd_at_str || 0) - new Date(a.ftd_at_str || 0)
  );
  const ftds = allFtds.slice(0, limit);
  const volumeCents = allFtds.reduce((a, f) => a + (Number(f.ftd_amount_cents) || 0), 0);

  return {
    expert,
    total_ftds: allFtds.length,
    volume_brl: brlFromCents(volumeCents),
    ticket_medio_brl: allFtds.length ? brlFromCents(volumeCents / allFtds.length) : '0',
    ftds: ftds.map(f => ({
      apostatudo_user_id: f.player_id,
      email: f.email,
      nome: f.name,
      ftd_em: f.ftd_at_str,
      valor_brl: brlFromCents(f.ftd_amount_cents),
      affiliate_id: f.recommended_by,
    })),
  };
}

async function getMetricasExpertApostatudo({ expert, from, to, user_id = 1 }) {
  const mapping = await db.listApostatudoMap(user_id);
  const expertMap = mapping.filter(m => m.expert.toUpperCase() === expert.toUpperCase());
  if (expertMap.length === 0) return { error: `Expert '${expert}' não tem afiliado Apostatudo mapeado.` };
  const affLinksDoExpert = new Set(
    expertMap.map(m => (m.aff_link || '').split('?')[0]).filter(Boolean)
  );

  const m = await getAffiliateMetrics(from, to);
  const todos = m.by_affiliate || [];
  const doExpert = todos.filter(a => affLinksDoExpert.has(a.affiliate));

  // Totaliza
  const totais = doExpert.reduce((acc, a) => {
    for (const k of ['success', 'dup', 'error', 'validation', 'proxy', 'ftds']) {
      acc[k] = (acc[k] || 0) + (a.totals?.[k] || 0);
    }
    return acc;
  }, {});

  return {
    expert,
    periodo: m.range,
    aff_links_mapeados: affLinksDoExpert.size,
    aff_links_encontrados_na_api: doExpert.length,
    totais_expert: totais,
    detalhe_por_aff_link: doExpert.map(a => ({
      aff_link: a.affiliate,
      totals: a.totals,
      utm_tree: a.variant_rows?.length || 0,
    })),
  };
}

async function getAtividadeLead({ apostatudo_user_id }) {
  const player = await apo(`/admin/players/${apostatudo_user_id}`);
  const wallet = await apo(`/admin/players/${apostatudo_user_id}/wallet-history?limit=50`).catch(() => ({ data: [] }));
  const txs = await apo(`/admin/transactions?player_id=${apostatudo_user_id}&limit=20`).catch(() => ({ data: [] }));
  return {
    player_id: player.id,
    nome: player.name,
    email: player.email,
    phone: player.phone,
    cadastro_em: player.apostatudo_created_at,
    affiliate_id: player.recommended_by,
    aff_link: player.reg_aff_link,
    saldo_atual_brl: brlFromCents(player.latest_wallet?.balance_cents),
    ftd: player.ftd ? {
      data: player.ftd.ftd_at_str,
      valor_brl: brlFromCents(player.ftd.ftd_amount_cents),
    } : null,
    historico_saldo: (wallet.data || []).slice(0, 20).map(w => ({
      em: new Date(w.captured_at).toISOString(),
      saldo_brl: brlFromCents(w.balance_cents),
      bonus_brl: brlFromCents(w.bonus_cents),
    })),
    transacoes_recentes: (txs.data || []).slice(0, 10).map(t => ({
      tipo: t.type, status: t.status, valor_brl: brlFromCents(t.amount_cents),
      metodo: t.method, criada_em: t.created_at, aprovada_em: t.approved_at,
    })),
  };
}

async function getTopLeadsExpert({ expert, user_id = 1, limit = 20 }) {
  const mapping = await db.listApostatudoMap(user_id);
  const expertMap = mapping.filter(m => m.expert.toUpperCase() === expert.toUpperCase());
  if (expertMap.length === 0) return { error: `Expert '${expert}' não tem afiliado mapeado.` };

  const leads = [];
  for (const m of expertMap) {
    if (m.affiliate_id) {
      try {
        const r = await apo(`/admin/affiliates/${m.affiliate_id}/leads?limit=500`);
        leads.push(...(r.data || []));
      } catch (e) { /* skip */ }
    }
    if (m.aff_link) {
      try {
        const r = await apo(`/admin/affiliates-by-link/leads?aff_link=${encodeURIComponent(m.aff_link)}&limit=500`);
        leads.push(...(r.data || []));
      } catch (e) { /* skip */ }
    }
  }
  // Dedup por id
  const dedup = new Map();
  for (const l of leads) if (!dedup.has(l.id)) dedup.set(l.id, l);
  const all = [...dedup.values()];

  // Ordena por ftd_value_cents desc (top depositadores)
  all.sort((a, b) => (b.ftd_value_cents || 0) - (a.ftd_value_cents || 0));

  return {
    expert,
    total_leads_unicos: all.length,
    com_ftd: all.filter(l => l.ftd_value_cents).length,
    top: all.slice(0, limit).map(l => ({
      apostatudo_user_id: l.id,
      nome: l.name,
      email: l.email,
      telefone: l.phone,
      ftd_brl: l.ftd_value_cents ? brlFromCents(l.ftd_value_cents) : null,
      ftd_em: l.ftd_date,
      cadastro_em: l.apostatudo_created_at,
      ultimo_acesso: l.last_seen_at ? new Date(l.last_seen_at).toISOString() : null,
      total_logins: l.login_count,
    })),
  };
}

async function getResumoGeral() {
  const [stats, source] = await Promise.all([
    apo('/admin/stats'),
    apo('/admin/source-breakdown').catch(() => ({ data: [] })),
  ]);
  // Deposits aprovados
  const depAprovados = (stats.transactions || []).find(t => t.type === 'deposit' && t.status === 'approved');
  return {
    players: stats.players,
    depositos_aprovados: depAprovados ? {
      quantidade: depAprovados.n,
      volume_brl: brlFromCents(depAprovados.total),
    } : null,
    transacoes_summary: stats.transactions,
    breakdown_origem: source.data,
  };
}

// ─── MCP tools ─────────────────────────────────────────────────────────────

const APOSTATUDO_TOOLS = [
  {
    name: 'get_apostatudo_mapeamento',
    description: 'Lista o mapeamento atual entre experts (DANI/DEIVID/JUH) e os afiliados/aff_links na casa Apostatudo. Sem isso as outras tools de expert não funcionam.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'listar_afiliados_apostatudo_descoberta',
    description: 'Lista todos os afiliados (por affiliate_id E por aff_link) detectados na Apostatudo. Use pra descobrir quais afiliados pertencem a cada expert antes de mapear.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'mapear_apostatudo_expert',
    description: 'Vincula um expert a um affiliate_id ou aff_link da Apostatudo. A partir desse mapeamento todas as queries por expert funcionam.',
    input_schema: {
      type: 'object',
      properties: {
        expert: { type: 'string', description: 'DANI, DEIVID, JUH...' },
        affiliate_id: { type: 'string', description: 'Código numérico do afiliado (opcional se passar aff_link)' },
        aff_link: { type: 'string', description: 'URL completa do aff_link sem query string (opcional se passar affiliate_id)' },
        utm_source: { type: 'string' },
        label: { type: 'string' },
      },
      required: ['expert'],
    },
  },
  {
    name: 'get_apostatudo_ftds_expert',
    description: 'FTDs (primeiros depósitos) dos leads do expert: volume total, ticket médio, lista dos últimos com nome/email/valor/data.',
    input_schema: {
      type: 'object',
      properties: { expert: { type: 'string' }, limit: { type: 'number' } },
      required: ['expert'],
    },
  },
  {
    name: 'get_apostatudo_metricas_expert',
    description: 'Métricas diárias por aff_link do expert: cadastros success/dup/error/validation/proxy + FTDs. Use pra avaliar ROAS e detectar UTM com problema.',
    input_schema: {
      type: 'object',
      properties: {
        expert: { type: 'string' },
        from: { type: 'string', description: 'YYYY-MM-DD' },
        to: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['expert'],
    },
  },
  {
    name: 'get_apostatudo_top_leads_expert',
    description: 'Top leads do expert ordenados por valor depositado. Mostra quem é o maior depositante, total de leads únicos e quantos converteram.',
    input_schema: {
      type: 'object',
      properties: { expert: { type: 'string' }, limit: { type: 'number' } },
      required: ['expert'],
    },
  },
  {
    name: 'get_apostatudo_atividade_lead',
    description: 'Atividade detalhada de UM lead: saldo atual, histórico de saldo, FTD, transações recentes.',
    input_schema: {
      type: 'object',
      properties: { apostatudo_user_id: { type: 'number' } },
      required: ['apostatudo_user_id'],
    },
  },
  {
    name: 'get_apostatudo_resumo_geral',
    description: 'Visão geral do funil na Apostatudo: total players, DAU/WAU/MAU, volume de depósitos aprovados, breakdown login vs register.',
    input_schema: { type: 'object', properties: {} },
  },
];

async function executeApostatudoTool(name, input, userId = 1) {
  switch (name) {
    case 'get_apostatudo_mapeamento': return getApostatudoMapeamento({ user_id: userId });
    case 'listar_afiliados_apostatudo_descoberta': return listarAfiliadosDescoberta();
    case 'mapear_apostatudo_expert':
      if (!input.affiliate_id && !input.aff_link) throw new Error('Precisa affiliate_id OU aff_link');
      const m = await db.upsertApostatudoMap(userId, input);
      return { ok: true, mapeamento: m };
    case 'get_apostatudo_ftds_expert': return getFtdsExpert({ ...input, user_id: userId });
    case 'get_apostatudo_metricas_expert': return getMetricasExpertApostatudo({ ...input, user_id: userId });
    case 'get_apostatudo_top_leads_expert': return getTopLeadsExpert({ ...input, user_id: userId });
    case 'get_apostatudo_atividade_lead': return getAtividadeLead(input);
    case 'get_apostatudo_resumo_geral': return getResumoGeral();
    default: throw new Error(`Apostatudo tool desconhecida: ${name}`);
  }
}

module.exports = {
  apo, getStats, listAffiliates, listAffiliatesByLink,
  getAffiliateMetrics, resolveExpertFromLead,
  APOSTATUDO_TOOLS, executeApostatudoTool,
};
