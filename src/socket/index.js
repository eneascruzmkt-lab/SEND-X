/**
 * ============================================================
 *  Socket.io — Gerenciamento de rooms em tempo real
 * ============================================================
 *
 *  Cada "par" (Telegram grupo + SendPulse bot) tem uma room
 *  identificada como "par_{id}".
 *
 *  Eventos:
 *  - join_par(parId)  → cliente entra na room do par (recebe updates)
 *  - leave_par(parId) → cliente sai da room do par
 *
 *  Emissões (feitas por outros módulos via io.to):
 *  - new_message      → nova mensagem capturada do Telegram (bot/index.js)
 *  - schedule_update  → agendamento criado/editado/enviado (routes + scheduler)
 *  - dispatch_fired   → disparo executado pelo scheduler
 *
 *  IMPORTANTE: Este arquivo NÃO faz lógica de negócio.
 *  Apenas gerencia as rooms. Outros módulos emitem os eventos.
 * ============================================================
 */

function setup(io) {
  io.on('connection', (socket) => {
    // Cliente entra na room de um par para receber atualizações em tempo real
    socket.on('join_par', (parId) => {
      if (parId && !isNaN(parId)) {
        socket.join(`par_${parId}`);
      }
    });

    // Cliente sai da room (ao trocar de par ou desconectar)
    socket.on('leave_par', (parId) => {
      if (parId && !isNaN(parId)) {
        socket.leave(`par_${parId}`);
      }
    });
  });
}

module.exports = { setup };
