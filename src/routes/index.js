const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const sendpulse = require('../sendpulse');

const router = express.Router();

// ── Upload ────────────────────────────────────────────
const uploadDir = path.join(__dirname, '..', '..', 'public', 'uploads');
const fs = require('fs');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomBytes(12).toString('hex') + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max (catbox limit)
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.mp4', '.gif', '.webm', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Formato não permitido. Use: JPG, PNG, MP4, GIF'));
  },
});

router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  const url = `/uploads/${req.file.filename}`;
  res.json({ url, filename: req.file.filename, size: req.file.size });
});

// Upload media for an existing feed message (large videos that couldn't be downloaded)
router.post('/messages/:id/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  const msg = db.raw.prepare('SELECT * FROM messages WHERE id=?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' });

  const localUrl = `/uploads/${req.file.filename}`;
  const mediaType = req.file.mimetype.startsWith('video') ? 'video' : 'photo';

  // Upload to public host (catbox for video, telegra.ph for image)
  let publicUrl = null;
  try {
    publicUrl = await sendpulse.__resolveMediaUrl(localUrl, mediaType);
  } catch (e) {
    console.error('[upload] public upload failed:', e.message);
  }

  // Update the message record
  db.raw.prepare('UPDATE messages SET file_id=?, telegram_media_url=? WHERE id=?')
    .run(localUrl, publicUrl || null, msg.id);

  const io = req.app.get('io');
  if (io && msg.par_id) io.to(`par_${msg.par_id}`).emit('messages_updated');

  res.json({ ok: true, localUrl, publicUrl });
});

// ── Pares ──────────────────────────────────────────────
router.get('/pares', (req, res) => {
  res.json(db.getAllPares());
});

router.post('/pares', (req, res) => {
  try {
    const { nome, telegram_group_id, sendpulse_bot_id, sendpulse_bot_nome, channel_username } = req.body;
    if (!nome || !telegram_group_id || !sendpulse_bot_id) {
      return res.status(400).json({ error: 'nome, telegram_group_id e sendpulse_bot_id são obrigatórios' });
    }
    const par = db.createPar({
      nome,
      telegram_group_id,
      sendpulse_bot_id,
      sendpulse_bot_nome: sendpulse_bot_nome || null,
      channel_username: channel_username ? channel_username.replace('@', '') : null,
    });
    res.status(201).json(par);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'telegram_group_id já cadastrado' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.put('/pares/:id', (req, res) => {
  const par = db.getParById(req.params.id);
  if (!par) return res.status(404).json({ error: 'Par não encontrado' });
  const updated = db.updatePar(req.params.id, {
    nome: req.body.nome || par.nome,
    telegram_group_id: req.body.telegram_group_id || par.telegram_group_id,
    sendpulse_bot_id: req.body.sendpulse_bot_id || par.sendpulse_bot_id,
    sendpulse_bot_nome: req.body.sendpulse_bot_nome ?? par.sendpulse_bot_nome,
    channel_username: req.body.channel_username !== undefined
      ? (req.body.channel_username ? req.body.channel_username.replace('@', '') : null)
      : (par.channel_username || null),
  });
  res.json(updated);
});

router.delete('/pares/:id', (req, res) => {
  db.deactivatePar(req.params.id);
  res.json({ ok: true });
});

// ── Messages ───────────────────────────────────────────
router.get('/messages', (req, res) => {
  const { par_id } = req.query;
  if (!par_id) return res.status(400).json({ error: 'par_id obrigatório' });
  res.json(db.getMessages(Number(par_id)));
});

// ── Schedules ──────────────────────────────────────────
router.get('/schedules', (req, res) => {
  const { par_id, status } = req.query;
  if (par_id) {
    res.json(db.getSchedules(Number(par_id), status || null));
  } else {
    res.json(db.getAllSchedules(status || null));
  }
});

router.post('/schedules', (req, res) => {
  try {
    let { par_id, sendpulse_bot_id } = req.body;
    if (!req.body.scheduled_at) {
      return res.status(400).json({ error: 'scheduled_at é obrigatório' });
    }
    // Resolve bot_id from par if not provided
    if (!sendpulse_bot_id && par_id) {
      const par = db.getParById(par_id);
      if (par) {
        req.body.sendpulse_bot_id = par.sendpulse_bot_id;
        req.body.sendpulse_bot_nome = req.body.sendpulse_bot_nome || par.sendpulse_bot_nome;
      }
    }
    if (!req.body.sendpulse_bot_id && !par_id) {
      return res.status(400).json({ error: 'par_id ou sendpulse_bot_id é obrigatório' });
    }
    if (req.body.buttons && req.body.buttons.length > 3) {
      return res.status(400).json({ error: 'Máximo 3 botões permitidos' });
    }
    if (req.body.buttons && req.body.buttons.length > 0 && req.body.origem === 'grupo') {
      return res.status(400).json({ error: 'Botões não permitidos para mensagens do grupo' });
    }
    const schedule = db.createSchedule(req.body);
    const io = req.app.get('io');
    if (io && par_id) io.to(`par_${par_id}`).emit('schedule_update', schedule);
    res.status(201).json(schedule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Envio imediato
router.post('/schedules/:id/send', async (req, res) => {
  const schedule = db.getScheduleById(req.params.id);
  if (!schedule) return res.status(404).json({ error: 'Agendamento não encontrado' });

  // Resolve bot_id
  let botId = schedule.sendpulse_bot_id;
  const par = schedule.par_id ? db.getParById(schedule.par_id) : null;
  if (!botId && par) botId = par.sendpulse_bot_id;
  if (!botId) return res.status(400).json({ error: 'Bot ID não encontrado' });

  try {
    const s = { ...schedule, sendpulse_bot_id: botId };
    await sendpulse.dispatch(s, par);
    db.updateScheduleStatus(schedule.id, 'enviado');
    db.insertLog({ schedule_id: schedule.id, par_id: schedule.par_id, status: 'enviado' });
    res.json({ ok: true, status: 'enviado' });
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    db.updateScheduleStatus(schedule.id, 'erro', errMsg);
    db.insertLog({ schedule_id: schedule.id, par_id: schedule.par_id, status: 'erro', sendpulse_response: JSON.stringify(err.response?.data || err.message) });
    res.status(500).json({ error: errMsg });
  }
});

router.put('/schedules/:id', (req, res) => {
  const existing = db.getScheduleById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Agendamento não encontrado' });
  if (req.body.buttons && req.body.buttons.length > 3) {
    return res.status(400).json({ error: 'Máximo 3 botões permitidos' });
  }
  const updated = db.updateSchedule(req.params.id, req.body);
  const io = req.app.get('io');
  if (io) io.to(`par_${updated.par_id}`).emit('schedule_update', updated);
  res.json(updated);
});

router.delete('/schedules/:id', (req, res) => {
  const existing = db.getScheduleById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Agendamento não encontrado' });
  db.deleteSchedule(req.params.id);
  const io = req.app.get('io');
  if (io) io.to(`par_${existing.par_id}`).emit('schedule_update', { id: existing.id, deleted: true });
  res.json({ ok: true });
});

// ── Dashboard ──────────────────────────────────────────
router.get('/dashboard', (req, res) => {
  const { par_id } = req.query;
  if (!par_id) return res.status(400).json({ error: 'par_id obrigatório' });
  res.json(db.getDashboard(Number(par_id)));
});

// ── SendPulse Bots ─────────────────────────────────────
router.get('/sendpulse/bots', async (req, res) => {
  try {
    const bots = await sendpulse.listBots();
    res.json(bots);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar bots: ' + err.message });
  }
});

module.exports = router;
