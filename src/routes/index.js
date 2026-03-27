/**
 * ============================================================
 *  Routes — API REST do SEND-X
 * ============================================================
 *
 *  Base: /api (definido no index.js principal)
 *
 *  Rotas públicas (sem auth):
 *  - POST /auth/register  → cadastro de usuário
 *  - POST /auth/login     → login (retorna JWT)
 *  - GET  /auth/me        → dados do usuário logado
 *
 *  Rotas protegidas (requerem Bearer token):
 *  - POST   /upload           → upload de mídia (foto/vídeo)
 *  - GET    /settings         → configurações do usuário
 *  - PUT    /settings         → atualizar configurações
 *  - GET    /pares            → listar pares ativos
 *  - POST   /pares            → criar par
 *  - PUT    /pares/:id        → editar par
 *  - DELETE /pares/:id        → desativar par (soft delete)
 *  - GET    /messages         → mensagens do feed de um par
 *  - GET    /schedules        → listar agendamentos
 *  - POST   /schedules        → criar agendamento
 *  - PUT    /schedules/:id    → editar agendamento
 *  - DELETE /schedules/:id    → excluir agendamento (permanente!)
 *  - POST   /schedules/:id/send → enviar agendamento manualmente
 *  - GET    /dashboard        → contadores do dashboard
 *  - GET    /sendpulse/bots   → listar bots SendPulse
 *
 *  Todas as rotas protegidas usam req.userId (injetado pelo middleware auth).
 *  Verificação de ownership: cada recurso valida se pertence ao usuário.
 * ============================================================
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const sendpulse = require('../sendpulse');
const { hashPassword, comparePassword, generateToken, auth } = require('../auth');

const router = express.Router();

// ── Upload de mídia ─────────────────────────────────────
// Salva em public/uploads/ com nome aleatório (hex)
// Formatos: JPG, PNG, MP4, GIF, WEBM, WEBP — máx 50MB
const uploadDir = path.join(__dirname, '..', '..', 'public', 'uploads');
const fs = require('fs');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomBytes(12).toString('hex') + ext); // Nome aleatório
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.mp4', '.gif', '.webm', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Formato não permitido. Use: JPG, PNG, MP4, GIF'));
  },
});

// ── Auth (rotas públicas) ───────────────────────────────

/** POST /auth/register — cadastra novo usuário */
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

/** POST /auth/login — login com email + senha, retorna JWT */
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

/** GET /auth/me — retorna dados do usuário logado (requer token) */
router.get('/auth/me', auth, async (req, res) => {
  const user = await db.getUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json(user);
});

// ══════════════════════════════════════════════════════════
//  TODAS AS ROTAS ABAIXO REQUEREM AUTENTICAÇÃO (Bearer JWT)
// ══════════════════════════════════════════════════════════
router.use(auth);

// ── Upload ──────────────────────────────────────────────

/** POST /upload — upload de arquivo de mídia, retorna URL local */
router.post('/upload', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  const localUrl = `/uploads/${req.file.filename}`;
  console.log('[upload] saved locally:', localUrl);
  res.json({ url: localUrl, filename: req.file.filename, size: req.file.size });
});

// ── User Settings ───────────────────────────────────────

/** GET /settings — retorna configurações (secrets mascarados) */
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

/** PUT /settings — atualizar configurações (não sobrescreve se mascarado) */
router.put('/settings', async (req, res) => {
  const { sendpulse_id, sendpulse_secret, telegram_token, webhook_domain } = req.body;
  const current = await db.getUserSettings(req.userId);

  // Se o valor é '••••••••', mantém o atual (campo mascarado = não alterou)
  const updated = await db.upsertUserSettings(req.userId, {
    sendpulse_id: sendpulse_id ?? current.sendpulse_id ?? null,
    sendpulse_secret: (sendpulse_secret && sendpulse_secret !== '••••••••') ? sendpulse_secret : (current.sendpulse_secret ?? null),
    telegram_token: (telegram_token && telegram_token !== '••••••••') ? telegram_token : (current.telegram_token ?? null),
    webhook_domain: webhook_domain ?? current.webhook_domain ?? null,
  });

  // Reinicia o bot Telegraf do usuário (caso o token tenha mudado)
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

/**
 * Helper: obtém credenciais SendPulse do usuário logado.
 * Retorna null se não configuradas (usado para validação).
 */
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

// ── Pares ───────────────────────────────────────────────
// Par = vínculo entre Telegram grupo + SendPulse bot
// Delete é soft (ativo=0), NÃO apaga schedules existentes

/** GET /pares — lista pares ativos do usuário */
router.get('/pares', async (req, res) => {
  res.json(await db.getAllPares(req.userId));
});

/** POST /pares — cria novo par (nome, telegram_group_id, sendpulse_bot_id obrigatórios) */
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
    // UNIQUE(user_id, telegram_group_id) — mesmo grupo não pode ser cadastrado 2x
    if (err.message.includes('unique') || err.message.includes('duplicate')) {
      return res.status(409).json({ error: 'telegram_group_id já cadastrado para este usuário' });
    }
    res.status(500).json({ error: err.message });
  }
});

/** PUT /pares/:id — editar par (verifica ownership) */
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

/** DELETE /pares/:id — desativa par (soft delete, ativo=0). Schedules NÃO são afetados. */
router.delete('/pares/:id', async (req, res) => {
  const par = await db.getParById(req.params.id);
  if (!par || par.user_id !== req.userId) return res.status(404).json({ error: 'Par não encontrado' });
  await db.deactivatePar(req.params.id);
  res.json({ ok: true });
});

