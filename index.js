/**
 * ============================================================
 *  SEND-X — Ponto de entrada principal do servidor
 * ============================================================
 *
 *  Arquitetura:
 *  - Express HTTP server + Socket.io (tempo real)
 *  - PostgreSQL via DATABASE_URL (Railway)
 *  - Módulos: db, routes, socket, bot (feed), scheduler
 *
 *  Fluxo de inicialização:
 *  1. Carrega variáveis de ambiente (.env)
 *  2. Cria servidor Express + Socket.io
 *  3. Conecta ao PostgreSQL e cria tabelas (IF NOT EXISTS)
 *  4. Inicia bot manager (Telegraf + polling SendPulse)
 *  5. Inicia scheduler (cron a cada minuto)
 *  6. Escuta na porta PORT
 *
 *  IMPORTANTE: Este arquivo NÃO deve ser alterado sem necessidade.
 *  Qualquer mudança aqui afeta TODO o sistema.
 * ============================================================
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// Módulos internos do SEND-X
const db = require('./src/db');             // Banco de dados PostgreSQL
const routes = require('./src/routes');     // Rotas da API REST
const { setup: setupSocket } = require('./src/socket'); // WebSocket rooms
const feed = require('./src/bot');          // Bot Telegram + polling SendPulse
const scheduler = require('./src/scheduler'); // Cron de disparos agendados

const app = express();
const server = http.createServer(app);

// Socket.io com CORS aberto (frontend pode estar em domínio diferente)
const io = new Server(server, { cors: { origin: '*' } });

// Middleware global
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Frontend estático

// Compartilha io e botManager com as rotas via app.set
// Usado em: routes/index.js para emitir eventos de schedule_update
app.set('io', io);
app.set('botManager', feed);

// Todas as rotas da API ficam em /api/*
app.use('/api', routes);

// Configura rooms do Socket.io (join_par / leave_par)
setupSocket(io);

// ── Inicialização ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;

db.init().then(() => {
  // Bot manager — captura mensagens dos grupos Telegram em tempo real
  feed.start(io);

  // Scheduler — dispara agendamentos pendentes a cada minuto
  scheduler.start(io);

  // Cron Klarvel: agrega dados das lives do dia anterior, todo dia às 06:00 BRT
  const cron = require('node-cron');
  const { aggregateKlarvelForDate } = require('./src/cron/klarvel-aggregate');
  cron.schedule('0 6 * * *', async () => {
    console.log('[cron-klarvel] agregando lives do dia anterior…');
    try {
      const r = await aggregateKlarvelForDate();
      console.log('[cron-klarvel] ok:', JSON.stringify(r));
    } catch (e) { console.error('[cron-klarvel]', e.message); }
  }, { timezone: 'America/Sao_Paulo' });
  console.log('[cron-klarvel] agendado pra 06:00 BRT diário');

  // Cron AI Advisor: gera recomendações + mede outcomes + notifica WhatsApp
  // Horários: 08:00 (manhã), 15:00 (tarde), 00:00 (madrugada/fechamento) BRT
  const advisor = require('./src/ai-advisor');
  const runAdvisor = async (slot) => {
    console.log(`[cron-ai-advisor:${slot}] gerando recomendações…`);
    try {
      await advisor.medirOutcomesAtrasados(1);
      const recs = await advisor.gerarRecomendacoes(1, undefined, slot);
      console.log(`[cron-ai-advisor:${slot}] geradas ${recs.length} recomendações`);
      const notif = await advisor.notificarTop3(1, slot);
      console.log(`[cron-ai-advisor:${slot}] notify:`, JSON.stringify(notif));
    } catch (e) { console.error(`[cron-ai-advisor:${slot}]`, e.message); }
  };
  cron.schedule('0 8 * * *',  () => runAdvisor('manha'),    { timezone: 'America/Sao_Paulo' });
  cron.schedule('0 15 * * *', () => runAdvisor('tarde'),    { timezone: 'America/Sao_Paulo' });
  cron.schedule('0 0 * * *',  () => runAdvisor('madrugada'),{ timezone: 'America/Sao_Paulo' });
  console.log('[cron-ai-advisor] agendado pra 08:00, 15:00 e 00:00 BRT');

  // Smart Reminders: scanneia lives terminadas a cada 10min
  const smartReminders = require('./src/smart-reminders');
  cron.schedule('*/10 * * * *', async () => {
    try {
      const r = await smartReminders.processarLivesTerminadas(1, 30);
      if (Array.isArray(r) && r.length > 0) {
        console.log('[cron-reminders]', JSON.stringify(r));
      }
    } catch (e) { console.error('[cron-reminders]', e.message); }
  });
  console.log('[cron-reminders] agendado a cada 10 minutos');

  server.listen(PORT, () => {
    console.log(`[server] rodando em http://localhost:${PORT}`);
  });

  // Graceful shutdown — encerra bots e conexões ao receber SIGINT/SIGTERM
  const shutdown = (signal) => {
    console.log(`[server] ${signal} recebido, encerrando...`);
    feed.stop();
    server.close(() => {
      db.pool.end().then(() => {
        console.log('[server] encerrado.');
        process.exit(0);
      });
    });
    // Forçar saída após 10s se algo travar
    setTimeout(() => process.exit(1), 10000);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}).catch(err => {
  console.error('[db] Falha ao inicializar PostgreSQL:', err.message);
  process.exit(1);
});
