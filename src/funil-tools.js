/**
 * Tool de funil consolidado por expert — junta TODAS as fontes de dados
 * num único retorno pra Claude analisar onde o funil "fura".
 *
 * Fontes:
 *  - Planilha (gasto Meta, cliques, FTDs registrados, Telegram joins, Net P&L)
 *  - Postbacks Apostatudo (FTDs reais por UTM)
 *  - Klarvel (lives: pico, participantes únicos, mensagens, engajamento)
 *  - monitorgrupo (WhatsApp: total grupos leads, membros ativos, taxa engajamento)
 */

const { executeTool: executeInsightTool } = require('./insights-tools');
const { executeKlarvelTool } = require('./klarvel-tools');
const { executeMonitorgrupoTool } = require('./monitorgrupo-tools');

function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function pct(num, den) {
  if (!den) return null;
  return Math.round((num / den) * 1000) / 10;
}

async function get_funil_expert({ expert, periodo = '7d', de, ate, user_id = 1 }) {
  const errors = [];
  let metricas = null, postbacks = null, klarvel = null, mgrupos = null;

  // Métricas planilha (gasto, FTDs registrados, Net P&L, telegram joins)
  try {
    metricas = await executeInsightTool('get_metricas_expert', { expert, periodo, de, ate, comparar: false }, user_id);
  } catch (e) { errors.push({ fonte: 'planilha', error: e.message }); }

  // Postbacks reais (FTDs tempo real)
  try {
    postbacks = await executeInsightTool('get_postbacks_por_utm', { expert, periodo, de, ate }, user_id);
  } catch (e) { errors.push({ fonte: 'postbacks', error: e.message }); }

  // Klarvel (lives)
  try {
    klarvel = await executeKlarvelTool('get_lives_resumo', { expert, periodo, de, ate });
  } catch (e) { errors.push({ fonte: 'klarvel', error: e.message }); }

  // monitorgrupo (WhatsApp)
  try {
    mgrupos = await executeMonitorgrupoTool('get_engajamento_grupos', { expert, periodo, de, ate });
    if (mgrupos?.error) { errors.push({ fonte: 'monitorgrupo', error: mgrupos.error }); mgrupos = null; }
  } catch (e) { errors.push({ fonte: 'monitorgrupo', error: e.message }); }

  // Cálculo do funil
  const gasto = metricas?.gasto || 0;
  const cliques = metricas?.cliques || 0;
  const cadastros = metricas?.cadastros || 0;
  const ftds_planilha = metricas?.ftds || 0;
  const ftds_real = Number(postbacks?.totais?.ftds || 0);
  const ftd_amount = metricas?.ftdAmount || 0;
  const deposits = metricas?.depositsAmount || 0;
  const telegram_joins = metricas?.telegramJoins || 0;
  const netPL = metricas?.netPL || 0;

  const lives_total = klarvel?.total_lives || 0;
  const lives_participantes = klarvel?.participantes_unicos_soma || 0;
  const lives_engajamento_pct = klarvel?.taxa_engajamento_media || '0%';

  const wpp_total_grupos = mgrupos?.total_grupos_leads || 0;
  const wpp_membros = mgrupos?.total_membros || 0;
  const wpp_ativos = mgrupos?.membros_ativos || 0;
  const wpp_engajamento_pct = mgrupos?.taxa_engajamento || '0%';

  // Funil percentual (drop-off entre etapas)
  const funil = [];
  if (gasto > 0)      funil.push({ etapa: 'Gasto Meta',        valor: round2(gasto), unit: 'R$' });
  if (cliques > 0)    funil.push({ etapa: 'Cliques no Link',   valor: cliques,        custo_por_clique_brl: gasto > 0 ? round2(gasto / cliques) : null });
  if (cadastros > 0)  funil.push({ etapa: 'Cadastros',         valor: cadastros,      conv_clique_para_cadastro_pct: pct(cadastros, cliques) });
  if (telegram_joins > 0) funil.push({ etapa: 'Inscritos Telegram', valor: telegram_joins, conv_cadastro_para_telegram_pct: pct(telegram_joins, cadastros) });
  if (wpp_ativos > 0) funil.push({ etapa: 'Ativos WhatsApp',   valor: wpp_ativos,     do_total_membros_pct: pct(wpp_ativos, wpp_membros) });
  if (lives_participantes > 0) funil.push({ etapa: 'Participantes Lives', valor: lives_participantes });
  funil.push({ etapa: 'FTDs (planilha)', valor: ftds_planilha, conv_cadastro_para_ftd_pct: pct(ftds_planilha, cadastros) });
  funil.push({ etapa: 'FTDs (postback real)', valor: ftds_real, conv_cadastro_para_ftd_pct: pct(ftds_real, cadastros) });

  // CACs reais
  const custoPorFTD = ftds_real > 0 ? round2(gasto / ftds_real) : null;
  const custoPorInscritoTelegram = telegram_joins > 0 ? round2(gasto / telegram_joins) : null;
  const custoPorAtivoWpp = wpp_ativos > 0 ? round2(gasto / wpp_ativos) : null;
  const roi = gasto > 0 ? round2(netPL / gasto) : null;

  // Alertas heurísticos (onde o funil "fura")
  const alertas = [];
  if (gasto > 100 && ftds_real === 0) alertas.push(`🚨 Gastou R$${round2(gasto)} sem nenhum FTD real (postback)`);
  if (cliques > 50 && cadastros === 0) alertas.push(`⚠️ ${cliques} cliques mas 0 cadastros — landing/casa pode estar quebrada`);
  if (cadastros > 5 && telegram_joins === 0) alertas.push(`⚠️ ${cadastros} cadastros mas 0 inscritos Telegram — falha de captação?`);
  if (wpp_membros > 100 && wpp_ativos < wpp_membros * 0.05) alertas.push(`📉 Grupo WhatsApp com baixíssimo engajamento (${wpp_engajamento_pct})`);
  if (lives_total > 0 && lives_participantes < 10) alertas.push(`📺 Lives com audiência baixa (${lives_participantes} participantes em ${lives_total} lives)`);
  if (ftds_planilha !== ftds_real) alertas.push(`🔍 FTDs planilha (${ftds_planilha}) ≠ postback real (${ftds_real}) — divergência na coleta`);
  if (netPL < 0 && gasto > 0) alertas.push(`📉 P&L negativo: R$${round2(netPL)} (ROI ${roi}x)`);

  return {
    expert,
    periodo: metricas?.periodo || periodo,
    funil,
    custo_por_ftd: custoPorFTD,
    custo_por_inscrito_telegram: custoPorInscritoTelegram,
    custo_por_ativo_whatsapp: custoPorAtivoWpp,
    roi,
    net_pl: round2(netPL),
    detalhes: {
      planilha: metricas ? {
        gasto: round2(gasto), cliques, cadastros,
        ftds: ftds_planilha, ftd_amount: round2(ftd_amount),
        deposits: round2(deposits),
        telegram_joins, net_pl: round2(netPL),
      } : null,
      postbacks_real: postbacks ? {
        ftds: ftds_real,
        leads: Number(postbacks.totais?.leads || 0),
        ftd_amount: round2(postbacks.totais?.ftd_payout || 0),
        top_utm: (postbacks.utms || []).slice(0, 5),
      } : null,
      lives: klarvel ? {
        total: lives_total,
        pico_max: klarvel.pico_simultaneos_max,
        pico_medio: klarvel.pico_simultaneos_medio,
        participantes_unicos: lives_participantes,
        mensagens: klarvel.mensagens_total,
        engajamento: lives_engajamento_pct,
      } : null,
      whatsapp: mgrupos ? {
        grupos_leads: wpp_total_grupos,
        membros_total: wpp_membros,
        membros_ativos: wpp_ativos,
        mensagens_total: mgrupos.total_mensagens,
        engajamento: wpp_engajamento_pct,
      } : null,
    },
    alertas: alertas.length > 0 ? alertas : ['nenhum alerta crítico'],
    fontes_indisponiveis: errors.length > 0 ? errors : undefined,
  };
}

