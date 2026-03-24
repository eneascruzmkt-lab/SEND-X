const cron = require('node-cron');
const db = require('../db');
const sendpulse = require('../sendpulse');

let io = null;

async function scheduleNextOccurrence(schedule) {
  const current = new Date(schedule.scheduled_at);
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
      } while (next.getDay() === 0 || next.getDay() === 6);
      break;
    }
    case 'semanal':
      next = new Date(current);
      next.setDate(next.getDate() + 7);
      break;
    default:
      return;
  }

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
    scheduled_at: next.toISOString().slice(0, 19),
    recurrence: schedule.recurrence,
  });
}

function start(socketIo) {
  io = socketIo;

  // Fire pending schedules every minute
  cron.schedule('* * * * *', async () => {
    const pendentes = await db.getSchedulesDue();
    for (const s of pendentes) {
      const userId = s.user_id;
      if (!userId) {
        await db.updateScheduleStatus(s.id, 'erro', 'Usuário não encontrado');
        continue;
      }

      const settings = await db.getUserSettings(userId);
      if (!settings.sendpulse_id || !settings.sendpulse_secret) {
        await db.updateScheduleStatus(s.id, 'erro', 'Credenciais SendPulse não configuradas');
        continue;
      }

      const credentials = {
        sendpulse_id: settings.sendpulse_id,
        sendpulse_secret: settings.sendpulse_secret,
        webhook_domain: settings.webhook_domain,
      };

      const par = s.par_id ? await db.getParById(s.par_id) : null;
      if (!s.sendpulse_bot_id && par) {
        s.sendpulse_bot_id = par.sendpulse_bot_id;
      }
      if (!s.sendpulse_bot_id) {
        await db.updateScheduleStatus(s.id, 'erro', 'Bot ID não encontrado');
        continue;
      }

      try {
        await sendpulse.dispatch(s, par, credentials);
        await db.updateScheduleStatus(s.id, 'enviado');
        await db.insertLog({ schedule_id: s.id, par_id: s.par_id, status: 'enviado' });
        if (s.recurrence) await scheduleNextOccurrence(s);
        if (io && s.par_id) {
          const updated = await db.getScheduleById(s.id);
          io.to(`par_${s.par_id}`).emit('schedule_update', updated);
          io.to(`par_${s.par_id}`).emit('dispatch_fired', {
            par_id: s.par_id, schedule_id: s.id, status: 'enviado',
          });
        }
      } catch (err) {
        const errMsg = err.response?.data?.message || err.message;
        await db.updateScheduleStatus(s.id, 'erro', errMsg);
        await db.insertLog({
          schedule_id: s.id, par_id: s.par_id, status: 'erro',
          sendpulse_response: JSON.stringify(err.response?.data || err.message),
        });
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

  // Midnight cleanup
  cron.schedule('0 0 * * *', async () => {
    await db.clearMessages();
    console.log('[cron] messages apagadas —', new Date().toISOString());
  });

  console.log('[scheduler] cron jobs iniciados');
}

module.exports = { start };
