const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', '..', 'data.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id           INTEGER PRIMARY KEY REFERENCES users(id),
  sendpulse_id      TEXT,
  sendpulse_secret  TEXT,
  telegram_token    TEXT,
  webhook_domain    TEXT,
  updated_at        TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pares (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER NOT NULL REFERENCES users(id),
  nome                TEXT NOT NULL,
  telegram_group_id   TEXT NOT NULL,
  sendpulse_bot_id    TEXT NOT NULL,
  sendpulse_bot_nome  TEXT,
  ativo               INTEGER DEFAULT 1,
  created_at          TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, telegram_group_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  par_id        INTEGER NOT NULL REFERENCES pares(id),
  text          TEXT,
  from_user     TEXT,
  message_type  TEXT DEFAULT 'text',
  file_id       TEXT,
  telegram_media_url TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schedules (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER REFERENCES users(id),
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
try { db.exec('ALTER TABLE pares ADD COLUMN user_id INTEGER REFERENCES users(id)'); } catch {}
try { db.exec('ALTER TABLE schedules ADD COLUMN user_id INTEGER REFERENCES users(id)'); } catch {}
try { db.exec('ALTER TABLE schedules ADD COLUMN sendpulse_bot_id TEXT'); } catch {}
try { db.exec('ALTER TABLE schedules ADD COLUMN sendpulse_bot_nome TEXT'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN telegram_media_url TEXT'); } catch {}

// ── Users ─────────────────────────────────────────────
module.exports = {
  // Users
  createUser(data) {
    const stmt = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (@name, @email, @password_hash)');
    const info = stmt.run(data);
    return db.prepare('SELECT id, name, email, created_at FROM users WHERE id=?').get(info.lastInsertRowid);
  },
  getUserByEmail(email) {
    return db.prepare('SELECT * FROM users WHERE email=?').get(email);
  },
  getUserById(id) {
    return db.prepare('SELECT id, name, email, created_at FROM users WHERE id=?').get(id);
  },

  // User Settings
  getUserSettings(userId) {
    return db.prepare('SELECT * FROM user_settings WHERE user_id=?').get(userId) || {};
  },
  upsertUserSettings(userId, data) {
    const existing = db.prepare('SELECT user_id FROM user_settings WHERE user_id=?').get(userId);
    if (existing) {
      db.prepare(`
        UPDATE user_settings SET sendpulse_id=@sendpulse_id, sendpulse_secret=@sendpulse_secret,
          telegram_token=@telegram_token, webhook_domain=@webhook_domain, updated_at=datetime('now')
        WHERE user_id=@user_id
      `).run({ user_id: userId, ...data });
    } else {
      db.prepare(`
        INSERT INTO user_settings (user_id, sendpulse_id, sendpulse_secret, telegram_token, webhook_domain)
        VALUES (@user_id, @sendpulse_id, @sendpulse_secret, @telegram_token, @webhook_domain)
      `).run({ user_id: userId, ...data });
    }
    return this.getUserSettings(userId);
  },

  // Get all users that have telegram_token configured (for bot manager)
  getUsersWithTelegram() {
    return db.prepare(`
      SELECT u.id, us.telegram_token FROM users u
      JOIN user_settings us ON us.user_id = u.id
      WHERE us.telegram_token IS NOT NULL AND us.telegram_token != ''
    `).all();
  },

  // Pares
  getAllPares(userId) {
    return db.prepare('SELECT * FROM pares WHERE user_id=? AND ativo=1 ORDER BY created_at DESC').all(userId);
  },
  getParById(id) {
    return db.prepare('SELECT * FROM pares WHERE id=?').get(id);
  },
  getParByGroupId(groupId) {
    return db.prepare('SELECT * FROM pares WHERE telegram_group_id=? AND ativo=1').get(groupId);
  },
  getParsByGroupId(groupId) {
    return db.prepare('SELECT * FROM pares WHERE telegram_group_id=? AND ativo=1').all(groupId);
  },
  createPar(data) {
    const stmt = db.prepare(`
      INSERT INTO pares (user_id, nome, telegram_group_id, sendpulse_bot_id, sendpulse_bot_nome)
      VALUES (@user_id, @nome, @telegram_group_id, @sendpulse_bot_id, @sendpulse_bot_nome)
    `);
    const info = stmt.run(data);
    return this.getParById(info.lastInsertRowid);
  },
  updatePar(id, data) {
    db.prepare(`
      UPDATE pares SET nome=@nome, telegram_group_id=@telegram_group_id,
        sendpulse_bot_id=@sendpulse_bot_id, sendpulse_bot_nome=@sendpulse_bot_nome
      WHERE id=@id
    `).run({ ...data, id });
    return this.getParById(id);
  },
  deactivatePar(id) {
    db.prepare('UPDATE pares SET ativo=0 WHERE id=?').run(id);
  },

  // Messages
  insertMessage(msg) {
    const cols = ['par_id', 'text', 'from_user', 'message_type', 'file_id'];
    if (msg.created_at) cols.push('created_at');
    if (msg.telegram_media_url) cols.push('telegram_media_url');
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
        'SELECT * FROM schedules WHERE par_id=? AND status=? ORDER BY scheduled_at ASC'
      ).all(parId, status);
    }
    return db.prepare(
      'SELECT * FROM schedules WHERE par_id=? ORDER BY scheduled_at ASC'
    ).all(parId);
  },
  getAllSchedules(status, userId) {
    if (status && userId) {
      return db.prepare(
        'SELECT * FROM schedules WHERE user_id=? AND status=? ORDER BY scheduled_at ASC'
      ).all(userId, status);
    }
    if (userId) {
      return db.prepare('SELECT * FROM schedules WHERE user_id=? ORDER BY scheduled_at ASC').all(userId);
    }
    if (status) {
      return db.prepare(
        'SELECT * FROM schedules WHERE status=? ORDER BY scheduled_at ASC'
      ).all(status);
    }
    return db.prepare('SELECT * FROM schedules ORDER BY scheduled_at ASC').all();
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
      INSERT INTO schedules (user_id, par_id, sendpulse_bot_id, sendpulse_bot_nome, origem, content_type,
        content_text, content_file_id, content_media_url, buttons, scheduled_at, recurrence)
      VALUES (@user_id, @par_id, @sendpulse_bot_id, @sendpulse_bot_nome, @origem, @content_type,
        @content_text, @content_file_id, @content_media_url, @buttons, @scheduled_at, @recurrence)
    `);
    const info = stmt.run({
      user_id: data.user_id || null,
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
