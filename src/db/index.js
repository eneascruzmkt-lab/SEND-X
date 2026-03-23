const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', '..', 'data.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS pares (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  nome                TEXT NOT NULL,
  telegram_group_id   TEXT NOT NULL UNIQUE,
  sendpulse_bot_id    TEXT NOT NULL,
  sendpulse_bot_nome  TEXT,
  ativo               INTEGER DEFAULT 1,
  created_at          TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  par_id        INTEGER NOT NULL REFERENCES pares(id),
  text          TEXT,
  from_user     TEXT,
  message_type  TEXT DEFAULT 'text',
  file_id       TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schedules (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  par_id              INTEGER REFERENCES pares(id),
  sendpulse_bot_id    TEXT,
  sendpulse_bot_nome  TEXT,
  origem              TEXT DEFAULT 'manual',
  content_type        TEXT DEFAULT 'text',
  content_text        TEXT,
  content_file_id     TEXT,
  content_media_url   TEXT,
  buttons             TEXT,
  scheduled_at        TEXT NOT NULL,
  status              TEXT DEFAULT 'pendente',
  recurrence          TEXT DEFAULT NULL,
  error_msg           TEXT,
  created_at          TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id   INTEGER REFERENCES schedules(id),
  par_id        INTEGER REFERENCES pares(id),
  status        TEXT,
  sendpulse_response TEXT,
  fired_at      TEXT DEFAULT (datetime('now'))
);
`);

// Migration: add columns if missing (safe for existing DBs)
try { db.exec('ALTER TABLE schedules ADD COLUMN sendpulse_bot_id TEXT'); } catch {}
try { db.exec('ALTER TABLE schedules ADD COLUMN sendpulse_bot_nome TEXT'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN telegram_media_url TEXT'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN telegram_message_id INTEGER'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN telegram_chat_id TEXT'); } catch {}
try { db.exec('ALTER TABLE schedules ADD COLUMN telegram_message_id INTEGER'); } catch {}
try { db.exec('ALTER TABLE schedules ADD COLUMN telegram_chat_id TEXT'); } catch {}
try { db.exec('ALTER TABLE pares ADD COLUMN channel_username TEXT'); } catch {}

// ── Pares ───────────────────────────────────────────────
const insertPar = db.prepare(`
  INSERT INTO pares (nome, telegram_group_id, sendpulse_bot_id, sendpulse_bot_nome, channel_username)
  VALUES (@nome, @telegram_group_id, @sendpulse_bot_id, @sendpulse_bot_nome, @channel_username)
`);

const updatePar = db.prepare(`
  UPDATE pares SET nome=@nome, telegram_group_id=@telegram_group_id,
    sendpulse_bot_id=@sendpulse_bot_id, sendpulse_bot_nome=@sendpulse_bot_nome,
    channel_username=@channel_username
  WHERE id=@id
`);

const deactivatePar = db.prepare(`UPDATE pares SET ativo=0 WHERE id=?`);

module.exports = {
  // Pares
  getAllPares() {
    return db.prepare('SELECT * FROM pares WHERE ativo=1 ORDER BY created_at DESC').all();
  },
  getParById(id) {
    return db.prepare('SELECT * FROM pares WHERE id=?').get(id);
  },
  getParByGroupId(groupId) {
    return db.prepare('SELECT * FROM pares WHERE telegram_group_id=? AND ativo=1').get(groupId);
  },
  createPar(data) {
    const info = insertPar.run(data);
    return this.getParById(info.lastInsertRowid);
  },
  updatePar(id, data) {
    updatePar.run({ ...data, id });
    return this.getParById(id);
  },
  deactivatePar(id) {
    deactivatePar.run(id);
  },

  // Messages
  insertMessage(msg) {
    const cols = ['par_id', 'text', 'from_user', 'message_type', 'file_id'];
    if (msg.created_at) cols.push('created_at');
    if (msg.telegram_media_url) cols.push('telegram_media_url');
    if (msg.telegram_message_id) cols.push('telegram_message_id');
    if (msg.telegram_chat_id) cols.push('telegram_chat_id');
    const placeholders = cols.map(c => '@' + c).join(', ');
    const stmt = db.prepare(`INSERT INTO messages (${cols.join(', ')}) VALUES (${placeholders})`);
    const info = stmt.run(msg);
    return db.prepare('SELECT * FROM messages WHERE id=?').get(info.lastInsertRowid);
  },
  getMessages(parId, limit = 200) {
    return db.prepare(
      'SELECT * FROM messages WHERE par_id=? ORDER BY id DESC LIMIT ?'
    ).all(parId, limit);
  },
  clearMessages() {
    db.prepare('DELETE FROM messages').run();
  },

  // Schedules
  getSchedules(parId, status) {
    if (status) {
      return db.prepare(
        'SELECT * FROM schedules WHERE par_id=? AND status=? ORDER BY scheduled_at DESC'
      ).all(parId, status);
    }
    return db.prepare(
      'SELECT * FROM schedules WHERE par_id=? ORDER BY scheduled_at DESC'
    ).all(parId);
  },
  getAllSchedules(status) {
    if (status) {
      return db.prepare(
        'SELECT * FROM schedules WHERE status=? ORDER BY scheduled_at DESC'
      ).all(status);
    }
    return db.prepare('SELECT * FROM schedules ORDER BY scheduled_at DESC').all();
  },
  getScheduleById(id) {
    return db.prepare('SELECT * FROM schedules WHERE id=?').get(id);
  },
  getSchedulesDue() {
    return db.prepare(
      "SELECT * FROM schedules WHERE status='pendente' AND scheduled_at <= datetime('now')"
    ).all();
  },
  createSchedule(data) {
    const stmt = db.prepare(`
      INSERT INTO schedules (par_id, sendpulse_bot_id, sendpulse_bot_nome, origem, content_type,
        content_text, content_file_id, content_media_url, buttons, scheduled_at, recurrence,
        telegram_message_id, telegram_chat_id)
      VALUES (@par_id, @sendpulse_bot_id, @sendpulse_bot_nome, @origem, @content_type,
        @content_text, @content_file_id, @content_media_url, @buttons, @scheduled_at, @recurrence,
        @telegram_message_id, @telegram_chat_id)
    `);
    const info = stmt.run({
      par_id: data.par_id || null,
      sendpulse_bot_id: data.sendpulse_bot_id || null,
      sendpulse_bot_nome: data.sendpulse_bot_nome || null,
      origem: data.origem || 'manual',
      content_type: data.content_type || 'text',
      content_text: data.content_text || null,
      content_file_id: data.content_file_id || null,
      content_media_url: data.content_media_url || null,
      buttons: data.buttons ? JSON.stringify(data.buttons) : null,
      scheduled_at: data.scheduled_at,
      recurrence: data.recurrence || null,
      telegram_message_id: data.telegram_message_id || null,
      telegram_chat_id: data.telegram_chat_id || null,
    });
    return this.getScheduleById(info.lastInsertRowid);
  },
  updateSchedule(id, data) {
    const fields = [];
    const vals = { id };
    for (const key of ['content_type','content_text','content_file_id','content_media_url','buttons','scheduled_at','recurrence','status','sendpulse_bot_id','sendpulse_bot_nome']) {
      if (data[key] !== undefined) {
        fields.push(`${key}=@${key}`);
        vals[key] = key === 'buttons' && typeof data[key] === 'object' ? JSON.stringify(data[key]) : data[key];
      }
    }
    if (fields.length === 0) return this.getScheduleById(id);
    db.prepare(`UPDATE schedules SET ${fields.join(', ')} WHERE id=@id`).run(vals);
    return this.getScheduleById(id);
  },
  updateScheduleStatus(id, status, errorMsg) {
    if (errorMsg) {
      db.prepare('UPDATE schedules SET status=?, error_msg=? WHERE id=?').run(status, errorMsg, id);
    } else {
      db.prepare('UPDATE schedules SET status=? WHERE id=?').run(status, id);
    }
  },
  deleteSchedule(id) {
    db.prepare('DELETE FROM schedules WHERE id=?').run(id);
  },

  // Logs
  insertLog(data) {
    db.prepare(`
      INSERT INTO logs (schedule_id, par_id, status, sendpulse_response)
      VALUES (@schedule_id, @par_id, @status, @sendpulse_response)
    `).run({
      schedule_id: data.schedule_id,
      par_id: data.par_id || null,
      status: data.status,
      sendpulse_response: data.sendpulse_response || null,
    });
  },

  // Dashboard
  getDashboard(parId) {
    const today = new Date().toISOString().slice(0, 10);
    const agendados_hoje = db.prepare(
      "SELECT COUNT(*) as c FROM schedules WHERE par_id=? AND scheduled_at LIKE ? AND status='pendente'"
    ).get(parId, `${today}%`).c;
    const enviados = db.prepare(
      "SELECT COUNT(*) as c FROM schedules WHERE par_id=? AND status='enviado'"
    ).get(parId).c;
    const pendentes = db.prepare(
      "SELECT COUNT(*) as c FROM schedules WHERE par_id=? AND status='pendente'"
    ).get(parId).c;
    const erros = db.prepare(
      "SELECT COUNT(*) as c FROM schedules WHERE par_id=? AND status='erro'"
    ).get(parId).c;
    const msgs_hoje = db.prepare(
      'SELECT COUNT(*) as c FROM messages WHERE par_id=?'
    ).get(parId).c;
    return { agendados_hoje, enviados, pendentes, erros, msgs_hoje };
  },

  raw: db,
};
