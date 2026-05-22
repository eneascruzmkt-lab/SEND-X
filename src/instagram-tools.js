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
    console.error('[instagram] insights falhou:', e.message);
  }

  // Follows e Unfollows do dia ANTERIOR (Graph API só libera D-1)
  // Métrica: follows_and_unfollows com breakdown=follow_type
  let new_follows = null, unfollows = null;
  try {
    const since = Math.floor((Date.now() - 2 * 86400000) / 1000);
    const until = Math.floor(Date.now() / 1000);
    const ff = await fbGet(`/${igUserId}/insights`, {
      metric: 'follows_and_unfollows',
      period: 'day',
      since, until,
      metric_type: 'total_value',
      breakdown: 'follow_type',
    });
    const data = ff.data?.[0];
    const breakdown = data?.total_value?.breakdowns?.[0]?.results || [];
    for (const b of breakdown) {
      const dim = b.dimension_values?.[0];
      if (dim === 'FOLLOWER') new_follows = Number(b.value) || 0;
      if (dim === 'NON_FOLLOWER' || dim === 'UNFOLLOW') unfollows = Number(b.value) || 0;
    }
  } catch (e) {
    console.error('[instagram] follows_and_unfollows falhou:', e.message);
  }

  return {
    username: profile.username,
    name: profile.name,
    followers_count: profile.followers_count,
    follows_count: profile.follows_count,
    media_count: profile.media_count,
    profile_pic_url: profile.profile_picture_url,
    insights,
    new_follows,
    unfollows,
    net_followers: (new_follows != null && unfollows != null) ? new_follows - unfollows : null,
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

/** Stories ATIVOS (últimas 24h) — somem após esse período. */
async function fetchStoriesAtivos(igUserId) {
  const data = await fbGet(`/${igUserId}/stories`, {
    fields: 'id,media_type,media_url,thumbnail_url,permalink,timestamp',
  });
  return data.data || [];
}

/** Comentários de um post (até 100). */
async function fetchComentarios(mediaId, limit = 50) {
  try {
    const data = await fbGet(`/${mediaId}/comments`, {
      fields: 'id,text,username,timestamp,like_count,replies{id,text,username,timestamp}',
      limit,
    });
    return data.data || [];
  } catch (e) { return []; }
}

/** Conversas DM recentes (precisa instagram_manage_messages). */
async function fetchDMs(igUserId, limit = 20) {
  try {
    // /me/conversations precisa do fb_page_id, não ig_user_id. Pegamos via account
    const data = await fbGet(`/me/conversations`, {
      platform: 'instagram',
      fields: 'id,updated_time,participants,messages.limit(5){id,from,message,created_time}',
      limit,
    });
    return data.data || [];
  } catch (e) {
    console.error('[ig] DMs falhou:', e.message);
    return [];
  }
}

/** Salva snapshot dos stories ativos no DB (eles somem em 24h). */
async function fetchAllStoriesSnapshots(userId = 1) {
  const accounts = await db.listInstagramAccounts(userId);
  const results = [];
  for (const acc of accounts) {
    try {
      const stories = await fetchStoriesAtivos(acc.ig_user_id);
      for (const s of stories) {
        await db.upsertInstagramStory(userId, {
          expert: acc.expert,
          ig_user_id: acc.ig_user_id,
          story_id: s.id,
          media_type: s.media_type,
          media_url: s.media_url,
          thumbnail_url: s.thumbnail_url,
          permalink: s.permalink,
          timestamp: s.timestamp,
          description: null,
        });
      }
      results.push({ expert: acc.expert, stories_capturados: stories.length });
    } catch (e) {
      results.push({ expert: acc.expert, error: e.message });
    }
  }
  return results;
}

/**
 * Snapshot diário COMPLETO do Instagram:
 * - Stories ativos
 * - Posts recentes (com insights)
 * - Top comentários de cada post recente
 * - DMs recentes
 *
 * Salva tudo no DB pra servir de contexto pro ecossistema.
 */
async function fetchAllIgFullSnapshot(userId = 1) {
  const accounts = await db.listInstagramAccounts(userId);
  const results = [];
  for (const acc of accounts) {
    const summary = { expert: acc.expert, stories: 0, posts: 0, comments: 0, dms: 0 };
    try {
      // 1) Stories
      const stories = await fetchStoriesAtivos(acc.ig_user_id).catch(() => []);
      for (const s of stories) {
        await db.upsertInstagramStory(userId, {
          expert: acc.expert, ig_user_id: acc.ig_user_id, story_id: s.id,
          media_type: s.media_type, media_url: s.media_url,
          thumbnail_url: s.thumbnail_url, permalink: s.permalink,
          timestamp: s.timestamp,
        });
        summary.stories++;
      }

      // 2) Posts recentes (20 últimos)
      const posts = await fetchRecentPosts(acc.ig_user_id, 20).catch(() => []);
      for (const p of posts) {
        const insights = await fetchPostInsights(p.id);
        await db.upsertInstagramPost(userId, {
          expert: acc.expert, ig_user_id: acc.ig_user_id, post_id: p.id,
          caption: p.caption, media_type: p.media_type,
          media_url: p.media_url, thumbnail_url: p.thumbnail_url,
          permalink: p.permalink, timestamp: p.timestamp,
          like_count: p.like_count, comments_count: p.comments_count,
          reach: insights?.reach, impressions: insights?.impressions, saved: insights?.saved,
        });
        summary.posts++;

        // 3) Top comentários do post (até 30)
        const comments = await fetchComentarios(p.id, 30).catch(() => []);
        for (const c of comments) {
          await db.upsertInstagramComment(userId, {
            expert: acc.expert, post_id: p.id, comment_id: c.id,
            autor_username: c.username, texto: c.text,
            like_count: c.like_count, timestamp: c.timestamp,
            is_reply: false, parent_id: null,
          });
          summary.comments++;
          // Replies (até 5 por comentário)
          for (const r of (c.replies?.data || [])) {
            await db.upsertInstagramComment(userId, {
              expert: acc.expert, post_id: p.id, comment_id: r.id,
              autor_username: r.username, texto: r.text,
              like_count: 0, timestamp: r.timestamp,
              is_reply: true, parent_id: c.id,
            });
            summary.comments++;
          }
        }
      }

      // 4) DMs recentes (até 20 conversas)
      const dms = await fetchDMs(acc.ig_user_id, 20).catch(() => []);
      for (const conv of dms) {
        const lastMsg = conv.messages?.data?.[0];
        await db.upsertInstagramDM(userId, {
          expert: acc.expert,
          conversation_id: conv.id,
          participants: conv.participants?.data || [],
          last_msg_text: lastMsg?.message,
          last_msg_at: lastMsg?.created_time || conv.updated_time,
        });
        // Mensagens (até 5 últimas por conversa)
        for (const m of (conv.messages?.data || [])) {
          await db.upsertInstagramDMMessage(userId, {
            conversation_id: conv.id,
            message_id: m.id,
            from_username: m.from?.username || m.from?.name || '?',
            message_text: m.message,
            timestamp: m.created_time,
          });
        }
        summary.dms++;
      }

      results.push(summary);
    } catch (e) {
      results.push({ ...summary, error: e.message });
    }
  }
  return results;
}

/** Atividade do dia: stories + posts + comentários + DMs em um payload. */
async function getAtividadeDia(userId, expert, fromDate, toDate) {
  const acc = await db.getInstagramAccountByExpert(userId, expert);
  if (!acc) return { error: `Expert ${expert} não mapeado no Instagram` };

  const igId = acc.ig_user_id;
  // Stories (ativos agora — pega últimas 24h)
  const stories = await fetchStoriesAtivos(igId).catch(() => []);
  // Stories históricos do DB (snapshot)
  const storiesHistorico = await db.listInstagramStories(userId, {
    expert, fromDate, toDate, limit: 100,
  });
  // Posts recentes do feed
  const posts = await fetchRecentPosts(igId, 15).catch(() => []);
  // Filtra posts do período
  const postsNoPeriodo = posts.filter(p => {
    if (!fromDate || !toDate) return true;
    const t = new Date(p.timestamp);
    return t >= new Date(fromDate) && t <= new Date(toDate);
  });
  // Pra cada post recente, pega top comentários
  const postsComComentarios = [];
  for (const p of postsNoPeriodo.slice(0, 5)) {
    const comentarios = await fetchComentarios(p.id, 20).catch(() => []);
    postsComComentarios.push({
      id: p.id,
      caption: p.caption,
      media_type: p.media_type,
      permalink: p.permalink,
      thumbnail_url: p.thumbnail_url || p.media_url,
      timestamp: p.timestamp,
      like_count: p.like_count,
      comments_count: p.comments_count,
      top_comentarios: comentarios.slice(0, 10).map(c => ({
        autor: c.username, texto: c.text, likes: c.like_count, ts: c.timestamp,
      })),
    });
  }

  return {
    expert,
    ig_username: acc.ig_username,
    profile_pic_url: acc.profile_pic_url,
    stories_ativos_agora: stories.length,
    stories_ativos: stories.map(s => ({
      id: s.id, media_type: s.media_type, media_url: s.media_url,
      thumbnail_url: s.thumbnail_url, permalink: s.permalink, timestamp: s.timestamp,
    })),
    stories_historico_periodo: storiesHistorico.length,
    stories_historico: storiesHistorico,
    posts: postsComComentarios,
    posts_periodo_total: postsNoPeriodo.length,
  };
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
        new_follows: snap.new_follows,
        unfollows: snap.unfollows,
        raw: snap,
      });
      results.push({
        expert: acc.expert, ig_username: acc.ig_username,
        followers: snap.followers_count,
        new_follows: snap.new_follows, unfollows: snap.unfollows, net: snap.net_followers,
        ok: true,
      });
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
  const totalNewFollows = snapshots.reduce((a, s) => a + (Number(s.new_follows) || 0), 0);
  const totalUnfollows = snapshots.reduce((a, s) => a + (Number(s.unfollows) || 0), 0);
  const netFollowers = (totalNewFollows > 0 || totalUnfollows > 0) ? totalNewFollows - totalUnfollows : null;
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
    delta_total_seguidores: novosSeguidores,
    novos_seguidores_periodo: totalNewFollows > 0 ? totalNewFollows : null,
    unfollows_periodo: totalUnfollows > 0 ? totalUnfollows : null,
    saldo_seguidores_periodo: netFollowers,
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
      new_follows: s.new_follows,
      unfollows: s.unfollows,
      net: (s.new_follows != null && s.unfollows != null) ? s.new_follows - s.unfollows : null,
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
    name: 'get_instagram_atividade_dia',
    description: 'Atividade COMPLETA do Instagram do expert: stories ativos agora (últimas 24h) + stories do histórico no período + posts + comentários top de cada post. Use pra entender o que o expert postou e qual a recepção. Cada story/post traz media_url ou thumbnail_url que pode ser baixada e analisada via vision.',
    input_schema: {
      type: 'object',
      properties: {
        expert: { type: 'string' },
        de: { type: 'string', description: 'ISO date (opcional, default hoje)' },
        ate: { type: 'string', description: 'ISO date (opcional)' },
      },
      required: ['expert'],
    },
  },
  {
    name: 'get_instagram_stories_ativos',
    description: 'Stories Instagram ATIVOS agora (últimas 24h) do expert. Cada item tem media_url (URL pública da imagem/vídeo) que pode ser analisada via vision.',
    input_schema: { type: 'object', properties: { expert: { type: 'string' } }, required: ['expert'] },
  },
  {
    name: 'get_instagram_comentarios',
    description: 'Comentários de um post específico do Instagram (até 50). Mostra autor, texto, likes, timestamp e replies.',
    input_schema: {
      type: 'object',
      properties: {
        media_id: { type: 'string', description: 'ID do post (pegar via get_instagram_atividade_dia ou listar_instagram_posts)' },
      },
      required: ['media_id'],
    },
  },
  {
    name: 'get_instagram_dms',
    description: 'Conversações DM recentes do Instagram do expert. Lista conversas + últimas mensagens de cada.',
    input_schema: {
      type: 'object',
      properties: { expert: { type: 'string' }, limit: { type: 'number' } },
      required: ['expert'],
    },
  },
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
  if (name === 'get_instagram_atividade_dia') {
    const hoje = new Date(); const yesterday = new Date(Date.now() - 24*86400000);
    return await getAtividadeDia(userId, input.expert,
      input.de || yesterday.toISOString(),
      input.ate || hoje.toISOString()
    );
  }
  if (name === 'get_instagram_stories_ativos') {
    const acc = await db.getInstagramAccountByExpert(userId, input.expert);
    if (!acc) return { error: `Expert ${input.expert} não mapeado` };
    return { expert: input.expert, ig_username: acc.ig_username, stories: await fetchStoriesAtivos(acc.ig_user_id) };
  }
  if (name === 'get_instagram_comentarios') {
    return { media_id: input.media_id, comentarios: await fetchComentarios(input.media_id, 50) };
  }
  if (name === 'get_instagram_dms') {
    const acc = await db.getInstagramAccountByExpert(userId, input.expert);
    if (!acc) return { error: `Expert ${input.expert} não mapeado` };
    return { expert: input.expert, dms: await fetchDMs(acc.ig_user_id, input.limit || 20) };
  }
  throw new Error(`Instagram tool desconhecida: ${name}`);
}