function pctVar(curr, prev) {
  if (prev === 0 || prev == null) return curr > 0 ? 100 : 0;
  return round2(((curr - prev) / Math.abs(prev)) * 100);
}

async function get_comparativo_funil(input, userId = 1) {
  const {
    expert_a = 'DANI', expert_b = 'DEIVID',
    periodo_a = '7d', periodo_b = '7d',
    de_a, ate_a, de_b, ate_b,
    modo = 'expert_vs_expert', // ou 'periodo_vs_periodo' (mesmo expert, dois períodos)
  } = input || {};

  let a, b;
  if (modo === 'periodo_vs_periodo') {
    a = await get_funil_expert({ expert: expert_a, periodo: periodo_a, de: de_a, ate: ate_a, user_id: userId });
    b = await get_funil_expert({ expert: expert_a, periodo: periodo_b, de: de_b, ate: ate_b, user_id: userId });
  } else {
    a = await get_funil_expert({ expert: expert_a, periodo: periodo_a, de: de_a, ate: ate_a, user_id: userId });
    b = await get_funil_expert({ expert: expert_b, periodo: periodo_b || periodo_a, de: de_b, ate: ate_b, user_id: userId });
  }

  // Diff em métricas-chave
  const m = (x, path) => path.split('.').reduce((o, k) => (o == null ? 0 : o[k]), x) || 0;
  const diff = {
    gasto_meta: { a: m(a, 'detalhes.planilha.gasto'), b: m(b, 'detalhes.planilha.gasto'), var_pct: pctVar(m(b, 'detalhes.planilha.gasto'), m(a, 'detalhes.planilha.gasto')) },
    cliques: { a: m(a, 'detalhes.planilha.cliques'), b: m(b, 'detalhes.planilha.cliques'), var_pct: pctVar(m(b, 'detalhes.planilha.cliques'), m(a, 'detalhes.planilha.cliques')) },
    cadastros: { a: m(a, 'detalhes.planilha.cadastros'), b: m(b, 'detalhes.planilha.cadastros'), var_pct: pctVar(m(b, 'detalhes.planilha.cadastros'), m(a, 'detalhes.planilha.cadastros')) },
    ftds_real: { a: m(a, 'detalhes.postbacks_real.ftds'), b: m(b, 'detalhes.postbacks_real.ftds'), var_pct: pctVar(m(b, 'detalhes.postbacks_real.ftds'), m(a, 'detalhes.postbacks_real.ftds')) },
    net_pl: { a: a.net_pl, b: b.net_pl, var_pct: pctVar(b.net_pl, a.net_pl) },
    custo_por_ftd: { a: a.custo_por_ftd, b: b.custo_por_ftd, var_pct: pctVar(b.custo_por_ftd, a.custo_por_ftd) },
    roi: { a: a.roi, b: b.roi, var_pct: pctVar(b.roi, a.roi) },
    telegram_joins: { a: m(a, 'detalhes.planilha.telegram_joins'), b: m(b, 'detalhes.planilha.telegram_joins'), var_pct: pctVar(m(b, 'detalhes.planilha.telegram_joins'), m(a, 'detalhes.planilha.telegram_joins')) },
    whatsapp_ativos: { a: m(a, 'detalhes.whatsapp.membros_ativos'), b: m(b, 'detalhes.whatsapp.membros_ativos'), var_pct: pctVar(m(b, 'detalhes.whatsapp.membros_ativos'), m(a, 'detalhes.whatsapp.membros_ativos')) },
    lives_total: { a: m(a, 'detalhes.lives.total'), b: m(b, 'detalhes.lives.total'), var_pct: pctVar(m(b, 'detalhes.lives.total'), m(a, 'detalhes.lives.total')) },
    lives_participantes: { a: m(a, 'detalhes.lives.participantes_unicos'), b: m(b, 'detalhes.lives.participantes_unicos'), var_pct: pctVar(m(b, 'detalhes.lives.participantes_unicos'), m(a, 'detalhes.lives.participantes_unicos')) },
  };

  // Vencedor por métrica (em B vs A — B é o "novo"/"alvo")
  const insights = [];
  if (diff.ftds_real.var_pct >= 30) insights.push(`🚀 B tem ${diff.ftds_real.var_pct}% mais FTDs reais`);
  else if (diff.ftds_real.var_pct <= -30) insights.push(`⚠️ B tem ${Math.abs(diff.ftds_real.var_pct)}% menos FTDs reais`);
  if (diff.custo_por_ftd.a > 0 && diff.custo_por_ftd.b > 0 && diff.custo_por_ftd.var_pct <= -20) insights.push(`💚 B é ${Math.abs(diff.custo_por_ftd.var_pct)}% mais eficiente em custo/FTD`);
  if (diff.roi.a != null && diff.roi.b != null && diff.roi.var_pct >= 30) insights.push(`📈 B tem ROI ${diff.roi.var_pct}% melhor`);

  return {
    modo,
    a: { ...a, label: modo === 'periodo_vs_periodo' ? a.periodo : a.expert },
    b: { ...b, label: modo === 'periodo_vs_periodo' ? b.periodo : b.expert },
    diff,
    insights,
  };
}

