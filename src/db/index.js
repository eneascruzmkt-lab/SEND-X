/**
 * ============================================================
 *  DB — Camada de acesso ao PostgreSQL (Railway)
 * ============================================================
 *
 *  Tabelas:
 *  - users           → cadastro de usuários (email + senha bcrypt)
 *  - user_settings   → credenciais SendPulse + Telegram por usuário
 *  - pares           → vínculo Telegram grupo <-> SendPulse bot
 *  - messages        → mensagens capturadas dos grupos Telegram (feed)
 *  - schedules       → agendamentos de disparo (pendente/enviado/erro)
 *  - logs            → histórico de disparos (auditoria)
 *
 *  REGRAS CRÍTICAS:
 *  ┌─────────────────────────────────────────────────────────┐
 *  │  1. NUNCA usar DROP TABLE ou TRUNCATE em schedules      │
 *  │  2. NUNCA usar CREATE TABLE sem IF NOT EXISTS            │
 *  │  3. Alterações de schema devem ser feitas via ALTER TABLE│
 *  │  4. Dados de schedules são IRREVERSÍVEIS se perdidos     │
 *  └─────────────────────────────────────────────────────────┘
 *
 *  Status de schedules:
 *  - 'pendente' → aguardando disparo (cron verifica a cada minuto)
 *  - 'enviado'  → disparado com sucesso via SendPulse
 *  - 'erro'     → falha no disparo (mensagem salva em error_msg)
 *
 *  Recorrência de schedules:
 *  - null       → disparo único
 *  - 'diario'   → repete todo dia no mesmo horário
 *  - 'diasuteis' → repete seg-sex no mesmo horário
 *  - 'semanal'  → repete a cada 7 dias no mesmo horário
 * ============================================================
 */

const { Pool } = require('pg');

const dbUrl = process.env.DATABASE_URL;
console.log('[db] DATABASE_URL presente:', !!dbUrl);

if (!dbUrl) {
  console.error('[db] ERRO: DATABASE_URL não está definida. Configure nas variáveis do Railway.');
  process.exit(1);
}

// Pool de conexões PostgreSQL com SSL (Railway exige)
const pool = new Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
});

