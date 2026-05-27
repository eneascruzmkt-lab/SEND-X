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

// ── WRITES (Fase C — criação) ───────────────────────────────────────────────
// Todas as criações:
//  - exigem confirm:true no input. Sem isso, retornam preview.
//  - criam status=PAUSED por default (operador ativa via Ads Manager depois).
//  - logam stderr antes de executar.

function buildPreview(action, payload, note) {
  return {
    _preview: true,
    action,
    payload,
    note: note || 'Chamar novamente com confirm:true pra aplicar. Tudo será criado PAUSED.',
  };
}

async function graphPost(path, body) {
  const url = new URL(`${GRAPH_API}${path}`);
  url.searchParams.set('access_token', token());
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body || {})) {
    if (v === undefined || v === null) continue;
    params.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const resp = await fetch(url.toString(), {
    method: 'POST',
    body: params,
    signal: AbortSignal.timeout(25_000),
  });
  const text = await resp.text();
  if (!resp.ok) {
    let detail = text;
    try { detail = JSON.stringify(JSON.parse(text).error || text); } catch {}
    throw new Error(`Graph API ${resp.status} (POST ${path}): ${detail.slice(0, 400)}`);
  }
  return JSON.parse(text);
}

async function createMetaAdsCampaign({ expert, name, objective, status = 'PAUSED', daily_budget_brl, lifetime_budget_brl, special_ad_categories = [], confirm = false }, userId) {
  if (!name) throw new Error('name obrigatório');
  if (!objective) throw new Error('objective obrigatório (ex: OUTCOME_TRAFFIC, OUTCOME_SALES, OUTCOME_ENGAGEMENT, OUTCOME_AWARENESS, OUTCOME_LEADS, OUTCOME_APP_PROMOTION)');
  const act = await adAccountForExpert(expert, userId);

  const body = {
    name,
    objective,
    status,
    special_ad_categories: special_ad_categories.length > 0 ? special_ad_categories : [],
  };
  if (daily_budget_brl) body.daily_budget = Math.round(Number(daily_budget_brl) * 100);
  if (lifetime_budget_brl) body.lifetime_budget = Math.round(Number(lifetime_budget_brl) * 100);

  if (!confirm) return buildPreview('CREATE campaign', { ad_account: act, ...body });

  console.error(`[meta-ads-write] CREATE campaign expert=${expert} name="${name}" objective=${objective}`);
  const r = await graphPost(`/${act}/campaigns`, body);
  return { ok: true, action: 'CREATE campaign', campaign_id: r.id, ad_account: act, name, status, objective };
}

async function createMetaAdsAdset({ campaign_id, name, daily_budget_brl, lifetime_budget_brl, optimization_goal, billing_event = 'IMPRESSIONS', bid_strategy = 'LOWEST_COST_WITHOUT_CAP', bid_amount_cents, targeting, start_time, end_time, status = 'PAUSED', confirm = false }, _userId) {
  if (!campaign_id) throw new Error('campaign_id obrigatório (use create_meta_ads_campaign primeiro)');
  if (!name) throw new Error('name obrigatório');
  if (!optimization_goal) throw new Error('optimization_goal obrigatório (ex: LINK_CLICKS, LANDING_PAGE_VIEWS, OFFSITE_CONVERSIONS, REACH, IMPRESSIONS, MESSAGES)');
  if (!targeting || typeof targeting !== 'object') throw new Error('targeting obrigatório (objeto JSON — ex: {"age_min":18,"age_max":65,"genders":[1,2],"geo_locations":{"countries":["BR"]}})');
  if (!daily_budget_brl && !lifetime_budget_brl) throw new Error('precisa de daily_budget_brl OU lifetime_budget_brl');

  // Resolve ad_account a partir do campaign_id
  const campInfo = await graphGet(`/${campaign_id}`, { fields: 'account_id,name' });
  const act = `act_${campInfo.account_id}`;

  const body = {
    campaign_id,
    name,
    optimization_goal,
    billing_event,
    bid_strategy,
    targeting,
    status,
  };
  if (daily_budget_brl) body.daily_budget = Math.round(Number(daily_budget_brl) * 100);
  if (lifetime_budget_brl) body.lifetime_budget = Math.round(Number(lifetime_budget_brl) * 100);
  if (bid_amount_cents) body.bid_amount = Math.round(Number(bid_amount_cents));
  if (start_time) body.start_time = start_time;
  if (end_time) body.end_time = end_time;

  if (!confirm) return buildPreview('CREATE adset', { ad_account: act, campaign_name: campInfo.name, ...body });

  console.error(`[meta-ads-write] CREATE adset campaign=${campaign_id} name="${name}" budget=${daily_budget_brl || lifetime_budget_brl}`);
  const r = await graphPost(`/${act}/adsets`, body);
  return { ok: true, action: 'CREATE adset', adset_id: r.id, campaign_id, ad_account: act, name, status };
}

