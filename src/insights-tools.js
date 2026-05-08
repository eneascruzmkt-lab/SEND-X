const db = require('./db');
const { fetchRelatorioData, extractRow } = require('./routes/relatorio');

// ─── Helpers ───────────────────────────────────────────────────────────────

function nowBRT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function pad(n) { return String(n).padStart(2, '0'); }
function brt(y, m, d, h = 0, mi = 0, s = 0) {
  return new Date(`${y}-${pad(m+1)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}-03:00`);
}
function fmtBR(d) { return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`; }
function round2(n) { return Math.round(Number(n) * 100) / 100; }

function pctVar(curr, prev) {
  if (prev === 0) return curr > 0 ? 100 : 0;
  return round2(((curr - prev) / Math.abs(prev)) * 100);
}

function shiftPeriodBack(periodo, de, ate) {
  // Devolve { periodo, de, ate } para o período anterior de mesma duração
  const map = { ontem: 'custom', '7d': 'custom', '1m': 'lastm', '3m': 'custom' };
  const now = nowBRT();
  const y = now.getFullYear(), m = now.getMonth(), today = now.getDate();
  if (periodo === 'ontem') {
    const ant = new Date(y, m, today - 2);
    return { periodo: 'custom', de: fmtBR(ant), ate: fmtBR(ant) };
  }
  if (periodo === '7d') {
    const e = new Date(y, m, today - 8);
    const s = new Date(e); s.setDate(s.getDate() - 6);
    return { periodo: 'custom', de: fmtBR(s), ate: fmtBR(e) };
  }
  if (periodo === '1m') return { periodo: 'lastm' };
  if (periodo === 'lastm') {
    const e = new Date(y, m - 1, 0);
    const s = new Date(y, m - 2, 1);
    return { periodo: 'custom', de: fmtBR(s), ate: fmtBR(e) };
  }
  if (periodo === '3m') {
    const e = new Date(y, m - 3, 0);
    const s = new Date(y, m - 5, 1);
    return { periodo: 'custom', de: fmtBR(s), ate: fmtBR(e) };
  }
  if (periodo === 'custom' && de && ate) {
    const [d1, m1, y1] = de.split('/').map(Number);
    const [d2, m2, y2] = ate.split('/').map(Number);
    const start = new Date(y1, m1 - 1, d1);
    const end = new Date(y2, m2 - 1, d2);
    const days = Math.round((end - start) / 86_400_000) + 1;
    const prevEnd = new Date(start); prevEnd.setDate(prevEnd.getDate() - 1);
    const prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate() - (days - 1));
    return { periodo: 'custom', de: fmtBR(prevStart), ate: fmtBR(prevEnd) };
  }
  return null;
}

function periodoToTimestampsBRT(periodo, de, ate) {
  const now = nowBRT();
  const y = now.getFullYear(), m = now.getMonth(), today = now.getDate();
  let s, e;
  switch (periodo) {
    case 'hoje':   s = brt(y, m, today);              e = brt(y, m, today, 23, 59, 59); break;
    case 'ontem':  s = brt(y, m, today - 1);          e = brt(y, m, today - 1, 23, 59, 59); break;
    case '7d':     s = brt(y, m, today - 6);          e = brt(y, m, today, 23, 59, 59); break;
    case '14d':    s = brt(y, m, today - 13);         e = brt(y, m, today, 23, 59, 59); break;
    case '30d':    s = brt(y, m, today - 29);         e = brt(y, m, today, 23, 59, 59); break;
    case '1m':     s = brt(y, m, 1);                  e = brt(y, m, today, 23, 59, 59); break;
    case 'lastm':  s = brt(y, m - 1, 1);              e = brt(y, m, 1, 0, 0, 0); e = new Date(e - 1); break;
    case '3m':     s = brt(y, m - 2, 1);              e = brt(y, m, today, 23, 59, 59); break;
    case 'custom': {
      if (!de || !ate) throw new Error('custom requer de+ate');
      const [d1, m1, y1] = de.split('/').map(Number);
      const [d2, m2, y2] = ate.split('/').map(Number);
      s = brt(y1, m1 - 1, d1);
      e = brt(y2, m2 - 1, d2, 23, 59, 59);
      break;
    }
    default: throw new Error(`Período inválido: ${periodo}`);
  }
  return { startTs: s, endTs: e };
}

// ─── Tool definitions (formato Anthropic) ──────────────────────────────────

const COMMON_PERIODO = {
  type: 'object',
  properties: {
    expert: { type: 'string', description: 'Nome do expert (aba): DANI, DEIVID, JUH, NUCLEAR' },
    periodo: { type: 'string', enum: ['hoje','ontem','7d','1m','lastm','3m','custom'], description: 'Período relativo' },
    de: { type: 'string', description: 'DD/MM/YYYY (apenas custom)' },
    ate: { type: 'string', description: 'DD/MM/YYYY (apenas custom)' },
  },
  required: ['expert', 'periodo'],
};

const TOOLS = [
  {
    name: 'get_metricas_expert',
    description: 'Métricas consolidadas de um expert (FTDs, gasto, P&L, ROI, custo/FTD) no período. Inclui automaticamente comparativo com período anterior.',
    input_schema: COMMON_PERIODO,
  },
  {
    name: 'get_metricas_diario',
    description: 'Série dia-a-dia de métricas de um expert. Útil para detectar tendências, picos ou dias ruins.',
    input_schema: COMMON_PERIODO,
  },
  {
    name: 'get_dashboard_overview',
    description: 'Snapshot consolidado do negócio: P&L de ontem vs anteontem vs 7d, total por expert, status dos disparos, alertas. Use quando o usuário fizer pergunta ampla ou pedir visão geral.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_disparos_status',
    description: 'Status dos disparos SendPulse (schedules). Filtra por status, par/expert e período.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pendente','enviado','erro','todos'] },
        par: { type: 'string', description: 'Nome do par (DANI, DEIVID, NUCLEAR). Omitir para todos.' },
        periodo: { type: 'string', enum: ['hoje','ontem','7d','1m','lastm','3m','custom'] },
        de: { type: 'string' }, ate: { type: 'string' },
      },
      required: ['periodo'],
    },
  },
  {
    name: 'get_telegram_growth',
    description: 'Crescimento do canal Telegram de um expert (inscritos por dia da planilha) cruzado com gasto Meta para custo por inscrito.',
    input_schema: COMMON_PERIODO,
  },
  {
    name: 'get_postbacks_por_utm',
    description: 'Performance real de FTDs/leads agregada por UTM source/medium (postbacks da Apostatudo). Use para descobrir qual campanha/criativo está convertendo de verdade.',
    input_schema: COMMON_PERIODO,
  },
];

// ─── Tool implementations ──────────────────────────────────────────────────

async function tool_metricas_expert(input, userId) {
  const { expert, periodo, de, ate } = input;
  const cur = await fetchRelatorioData(userId, expert, periodo, de, ate);
  const prev = shiftPeriodBack(periodo, de, ate);
  let comparativo = null;
  if (prev) {
    try {
      const prevData = await fetchRelatorioData(userId, expert, prev.periodo, prev.de, prev.ate);
      comparativo = {
        periodo_anterior: prevData.periodoLabel,
        gasto_var_pct: pctVar(cur.total.gasto, prevData.total.gasto),
        ftds_var_pct: pctVar(cur.total.ftds, prevData.total.ftds),
        netPL_var_pct: pctVar(cur.total.netPL, prevData.total.netPL),
        custoFTD_var_pct: pctVar(cur.total.custoFTD, prevData.total.custoFTD),
      };
    } catch (e) { /* ignora se não der pra calcular */ }
  }
  return {
    expert,
    periodo: cur.periodoLabel,
    ...cur.total,
    roi: cur.total.gasto > 0 ? round2(cur.total.netPL / cur.total.gasto) : 0,
    comparativo,
  };
}

async function tool_metricas_diario(input, userId) {
  const { expert, periodo, de, ate } = input;
  const cur = await fetchRelatorioData(userId, expert, periodo, de, ate);
  const dias = cur.rawRows.map(row => {
    const r = extractRow(row);
    return {
      data: row[0] || '—',
      gasto: round2(r.gasto),
      cliques: r.cliques,
      cadastros: r.cadastros,
      ftds: r.ftds,
      ftdAmount: round2(r.ftdAmount),
      custoFTD: r.ftds > 0 ? round2(r.gasto / r.ftds) : 0,
      depositsAmount: round2(r.depositsAmount),
      telegramJoins: r.telegramJoins,
      netPL: round2(r.netPL),
    };
  });
  return { expert, periodo: cur.periodoLabel, dias };
}

async function tool_dashboard_overview(_input, userId) {
  const accounts = await db.getAdAccounts(userId);
  const experts = accounts.map(a => a.tab);

  const perExpert = [];
  for (const exp of experts) {
    try {
      const ontem = await fetchRelatorioData(userId, exp, 'ontem');
      const w7    = await fetchRelatorioData(userId, exp, '7d');
      // Anteontem: usa período custom 1 dia antes
      const now = nowBRT();
      const ante = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2);
      const anteData = await fetchRelatorioData(userId, exp, 'custom', fmtBR(ante), fmtBR(ante));

      perExpert.push({
        expert: exp,
        ontem: {
          ftds: ontem.total.ftds,
          gasto: ontem.total.gasto,
          netPL: ontem.total.netPL,
          custoFTD: ontem.total.custoFTD,
        },
        anteontem: {
          ftds: anteData.total.ftds,
          gasto: anteData.total.gasto,
          netPL: anteData.total.netPL,
        },
        ultimos_7d: {
          ftds: w7.total.ftds,
          gasto: w7.total.gasto,
          netPL: w7.total.netPL,
          custoFTD: w7.total.custoFTD,
        },
        var_netPL_pct: pctVar(ontem.total.netPL, anteData.total.netPL),
        var_ftds_pct: pctVar(ontem.total.ftds, anteData.total.ftds),
      });
    } catch (e) {
      perExpert.push({ expert: exp, error: e.message });
    }
  }

  // Disparos
  const allSchedules = await db.getAllSchedules(null, userId);
  const now = nowBRT();
  const ago7d = new Date(now); ago7d.setDate(ago7d.getDate() - 7);
  const in24h = new Date(now); in24h.setHours(in24h.getHours() + 24);
  const pendentes24h = allSchedules.filter(s =>
    s.status === 'pendente' && new Date(s.scheduled_at) >= now && new Date(s.scheduled_at) <= in24h
  ).length;
  const erros7d = allSchedules.filter(s =>
    s.status === 'erro' && new Date(s.scheduled_at) >= ago7d
  ).length;

  // Alertas heurísticos
  const alertas = [];
  for (const e of perExpert) {
    if (e.error) continue;
    if (e.ontem.gasto > 0 && e.ontem.ftds === 0) {
      alertas.push(`🚨 ${e.expert}: gastou R$${e.ontem.gasto} ontem sem nenhum FTD`);
    }
    if (e.ontem.custoFTD > 0 && e.ultimos_7d.custoFTD > 0 && e.ontem.custoFTD > e.ultimos_7d.custoFTD * 1.5) {
      alertas.push(`⚠️ ${e.expert}: custo/FTD ontem (R$${e.ontem.custoFTD}) está 50%+ acima da média 7d (R$${e.ultimos_7d.custoFTD})`);
    }
    if (e.ontem.netPL < 0) {
      alertas.push(`📉 ${e.expert}: P&L negativo ontem (R$${e.ontem.netPL})`);
    }
  }
  if (erros7d > 0) alertas.push(`✉️ ${erros7d} disparo(s) com erro nos últimos 7 dias`);

  return {
    gerado_em: now.toISOString(),
    por_expert: perExpert,
    disparos: { pendentes_24h: pendentes24h, erros_7d: erros7d },
    alertas: alertas.length > 0 ? alertas : ['nenhum alerta'],
  };
}

async function tool_disparos_status(input, userId) {
  const { status = 'todos', par, periodo, de, ate } = input;
  const { startTs, endTs } = periodoToTimestampsBRT(periodo, de, ate);
  const pares = await db.getAllPares(userId);
  const parId = par ? pares.find(p => p.nome.toUpperCase() === par.toUpperCase())?.id : null;
  if (par && !parId) {
    return { error: `Par '${par}' não encontrado`, pares_disponiveis: pares.map(p => p.nome) };
  }

  const all = await db.getAllSchedules(status === 'todos' ? null : status, userId);
  const filtered = all.filter(s => {
    const t = new Date(s.scheduled_at);
    if (t < startTs || t > endTs) return false;
    if (parId && s.par_id !== parId) return false;
    return true;
  });

  const parMap = new Map(pares.map(p => [p.id, p.nome]));
  const stats = filtered.reduce((acc, s) => {
    acc.total++;
    acc.por_status[s.status] = (acc.por_status[s.status] || 0) + 1;
    const k = parMap.get(s.par_id) || 'sem_par';
    acc.por_par[k] = (acc.por_par[k] || 0) + 1;
    return acc;
  }, { total: 0, por_status: {}, por_par: {} });

  return {
    periodo: `${fmtBR(startTs)} — ${fmtBR(endTs)}`,
    stats,
    schedules: filtered.slice(0, 50).map(s => ({
      id: s.id,
      par: parMap.get(s.par_id),
      content_type: s.content_type,
      scheduled_at: s.scheduled_at,
      status: s.status,
      error_msg: s.error_msg,
    })),
  };
}

async function tool_telegram_growth(input, userId) {
  const cur = await tool_metricas_diario(input, userId);
  const totalInscritos = cur.dias.reduce((s, d) => s + d.telegramJoins, 0);
  const totalGasto = cur.dias.reduce((s, d) => s + d.gasto, 0);
  return {
    expert: input.expert,
    periodo: cur.periodo,
    total_inscritos: totalInscritos,
    total_gasto: round2(totalGasto),
    custo_por_inscrito: totalInscritos > 0 ? round2(totalGasto / totalInscritos) : 0,
    dias: cur.dias.map(d => ({
      data: d.data,
      inscritos: d.telegramJoins,
      gasto: d.gasto,
      custo_por_inscrito: d.telegramJoins > 0 ? round2(d.gasto / d.telegramJoins) : 0,
    })),
  };
}

async function tool_postbacks_por_utm(input, userId) {
  const { expert, periodo, de, ate } = input;
  const { startTs, endTs } = periodoToTimestampsBRT(periodo, de, ate);
  const utms = await db.getPostbacksByUtm(userId, expert, startTs, endTs);
  const totalLeads = utms.reduce((s, u) => s + Number(u.leads), 0);
  const totalFtds = utms.reduce((s, u) => s + Number(u.ftds), 0);
  const totalPayout = utms.reduce((s, u) => s + Number(u.ftd_payout), 0);
  return {
    expert,
    periodo: `${fmtBR(startTs)} — ${fmtBR(endTs)}`,
    totais: { leads: totalLeads, ftds: totalFtds, ftd_payout: round2(totalPayout) },
    breakdown: utms.map(u => ({
      utm_source: u.utm_source,
      utm_medium: u.utm_medium,
      leads: Number(u.leads),
      ftds: Number(u.ftds),
      ftd_payout: round2(Number(u.ftd_payout)),
    })),
  };
}

const HANDLERS = {
  get_metricas_expert: tool_metricas_expert,
  get_metricas_diario: tool_metricas_diario,
  get_dashboard_overview: tool_dashboard_overview,
  get_disparos_status: tool_disparos_status,
  get_telegram_growth: tool_telegram_growth,
  get_postbacks_por_utm: tool_postbacks_por_utm,
};

async function executeTool(name, input, userId) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`Tool desconhecida: ${name}`);
  return await handler(input || {}, userId);
}

module.exports = { TOOLS, executeTool };
