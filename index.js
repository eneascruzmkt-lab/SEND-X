require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const db = require('./src/db');
const routes = require('./src/routes');
const { setup: setupSocket } = require('./src/socket');
const feed = require('./src/bot');
const scheduler = require('./src/scheduler');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Share io and botManager with routes
app.set('io', io);
app.set('botManager', feed);

// Routes
app.use('/api', routes);

// Socket.io
setupSocket(io);

// Init DB, then start everything
const PORT = process.env.PORT || 3000;

db.init().then(() => {
  // Feed — polls SendPulse API for incoming group messages
  feed.start(io);

  // Scheduler
  scheduler.start(io);

  server.listen(PORT, () => {
    console.log(`[server] rodando em http://localhost:${PORT}`);
  });

  // Graceful shutdown
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
