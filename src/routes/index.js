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
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.mp4', '.gif', '.webm', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Formato não permitido. Use: JPG, PNG, MP4, GIF'));
  },
});

// ── Auth routes (public) ─────────────────────────────
router.post('/auth/register', async (req, res) => {
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
    const existing = await db.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'Email já cadastrado' });
    }
    const user = await db.createUser({ name, email, password_hash: hashPassword(password) });
    const token = generateToken(user);
    res.status(201).json({ user, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    }
    const user = await db.getUserByEmail(email);
    if (!user || !comparePassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Email ou senha incorretos' });
    }
    const token = generateToken(user);
    res.json({ user: { id: user.id, name: user.name, email: user.email }, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/auth/me', auth, async (req, res) => {
  const user = await db.getUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json(user);
});

// ── All routes below require auth ────────────────────
router.use(auth);

// ── Upload ───────────────────────────────────────────
router.post('/upload', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  const localUrl = `/uploads/${req.file.filename}`;
  const localPath = req.file.path;
  const ext = path.extname(req.file.originalname).toLowerCase();
  const isVideo = ['.mp4', '.webm', '.gif'].includes(ext);
  const isPhoto = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);

  let telegramFileId = null;
  let previewUrl = localUrl;

  // Upload to Telegram Bot API to get permanent file_id
  if (isVideo || isPhoto) {
    try {
      const settings = await db.getUserSettings(req.userId);
      if (settings.telegram_token) {
        const FormData = require('form-data');
        const fstream = require('fs');
        const axios = require('axios');
        const botUrl = `https://api.telegram.org/bot${settings.telegram_token}`;

        // Find a paired group to use as temporary upload target
        const pares = await db.getAllPares(req.userId);
        const activePar = pares.find(p => p.ativo && p.telegram_group_id);

        if (activePar) {
          const method = isVideo ? 'sendVideo' : 'sendPhoto';
          const field = isVideo ? 'video' : 'photo';
          const form = new FormData();
          form.append('chat_id', activePar.telegram_group_id);
          form.append(field, fstream.createReadStream(localPath));
          form.append('disable_notification', 'true');

          const tgRes = await axios.post(`${botUrl}/${method}`, form, {
            headers: form.getHeaders(),
            timeout: 120000,
            maxContentLength: 210 * 1024 * 1024,
          });

          if (tgRes.data?.ok && tgRes.data?.result) {
            const result = tgRes.data.result;
            if (isVideo && result.video) {
              telegramFileId = result.video.file_id;
            } else if (isPhoto && result.photo?.length > 0) {
              telegramFileId = result.photo[result.photo.length - 1].file_id;
            }
            // Delete the temporary message
            try {
              await axios.post(`${botUrl}/deleteMessage`, {
                chat_id: activePar.telegram_group_id,
                message_id: result.message_id,
              });
            } catch {}
            console.log('[upload] telegram file_id:', telegramFileId?.slice(0, 40) + '...');
          }
        }
      }
    } catch (err) {
      console.error('[upload] telegram upload failed:', err.message);
    }
  }

  // Upload to catbox for preview URL (browser display)
  try {
    const FormData = require('form-data');
    const fstream = require('fs');
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', fstream.createReadStream(localPath));

    const catRes = await require('axios').post('https://catbox.moe/user/api.php', form, {
      headers: form.getHeaders(),
      timeout: 120000,
      maxContentLength: 210 * 1024 * 1024,
    });

    if (catRes.data && catRes.data.startsWith('https://')) {
      previewUrl = catRes.data.trim();
      console.log('[upload] catbox preview URL:', previewUrl);
    }
  } catch (err) {
    console.error('[upload] catbox upload failed, using local:', err.message);
  }

  // Clean up local file
  try { fs.unlinkSync(localPath); } catch {}

  res.json({ url: previewUrl, file_id: telegramFileId, filename: req.file.filename, size: req.file.size });
});

// ── User Settings ────────────────────────────────────
router.get('/settings', async (req, res) => {
  const settings = await db.getUserSettings(req.userId);
  res.json({
    sendpulse_id: settings.sendpulse_id || '',
    sendpulse_secret: settings.sendpulse_secret ? '••••••••' : '',
    telegram_token: settings.telegram_token ? '••••••••' : '',
    webhook_domain: settings.webhook_domain || '',
    has_sendpulse: !!(settings.sendpulse_id && settings.sendpulse_secret),
    has_telegram: !!settings.telegram_token,
  });
});

