/**
 * Research tools — rodam server-side no SEND-X.
 * Não dependem do Claude Code/bridge nem requerem aprovação do user.
 *
 * Tools:
 *  - analisarConcorrenteInstagram(ig_username) → perfil + 15 posts via Graph API
 *  - metaAdsLibrarySearch({search_terms,...}) → ads ativos no Brasil
 *  - webSearch(query) → busca web via DuckDuckGo HTML scrape (zero custo)
 *  - fetchUrl(url) → fetch HTTP simples com User-Agent realista
 */

const FB_TOKEN = () => process.env.FB_ACCESS_TOKEN;
const GRAPH = 'https://graph.facebook.com/v19.0';

// IG business account ID que tem permissão pra business_discovery (de qualquer
// IG ligado a uma das ad accounts da conta). Cacheado entre chamadas.
let _igBusinessAccountId = null;
async function getIgBusinessAccountId() {
  if (_igBusinessAccountId) return _igBusinessAccountId;
  const url = `${GRAPH}/me/accounts?fields=instagram_business_account&access_token=${FB_TOKEN()}`;
  const resp = await fetch(url);
  const data = await resp.json();
  for (const p of data.data || []) {
    const iba = p.instagram_business_account?.id;
    if (iba) { _igBusinessAccountId = iba; return iba; }
  }
  throw new Error('Nenhuma conta Instagram business vinculada à FB_ACCESS_TOKEN');
}

// ─── Tool: analisarConcorrenteInstagram ────────────────────────────────────

async function analisarConcorrenteInstagram({ ig_username }) {
  if (!ig_username) throw new Error('ig_username obrigatório');
  const username = String(ig_username).trim().replace(/^@/, '');
  if (!FB_TOKEN()) throw new Error('FB_ACCESS_TOKEN não configurado no servidor');

  const iba = await getIgBusinessAccountId();
  const fields = `business_discovery.username(${username}){name,username,followers_count,follows_count,media_count,biography,website,profile_picture_url,media.limit(15){caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url}}`;
  const url = new URL(`${GRAPH}/${iba}`);
  url.searchParams.set('fields', fields);
  url.searchParams.set('access_token', FB_TOKEN());

  const resp = await fetch(url);
  const data = await resp.json();
  if (data.error) throw new Error(`Graph API: ${data.error.message}`);

  const bd = data.business_discovery;
  if (!bd) throw new Error(`Perfil @${username} não encontrado ou não é Business/Creator account`);

  const posts = (bd.media?.data || []).map(p => ({
    data: p.timestamp?.slice(0, 10),
    tipo: p.media_type,
    formato: p.media_product_type,
    likes: p.like_count,
    comments: p.comments_count,
    caption: (p.caption || '').slice(0, 600),
    permalink: p.permalink,
  }));

  // Engagement rate médio (likes+comments) / followers
  const totalEngage = posts.reduce((s, p) => s + (p.likes || 0) + (p.comments || 0), 0);
  const avgEngage = posts.length > 0 ? totalEngage / posts.length : 0;
  const engagementRate = bd.followers_count > 0
    ? ((avgEngage / bd.followers_count) * 100).toFixed(3) + '%'
    : 'N/A';

  return {
    username: bd.username,
    name: bd.name,
    followers: bd.followers_count,
    media_count: bd.media_count,
    biography: bd.biography,
    website: bd.website,
    profile_picture_url: bd.profile_picture_url,
    engagement_rate_medio: engagementRate,
    posts_recentes: posts,
  };
}

// ─── Tool: metaAdsLibrarySearch ────────────────────────────────────────────

async function metaAdsLibrarySearch({ search_terms, search_page_ids, ad_active_status = 'ALL', limit = 15 }) {
  if (!search_terms && !search_page_ids) {
    throw new Error('Forneça search_terms ou search_page_ids');
  }
  if (!FB_TOKEN()) throw new Error('FB_ACCESS_TOKEN não configurado');

  const url = new URL(`${GRAPH}/ads_archive`);
  url.searchParams.set('ad_type', 'ALL');
  url.searchParams.set('ad_reached_countries', JSON.stringify(['BR']));
  url.searchParams.set('ad_active_status', ad_active_status);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('fields',
    'id,page_name,page_id,ad_creative_bodies,ad_creative_link_titles,ad_creative_link_descriptions,' +
    'ad_creative_link_captions,ad_delivery_start_time,ad_delivery_stop_time,ad_snapshot_url,publisher_platforms');
  if (search_terms) url.searchParams.set('search_terms', search_terms);
  if (search_page_ids) url.searchParams.set('search_page_ids', JSON.stringify(search_page_ids));
  url.searchParams.set('access_token', FB_TOKEN());

  const resp = await fetch(url);
  const data = await resp.json();
  if (data.error) throw new Error(`Ads Library: ${data.error.message}`);

  const ads = (data.data || []).map(a => ({
    id: a.id,
    page_name: a.page_name,
    page_id: a.page_id,
    start: a.ad_delivery_start_time,
    stop: a.ad_delivery_stop_time || 'ainda ativo',
    platforms: a.publisher_platforms,
    body: (a.ad_creative_bodies || [])[0]?.slice(0, 400),
    title: (a.ad_creative_link_titles || [])[0],
    description: (a.ad_creative_link_descriptions || [])[0]?.slice(0, 200),
    caption: (a.ad_creative_link_captions || [])[0],
    snapshot_url: a.ad_snapshot_url,
  }));

  // Agrupa por Page (mostra quem mais anuncia o termo)
  const pages = {};
  for (const a of ads) {
    const k = a.page_id;
    if (!pages[k]) pages[k] = { page_name: a.page_name, page_id: a.page_id, count: 0 };
    pages[k].count++;
  }
  return {
    total: ads.length,
    pages_distintas: Object.values(pages).sort((a, b) => b.count - a.count),
    ads: ads.slice(0, limit),
  };
}

