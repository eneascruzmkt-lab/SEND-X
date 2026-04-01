/**
 * ============================================================
 *  Scheduler — Cron de disparos automáticos
 * ============================================================
 *
 *  Dois cron jobs:
 *
 *  1. A CADA MINUTO: verifica schedules pendentes com scheduled_at <= NOW()
 *     e dispara via SendPulse. Processa todos os usuários.
 *
 *  2. MEIA-NOITE: limpa tabela messages (feed do dia anterior).
 *     ATENÇÃO: Só limpa messages, NUNCA schedules.
 *
 *  Fluxo de disparo:
 *  ┌──────────────────────────────────────────────────────────┐
 *  │  1. getSchedulesDue() → busca pendentes com data <= NOW  │
 *  │  2. Valida: user_id, credenciais SendPulse, bot_id       │
 *  │  3. sendpulse.dispatch() → envia campanha                │
 *  │  4. Se recorrente: cria próxima ocorrência ANTES de      │
 *  │     marcar como 'enviado' (protege contra perda)          │
 *  │  5. Marca como 'enviado' + insere log                     │
 *  │  6. Emite eventos via Socket.io para atualizar frontend   │
 *  └──────────────────────────────────────────────────────────┘
 *
 *  PROTEÇÃO DE RECORRÊNCIA:
 *  Se scheduleNextOccurrence falhar, o schedule NÃO é marcado
 *  como 'enviado' — permanece 'pendente' para retry no próximo
 *  ciclo. Isso evita que recorrências "desapareçam" silenciosamente.
 * ============================================================
 */

const cron = require('node-cron');
const db = require('../db');
const sendpulse = require('../sendpulse');

let io = null; // Referência ao Socket.io (injetada via start)

/**
 * Cria a próxima ocorrência de um schedule recorrente.
 * Calcula a data com base no scheduled_at atual + tipo de recorrência.
 *
 * Tipos:
 * - 'diario'    → +1 dia
 * - 'diasuteis' → próximo dia útil (pula sáb/dom)
 * - 'semanal'   → +7 dias
 *
 * Cria um NOVO registro na tabela schedules (não modifica o atual).
 * O novo schedule herda: user_id, par_id, bot, conteúdo, recurrence.
 */
async function scheduleNextOccurrence(schedule) {
  const current = new Date(schedule.scheduled_at);
  if (isNaN(current.getTime())) {
    console.error('[scheduler] scheduled_at inválido para recorrência:', schedule.scheduled_at);
    return;
  }
  let next;

  switch (schedule.recurrence) {
    case 'diario':
      next = new Date(current);
      next.setDate(next.getDate() + 1);
      break;
    case 'diasuteis': {
      next = new Date(current);
      do {
        next.setDate(next.getDate() + 1);
      } while (next.getDay() === 0 || next.getDay() === 6); // Pula sáb(6) e dom(0)
      break;
    }
    case 'semanal':
      next = new Date(current);
      next.setDate(next.getDate() + 7);
      break;
    default:
      return; // Tipo desconhecido — não cria próxima
  }

  // Cria novo schedule com todos os dados do atual + nova data
  await db.createSchedule({
    user_id: schedule.user_id,
    par_id: schedule.par_id,
    sendpulse_bot_id: schedule.sendpulse_bot_id,
    sendpulse_bot_nome: schedule.sendpulse_bot_nome,
    origem: schedule.origem,
    content_type: schedule.content_type,
    content_text: schedule.content_text,
    content_file_id: schedule.content_file_id,
    content_media_url: schedule.content_media_url,
    buttons: schedule.buttons,
    scheduled_at: next.toISOString(),
    recurrence: schedule.recurrence,
  });
}

/**
 * Inicia os cron jobs do scheduler.
 * @param {Object} socketIo — instância do Socket.io para emitir eventos
 */
