/**
 * ============================================================
 *  Scheduler — Cron de limpeza (disparo migrado para o Pulp)
 * ============================================================
 *
 *  O disparo de schedules foi migrado para o Pulp.
 *  Este modulo mantem apenas a limpeza de meia-noite.
 * ============================================================
 */

const cron = require('node-cron');
const db = require('../db');

function start() {
  // Limpeza de mensagens a meia-noite
  cron.schedule('0 0 * * *', async () => {
    try {
      await db.clearMessages();
      console.log('[cron] messages apagadas —', new Date().toISOString());
    } catch (err) {
      console.error('[cron] erro ao limpar messages:', err.message);
    }
  });

  console.log('[scheduler] cron de limpeza iniciado (disparo desativado — migrado para Pulp)');
}

module.exports = { start };
