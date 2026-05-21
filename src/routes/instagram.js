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

module.exports = router;