const FUNIL_TOOLS = [
  {
    name: 'get_funil_expert',
    description: 'Funil de conversão consolidado de um expert: cruza Gasto Meta + Cliques + Cadastros + Inscritos Telegram + Ativos WhatsApp + Participantes Lives + FTDs reais. Retorna CAC por etapa, ROI, alertas heurísticos. Use quando o operador pedir visão completa de performance ou onde o funil está "furando".',
    input_schema: {
      type: 'object',
      properties: {
        expert: { type: 'string', description: 'DANI, DEIVID, JUH...' },
        periodo: { type: 'string', enum: ['hoje','ontem','7d','14d','30d','1m','mtd','lastm','3m','custom'] },
        de: { type: 'string' }, ate: { type: 'string' },
      },
      required: ['expert'],
    },
  },
];

FUNIL_TOOLS.push({
  name: 'get_comparativo_funil',
  description: 'Compara funil de 2 experts (modo expert_vs_expert) ou do mesmo expert em 2 períodos (modo periodo_vs_periodo). Retorna diff com variação % em cada métrica + insights automáticos.',
  input_schema: {
    type: 'object',
    properties: {
      modo: { type: 'string', enum: ['expert_vs_expert', 'periodo_vs_periodo'], description: 'default expert_vs_expert' },
      expert_a: { type: 'string' },
      expert_b: { type: 'string' },
      periodo_a: { type: 'string', enum: ['hoje','ontem','7d','14d','30d','1m','mtd','lastm','3m','custom'] },
      periodo_b: { type: 'string', enum: ['hoje','ontem','7d','14d','30d','1m','mtd','lastm','3m','custom'] },
      de_a: { type: 'string' }, ate_a: { type: 'string' },
      de_b: { type: 'string' }, ate_b: { type: 'string' },
    },
  },
});