// ── Messages ────────────────────────────────────────────

/** GET /messages?par_id=X — mensagens do feed de um par (verifica ownership) */
router.get('/messages', async (req, res) => {
  const { par_id } = req.query;
  if (!par_id) return res.status(400).json({ error: 'par_id obrigatório' });
  const par = await db.getParById(Number(par_id));
  if (!par || par.user_id !== req.userId) return res.status(403).json({ error: 'Acesso negado' });
  res.json(await db.getMessages(Number(par_id)));
});

// ── Schedules ───────────────────────────────────────────
// CRUD de agendamentos de disparo
// Fluxo: criar pendente → scheduler dispara → status enviado/erro

/** GET /schedules?par_id=X&status=Y — lista agendamentos (filtro opcional) */
router.get('/schedules', async (req, res) => {
  const { par_id, status } = req.query;
  if (par_id) {
    const par = await db.getParById(Number(par_id));
    if (!par || par.user_id !== req.userId) return res.status(403).json({ error: 'Acesso negado' });
    res.json(await db.getSchedules(Number(par_id), status || null));
  } else {
    // Sem par_id: retorna todos os schedules do usuário
    res.json(await db.getAllSchedules(status || null, req.userId));
  }
});

/**
 * POST /schedules — cria novo agendamento.
 * Campos obrigatórios: scheduled_at + (par_id ou sendpulse_bot_id)
 * Validações: recurrence, buttons (máx 3), buttons não permitidos para origem='grupo'
 */
router.post('/schedules', async (req, res) => {
  try {
    let { par_id, sendpulse_bot_id } = req.body;
    if (!req.body.scheduled_at) {
      return res.status(400).json({ error: 'scheduled_at é obrigatório' });
    }
    if (isNaN(new Date(req.body.scheduled_at).getTime())) {
      return res.status(400).json({ error: 'scheduled_at inválido' });
    }
    // Verifica ownership do par
    if (par_id) {
      const par = await db.getParById(par_id);
      if (!par || par.user_id !== req.userId) return res.status(403).json({ error: 'Acesso negado' });
    }
    // Se não tem bot_id explícito, herda do par
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
    // Valida recurrence
    if (req.body.recurrence && !['diario', 'diasuteis', 'semanal'].includes(req.body.recurrence)) {
      return res.status(400).json({ error: 'recurrence inválido. Use: diario, diasuteis ou semanal' });
    }
    // Valida buttons (máximo 3, não permitido para mensagens do grupo)
    if (req.body.buttons && req.body.buttons.length > 3) {
      return res.status(400).json({ error: 'Máximo 3 botões permitidos' });
    }
    if (req.body.buttons && req.body.buttons.length > 0 && req.body.origem === 'grupo') {
      return res.status(400).json({ error: 'Botões não permitidos para mensagens do grupo' });
    }
    // Injeta user_id do token JWT
    req.body.user_id = req.userId;
    console.log('[schedules] criando:', { content_type: req.body.content_type, content_media_url: req.body.content_media_url?.slice?.(0, 80), origem: req.body.origem });
    const schedule = await db.createSchedule(req.body);
    // Notifica frontend via Socket.io
    const io = req.app.get('io');
    if (io && par_id) io.to(`par_${par_id}`).emit('schedule_update', schedule);
    res.status(201).json(schedule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /schedules/:id/send — envio manual imediato de um agendamento */
router.post('/schedules/:id/send', async (req, res) => {
  const schedule = await db.getScheduleById(req.params.id);
  if (!schedule || schedule.user_id !== req.userId) return res.status(404).json({ error: 'Agendamento não encontrado' });

  const credentials = await getCredentials(req);
  if (!credentials) return res.status(400).json({ error: 'Configure suas credenciais SendPulse em Configurações' });

  // Resolve bot_id: do schedule ou do par
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

/** PUT /schedules/:id — editar agendamento (verifica ownership) */
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

/**
 * DELETE /schedules/:id — exclui agendamento PERMANENTEMENTE.
 * ATENÇÃO: Não há como recuperar após exclusão.
 * Emite evento 'schedule_update' com { deleted: true } para o frontend.
 */
router.delete('/schedules/:id', async (req, res) => {
  const existing = await db.getScheduleById(req.params.id);
  if (!existing || existing.user_id !== req.userId) return res.status(404).json({ error: 'Agendamento não encontrado' });
  await db.deleteSchedule(req.params.id);
  const io = req.app.get('io');
  if (io) io.to(`par_${existing.par_id}`).emit('schedule_update', { id: existing.id, deleted: true });
  res.json({ ok: true });
});

// ── Dashboard ───────────────────────────────────────────

/** GET /dashboard?par_id=X — contadores do dashboard de um par */
router.get('/dashboard', async (req, res) => {
  const { par_id } = req.query;
  if (!par_id) return res.status(400).json({ error: 'par_id obrigatório' });
  const par = await db.getParById(Number(par_id));
  if (!par || par.user_id !== req.userId) return res.status(403).json({ error: 'Acesso negado' });
  res.json(await db.getDashboard(Number(par_id)));
});

// ── SendPulse Bots ──────────────────────────────────────

/** GET /sendpulse/bots — lista bots da conta SendPulse do usuário */
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
