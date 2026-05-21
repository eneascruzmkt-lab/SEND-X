/**
 * Instagram tools — Graph API (Instagram Business via FB token).
 *
 * Requer:
 *  - FB_ACCESS_TOKEN com escopo instagram_basic + pages_show_list + pages_read_engagement
 *  - Páginas Facebook conectadas a Instagram Business
 *
 * Fluxo:
 *  1. discoverInstagramAccounts() lista todas IG business accounts ligadas ao token
 *  2. Operador mapeia cada uma a um expert (DANI/DEIVID/JUH) via UI
 *  3. fetchInstagramSnapshot() coleta métricas diárias (followers, posts, reach, ...)
 *  4. Cron diário às 07h BRT roda fetchAllSnapshots() salvando em instagram_daily_snapshots
 *  5. getInstagramMetrics(expert, periodo) calcula delta entre snapshots
 */

const db = require('./db');

const GRAPH_API = 'https://graph.facebook.com/v21.0';

function token() {
  if (!process.env.FB_ACCESS_TOKEN) throw new Error('FB_ACCESS_TOKEN não configurado');
  return process.env.FB_ACCESS_TOKEN;
}

async function fbGet(path, params = {}) {
  const url = new URL(`${GRAPH_API}${path}`);
  url.searchParams.set('access_token', token());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const resp = await fetch(url.toString());
  const data = await resp.json();
  if (data.error) throw new Error(`Graph API ${data.error.code}: ${data.error.message}`);
  return data;
}

/** Lista todas as IG business accounts acessíveis pelo token (via páginas FB). */
async function discoverInstagramAccounts() {
  // Step 1: páginas FB que o usuário gerencia
  const pages = await fbGet('/me/accounts', { fields: 'id,name,instagram_business_account{id,username,name,profile_picture_url,followers_count,media_count,biography}' });
  const accounts = [];
  for (const page of pages.data || []) {
    if (page.instagram_business_account) {
      const ig = page.instagram_business_account;
      accounts.push({
        fb_page_id: page.id,
        fb_page_name: page.name,
        ig_user_id: ig.id,
        ig_username: ig.username,
        ig_display_name: ig.name,
        profile_pic_url: ig.profile_picture_url,
        followers_count: ig.followers_count,
        media_count: ig.media_count,
        biography: ig.biography,
      });
    }
  }
  return accounts;
}

/** Snapshot atual: followers, media count + insights agregados últimos 30d. */
async function fetchInstagramSnapshot(igUserId) {
  // Perfil básico
  const profile = await fbGet(`/${igUserId}`, {
    fields: 'username,name,followers_count,follows_count,media_count,profile_picture_url',
  });

  // Insights (métricas agregadas - últimos 30 dias)
  // Métricas disponíveis pra Instagram Business: reach, impressions, profile_views, website_clicks
  let insights = {};
  try {
    const since = Math.floor((Date.now() - 30 * 86400000) / 1000);
    const until = Math.floor(Date.now() / 1000);
    const insightsResp = await fbGet(`/${igUserId}/insights`, {
      metric: 'reach,impressions,profile_views,website_clicks',
      period: 'day',
      since, until,
      metric_type: 'total_value',
    });
    for (const m of insightsResp.data || []) {
      insights[m.name] = (m.values || []).reduce((a, v) => a + (Number(v.value) || 0), 0);
    }
  } catch (e) {
    // Insights podem falhar se token sem permissão — segue sem
    console.error('[instagram] insights falhou:', e.message);
  }

  return {
    username: profile.username,
    name: profile.name,
    followers_count: profile.followers_count,
    follows_count: profile.follows_count,
    media_count: profile.media_count,
    profile_pic_url: profile.profile_picture_url,
    insights,
  };
}

/** Posts recentes (últimos N) com engajamento. */
async function fetchRecentPosts(igUserId, limit = 10) {
  const data = await fbGet(`/${igUserId}/media`, {
    fields: 'id,caption,media_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count',
    limit,
  });
  return data.data || [];
}

