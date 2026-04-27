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
 *  │  2. Proteção B: se atraso > 2h, marca 'expirado' e pula │
 *  │  3. Valida: user_id, credenciais SendPulse, bot_id       │
 *  │  4. sendpulse.dispatch() → envia campanha                │
 *  │  5. Se recorrente: cria próxima ocorrência ANTES de      │
 *  │     marcar como 'enviado' (protege contra perda)          │
 *  │  6. Marca como 'enviado' + insere log                     │
 *  │  7. Emite eventos via Socket.io para atualizar frontend   │
 *  └──────────────────────────────────────────────────────────┘
 *
 *  PROTEÇÕES:
 *  A) Recorrência sobrevive ao erro — mesmo que o disparo falhe,
 *     a próxima ocorrência é criada. A cadeia nunca quebra.
 *  B) Schedule vencido não dispara — se scheduled_at tem mais de
 *     2h de atraso, marca como 'expirado' (evita rajada após erro).
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

// Limite máximo de atraso antes de um schedule expirar (2 horas)
const MAX_ATRASO_MS = 2 * 60 * 60 * 1000;

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

      // ── Proteção B: schedule vencido não dispara ──
      // Se scheduled_at tem mais de 2h de atraso, marca como 'expirado'.
      // Impede rajada de mensagens acumuladas após erro temporário.
      const atraso = Date.now() - new Date(s.scheduled_at).getTime();
      if (atraso > MAX_ATRASO_MS) {
        console.log(`[scheduler] Schedule ${s.id} expirado (atraso: ${Math.round(atraso / 60000)}min) — pulando`);
        await db.updateScheduleStatus(s.id, 'expirado', `Expirado: atraso de ${Math.round(atraso / 60000)} minutos`);
        await db.insertLog({ schedule_id: s.id, par_id: s.par_id, status: 'expirado', sendpulse_response: 'Schedule vencido — não disparado' });
        // Mesmo expirado, recorrência deve continuar
        if (s.recurrence) {
          try {
            await scheduleNextOccurrence(s);
            console.log(`[scheduler] Próxima recorrência criada para schedule expirado ${s.id}`);
          } catch (recErr) {
            console.error('[scheduler] erro ao criar recorrência de schedule expirado', s.id, ':', recErr.message);
          }
        }
        if (io && s.par_id) {
          io.to(`par_${s.par_id}`).emit('dispatch_fired', {
            par_id: s.par_id, schedule_id: s.id, status: 'expirado',
          });
        }
        continue;
      }

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

        // ── Recorrência: cria próxima ocorrência ANTES de marcar como enviado ──
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
          io.to(`par_${updated.par_id}`).emit('schedule_update', updated);
          io.to(`par_${s.par_id}`).emit('dispatch_fired', {
            par_id: s.par_id, schedule_id: s.id, status: 'enviado',
          });
        }
      } catch (err) {
        // ── Proteção A: recorrência sobrevive ao erro ──
        // Erro no disparo marca como 'erro', MAS ainda cria a próxima
        // ocorrência se for recorrente. A cadeia nunca quebra.
        const errMsg = err.response?.data?.message || err.message;
        await db.updateScheduleStatus(s.id, 'erro', errMsg);
        await db.insertLog({
          schedule_id: s.id, par_id: s.par_id, status: 'erro',
          sendpulse_response: JSON.stringify(err.response?.data || err.message),
        });

        // Cria próxima ocorrência mesmo com erro (proteção A)
        if (s.recurrence) {
          try {
            await scheduleNextOccurrence(s);
            console.log(`[scheduler] Próxima recorrência criada apesar do erro no schedule ${s.id}`);
          } catch (recErr) {
            console.error('[scheduler] erro ao criar recorrência após falha do schedule', s.id, ':', recErr.message);
          }
        }

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

    // Limpeza de arquivos de upload não referenciados por schedules
    try {
      const fs = require('fs');
      const path = require('path');
      const uploadsDir = path.join(__dirname, '..', '..', 'public', 'uploads');
      if (fs.existsSync(uploadsDir)) {
        const usedUrls = await db.getScheduleMediaFiles();
        const usedFiles = new Set(usedUrls.map(u => u.split('/').pop()));
        const files = fs.readdirSync(uploadsDir);
        let removed = 0;
        for (const f of files) {
          if (!usedFiles.has(f)) {
            fs.unlinkSync(path.join(uploadsDir, f));
            removed++;
          }
        }
        if (removed > 0) console.log(`[cron] ${removed} arquivos de upload removidos`);
      }
    } catch (err) {
      console.error('[cron] erro ao limpar uploads:', err.message);
    }
  });

  console.log('[scheduler] cron jobs iniciados');
}

module.exports = { start };
