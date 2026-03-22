const cron = require('node-cron');
const db = require('../db');
const sendpulse = require('../sendpulse');

let io = null;

function scheduleNextOccurrence(schedule) {
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

  db.createSchedule({
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
    const pendentes = db.getSchedulesDue();
    for (const s of pendentes) {
      // Resolve bot_id: direto no schedule ou via par
      const par = s.par_id ? db.getParById(s.par_id) : null;
      if (!s.sendpulse_bot_id && par) {
        s.sendpulse_bot_id = par.sendpulse_bot_id;
      }
      if (!s.sendpulse_bot_id) {
        db.updateScheduleStatus(s.id, 'erro', 'Bot ID não encontrado');
        continue;
      }

      try {
        await sendpulse.dispatch(s, par);
        db.updateScheduleStatus(s.id, 'enviado');
        db.insertLog({ schedule_id: s.id, par_id: s.par_id, status: 'enviado' });
        if (s.recurrence) scheduleNextOccurrence(s);
        if (io && s.par_id) {
          io.to(`par_${s.par_id}`).emit('schedule_update', db.getScheduleById(s.id));
          io.to(`par_${s.par_id}`).emit('dispatch_fired', {
            par_id: s.par_id, schedule_id: s.id, status: 'enviado',
          });
        }
      } catch (err) {
        const errMsg = err.response?.data?.message || err.message;
        db.updateScheduleStatus(s.id, 'erro', errMsg);
        db.insertLog({
          schedule_id: s.id, par_id: s.par_id, status: 'erro',
          sendpulse_response: JSON.stringify(err.response?.data || err.message),
        });
        if (io && s.par_id) {
          io.to(`par_${s.par_id}`).emit('schedule_update', db.getScheduleById(s.id));
          io.to(`par_${s.par_id}`).emit('dispatch_fired', {
            par_id: s.par_id, schedule_id: s.id, status: 'erro',
          });
        }
      }
    }
  });

  // Midnight cleanup
  cron.schedule('0 0 * * *', () => {
    db.clearMessages();
    console.log('[cron] messages apagadas —', new Date().toISOString());
  });

  console.log('[scheduler] cron jobs iniciados');
}

module.exports = { start };