async function fetchPostInsights(mediaId) {
  try {
    const data = await fbGet(`/${mediaId}/insights`, {
      metric: 'impressions,reach,saved,engagement',
    });
    const result = {};
    for (const m of data.data || []) result[m.name] = m.values?.[0]?.value;
    return result;
  } catch (e) { return null; }
}

/** Cron job: coleta snapshot diário de TODAS as accounts cadastradas pra um user. */
async function fetchAllSnapshots(userId = 1, targetDate = null) {
  const date = targetDate || new Date().toISOString().slice(0, 10);
  const accounts = await db.listInstagramAccounts(userId);
  const results = [];
  for (const acc of accounts) {
    try {
      const snap = await fetchInstagramSnapshot(acc.ig_user_id);
      await db.upsertInstagramSnapshot(userId, {
        ig_user_id: acc.ig_user_id,
        expert: acc.expert,
        snapshot_date: date,
        followers_count: snap.followers_count,
        media_count: snap.media_count,
        reach: snap.insights?.reach,
        impressions: snap.insights?.impressions,
        profile_views: snap.insights?.profile_views,
        website_clicks: snap.insights?.website_clicks,
        raw: snap,
      });
      results.push({ expert: acc.expert, ig_username: acc.ig_username, followers: snap.followers_count, ok: true });
    } catch (e) {
      results.push({ expert: acc.expert, ig_username: acc.ig_username, error: e.message });
    }
  }
  return results;
}

/** Calcula métricas de Instagram pro expert no período (delta de seguidores etc). */
async function getInstagramMetrics(userId, expert, periodo = '7d', deStr, ateStr) {
  const acc = await db.getInstagramAccountByExpert(userId, expert);
  if (!acc) return { error: `Expert ${expert} não tem Instagram mapeado` };

  const now = new Date();
  const range = resolvePeriodo(periodo, deStr, ateStr);

  const fromDate = range.start.toISOString().slice(0, 10);
  const toDate = range.end.toISOString().slice(0, 10);
  const snapshots = await db.getInstagramSnapshots(userId, acc.ig_user_id, fromDate, toDate);

  // Snapshot atual em tempo real (mais preciso que o último daily)
  let current;
  try { current = await fetchInstagramSnapshot(acc.ig_user_id); }
  catch (e) { current = null; }

  const followersAtual = current?.followers_count ?? (snapshots[snapshots.length - 1]?.followers_count ?? null);
  const followersInicio = snapshots[0]?.followers_count ?? null;
  const novosSeguidores = (followersAtual != null && followersInicio != null)
    ? followersAtual - followersInicio
    : null;

  const totalReach = snapshots.reduce((a, s) => a + (Number(s.reach) || 0), 0);
  const totalImpressions = snapshots.reduce((a, s) => a + (Number(s.impressions) || 0), 0);
  const totalProfileViews = snapshots.reduce((a, s) => a + (Number(s.profile_views) || 0), 0);
  const totalWebsiteClicks = snapshots.reduce((a, s) => a + (Number(s.website_clicks) || 0), 0);
  const mediaCountFim = snapshots[snapshots.length - 1]?.media_count ?? current?.media_count ?? null;
  const mediaCountInicio = snapshots[0]?.media_count ?? null;
  const postsNoPeriodo = (mediaCountFim != null && mediaCountInicio != null)
    ? mediaCountFim - mediaCountInicio : null;

  return {
    expert,
    ig_username: acc.ig_username,
    profile_pic_url: acc.profile_pic_url,
    periodo: range.label,
    seguidores_atual: followersAtual,
    seguidores_inicio_periodo: followersInicio,
    novos_seguidores_periodo: novosSeguidores,
    total_posts: current?.media_count ?? null,
    posts_no_periodo: postsNoPeriodo,
    reach_total: totalReach,
    impressions_total: totalImpressions,
    profile_views_total: totalProfileViews,
    website_clicks_total: totalWebsiteClicks,
    snapshots_count: snapshots.length,
    serie_diaria: snapshots.map(s => ({
      date: s.snapshot_date,
      followers: s.followers_count,
      reach: s.reach,
      impressions: s.impressions,
    })),
  };
}

