/**
 * Meta Ads tools (campaign / adset / ad level) via Graph API.
 *
 * Por que existir: a tabela `ad_accounts` mapeia expert → ad_account_id, e a
 * planilha agrega gasto diário no nível conta. Pra entender quem performa,
 * qual criativo escala, qual adset precisa pausar — precisamos do nível
 * campaign/adset/ad. Essa lib expõe isso pro bridge MCP.
 *
 * Dependências (env):
 *  - FB_ACCESS_TOKEN — token com escopo ads_read (já usado por instagram-tools / research-tools)
 *
 * Mapeamento expert → ad_account_id vem de db.getAdAccounts(userId) — mesma
 * tabela usada pelo dashboard. user_id default = 1 (owner principal Aytalo).
 */

const db = require('./db');

const GRAPH_API = 'https://graph.facebook.com/v21.0';

function token() {
  const t = process.env.FB_ACCESS_TOKEN;
  if (!t) throw new Error('FB_ACCESS_TOKEN não configurado no servidor');
  return t;
}

// ── Período → since/until (formato YYYY-MM-DD, BRT) ─────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function nowBRT() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })); }
function parseBR(s) {
  if (!s) return null;
  const [d, m, y] = s.split('/').map(Number);
  return ymd(new Date(y, m - 1, d));
}
function resolveTimeRange(periodo, de, ate) {
  const now = nowBRT();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let since, until, label = periodo;
  switch (periodo) {
    case 'hoje':  since = until = ymd(today); break;
    case 'ontem': {
      const y = new Date(today); y.setDate(y.getDate() - 1);
      since = until = ymd(y); break;
    }
    case '7d': {
      const s = new Date(today); s.setDate(s.getDate() - 6);
      since = ymd(s); until = ymd(today); break;
    }
    case '14d': {
      const s = new Date(today); s.setDate(s.getDate() - 13);
      since = ymd(s); until = ymd(today); break;
    }
    case '30d': {
      const s = new Date(today); s.setDate(s.getDate() - 29);
      since = ymd(s); until = ymd(today); break;
    }
    case '1m':
    case 'mtd': {
      since = ymd(new Date(today.getFullYear(), today.getMonth(), 1));
      until = ymd(today); break;
    }
    case 'lastm': {
      const s = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const e = new Date(today.getFullYear(), today.getMonth(), 0);
      since = ymd(s); until = ymd(e); break;
    }
    case '3m': {
      const s = new Date(today.getFullYear(), today.getMonth() - 2, 1);
      since = ymd(s); until = ymd(today); break;
    }
    case 'custom':
      since = parseBR(de); until = parseBR(ate);
      if (!since || !until) throw new Error('periodo=custom exige de e ate em DD/MM/YYYY');
      label = `${de}–${ate}`;
      break;
    default: {
      // default 7d
      const s = new Date(today); s.setDate(s.getDate() - 6);
      since = ymd(s); until = ymd(today);
      label = '7d';
    }
  }
  return { since, until, label };
}

// ── Resolver expert → ad_account_id ─────────────────────────────────────────
async function adAccountForExpert(expert, userId) {
  const accounts = await db.getAdAccounts(userId);
  const upper = (expert || '').toUpperCase();
  const found = accounts.find(a => (a.tab || '').toUpperCase() === upper);
  if (!found) {
    const disponiveis = accounts.map(a => a.tab).join(', ') || '(nenhum mapeado)';
    throw new Error(`Expert "${expert}" não tem ad_account mapeado. Disponíveis: ${disponiveis}`);
  }
  // ad_account_id pode estar como "act_xxx" ou só "xxx" — normaliza
  const raw = found.ad_account_id;
  return raw.startsWith('act_') ? raw : `act_${raw}`;
}

