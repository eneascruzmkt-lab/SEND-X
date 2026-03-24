const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const sendpulse = require('../sendpulse');
const { hashPassword, comparePassword, generateToken, auth } = require('../auth');

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
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.mp4', '.gif', '.webm', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Formato não permitido. Use: JPG, PNG, MP4, GIF'));
  },
});

// ── Auth routes (public) ─────────────────────────────
router.post('/auth/register', (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nome, email e senha são obrigatórios' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Formato de email inválido' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres' });
    }
    const existing = db.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'Email já cadastrado' });
    }
    const user = db.createUser({ name, email, password_hash: hashPassword(password) });
    const token = generateToken(user);
    res.status(201).json({ user, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    }
    const user = db.getUserByEmail(email);
    if (!user || !comparePassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Email ou senha incorretos' });
    }
    const token = generateToken(user);
    res.json({ user: { id: user.id, name: user.name, email: user.email }, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/auth/me', auth, (req, res) => {
  const user = db.getUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json(user);
});

// ── All routes below require auth ────────────────────
router.use(auth);

// ── Upload ───────────────────────────────────────────
router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  const url = `/uploads/${req.file.filename}`;
  res.json({ url, filename: req.file.filename, size: req.file.size });
});

// ── User Settings ────────────────────────────────────
router.get('/settings', (req, res) => {
  const settings = db.getUserSettings(req.userId);
  // Mask secrets for display
  res.json({
    sendpulse_id: settings.sendpulse_id || '',
    sendpulse_secret: settings.sendpulse_secret ? '••••••••' : '',
    telegram_token: settings.telegram_token ? '••••••••' : '',
    webhook_domain: settings.webhook_domain || '',
    has_sendpulse: !!(settings.sendpulse_id && settings.sendpulse_secret),
    has_telegram: !!settings.telegram_token,
  });
});

router.put('/settings', (req, res) => {
  const { sendpulse_id, sendpulse_secret, telegram_token, webhook_domain } = req.body;
  const current = db.getUserSettings(req.userId);

  const updated = db.upsertUserSettings(req.userId, {
    sendpulse_id: sendpulse_id ?? current.sendpulse_id ?? null,
    sendpulse_secret: (sendpulse_secret && sendpulse_secret !== '••••••••') ? sendpulse_secret : (current.sendpulse_secret ?? null),
    telegram_token: (telegram_token && telegram_token !== '••••••••') ? telegram_token : (current.telegram_token ?? null),
    webhook_domain: webhook_domain ?? current.webhook_domain ?? null,
  });

  // Notify bot manager to restart bots for this user
  const botManager = req.app.get('botManager');
  if (botManager) botManager.refreshUser(req.userId);

  res.json({
    sendpulse_id: updated.sendpulse_id || '',
    sendpulse_secret: updated.sendpulse_secret ? '••••••••' : '',
    telegram_token: updated.telegram_token ? '••••••••' : '',
    webhook_domain: updated.webhook_domain || '',
    has_sendpulse: !!(updated.sendpulse_id && updated.sendpulse_secret),
    has_telegram: !!updated.telegram_token,
  });
});

// Helper: get user's sendpulse credentials
function getCredentials(req) {
  const settings = db.getUserSettings(req.userId);
  if (!settings.sendpulse_id || !settings.sendpulse_secret) {
    return null;
  }
  return {
    sendpulse_id: settings.sendpulse_id,
    sendpulse_secret: settings.sendpulse_secret,
    webhook_domain: settings.webhook_domain,
  };
}

// ── Pares ──────────────────────────────────────────────
router.get('/pares', (req, res) => {
  res.json(db.getAllPares(req.userId));
});