// ── Schema ──────────────────────────────────────────────
// IMPORTANTE: NUNCA usar DROP TABLE ou TRUNCATE aqui.
// Sempre usar CREATE TABLE IF NOT EXISTS para preservar dados existentes.
// Se precisar alterar uma tabela, use ALTER TABLE ADD COLUMN IF NOT EXISTS.
async function init() {
  console.log('[db] Conectando ao PostgreSQL...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id           INTEGER PRIMARY KEY REFERENCES users(id),
      sendpulse_id      TEXT,
      sendpulse_secret  TEXT,
      telegram_token    TEXT,
      webhook_domain    TEXT,
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pares (
      id                  SERIAL PRIMARY KEY,
      user_id             INTEGER NOT NULL REFERENCES users(id),
      nome                TEXT NOT NULL,
      telegram_group_id   TEXT NOT NULL,
      sendpulse_bot_id    TEXT NOT NULL,
      sendpulse_bot_nome  TEXT,
      ativo               INTEGER DEFAULT 1,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, telegram_group_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id            SERIAL PRIMARY KEY,
      par_id        INTEGER NOT NULL REFERENCES pares(id),
      text          TEXT,
      from_user     TEXT,
      message_type  TEXT DEFAULT 'text',
      file_id       TEXT,
      telegram_media_url TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id                  SERIAL PRIMARY KEY,
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
      scheduled_at        TIMESTAMPTZ NOT NULL,
      status              TEXT DEFAULT 'pendente',
      recurrence          TEXT DEFAULT NULL,
      error_msg           TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS logs (
      id            SERIAL PRIMARY KEY,
      schedule_id   INTEGER REFERENCES schedules(id),
      par_id        INTEGER REFERENCES pares(id),
      status        TEXT,
      sendpulse_response TEXT,
      fired_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Adiciona colunas Google Sheets (per-user) se não existirem
  await pool.query(`
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS google_service_account_key TEXT;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS google_sheet_id TEXT;
  `);
  console.log('[db] PostgreSQL schema OK');
}

// ── Users ─────────────────────────────────────────────
module.exports = {
  init,
  pool, // Exposto para graceful shutdown em index.js

  /** Cria novo usuário e retorna sem password_hash */
  async createUser(data) {
    const res = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email, created_at',
      [data.name, data.email, data.password_hash]
    );
    return res.rows[0];
  },

  /** Busca usuário por email (inclui password_hash para login) */
  async getUserByEmail(email) {
    const res = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    return res.rows[0] || null;
  },

  /** Busca usuário por id (sem password_hash — seguro para resposta) */
  async getUserById(id) {
    const res = await pool.query('SELECT id, name, email, created_at FROM users WHERE id=$1', [id]);
    return res.rows[0] || null;
  },

  // ── User Settings ─────────────────────────────────────

  /** Retorna configurações do usuário (SendPulse + Telegram) */
  async getUserSettings(userId) {
    const res = await pool.query('SELECT * FROM user_settings WHERE user_id=$1', [userId]);
    return res.rows[0] || {};
  },

  /** Cria ou atualiza configurações do usuário (upsert) */
  async upsertUserSettings(userId, data) {
    const existing = await pool.query('SELECT user_id FROM user_settings WHERE user_id=$1', [userId]);
    if (existing.rows.length > 0) {
      await pool.query(`
        UPDATE user_settings SET sendpulse_id=$2, sendpulse_secret=$3,
          telegram_token=$4, webhook_domain=$5,
          google_service_account_key=$6, google_sheet_id=$7, updated_at=NOW()
        WHERE user_id=$1
      `, [userId, data.sendpulse_id, data.sendpulse_secret, data.telegram_token, data.webhook_domain,
          data.google_service_account_key, data.google_sheet_id]);
    } else {
      await pool.query(`
        INSERT INTO user_settings (user_id, sendpulse_id, sendpulse_secret, telegram_token, webhook_domain,
          google_service_account_key, google_sheet_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [userId, data.sendpulse_id, data.sendpulse_secret, data.telegram_token, data.webhook_domain,
          data.google_service_account_key, data.google_sheet_id]);
    }
    return this.getUserSettings(userId);
  },

  /** Lista todos os usuários que têm telegram_token configurado (para iniciar bots) */
  async getUsersWithTelegram() {
    const res = await pool.query(`
      SELECT u.id, us.telegram_token FROM users u
      JOIN user_settings us ON us.user_id = u.id
      WHERE us.telegram_token IS NOT NULL AND us.telegram_token != ''
    `);
    return res.rows;
  },

  // ── Pares ─────────────────────────────────────────────
  // Par = vínculo entre um grupo Telegram e um bot SendPulse
  // ativo=1 → ativo, ativo=0 → desativado (soft delete)

  /** Lista todos os pares ativos de um usuário */
  async getAllPares(userId) {
    const res = await pool.query('SELECT * FROM pares WHERE user_id=$1 AND ativo=1 ORDER BY created_at DESC', [userId]);
    return res.rows;
  },

  /** Busca par por ID (inclui inativos — usado internamente) */
  async getParById(id) {
    const res = await pool.query('SELECT * FROM pares WHERE id=$1', [id]);
    return res.rows[0] || null;
  },

  /** Busca par ativo por telegram_group_id (usado pelo bot ao receber mensagem) */
  async getParByGroupId(groupId) {
    const res = await pool.query('SELECT * FROM pares WHERE telegram_group_id=$1 AND ativo=1', [groupId]);
    return res.rows[0] || null;
  },

  /** Busca todos os pares ativos com um telegram_group_id (pode haver mais de um usuário) */
  async getParsByGroupId(groupId) {
    const res = await pool.query('SELECT * FROM pares WHERE telegram_group_id=$1 AND ativo=1', [groupId]);
    return res.rows;
  },

  /**
   * Cria novo par (vínculo Telegram grupo <-> SendPulse bot).
   * Se já existe um par desativado (ativo=0) com mesmo user_id + telegram_group_id,
   * reativa ele com os novos dados em vez de falhar por constraint UNIQUE.
   */
  async createPar(data) {
    // Verifica se existe par desativado com mesmo group_id para esse usuário
    const existing = await pool.query(
      'SELECT * FROM pares WHERE user_id=$1 AND telegram_group_id=$2 AND ativo=0',
      [data.user_id, data.telegram_group_id]
    );
    if (existing.rows.length > 0) {
      // Reativa o par existente com os novos dados
      const id = existing.rows[0].id;
      await pool.query(`
        UPDATE pares SET nome=$2, sendpulse_bot_id=$3, sendpulse_bot_nome=$4, ativo=1
        WHERE id=$1
      `, [id, data.nome, data.sendpulse_bot_id, data.sendpulse_bot_nome]);
      return this.getParById(id);
    }
    const res = await pool.query(`
      INSERT INTO pares (user_id, nome, telegram_group_id, sendpulse_bot_id, sendpulse_bot_nome)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [data.user_id, data.nome, data.telegram_group_id, data.sendpulse_bot_id, data.sendpulse_bot_nome]);
    return res.rows[0];
  },

  /** Atualiza dados do par (nome, IDs) */
  async updatePar(id, data) {
    await pool.query(`
      UPDATE pares SET nome=$2, telegram_group_id=$3, sendpulse_bot_id=$4, sendpulse_bot_nome=$5
      WHERE id=$1
    `, [id, data.nome, data.telegram_group_id, data.sendpulse_bot_id, data.sendpulse_bot_nome]);
    return this.getParById(id);
  },

  /** Desativa par (soft delete — ativo=0). Schedules existentes NÃO são afetados. */
  async deactivatePar(id) {
    await pool.query('UPDATE pares SET ativo=0 WHERE id=$1', [id]);
  },

  // ── Messages ──────────────────────────────────────────
  // Mensagens capturadas dos grupos Telegram (feed ao vivo)
  // Limpas diariamente pelo cron de meia-noite (clearMessages)

  /** Insere mensagem capturada do Telegram. Campos opcionais: created_at, telegram_media_url */
  async insertMessage(msg) {
    const cols = ['par_id', 'text', 'from_user', 'message_type', 'file_id'];
    const vals = [msg.par_id, msg.text, msg.from_user, msg.message_type, msg.file_id];
    if (msg.created_at) { cols.push('created_at'); vals.push(msg.created_at); }
    if (msg.telegram_media_url) { cols.push('telegram_media_url'); vals.push(msg.telegram_media_url); }
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const res = await pool.query(
      `INSERT INTO messages (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      vals
    );
    return res.rows[0];
  },

  /** Busca últimas mensagens de um par (DESC por id, limit padrão 200) */
  async getMessages(parId, limit = 200) {
    const res = await pool.query(
      'SELECT * FROM messages WHERE par_id=$1 ORDER BY id DESC LIMIT $2',
      [parId, limit]
    );
    return res.rows;
  },

  /**
   * Apaga TODAS as mensagens do feed.
   * Executado pelo cron de meia-noite (scheduler/index.js).
   * ATENÇÃO: Só afeta a tabela messages, NUNCA schedules.
   */
  async clearMessages() {
    await pool.query('DELETE FROM messages');
  },

  // ── Schedules ─────────────────────────────────────────
  // Agendamentos de disparo para o SendPulse
  // O scheduler (cron) processa pendentes a cada minuto
  //
  // FLUXO DE VIDA:
  // 1. Criado como 'pendente' (via frontend ou recorrência)
  // 2. Quando scheduled_at <= NOW(), o cron dispara via SendPulse
  // 3. Se sucesso → 'enviado'. Se erro → 'erro' + error_msg
  // 4. Se tem recorrência → cria NOVO schedule para próxima data
  //
  // NUNCA deletar schedules automaticamente. Apenas via ação do usuário.

  /** Busca schedules de um par, opcionalmente filtrado por status */
  async getSchedules(parId, status) {
    if (status) {
      const res = await pool.query(
        'SELECT * FROM schedules WHERE par_id=$1 AND status=$2 ORDER BY scheduled_at ASC',
        [parId, status]
      );
      return res.rows;
    }
    const res = await pool.query('SELECT * FROM schedules WHERE par_id=$1 ORDER BY scheduled_at ASC', [parId]);
    return res.rows;
  },

  /** Busca todos os schedules do usuário, opcionalmente filtrado por status */
  async getAllSchedules(status, userId) {
    if (status && userId) {
      const res = await pool.query(
        'SELECT * FROM schedules WHERE user_id=$1 AND status=$2 ORDER BY scheduled_at ASC',
        [userId, status]
      );
      return res.rows;
    }
    if (userId) {
      const res = await pool.query('SELECT * FROM schedules WHERE user_id=$1 ORDER BY scheduled_at ASC', [userId]);
      return res.rows;
    }
    if (status) {
      const res = await pool.query('SELECT * FROM schedules WHERE status=$1 ORDER BY scheduled_at ASC', [status]);
      return res.rows;
    }
    const res = await pool.query('SELECT * FROM schedules ORDER BY scheduled_at ASC');
    return res.rows;
  },

  /** Busca schedule por ID */
  async getScheduleById(id) {
    const res = await pool.query('SELECT * FROM schedules WHERE id=$1', [id]);
    return res.rows[0] || null;
  },

  /**
   * Busca schedules prontos para disparo (pendentes com data <= agora).
   * Chamado pelo cron a cada minuto.
   * Retorna de TODOS os usuários — o scheduler valida credenciais individualmente.
   */
  async getSchedulesDue() {
    const res = await pool.query("SELECT * FROM schedules WHERE status='pendente' AND scheduled_at <= NOW()");
    return res.rows;
  },

  /**
   * Cria novo schedule (agendamento de disparo).
   * Campos obrigatórios: scheduled_at
   * Buttons são serializados como JSON string se passados como objeto.
   */
  async createSchedule(data) {
    const buttons = data.buttons ? (typeof data.buttons === 'string' ? data.buttons : JSON.stringify(data.buttons)) : null;
    const res = await pool.query(`
      INSERT INTO schedules (user_id, par_id, sendpulse_bot_id, sendpulse_bot_nome, origem, content_type,
        content_text, content_file_id, content_media_url, buttons, scheduled_at, recurrence)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *
    `, [
      data.user_id || null,
      data.par_id || null,
      data.sendpulse_bot_id || null,
      data.sendpulse_bot_nome || null,
      data.origem || 'manual',
      data.content_type || 'text',
      data.content_text || null,
      data.content_file_id || null,
      data.content_media_url || null,
      buttons,
      data.scheduled_at,
      data.recurrence || null,
    ]);
    return res.rows[0];
  },

  /**
   * Atualiza campos de um schedule existente (parcial — só atualiza campos presentes em data).
   * Campos permitidos: content_type, content_text, content_file_id, content_media_url,
   *                    buttons, scheduled_at, recurrence, status, sendpulse_bot_id, sendpulse_bot_nome
   */
  async updateSchedule(id, data) {
    const fields = [];
    const vals = [id];
    let idx = 2;
    for (const key of ['content_type','content_text','content_file_id','content_media_url','buttons','scheduled_at','recurrence','status','sendpulse_bot_id','sendpulse_bot_nome']) {
      if (data[key] !== undefined) {
        fields.push(`${key}=$${idx}`);
        vals.push(key === 'buttons' && typeof data[key] === 'object' ? JSON.stringify(data[key]) : data[key]);
        idx++;
      }
    }
    if (fields.length === 0) return this.getScheduleById(id);
    await pool.query(`UPDATE schedules SET ${fields.join(', ')} WHERE id=$1`, vals);
    return this.getScheduleById(id);
  },

  /** Atualiza status de um schedule. Se erro, salva mensagem truncada (max 500 chars) */
  async updateScheduleStatus(id, status, errorMsg) {
    if (errorMsg) {
      const safeMsg = String(errorMsg).slice(0, 500);
      await pool.query('UPDATE schedules SET status=$2, error_msg=$3 WHERE id=$1', [id, status, safeMsg]);
    } else {
      await pool.query('UPDATE schedules SET status=$2 WHERE id=$1', [id, status]);
    }
  },

  /**
   * Deleta schedule permanentemente.
   * Chamado apenas via ação explícita do usuário (botão Excluir/Cancelar).
   * NUNCA chamar automaticamente — dados perdidos não podem ser recuperados.
   */
  async deleteSchedule(id) {
    await pool.query('DELETE FROM schedules WHERE id=$1', [id]);
  },

  // ── Logs ──────────────────────────────────────────────
  // Registro de todos os disparos (sucesso e erro) para auditoria

  /** Insere log de disparo (chamado pelo scheduler e pela rota /send) */
  async insertLog(data) {
    await pool.query(`
      INSERT INTO logs (schedule_id, par_id, status, sendpulse_response)
      VALUES ($1, $2, $3, $4)
    `, [data.schedule_id, data.par_id || null, data.status, data.sendpulse_response || null]);
  },

  // ── Dashboard ─────────────────────────────────────────

  /** Retorna contadores do dashboard para um par específico */
  async getDashboard(parId) {
    const today = new Date().toISOString().slice(0, 10);
    const [agendados, enviados, pendentes, erros, msgs] = await Promise.all([
      pool.query("SELECT COUNT(*) as c FROM schedules WHERE par_id=$1 AND scheduled_at::date = $2 AND status='pendente'", [parId, today]),
      pool.query("SELECT COUNT(*) as c FROM schedules WHERE par_id=$1 AND status='enviado'", [parId]),
      pool.query("SELECT COUNT(*) as c FROM schedules WHERE par_id=$1 AND status='pendente'", [parId]),
      pool.query("SELECT COUNT(*) as c FROM schedules WHERE par_id=$1 AND status='erro'", [parId]),
      pool.query('SELECT COUNT(*) as c FROM messages WHERE par_id=$1', [parId]),
    ]);
    return {
      agendados_hoje: parseInt(agendados.rows[0].c),
      enviados: parseInt(enviados.rows[0].c),
      pendentes: parseInt(pendentes.rows[0].c),
      erros: parseInt(erros.rows[0].c),
      msgs_hoje: parseInt(msgs.rows[0].c),
    };
  },

  /** Query genérica — usar com cuidado, preferir métodos específicos */
  async query(text, params) {
    const res = await pool.query(text, params);
    return res.rows;
  },
};
