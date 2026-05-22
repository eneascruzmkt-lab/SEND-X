const { Router } = require('express');
const db = require('../db');
const ig = require('../instagram-tools');
const { auth } = require('../auth');

const router = Router();
router.use(auth);
// Fallback userId = 1 (única conta operacional) se o middleware não setar
router.use((req, _res, next) => { if (!req.userId) req.userId = 1; next(); });

/** GET /api/instagram/discover — lista contas IG disponíveis no token FB */
router.get('/instagram/discover', async (_req, res) => {
  try {
    const accounts = await ig.discoverInstagramAccounts();
    res.json(accounts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/instagram/accounts — lista contas mapeadas */
router.get('/instagram/accounts', async (req, res) => {
  try {
    const list = await db.listInstagramAccounts(req.userId);
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/instagram/accounts — cadastra/atualiza mapeamento expert→IG */
router.post('/instagram/accounts', async (req, res) => {
  try {
    const { expert, ig_user_id, ig_username, fb_page_id, fb_page_name, profile_pic_url } = req.body || {};
    if (!expert || !ig_user_id) return res.status(400).json({ error: 'expert e ig_user_id obrigatórios' });
    const row = await db.upsertInstagramAccount(req.userId, {
      expert: expert.toUpperCase(),
      ig_user_id, ig_username, fb_page_id, fb_page_name, profile_pic_url,
    });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** DELETE /api/instagram/accounts/:expert — desativa mapeamento */
router.delete('/instagram/accounts/:expert', async (req, res) => {
  try {
    await db.deleteInstagramAccount(req.userId, req.params.expert.toUpperCase());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/instagram/metricas?expert=&periodo= — métricas consolidadas */
router.get('/instagram/metricas', async (req, res) => {
  try {
    const result = await ig.getInstagramMetrics(req.userId, req.query.expert, req.query.periodo || '7d', req.query.de, req.query.ate);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/instagram/posts?expert=&limit= — posts recentes */
router.get('/instagram/posts', async (req, res) => {
  try {
    const acc = await db.getInstagramAccountByExpert(req.userId, req.query.expert);
    if (!acc) return res.status(404).json({ error: 'Expert não mapeado' });
    const posts = await ig.fetchRecentPosts(acc.ig_user_id, Number(req.query.limit) || 10);
    res.json(posts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/instagram/snapshot — força snapshot manual (cron-style) */
router.post('/instagram/snapshot', async (req, res) => {
  try {
    const date = req.query.date || req.body?.date;
    const results = await ig.fetchAllSnapshots(req.userId, date);
    res.json({ ok: true, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/instagram/snapshot-stories — força captura de stories ativos */
router.post('/instagram/snapshot-stories', async (req, res) => {
  try {
    const results = await ig.fetchAllStoriesSnapshots(req.userId);
    res.json({ ok: true, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/instagram/snapshot-full — captura stories+posts+comentários+DMs */
router.post('/instagram/snapshot-full', async (req, res) => {
  try {
    const results = await ig.fetchAllIgFullSnapshot(req.userId);
    res.json({ ok: true, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/instagram/descrever-pendentes — força descrição IA */
router.post('/instagram/descrever-pendentes', async (req, res) => {
  try {
    const max = Number(req.query.max) || 10;
    const r = await ig.descreverPendentesIA(req.userId, max);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/instagram/db-atividade?expert=&periodo= — lê DO BANCO */
router.get('/instagram/db-atividade', async (req, res) => {
  try {
    const periodo = req.query.periodo || '24h';
    const now = new Date();
    let from = new Date(now - 24*86400000);
    if (periodo === '7d') from = new Date(now - 7*86400000);
    if (periodo === '30d') from = new Date(now - 30*86400000);
    const result = await db.getInstagramAtividadeFromDB(req.userId, req.query.expert, from, now);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/instagram/atividade?expert=&de=&ate= — stories+posts+comentários */
router.get('/instagram/atividade', async (req, res) => {
  try {
    const hoje = new Date(); const yesterday = new Date(Date.now() - 24*86400000);
    const result = await ig.getAtividadeDia(req.userId, req.query.expert,
      req.query.de || yesterday.toISOString(),
      req.query.ate || hoje.toISOString());
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/instagram/stories?expert= — stories ativos agora (24h) */
router.get('/instagram/stories', async (req, res) => {
  try {
    const acc = await db.getInstagramAccountByExpert(req.userId, req.query.expert);
    if (!acc) return res.status(404).json({ error: 'Expert não mapeado' });
    const stories = await ig.fetchStoriesAtivos(acc.ig_user_id);
    res.json({ expert: req.query.expert, ig_username: acc.ig_username, stories });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/instagram/comments/:media_id — comentários de um post */
router.get('/instagram/comments/:media_id', async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 50;
    res.json({ media_id: req.params.media_id, comentarios: await ig.fetchComentarios(req.params.media_id, limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/instagram/dms?expert= — DMs recentes */
router.get('/instagram/dms', async (req, res) => {
  try {
    const acc = await db.getInstagramAccountByExpert(req.userId, req.query.expert);
    if (!acc) return res.status(404).json({ error: 'Expert não mapeado' });
    const dms = await ig.fetchDMs(acc.ig_user_id, Number(req.query.limit) || 20);
    res.json({ expert: req.query.expert, dms });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