router.put('/settings', async (req, res) => {
  const { sendpulse_id, sendpulse_secret, telegram_token, webhook_domain } = req.body;
  const current = await db.getUserSettings(req.userId);

  const updated = await db.upsertUserSettings(req.userId, {
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
async function getCredentials(req) {
  const settings = await db.getUserSettings(req.userId);
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
router.get('/pares', async (req, res) => {
  res.json(await db.getAllPares(req.userId));
});

router.post('/pares', async (req, res) => {
  try {
    const { nome, telegram_group_id, sendpulse_bot_id, sendpulse_bot_nome } = req.body;
    if (!nome || !telegram_group_id || !sendpulse_bot_id) {
      return res.status(400).json({ error: 'nome, telegram_group_id e sendpulse_bot_id são obrigatórios' });
    }
    const par = await db.createPar({
      user_id: req.userId,
      nome,
      telegram_group_id,
      sendpulse_bot_id,
      sendpulse_bot_nome: sendpulse_bot_nome || null,
    });
    res.status(201).json(par);
  } catch (err) {
    if (err.message.includes('unique') || err.message.includes('duplicate')) {
      return res.status(409).json({ error: 'telegram_group_id já cadastrado para este usuário' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.put('/pares/:id', async (req, res) => {
  const par = await db.getParById(req.params.id);
  if (!par || par.user_id !== req.userId) return res.status(404).json({ error: 'Par não encontrado' });
  const updated = await db.updatePar(req.params.id, {
    nome: req.body.nome || par.nome,
    telegram_group_id: req.body.telegram_group_id || par.telegram_group_id,
    sendpulse_bot_id: req.body.sendpulse_bot_id || par.sendpulse_bot_id,
    sendpulse_bot_nome: req.body.sendpulse_bot_nome ?? par.sendpulse_bot_nome,
  });
  res.json(updated);
});

router.delete('/pares/:id', async (req, res) => {
  const par = await db.getParById(req.params.id);
  if (!par || par.user_id !== req.userId) return res.status(404).json({ error: 'Par não encontrado' });
  await db.deactivatePar(req.params.id);
  res.json({ ok: true });
});

// ── Messages ───────────────────────────────────────────
router.get('/messages', async (req, res) => {
  const { par_id } = req.query;
  if (!par_id) return res.status(400).json({ error: 'par_id obrigatório' });
  const par = await db.getParById(Number(par_id));
  if (!par || par.user_id !== req.userId) return res.status(403).json({ error: 'Acesso negado' });
  res.json(await db.getMessages(Number(par_id)));
});

// ── Schedules ──────────────────────────────────────────
router.get('/schedules', async (req, res) => {
  const { par_id, status } = req.query;
  if (par_id) {
    const par = await db.getParById(Number(par_id));
    if (!par || par.user_id !== req.userId) return res.status(403).json({ error: 'Acesso negado' });
    res.json(await db.getSchedules(Number(par_id), status || null));
  } else {
    res.json(await db.getAllSchedules(status || null, req.userId));
  }
});

router.post('/schedules', async (req, res) => {
  try {
    let { par_id, sendpulse_bot_id } = req.body;
    if (!req.body.scheduled_at) {
      return res.status(400).json({ error: 'scheduled_at é obrigatório' });
    }
    if (par_id) {
      const par = await db.getParById(par_id);
      if (!par || par.user_id !== req.userId) return res.status(403).json({ error: 'Acesso negado' });
    }
    if (!sendpulse_bot_id && par_id) {
      const par = await db.getParById(par_id);
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
    console.log('[schedules] criando:', { content_type: req.body.content_type, content_media_url: req.body.content_media_url?.slice?.(0, 80), origem: req.body.origem });
    const schedule = await db.createSchedule(req.body);
    const io = req.app.get('io');
    if (io && par_id) io.to(`par_${par_id}`).emit('schedule_update', schedule);
    res.status(201).json(schedule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/schedules/:id/send', async (req, res) => {
  const schedule = await db.getScheduleById(req.params.id);
  if (!schedule || schedule.user_id !== req.userId) return res.status(404).json({ error: 'Agendamento não encontrado' });

  const credentials = await getCredentials(req);
  if (!credentials) return res.status(400).json({ error: 'Configure suas credenciais SendPulse em Configurações' });

  let botId = schedule.sendpulse_bot_id;
  const par = schedule.par_id ? await db.getParById(schedule.par_id) : null;
  if (!botId && par) botId = par.sendpulse_bot_id;
  if (!botId) return res.status(400).json({ error: 'Bot ID não encontrado' });

  try {
    const s = { ...schedule, sendpulse_bot_id: botId };
    await sendpulse.dispatch(s, par, credentials);
    await db.updateScheduleStatus(schedule.id, 'enviado');
    await db.insertLog({ schedule_id: schedule.id, par_id: schedule.par_id, status: 'enviado' });
    res.json({ ok: true, status: 'enviado' });
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    await db.updateScheduleStatus(schedule.id, 'erro', errMsg);
    await db.insertLog({ schedule_id: schedule.id, par_id: schedule.par_id, status: 'erro', sendpulse_response: JSON.stringify(err.response?.data || err.message) });
    res.status(500).json({ error: errMsg });
  }
});

router.put('/schedules/:id', async (req, res) => {
  const existing = await db.getScheduleById(req.params.id);
  if (!existing || existing.user_id !== req.userId) return res.status(404).json({ error: 'Agendamento não encontrado' });
  if (req.body.buttons && req.body.buttons.length > 3) {
    return res.status(400).json({ error: 'Máximo 3 botões permitidos' });
  }
  const updated = await db.updateSchedule(req.params.id, req.body);
  const io = req.app.get('io');
  if (io) io.to(`par_${updated.par_id}`).emit('schedule_update', updated);
  res.json(updated);
});

router.delete('/schedules/:id', async (req, res) => {
  const existing = await db.getScheduleById(req.params.id);
  if (!existing || existing.user_id !== req.userId) return res.status(404).json({ error: 'Agendamento não encontrado' });
  await db.deleteSchedule(req.params.id);
  const io = req.app.get('io');
  if (io) io.to(`par_${existing.par_id}`).emit('schedule_update', { id: existing.id, deleted: true });
  res.json({ ok: true });
});

// ── Dashboard ──────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  const { par_id } = req.query;
  if (!par_id) return res.status(400).json({ error: 'par_id obrigatório' });
  const par = await db.getParById(Number(par_id));
  if (!par || par.user_id !== req.userId) return res.status(403).json({ error: 'Acesso negado' });
  res.json(await db.getDashboard(Number(par_id)));
});

// ── SendPulse Bots ─────────────────────────────────────
router.get('/sendpulse/bots', async (req, res) => {
  const credentials = await getCredentials(req);
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