function start(socketIo) {
  io = socketIo;

  // ── Cron: disparo de schedules pendentes (a cada minuto) ──
  cron.schedule('* * * * *', async () => {
    let pendentes;
    try {
      pendentes = await db.getSchedulesDue();
    } catch (err) {
      console.error('[scheduler] erro ao buscar pendentes:', err.message);
      return;
    }

    for (const s of pendentes) {
      // Validação: usuário deve existir
      const userId = s.user_id;
      if (!userId) {
        await db.updateScheduleStatus(s.id, 'erro', 'Usuário não encontrado');
        continue;
      }

      // Validação: credenciais SendPulse devem estar configuradas
      let settings;
      try {
        settings = await db.getUserSettings(userId);
      } catch (err) {
        console.error('[scheduler] erro ao buscar settings user', userId, ':', err.message);
        await db.updateScheduleStatus(s.id, 'erro', 'Erro ao buscar configurações');
        continue;
      }

      if (!settings.sendpulse_id || !settings.sendpulse_secret) {
        await db.updateScheduleStatus(s.id, 'erro', 'Credenciais SendPulse não configuradas');
        continue;
      }

      const credentials = {
        sendpulse_id: settings.sendpulse_id,
        sendpulse_secret: settings.sendpulse_secret,
        webhook_domain: settings.webhook_domain,
      };

      // Resolve bot_id: do schedule ou do par vinculado
      const par = s.par_id ? await db.getParById(s.par_id) : null;
      if (!s.sendpulse_bot_id && par) {
        s.sendpulse_bot_id = par.sendpulse_bot_id;
      }
      if (!s.sendpulse_bot_id) {
        await db.updateScheduleStatus(s.id, 'erro', 'Bot ID não encontrado');
        continue;
      }

      try {
        // ── Disparo via SendPulse ──
        await sendpulse.dispatch(s, par, credentials);

        // ── Proteção de recorrência ──
        // Para recorrentes: criar próxima ocorrência ANTES de marcar como enviado.
        // Se falhar, NÃO marca como enviado — mantém pendente para retry.
        // Isso evita que a recorrência "desapareça" do sistema.
        if (s.recurrence) {
          let recOk = false;
          try {
            await scheduleNextOccurrence(s);
            recOk = true;
          } catch (recErr) {
            console.error('[scheduler] erro ao criar próxima recorrência para schedule', s.id, '(tentativa 1):', recErr.message);
            // Retry uma vez antes de desistir
            try {
              await scheduleNextOccurrence(s);
              recOk = true;
            } catch (recErr2) {
              console.error('[scheduler] erro ao criar próxima recorrência para schedule', s.id, '(tentativa 2):', recErr2.message);
            }
          }
          if (!recOk) {
            // Falhou em criar próxima ocorrência — NÃO marcar como enviado
            // O schedule permanece 'pendente' e será reprocessado no próximo ciclo
            console.error('[scheduler] ALERTA: recorrência do schedule', s.id, 'não foi criada — mantendo como pendente');
            await db.insertLog({ schedule_id: s.id, par_id: s.par_id, status: 'enviado', sendpulse_response: 'Enviado, mas próxima recorrência falhou — mantido pendente para retry' });
            if (io && s.par_id) {
              io.to(`par_${s.par_id}`).emit('dispatch_fired', {
                par_id: s.par_id, schedule_id: s.id, status: 'enviado',
              });
            }
            continue; // Não marca como enviado — retry no próximo minuto
          }
        }

        // ── Sucesso: marca como enviado + log ──
        await db.updateScheduleStatus(s.id, 'enviado');
        await db.insertLog({ schedule_id: s.id, par_id: s.par_id, status: 'enviado' });

        // Notifica frontend via Socket.io
        if (io && s.par_id) {
          const updated = await db.getScheduleById(s.id);
          io.to(`par_${s.par_id}`).emit('schedule_update', updated);
          io.to(`par_${s.par_id}`).emit('dispatch_fired', {
            par_id: s.par_id, schedule_id: s.id, status: 'enviado',
          });
        }
      } catch (err) {
        // ── Erro no disparo: marca como erro + log ──
        const errMsg = err.response?.data?.message || err.message;
        await db.updateScheduleStatus(s.id, 'erro', errMsg);
        await db.insertLog({
          schedule_id: s.id, par_id: s.par_id, status: 'erro',
          sendpulse_response: JSON.stringify(err.response?.data || err.message),
        });
        // Notifica frontend do erro
        if (io && s.par_id) {
          const updated = await db.getScheduleById(s.id);
          io.to(`par_${s.par_id}`).emit('schedule_update', updated);
          io.to(`par_${s.par_id}`).emit('dispatch_fired', {
            par_id: s.par_id, schedule_id: s.id, status: 'erro',
          });
        }
      }
    }
  });

  // ── Cron: limpeza de mensagens à meia-noite ──
  // Remove TODAS as mensagens do feed (tabela messages).
  // ATENÇÃO: Isso NÃO afeta schedules — são tabelas separadas.
  cron.schedule('0 0 * * *', async () => {
    try {
      await db.clearMessages();
      console.log('[cron] messages apagadas —', new Date().toISOString());
    } catch (err) {
      console.error('[cron] erro ao limpar messages:', err.message);
    }
  });

  console.log('[scheduler] cron jobs iniciados');
}

module.exports = { start };