// ─── Tool: webSearch (DuckDuckGo HTML — zero custo, sem API key) ──────────

async function webSearch({ query, limit = 8 }) {
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', query);

  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    },
  });
  if (!resp.ok) throw new Error(`DuckDuckGo HTTP ${resp.status}`);
  const html = await resp.text();

  // Parse simples dos resultados (DDG HTML é estável)
  const results = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && results.length < limit) {
    const url = decodeURIComponent(
      m[1].replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, '').replace(/&rut=.*$/, '')
    );
    const title = m[2].replace(/<[^>]+>/g, '').trim();
    const snippet = m[3].replace(/<[^>]+>/g, '').trim().slice(0, 300);
    results.push({ title, url, snippet });
  }
  return { query, results };
}

// ─── Tool: fetchUrl (fetch simples com UA realista) ────────────────────────

async function fetchUrl({ url, max_chars = 5000 }) {
  if (!url) throw new Error('url obrigatório');
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    },
    redirect: 'follow',
  });
  const contentType = resp.headers.get('content-type') || '';
  const status = resp.status;
  let body = await resp.text();

  // Se for HTML, faz cleanup simples (remove scripts/styles/tags, mantém texto)
  if (contentType.includes('html')) {
    body = body
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return {
    url,
    status,
    content_type: contentType,
    body: body.slice(0, max_chars),
    truncated: body.length > max_chars,
  };
}

// ─── Tool definitions (Anthropic format, pra tool-calling no API mode) ─────

const RESEARCH_TOOLS = [
  {
    name: 'analisar_concorrente_instagram',
    description: 'Analisa perfil público de concorrente no Instagram via Meta Graph API: bio, seguidores, link bio, posts recentes (caption, likes, comments, formato), engagement rate. Use quando o operador pedir pra estudar concorrente, perfil, ou mencionar @username Instagram.',
    input_schema: {
      type: 'object',
      properties: {
        ig_username: { type: 'string', description: 'Username Instagram sem @ (ex: denerzimofc)' },
      },
      required: ['ig_username'],
    },
  },
  {
    name: 'meta_ads_library_search',
    description: 'Pesquisa anúncios ativos no Brasil na biblioteca pública do Meta. Use quando o operador pedir pra ver anúncios de concorrente, descobrir criativos veiculados, ou benchmarkar copy. Pode buscar por palavras-chave OU por page_id específico.',
    input_schema: {
      type: 'object',
      properties: {
        search_terms: { type: 'string', description: 'Palavras-chave (nome de pessoa, marca, jogo, casa de apostas)' },
        search_page_ids: { type: 'array', items: { type: 'string' }, description: 'IDs de Pages específicas (em formato string)' },
        ad_active_status: { type: 'string', enum: ['ALL', 'ACTIVE', 'INACTIVE'], description: 'Default ALL' },
        limit: { type: 'number', description: 'Default 15, max 50' },
      },
    },
  },
  {
    name: 'web_search',
    description: 'Busca web via DuckDuckGo. Use pra pesquisar tendências de mercado, regulamentação SPA, concorrentes em geral, novidades iGaming.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', description: 'Default 8' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_url',
    description: 'Baixa conteúdo de uma URL pública (artigo, landing page, blog post). Retorna texto limpo (HTML stripped). NÃO funciona em sites que bloqueiam (Instagram, Facebook, X) — use as tools específicas pra esses.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        max_chars: { type: 'number', description: 'Default 5000' },
      },
      required: ['url'],
    },
  },
];

const HANDLERS = {
  analisar_concorrente_instagram: analisarConcorrenteInstagram,
  meta_ads_library_search: metaAdsLibrarySearch,
  web_search: webSearch,
  fetch_url: fetchUrl,
};

async function executeResearchTool(name, input) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`Research tool desconhecida: ${name}`);
  return await handler(input || {});
}

module.exports = { RESEARCH_TOOLS, executeResearchTool, analisarConcorrenteInstagram, metaAdsLibrarySearch, webSearch, fetchUrl };