async function createMetaAdsAd({ adset_id, name, creative_id, status = 'PAUSED', tracking_specs, confirm = false }, _userId) {
  if (!adset_id) throw new Error('adset_id obrigatório');
  if (!name) throw new Error('name obrigatório');
  if (!creative_id) throw new Error('creative_id obrigatório (use create_meta_ads_creative_from_post ou duplicate_meta_ads_ad)');

  // Resolve ad_account a partir do adset
  const adsetInfo = await graphGet(`/${adset_id}`, { fields: 'account_id,campaign_id,name' });
  const act = `act_${adsetInfo.account_id}`;

  const body = {
    adset_id,
    name,
    creative: { creative_id },
    status,
  };
  if (tracking_specs) body.tracking_specs = tracking_specs;

  if (!confirm) return buildPreview('CREATE ad', { ad_account: act, adset_name: adsetInfo.name, ...body });

  console.error(`[meta-ads-write] CREATE ad adset=${adset_id} creative=${creative_id} name="${name}"`);
  const r = await graphPost(`/${act}/ads`, body);
  return { ok: true, action: 'CREATE ad', ad_id: r.id, adset_id, ad_account: act, name, status };
}

async function duplicateMetaAdsAd({ source_ad_id, target_adset_id, new_name, status = 'PAUSED', confirm = false }, _userId) {
  if (!source_ad_id) throw new Error('source_ad_id obrigatório');
  if (!new_name) throw new Error('new_name obrigatório');

  // Lê o ad original (creative + adset original)
  const src = await graphGet(`/${source_ad_id}`, { fields: 'name,adset_id,account_id,creative{id}' });
  const act = `act_${src.account_id}`;
  const adset = target_adset_id || src.adset_id;
  const creativeId = src.creative?.id;
  if (!creativeId) throw new Error(`Ad ${source_ad_id} sem creative válido`);

  const body = {
    adset_id: adset,
    name: new_name,
    creative: { creative_id: creativeId },
    status,
  };

  if (!confirm) return buildPreview('DUPLICATE ad', {
    source_ad_id, source_name: src.name, target_adset_id: adset,
    creative_id: creativeId, new_name, status,
  });

  console.error(`[meta-ads-write] DUPLICATE ad source=${source_ad_id} target_adset=${adset} new_name="${new_name}"`);
  const r = await graphPost(`/${act}/ads`, body);
  return { ok: true, action: 'DUPLICATE ad', ad_id: r.id, source_ad_id, adset_id: adset, ad_account: act, name: new_name, status };
}

