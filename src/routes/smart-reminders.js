const { Router } = require('express');
const db = require('../db');
const reminders = require('../smart-reminders');

const router = Router();

/** GET /api/reminders — lista histórico (filtros tipo/status) */
router.get('/reminders', async (req, res) => {
  try {
    const list = await db.listReminders(req.userId, {
      tipo: req.query.tipo || null,
      status: req.query.status || null,
      limit: Number(req.query.limit) || 50,
    });
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/reminders/test-live?meeting_id=UUID — gera + envia pra uma live específica */
router.post('/reminders/test-live', async (req, res) => {
  try {
    const meetingId = req.query.meeting_id || req.body?.meeting_id;
    if (!meetingId) return res.status(400).json({ error: 'meeting_id obrigatório' });
    const r = await reminders.processarLive(meetingId, req.userId);
    res.json(r);
  } catch (e) {
    console.error('[reminders/test-live]', e);
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/reminders/scan?minutes=60 — processa lives terminadas nos últimos N min */
router.post('/reminders/scan', async (req, res) => {
  try {
    const min = Number(req.query.minutes) || 60;
    const r = await reminders.processarLivesTerminadas(req.userId, min);
    res.json({ ok: true, results: r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
