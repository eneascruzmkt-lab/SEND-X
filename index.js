require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

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

// Share io with routes
app.set('io', io);

// Routes
app.use('/api', routes);

// Socket.io
setupSocket(io);

// Feed — polls SendPulse API for incoming group messages
feed.start(io);

// Scheduler
scheduler.start(io);

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[server] rodando em http://localhost:${PORT}`);
});