// ── HTTP helper ─────────────────────────────────────────────────────────────
async function graphGet(path, params) {
  const url = new URL(`${GRAPH_API}${path}`);
  url.searchParams.set('access_token', token());
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(25_000) });
  const text = await resp.text();
  if (!resp.ok) {
    let detail = text;
    try { detail = JSON.stringify(JSON.parse(text).error || text); } catch {}
    throw new Error(`Graph API ${resp.status}: ${detail.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

// ── Insights — campos comuns ────────────────────────────────────────────────
const INSIGHTS_FIELDS = [
  'spend', 'impressions', 'clicks', 'reach', 'frequency',
  'cpm', 'cpc', 'ctr',
  'actions', 'action_values', 'cost_per_action_type',
].join(',');

function summarizeInsights(row) {
  if (!row) return null;
  const actions = Array.isArray(row.actions) ? row.actions : [];
  const pickAction = (type) => {
    const a = actions.find(x => x.action_type === type);
    return a ? Number(a.value) : 0;
  };
  return {
    spend_brl: Number(row.spend || 0),
    impressions: Number(row.impressions || 0),
    clicks: Number(row.clicks || 0),
    reach: Number(row.reach || 0),
    frequency: Number(row.frequency || 0),
    cpm: Number(row.cpm || 0),
    cpc: Number(row.cpc || 0),
    ctr: Number(row.ctr || 0),
    landing_page_views: pickAction('landing_page_view'),
    leads: pickAction('lead'),
    link_clicks: pickAction('link_click'),
    messaging_conversations_started: pickAction('onsite_conversion.messaging_conversation_started_7d'),
  };
}

// ── Tools ───────────────────────────────────────────────────────────────────

async function getMetaAdsCampaigns({ expert, periodo = '7d', de, ate, status = 'ACTIVE', limit = 50 }, userId) {
  const act = await adAccountForExpert(expert, userId);
  const { since, until, label } = resolveTimeRange(periodo, de, ate);

  // Lista campanhas (status filter via effective_status)
  const effectiveFilter = status === 'ALL'
    ? undefined
    : { effective_status: [status === 'ACTIVE' ? 'ACTIVE' : status] };
  const campaigns = await graphGet(`/${act}/campaigns`, {
    fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time',
    limit,
    filtering: effectiveFilter ? [{ field: 'effective_status', operator: 'IN', value: [status] }] : undefined,
  });

  if (!campaigns.data || campaigns.data.length === 0) {
    return { expert, periodo: label, ad_account: act, total: 0, campaigns: [], msg: `Sem campanhas com status=${status}` };
  }

  // Insights agregados por campanha — chamada única usando level=campaign
  const insights = await graphGet(`/${act}/insights`, {
    level: 'campaign',
    fields: `campaign_id,campaign_name,${INSIGHTS_FIELDS}`,
    time_range: { since, until },
    limit: 500,
  });
  const byId = new Map();
  for (const r of insights.data || []) {
    byId.set(r.campaign_id, summarizeInsights(r));
  }

  const rows = campaigns.data.map(c => {
    const m = byId.get(c.id) || {};
    return {
      campaign_id: c.id,
      name: c.name,
      status: c.status,
      effective_status: c.effective_status,
      objective: c.objective,
      daily_budget_brl: c.daily_budget ? Number(c.daily_budget) / 100 : null,
      lifetime_budget_brl: c.lifetime_budget ? Number(c.lifetime_budget) / 100 : null,
      spend_brl: m.spend_brl || 0,
      impressions: m.impressions || 0,
      clicks: m.clicks || 0,
      cpm: m.cpm || 0,
      cpc: m.cpc || 0,
      ctr: m.ctr || 0,
      landing_page_views: m.landing_page_views || 0,
      leads: m.leads || 0,
      messaging_conversations_started: m.messaging_conversations_started || 0,
    };
  });

  // Ordena por gasto desc
  rows.sort((a, b) => b.spend_brl - a.spend_brl);

  const totals = rows.reduce((acc, r) => {
    acc.spend_brl += r.spend_brl;
    acc.impressions += r.impressions;
    acc.clicks += r.clicks;
    acc.landing_page_views += r.landing_page_views;
    acc.leads += r.leads;
    return acc;
  }, { spend_brl: 0, impressions: 0, clicks: 0, landing_page_views: 0, leads: 0 });
  totals.spend_brl = Number(totals.spend_brl.toFixed(2));

  return { expert, periodo: label, ad_account: act, total: rows.length, totals, campaigns: rows };
}

async function getMetaAdsAdsets({ expert, campaign_id, periodo = '7d', de, ate, status = 'ACTIVE', limit = 100 }, userId) {
  const act = await adAccountForExpert(expert, userId);
  const { since, until, label } = resolveTimeRange(periodo, de, ate);

  // Se campaign_id veio, lista adsets dessa campaign. Senão, todos da conta.
  const baseFilter = status === 'ALL' ? undefined : [{ field: 'effective_status', operator: 'IN', value: [status] }];
  const path = campaign_id ? `/${campaign_id}/adsets` : `/${act}/adsets`;
  const adsets = await graphGet(path, {
    fields: 'id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,optimization_goal,billing_event,targeting',
    limit,
    filtering: baseFilter,
  });

  if (!adsets.data || adsets.data.length === 0) {
    return { expert, periodo: label, ad_account: act, campaign_id: campaign_id || null, total: 0, adsets: [], msg: `Sem adsets` };
  }

  const insights = await graphGet(`/${act}/insights`, {
    level: 'adset',
    fields: `adset_id,adset_name,${INSIGHTS_FIELDS}`,
    time_range: { since, until },
    filtering: campaign_id ? [{ field: 'campaign.id', operator: 'EQUAL', value: campaign_id }] : undefined,
    limit: 500,
  });
  const byId = new Map();
  for (const r of insights.data || []) byId.set(r.adset_id, summarizeInsights(r));

  const rows = adsets.data.map(a => {
    const m = byId.get(a.id) || {};
    return {
      adset_id: a.id,
      name: a.name,
      status: a.status,
      effective_status: a.effective_status,
      campaign_id: a.campaign_id,
      daily_budget_brl: a.daily_budget ? Number(a.daily_budget) / 100 : null,
      lifetime_budget_brl: a.lifetime_budget ? Number(a.lifetime_budget) / 100 : null,
      optimization_goal: a.optimization_goal,
      billing_event: a.billing_event,
      spend_brl: m.spend_brl || 0,
      impressions: m.impressions || 0,
      clicks: m.clicks || 0,
      cpm: m.cpm || 0,
      cpc: m.cpc || 0,
      ctr: m.ctr || 0,
      landing_page_views: m.landing_page_views || 0,
      leads: m.leads || 0,
    };
  });
  rows.sort((a, b) => b.spend_brl - a.spend_brl);

  return { expert, periodo: label, ad_account: act, campaign_id: campaign_id || null, total: rows.length, adsets: rows };
}

async function getMetaAdsAds({ expert, adset_id, campaign_id, periodo = '7d', de, ate, status = 'ACTIVE', limit = 100 }, userId) {
  const act = await adAccountForExpert(expert, userId);
  const { since, until, label } = resolveTimeRange(periodo, de, ate);

  const baseFilter = status === 'ALL' ? undefined : [{ field: 'effective_status', operator: 'IN', value: [status] }];
  const path = adset_id ? `/${adset_id}/ads` : `/${act}/ads`;
  const ads = await graphGet(path, {
    fields: 'id,name,status,effective_status,adset_id,campaign_id,creative{id,name,thumbnail_url,image_url,object_story_spec},preview_shareable_link',
    limit,
    filtering: baseFilter,
  });

  if (!ads.data || ads.data.length === 0) {
    return { expert, periodo: label, ad_account: act, total: 0, ads: [], msg: 'Sem ads' };
  }

  const filtering = [];
  if (campaign_id) filtering.push({ field: 'campaign.id', operator: 'EQUAL', value: campaign_id });
  if (adset_id) filtering.push({ field: 'adset.id', operator: 'EQUAL', value: adset_id });
  const insights = await graphGet(`/${act}/insights`, {
    level: 'ad',
    fields: `ad_id,ad_name,${INSIGHTS_FIELDS}`,
    time_range: { since, until },
    filtering: filtering.length > 0 ? filtering : undefined,
    limit: 500,
  });
  const byId = new Map();
  for (const r of insights.data || []) byId.set(r.ad_id, summarizeInsights(r));

  const rows = ads.data.map(ad => {
    const m = byId.get(ad.id) || {};
    const cr = ad.creative || {};
    return {
      ad_id: ad.id,
      name: ad.name,
      status: ad.status,
      effective_status: ad.effective_status,
      adset_id: ad.adset_id,
      campaign_id: ad.campaign_id,
      creative_id: cr.id,
      creative_name: cr.name,
      thumbnail_url: cr.thumbnail_url,
      image_url: cr.image_url,
      preview_link: ad.preview_shareable_link,
      spend_brl: m.spend_brl || 0,
      impressions: m.impressions || 0,
      clicks: m.clicks || 0,
      cpm: m.cpm || 0,
      cpc: m.cpc || 0,
      ctr: m.ctr || 0,
      landing_page_views: m.landing_page_views || 0,
      leads: m.leads || 0,
    };
  });
  rows.sort((a, b) => b.spend_brl - a.spend_brl);

  return { expert, periodo: label, ad_account: act, adset_id: adset_id || null, campaign_id: campaign_id || null, total: rows.length, ads: rows };
}

async function getMetaAdsCreative({ ad_id }) {
  if (!ad_id) throw new Error('ad_id obrigatório');
  const ad = await graphGet(`/${ad_id}`, {
    fields: 'id,name,status,creative{id,name,thumbnail_url,image_url,video_id,object_story_spec,body,title,call_to_action_type}',
  });
  const cr = ad.creative || {};
  const spec = cr.object_story_spec || {};
  const link = spec.link_data || spec.video_data || spec.photo_data || {};
  return {
    ad_id: ad.id,
    ad_name: ad.name,
    status: ad.status,
    creative_id: cr.id,
    creative_name: cr.name,
    body: cr.body || link.message || null,
    title: cr.title || link.name || null,
    description: link.description || null,
    cta: cr.call_to_action_type || (link.call_to_action && link.call_to_action.type) || null,
    image_url: cr.image_url || null,
    thumbnail_url: cr.thumbnail_url || null,
    video_id: cr.video_id || link.video_id || null,
    link_url: link.link || null,
  };
}

// ── Specs MCP ───────────────────────────────────────────────────────────────
const META_ADS_TOOLS = [
  {
    name: 'get_meta_ads_campaigns',
    description: 'Lista campanhas Meta Ads de um expert (DANI/DEIVID/JUH) com gasto, CPM, CTR, leads, landing page views no período. Use quando o operador perguntar "quanto cada campanha gastou", "qual campanha tá performando", "melhor campanha", etc. Período default 7d.',
    input_schema: {
      type: 'object',
      properties: {
        expert: { type: 'string', description: 'DANI, DEIVID ou JUH' },
        periodo: { type: 'string', enum: ['hoje','ontem','7d','14d','30d','1m','mtd','lastm','3m','custom'], description: 'Default 7d' },
        de: { type: 'string', description: 'DD/MM/YYYY (só pra periodo=custom)' },
        ate: { type: 'string', description: 'DD/MM/YYYY (só pra periodo=custom)' },
        status: { type: 'string', enum: ['ACTIVE','PAUSED','DELETED','ALL'], description: 'Default ACTIVE' },
        limit: { type: 'number', description: 'Default 50, max 500' },
      },
      required: ['expert'],
    },
  },
  {
    name: 'get_meta_ads_adsets',
    description: 'Lista adsets Meta Ads de um expert com gasto/CPM/CTR/leads no período. Pode filtrar por campaign_id pra ver só os adsets de uma campanha específica. Use pra entender qual público/posicionamento performa melhor.',
    input_schema: {
      type: 'object',
      properties: {
        expert: { type: 'string', description: 'DANI, DEIVID ou JUH' },
        campaign_id: { type: 'string', description: 'Opcional: filtra adsets só dessa campanha' },
        periodo: { type: 'string', enum: ['hoje','ontem','7d','14d','30d','1m','mtd','lastm','3m','custom'] },
        de: { type: 'string' },
        ate: { type: 'string' },
        status: { type: 'string', enum: ['ACTIVE','PAUSED','DELETED','ALL'] },
        limit: { type: 'number', description: 'Default 100' },
      },
      required: ['expert'],
    },
  },
  {
    name: 'get_meta_ads_ads',
    description: 'Lista anúncios (criativos individuais) Meta Ads de um expert com gasto/CPM/CTR/leads + URL do criativo (image/thumbnail/preview). Pode filtrar por adset_id ou campaign_id. Use pra identificar qual criativo escala, qual zerar.',
    input_schema: {
      type: 'object',
      properties: {
        expert: { type: 'string', description: 'DANI, DEIVID ou JUH' },
        adset_id: { type: 'string', description: 'Opcional: ads de um adset específico' },
        campaign_id: { type: 'string', description: 'Opcional: ads de uma campanha específica' },
        periodo: { type: 'string', enum: ['hoje','ontem','7d','14d','30d','1m','mtd','lastm','3m','custom'] },
        de: { type: 'string' },
        ate: { type: 'string' },
        status: { type: 'string', enum: ['ACTIVE','PAUSED','DELETED','ALL'] },
        limit: { type: 'number', description: 'Default 100' },
      },
      required: ['expert'],
    },
  },
  {
    name: 'get_meta_ads_creative',
    description: 'Pega detalhes do criativo de um ad específico: copy (title/body), CTA, link, URL da imagem/vídeo. Use depois de listar ads pra ver o copy real do anúncio que tá performando.',
    input_schema: {
      type: 'object',
      properties: {
        ad_id: { type: 'string', description: 'ID do ad (vem de get_meta_ads_ads)' },
      },
      required: ['ad_id'],
    },
  },
];

const HANDLERS = {
  get_meta_ads_campaigns: getMetaAdsCampaigns,
  get_meta_ads_adsets: getMetaAdsAdsets,
  get_meta_ads_ads: getMetaAdsAds,
  get_meta_ads_creative: getMetaAdsCreative,
};

async function executeMetaAdsTool(name, input, userId) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`Meta Ads tool desconhecida: ${name}`);
  return handler(input || {}, userId || 1);
}

module.exports = { META_ADS_TOOLS, executeMetaAdsTool };