async function createMetaAdsCreativeFromPost({ expert, page_id, post_id, name, instagram_actor_id, confirm = false }, userId) {
  if (!page_id) throw new Error('page_id obrigatório (FB Page ou IG account id que publicou o post)');
  if (!post_id) throw new Error('post_id obrigatório (formato: pageid_postid ou só postid)');
  const act = await adAccountForExpert(expert, userId);

  // object_story_id = "pageid_postid" — formato esperado pela Graph
  const objectStoryId = post_id.includes('_') ? post_id : `${page_id}_${post_id}`;

  const body = {
    name: name || `creative-from-${objectStoryId.slice(0, 24)}`,
    object_story_id: objectStoryId,
  };
  if (instagram_actor_id) body.instagram_actor_id = instagram_actor_id;

  if (!confirm) return buildPreview('CREATE creative from post', { ad_account: act, object_story_id: objectStoryId, ...body });

  console.error(`[meta-ads-write] CREATE creative_from_post expert=${expert} post=${objectStoryId}`);
  const r = await graphPost(`/${act}/adcreatives`, body);
  return { ok: true, action: 'CREATE creative', creative_id: r.id, ad_account: act, object_story_id: objectStoryId };
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
  // ── WRITES (criação — sempre PAUSED por default) ──────────────────────────
  {
    name: 'create_meta_ads_campaign',
    description: 'Cria uma nova campanha Meta Ads (começa PAUSED por segurança — operador ativa depois). Sem confirm:true retorna PREVIEW da mudança. Com confirm:true cria de verdade. Use objective válido (OUTCOME_SALES, OUTCOME_TRAFFIC, OUTCOME_ENGAGEMENT, OUTCOME_LEADS, OUTCOME_AWARENESS, OUTCOME_APP_PROMOTION).',
    input_schema: {
      type: 'object',
      properties: {
        expert: { type: 'string', description: 'DANI, DEIVID ou JUH' },
        name: { type: 'string' },
        objective: { type: 'string', description: 'OUTCOME_SALES | OUTCOME_TRAFFIC | OUTCOME_ENGAGEMENT | OUTCOME_LEADS | OUTCOME_AWARENESS | OUTCOME_APP_PROMOTION' },
        status: { type: 'string', enum: ['PAUSED','ACTIVE'], description: 'Default PAUSED' },
        daily_budget_brl: { type: 'number', description: 'Em reais (ex: 50.00)' },
        lifetime_budget_brl: { type: 'number', description: 'Em reais. Usa daily OU lifetime, não os dois.' },
        special_ad_categories: { type: 'array', items: { type: 'string' }, description: 'Default vazio. Não usar pra iGaming.' },
        confirm: { type: 'boolean', description: 'False (default) = retorna preview. True = aplica.' },
      },
      required: ['expert','name','objective'],
    },
  },
  {
    name: 'create_meta_ads_adset',
    description: 'Cria um adset dentro de uma campanha existente (PAUSED). targeting é um objeto JSON arbitrário no formato Graph API. Sem confirm:true retorna preview.',
    input_schema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string' },
        name: { type: 'string' },
        daily_budget_brl: { type: 'number' },
        lifetime_budget_brl: { type: 'number' },
        optimization_goal: { type: 'string', description: 'LINK_CLICKS | LANDING_PAGE_VIEWS | OFFSITE_CONVERSIONS | REACH | IMPRESSIONS | MESSAGES | etc' },
        billing_event: { type: 'string', enum: ['IMPRESSIONS','LINK_CLICKS','PAGE_LIKES','POST_ENGAGEMENT','VIDEO_VIEWS','APP_INSTALLS'], description: 'Default IMPRESSIONS' },
        bid_strategy: { type: 'string', enum: ['LOWEST_COST_WITHOUT_CAP','LOWEST_COST_WITH_BID_CAP','COST_CAP'], description: 'Default LOWEST_COST_WITHOUT_CAP' },
        bid_amount_cents: { type: 'number', description: 'Em centavos, só se bid_strategy não for WITHOUT_CAP' },
        targeting: { type: 'object', description: 'Objeto JSON conforme Graph API. Mínimo: {"age_min":18,"age_max":65,"genders":[1,2],"geo_locations":{"countries":["BR"]}}' },
        start_time: { type: 'string', description: 'ISO 8601 (opcional)' },
        end_time: { type: 'string', description: 'ISO 8601 (opcional)' },
        status: { type: 'string', enum: ['PAUSED','ACTIVE'], description: 'Default PAUSED' },
        confirm: { type: 'boolean' },
      },
      required: ['campaign_id','name','optimization_goal','targeting'],
    },
  },
  {
    name: 'create_meta_ads_ad',
    description: 'Cria um anúncio (ad) dentro de um adset, usando creative_id existente. Sem confirm:true retorna preview.',
    input_schema: {
      type: 'object',
      properties: {
        adset_id: { type: 'string' },
        name: { type: 'string' },
        creative_id: { type: 'string', description: 'ID de um creative existente. Use create_meta_ads_creative_from_post pra criar a partir de um post IG/FB existente.' },
        status: { type: 'string', enum: ['PAUSED','ACTIVE'], description: 'Default PAUSED' },
        tracking_specs: { type: 'array', description: 'Opcional: tracking specs no formato Graph API' },
        confirm: { type: 'boolean' },
      },
      required: ['adset_id','name','creative_id'],
    },
  },
  {
    name: 'duplicate_meta_ads_ad',
    description: 'Duplica um ad existente (copia o creative pra um novo ad). Útil pra escalar criativo bom pra outro adset/audiência. Sem confirm:true retorna preview.',
    input_schema: {
      type: 'object',
      properties: {
        source_ad_id: { type: 'string', description: 'ID do ad de origem (vem de get_meta_ads_ads)' },
        target_adset_id: { type: 'string', description: 'Adset destino. Omite pra duplicar no mesmo adset.' },
        new_name: { type: 'string' },
        status: { type: 'string', enum: ['PAUSED','ACTIVE'], description: 'Default PAUSED' },
        confirm: { type: 'boolean' },
      },
      required: ['source_ad_id','new_name'],
    },
  },
  {
    name: 'create_meta_ads_creative_from_post',
    description: 'Cria um creative reutilizando um post existente do Instagram/Facebook (object_story_id). Mais fácil que criar do zero com upload de imagem. Sem confirm:true retorna preview.',
    input_schema: {
      type: 'object',
      properties: {
        expert: { type: 'string', description: 'DANI, DEIVID ou JUH' },
        page_id: { type: 'string', description: 'FB Page ID ou IG account ID que publicou o post' },
        post_id: { type: 'string', description: 'ID do post. Pode ser só o ID ou já no formato pageid_postid.' },
        instagram_actor_id: { type: 'string', description: 'IG account ID se for IG post' },
        name: { type: 'string', description: 'Opcional, default auto-gerado' },
        confirm: { type: 'boolean' },
      },
      required: ['page_id','post_id'],
    },
  },
];

const HANDLERS = {
  get_meta_ads_campaigns: getMetaAdsCampaigns,
  get_meta_ads_adsets: getMetaAdsAdsets,
  get_meta_ads_ads: getMetaAdsAds,
  get_meta_ads_creative: getMetaAdsCreative,
  create_meta_ads_campaign: createMetaAdsCampaign,
  create_meta_ads_adset: createMetaAdsAdset,
  create_meta_ads_ad: createMetaAdsAd,
  duplicate_meta_ads_ad: duplicateMetaAdsAd,
  create_meta_ads_creative_from_post: createMetaAdsCreativeFromPost,
};

async function executeMetaAdsTool(name, input, userId) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`Meta Ads tool desconhecida: ${name}`);
  return handler(input || {}, userId || 1);
}

module.exports = { META_ADS_TOOLS, executeMetaAdsTool };
