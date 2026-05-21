const { Router } = require('express');
const db = require('../db');
const advisor = require('../ai-advisor');

const router = Router();

/** POST /api/ai-advisor/notify — força envio top 3 pendentes via WhatsApp */
router.post('/ai-advisor/notify', async (req, res) => {
  try {
    const r = await advisor.notificarTop3(req.userId, req.query.slot || 'manual');
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/ai-advisor/analisar — força nova análise (gera 5 recomendações) */
router.post('/ai-advisor/analisar', async (req, res) => {
  try {
    const slot = req.query.slot || req.body?.slot || '';
    const recs = await advisor.gerarRecomendacoes(req.userId, undefined, slot);
    res.json({ ok: true, count: recs.length, recomendacoes: recs });
  } catch (e) {
    console.error('[ai-advisor/analisar]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/ai-advisor/recomendacoes — lista (default pendentes) */
router.get('/ai-advisor/recomendacoes', async (req, res) => {
  try {
    const status = req.query.status || null;
    const limit = Number(req.query.limit) || 50;
    const list = await db.listRecommendations(req.userId, { status, limit });
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** PATCH /api/ai-advisor/recomendacoes/:id — marca status (aplicado/ignorado/aprovado) */
router.patch('/ai-advisor/recomendacoes/:id', async (req, res) => {
  try {
    const { status, notes } = req.body || {};
    const valid = ['pendente', 'aplicado', 'ignorado', 'aprovado'];
    if (!valid.includes(status)) return res.status(400).json({ error: `status inválido (use: ${valid.join(',')})` });
    const updated = await db.updateRecommendationStatus(req.params.id, status, notes);
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/ai-advisor/score — estatísticas de tracking */
router.get('/ai-advisor/score', async (req, res) => {
  try {
    const stats = await db.query(
      `SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status='aplicado') AS aplicadas,
        COUNT(*) FILTER (WHERE status='ignorado') AS ignoradas,
        COUNT(*) FILTER (WHERE outcome_measured_at IS NOT NULL) AS medidas,
        AVG(outcome_score) FILTER (WHERE outcome_score IS NOT NULL) AS score_medio,
        SUM(outcome_ftds_delta) FILTER (WHERE outcome_score IS NOT NULL) AS ftds_total_delta,
        SUM(outcome_netpl_delta) FILTER (WHERE outcome_score IS NOT NULL) AS netpl_total_delta
       FROM ai_recommendations WHERE user_id=$1`,
      [req.userId]
    );
    res.json(stats[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