router.post('/pares', (req, res) => {
  try {
    const { nome, telegram_group_id, sendpulse_bot_id, sendpulse_bot_nome } = req.body;
    if (!nome || !telegram_group_id || !sendpulse_bot_id) {
      return res.status(400).json({ error: 'nome, telegram_group_id e sendpulse_bot_id são obrigatórios' });
    }
    const par = db.createPar({
      user_id: req.userId,
      nome,
      telegram_group_id,
      sendpulse_bot_id,
      sendpulse_bot_nome: sendpulse_bot_nome || null,
    });
    res.status(201).json(par);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'telegram_group_id já cadastrado para este usuário' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.put('/pares/:id', (req, res) => {
  const par = db.getParById(req.params.id);
  if (!par || par.user_id !== req.userId) return res.status(404).json({ error: 'Par não encontrado' });
  const updated = db.updatePar(req.params.id, {
    nome: req.body.nome || par.nome,
    telegram_group_id: req.body.telegram_group_id || par.telegram_group_id,
    sendpulse_bot_id: req.body.sendpulse_bot_id || par.sendpulse_bot_id,
    sendpulse_bot_nome: req.body.sendpulse_bot_nome ?? par.sendpulse_bot_nome,
  });
  res.json(updated);
});

router.delete('/pares/:id', (req, res) => {
  const par = db.getParById(req.params.id);
  if (!par || par.user_id !== req.userId) return res.status(404).json({ error: 'Par não encontrado' });
  db.deactivatePar(req.params.id);
  res.json({ ok: true });
});

// ── Messages ───────────────────────────────────────────
router.get('/messages', (req, res) => {
  const { par_id } = req.query;
  if (!par_id) return res.status(400).json({ error: 'par_id obrigatório' });
  const par = db.getParById(Number(par_id));
  if (!par || par.user_id !== req.userId) return res.status(403).json({ error: 'Acesso negado' });
  res.json(db.getMessages(Number(par_id)));
});

// ── Schedules ──────────────────────────────────────────
router.get('/schedules', (req, res) => {
  const { par_id, status } = req.query;
  if (par_id) {
    const par = db.getParById(Number(par_id));
    if (!par || par.user_id !== req.userId) return res.status(403).json({ error: 'Acesso negado' });
    res.json(db.getSchedules(Number(par_id), status || null));
  } else {
    res.json(db.getAllSchedules(status || null, req.userId));
  }
});

router.post('/schedules', (req, res) => {
  try {
    let { par_id, sendpulse_bot_id } = req.body;
    if (!req.body.scheduled_at) {
      return res.status(400).json({ error: 'scheduled_at é obrigatório' });
    }
    if (par_id) {
      const par = db.getParById(par_id);
      if (!par || par.user_id !== req.userId) return res.status(403).json({ error: 'Acesso negado' });
    }
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
    req.body.user_id = req.userId;
    const schedule = db.createSchedule(req.body);
    const io = req.app.get('io');
    if (io && par_id) io.to(`par_${par_id}`).emit('schedule_update', schedule);
    res.status(201).json(schedule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/schedules/:id/send', async (req, res) => {
  const schedule = db.getScheduleById(req.params.id);
  if (!schedule || schedule.user_id !== req.userId) return res.status(404).json({ error: 'Agendamento não encontrado' });

  const credentials = getCredentials(req);
  if (!credentials) return res.status(400).json({ error: 'Configure suas credenciais SendPulse em Configurações' });

  let botId = schedule.sendpulse_bot_id;
  const par = schedule.par_id ? db.getParById(schedule.par_id) : null;
  if (!botId && par) botId = par.sendpulse_bot_id;
  if (!botId) return res.status(400).json({ error: 'Bot ID não encontrado' });

  try {
    const s = { ...schedule, sendpulse_bot_id: botId };
    await sendpulse.dispatch(s, par, credentials);
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
  if (!existing || existing.user_id !== req.userId) return res.status(404).json({ error: 'Agendamento não encontrado' });
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
  if (!existing || existing.user_id !== req.userId) return res.status(404).json({ error: 'Agendamento não encontrado' });
  db.deleteSchedule(req.params.id);
  const io = req.app.get('io');
  if (io) io.to(`par_${existing.par_id}`).emit('schedule_update', { id: existing.id, deleted: true });
  res.json({ ok: true });
});

// ── Dashboard ──────────────────────────────────────────
router.get('/dashboard', (req, res) => {
  const { par_id } = req.query;
  if (!par_id) return res.status(400).json({ error: 'par_id obrigatório' });
  const par = db.getParById(Number(par_id));
  if (!par || par.user_id !== req.userId) return res.status(403).json({ error: 'Acesso negado' });
  res.json(db.getDashboard(Number(par_id)));
});

// ── SendPulse Bots ─────────────────────────────────────
router.get('/sendpulse/bots', async (req, res) => {
  const credentials = getCredentials(req);
  if (!credentials) {
    return res.status(400).json({ error: 'Configure suas credenciais SendPulse em Configurações', needs_setup: true });
  }
  try {
    const bots = await sendpulse.listBots(credentials);
    console.log('[sendpulse/bots] resultado:', JSON.stringify(bots).slice(0, 500));
    res.json(bots);
  } catch (err) {
    console.error('[sendpulse/bots] erro:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erro ao buscar bots: ' + err.message });
  }
});

module.exports = router;