FUNIL_TOOLS.push({
  name: 'get_expert_360',
  description: 'Visão 360 de um expert: funil + Instagram (atividade do dia) + lives + WhatsApp (engajamento grupos) + disparos + concorrentes (se mapeados). Use quando o operador pedir "como tá X hoje?" ou "resumo da DANI". Substitui chamar 5+ tools separadas.',
  input_schema: {
    type: 'object',
    properties: {
      expert: { type: 'string', description: 'DANI, DEIVID, JUH, NUCLEAR' },
      periodo: { type: 'string', enum: ['hoje','ontem','7d','14d','30d','1m','mtd','lastm','3m','custom'], description: 'default: hoje' },
      de: { type: 'string' }, ate: { type: 'string' },
    },
    required: ['expert'],
  },
});

// Helper de safe-await que retorna null em erro (pra não bloquear o 360 inteiro)
async function tryGet(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[expert-360] ${label} falhou:`, err.message);
    return { __error: err.message };
  }
}

async function get_expert_360({ expert, periodo = 'hoje', de, ate, user_id = 1 }) {
  if (!expert) throw new Error('expert obrigatório');

  // Tenta cada fonte em paralelo — uma falha não derruba as outras.
  const { executeInstagramTool } = require('./instagram-tools');
  const { executeApostatudoTool } = require('./apostatudo-tools');

  const [funil, instagram, lives, mensagensWa, disparos, postbacks, apostatudoStats] = await Promise.all([
    tryGet('funil',           () => get_funil_expert({ expert, periodo, de, ate, user_id })),
    tryGet('instagram',       () => executeInstagramTool('get_instagram_atividade_dia', { expert }, user_id)),
    tryGet('lives',           () => executeKlarvelTool('get_lives_resumo', { expert, periodo, de, ate })),
    tryGet('whatsapp_grupos', () => executeMonitorgrupoTool('get_engajamento_grupos', { expert, periodo, de, ate })),
    tryGet('disparos',        () => executeInsightTool('get_disparos_status', { par: expert, periodo, de, ate }, user_id)),
    tryGet('postbacks_utm',   () => executeInsightTool('get_postbacks_por_utm', { expert, periodo, de, ate }, user_id)),
    tryGet('apostatudo',      () => executeApostatudoTool('get_apostatudo_metricas_expert', { expert, periodo, de, ate }, user_id)),
  ]);

  // Insights automáticos rápidos
  const insights = [];
  if (funil?.ftds === 0 && funil?.gasto > 0) insights.push(`Gastou R$ ${funil.gasto?.toFixed?.(2)} hoje e zero FTDs.`);
  if (funil?.cac_ftd > 200) insights.push(`Custo por FTD R$ ${funil.cac_ftd?.toFixed?.(0)} — acima do healthy (R$ 80-150).`);
  if (instagram?.posts_hoje === 0 && instagram?.stories_hoje === 0) insights.push('Sem post nem story hoje no Instagram.');
  if (lives?.total_lives === 0 && new Date().getHours() >= 14) insights.push('Sem live registrada hoje (já passou das 14h).');
  if (disparos?.erro > 0) insights.push(`${disparos.erro} disparos com erro hoje — checar SendPulse.`);
  if (mensagensWa?.mensagens_total === 0) insights.push('Grupos WhatsApp silenciosos hoje (zero mensagens).');

  return {
    expert,
    periodo,
    gerado_em: new Date().toISOString(),
    funil,
    instagram,
    lives,
    whatsapp_grupos: mensagensWa,
    disparos,
    postbacks_utm: postbacks,
    apostatudo: apostatudoStats,
    insights,
  };
}

async function executeFunilTool(name, input, userId = 1) {
  if (name === 'get_funil_expert') return await get_funil_expert({ ...input, user_id: userId });
  if (name === 'get_comparativo_funil') return await get_comparativo_funil(input, userId);
  if (name === 'get_expert_360') return await get_expert_360({ ...input, user_id: userId });
  throw new Error(`Funil tool desconhecida: ${name}`);
}

module.exports = { FUNIL_TOOLS, executeFunilTool };
