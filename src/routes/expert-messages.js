const { Router } = require('express');
const { enviarMensagensExperts } = require('../expert-messages');

const router = Router();

/**
 * POST /api/expert-messages/enviar
 * Query params:
 *   slot=manha|tarde|noite (default manha)
 *   modo=teste|prod (default teste — envia pro privado do Aytalo)
 *   experts=DANI,DEIVID,JUH (CSV, opcional)
 */
router.post('/expert-messages/enviar', async (req, res) => {
  try {
    const slot = req.query.slot || req.body?.slot || 'manha';
    const modo = req.query.modo || req.body?.modo || 'teste';
    const expertsCsv = req.query.experts || req.body?.experts;
    const experts = expertsCsv ? String(expertsCsv).split(',').map(s => s.trim().toUpperCase()) : undefined;
    if (!['manha', 'tarde', 'noite'].includes(slot)) return res.status(400).json({ error: 'slot inválido (manha|tarde|noite)' });
    if (!['teste', 'prod'].includes(modo)) return res.status(400).json({ error: 'modo inválido (teste|prod)' });
    const results = await enviarMensagensExperts({ userId: req.userId, slot, modo, experts });
    res.json({ ok: true, slot, modo, results });
  } catch (e) {
    console.error('[expert-messages/enviar]', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