// resolver período (mesmo padrão dos outros tools)
function nowBRT() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })); }
function pad(n) { return String(n).padStart(2, '0'); }
function brt(y, m, d, h = 0, mi = 0, s = 0) { return new Date(`${y}-${pad(m+1)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}-03:00`); }
function parseBR(s) { if (!s) return null; const [d, m, y] = s.split('/').map(Number); return brt(y, m - 1, d); }
function resolvePeriodo(periodo, de, ate) {
  const now = nowBRT();
  const y = now.getFullYear(), m = now.getMonth(), today = now.getDate();
  let s, e;
  switch (periodo) {
    case 'hoje':  s = brt(y, m, today);     e = brt(y, m, today, 23, 59, 59); break;
    case 'ontem': s = brt(y, m, today - 1); e = brt(y, m, today - 1, 23, 59, 59); break;
    case '7d':    s = brt(y, m, today - 6); e = brt(y, m, today, 23, 59, 59); break;
    case '14d':   s = brt(y, m, today - 13);e = brt(y, m, today, 23, 59, 59); break;
    case '30d':   s = brt(y, m, today - 29);e = brt(y, m, today, 23, 59, 59); break;
    case '1m':    s = brt(y, m, 1);         e = brt(y, m, today, 23, 59, 59); break;
    case 'lastm': s = brt(y, m - 1, 1);     e = new Date(brt(y, m, 1) - 1); break;
    case '3m':    s = brt(y, m - 2, 1);     e = brt(y, m, today, 23, 59, 59); break;
    case 'custom':
      s = parseBR(de); e = parseBR(ate);
      if (!s || !e) throw new Error('custom requer de+ate (DD/MM/YYYY)');
      e = new Date(e.getTime() + 86_399_000);
      break;
    default: throw new Error(`Período inválido: ${periodo}`);
  }
  return { start: s, end: e, label: `${s.toISOString().slice(0,10)} — ${e.toISOString().slice(0,10)}` };
}

// ─── MCP tools (Claude do chat usa) ─────────────────────────────────────────

const INSTAGRAM_TOOLS = [
  {
    name: 'get_instagram_metricas',
    description: 'Métricas do Instagram do expert: seguidores atual, novos seguidores no período, posts, reach, impressões. Usa snapshots diários salvos no DB + tempo real via Graph API.',
    input_schema: {
      type: 'object',
      properties: {
        expert: { type: 'string', description: 'DANI, DEIVID, JUH...' },
        periodo: { type: 'string', enum: ['hoje','ontem','7d','14d','30d','1m','lastm','3m','custom'] },
        de: { type: 'string' }, ate: { type: 'string' },
      },
      required: ['expert','periodo'],
    },
  },
  {
    name: 'listar_instagram_contas',
    description: 'Lista todas as contas Instagram cadastradas no sistema (mapeamento expert → IG).',
    input_schema: { type: 'object', properties: {} },
  },
];

async function executeInstagramTool(name, input, userId = 1) {
  if (name === 'get_instagram_metricas') {
    return await getInstagramMetrics(userId, input.expert, input.periodo, input.de, input.ate);
  }
  if (name === 'listar_instagram_contas') {
    return await db.listInstagramAccounts(userId);
  }
  throw new Error(`Instagram tool desconhecida: ${name}`);
}

module.exports = {
  discoverInstagramAccounts,
  fetchInstagramSnapshot,
  fetchAllSnapshots,
  fetchRecentPosts,
  fetchPostInsights,
  getInstagramMetrics,
  INSTAGRAM_TOOLS,
  executeInstagramTool,
};