/**
 * Descreve uma imagem via bridge (Claude com vision nativo).
 * Retorna 2-3 frases sobre o conteúdo da imagem.
 */
async function descreverMidiaIA(mediaUrl, mediaType = 'IMAGE', contextoExtra = '') {
  if (!mediaUrl) return null;
  // Vídeos: descrição via thumbnail (preview frame)
  const url = (await db.getBridgeRegistry().catch(() => null))?.url || process.env.BRIDGE_URL;
  const secret = process.env.BRIDGE_SECRET;
  if (!url || !secret) return null;
  try {
    // Vídeos têm URL com .mp4 — Claude vision não lê vídeo, mas o thumbnail dá.
    // Tenta baixar a imagem e mandar como base64 (mais robusto que URL pública).
    let imagePayload = { url: mediaUrl };
    try {
      const imgResp = await fetch(mediaUrl);
      if (imgResp.ok) {
        const ct = imgResp.headers.get('content-type') || 'image/jpeg';
        // Só processa se for imagem (não vídeo)
        if (ct.startsWith('image/')) {
          const buf = await imgResp.arrayBuffer();
          const b64 = Buffer.from(buf).toString('base64');
          imagePayload = { data_base64: b64, mime_type: ct };
        }
      }
    } catch (e) { /* fica com url */ }

    const resp = await fetch(`${url}/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1' },
      body: JSON.stringify({
        message:
          'Descreva o conteúdo desta imagem do Instagram em 2-3 frases naturais em português brasileiro. ' +
          'Foque em: o que aparece (pessoas, ambiente, ação), o tema/sentimento, e qualquer texto visível. ' +
          'Seja específico e direto, sem disclaimers. Resposta APENAS com a descrição.' +
          (contextoExtra ? '\n\nContexto: ' + contextoExtra : ''),
        images: [imagePayload],
        mode: 'task',
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return (data.text || '').trim().slice(0, 600) || null;
  } catch (e) {
    console.error('[ig-describe] falhou:', e.message);
    return null;
  }
}

/**
 * Pega itens pendentes (sem description) e descreve em sequência.
 * Limita a N itens por execução pra não estourar tempo.
 */
async function descreverPendentesIA(userId = 1, maxItens = 8) {
  const { stories, posts } = await db.listInstagramItensSemDescription(userId, maxItens);
  const results = { stories_descritos: 0, posts_descritos: 0, errors: [] };

  for (const s of stories.slice(0, maxItens / 2)) {
    const url = s.media_url || s.thumbnail_url;
    if (!url) continue;
    const desc = await descreverMidiaIA(url, s.media_type, `Story do expert ${s.expert}`);
    if (desc) {
      await db.updateInstagramStoryDescription(userId, s.id, desc);
      results.stories_descritos++;
      console.log(`[ig-describe] story ${s.id} (${s.expert}): ${desc.slice(0, 80)}…`);
    }
  }
  for (const p of posts.slice(0, maxItens / 2)) {
    const url = p.thumbnail_url || p.media_url;
    if (!url) continue;
    const ctx = `Post do expert ${p.expert}. Legenda: ${(p.caption || '').slice(0, 200)}`;
    const desc = await descreverMidiaIA(url, p.media_type, ctx);
    if (desc) {
      await db.updateInstagramPostDescription(userId, p.id, desc);
      results.posts_descritos++;
      console.log(`[ig-describe] post ${p.id} (${p.expert}): ${desc.slice(0, 80)}…`);
    }
  }
  return results;
}

module.exports = {
  discoverInstagramAccounts,
  fetchInstagramSnapshot,
  fetchAllSnapshots,
  fetchRecentPosts,
  fetchPostInsights,
  fetchStoriesAtivos,
  fetchComentarios,
  fetchDMs,
  fetchAllStoriesSnapshots,
  fetchAllIgFullSnapshot,
  getAtividadeDia,
  getInstagramMetrics,
  descreverMidiaIA,
  descreverPendentesIA,
  INSTAGRAM_TOOLS,
  executeInstagramTool,
};
