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
  await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS api_key TEXT;`);
  // Anthropic API key (per-user) for Insights IA
  await pool.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS anthropic_api_key TEXT;`);
  // Usage tracking for Insights IA
  await pool.query(`
    CREATE TABLE IF NOT EXISTS insights_usage (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      input_tokens INTEGER,
      output_tokens INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Tabela de mapeamento mês → planilha
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sheet_months (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      month_key  TEXT NOT NULL,
      sheet_id   TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, month_key)
    );
  `);
  // Tabela de postbacks (eventos da Apostatudo: lead, ftd)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS postbacks (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id),
      tab             TEXT NOT NULL,
      event           TEXT NOT NULL,
      deal_id         TEXT,
      customer_id     TEXT,
      registration_id TEXT,
      utm_source      TEXT,
      utm_medium      TEXT,
      payout          NUMERIC(12,2) DEFAULT 0,
      payout_currency TEXT,
      campaign_id     TEXT,
      campaign_name   TEXT,
      link_id         TEXT,
      link_name       TEXT,
      afp             TEXT,
      raw_query       TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Anexos do chat: imagens, PDFs, texto, CSVs (BLOB no Postgres)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_attachments (
      id          SERIAL PRIMARY KEY,
      session_id  INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
      message_id  INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL,
      filename    TEXT NOT NULL,
      mime_type   TEXT NOT NULL,
      size_bytes  INTEGER NOT NULL,
      data        BYTEA NOT NULL,
      source      TEXT NOT NULL DEFAULT 'user',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_chat_attachments_session ON chat_attachments(session_id);
  `);
  // Registry do bridge (URL ngrok dinâmica, atualizada pelo start.sh do Mac)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bridge_registry (
      id          INTEGER PRIMARY KEY DEFAULT 1,
      url         TEXT NOT NULL,
      version     TEXT,
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT only_one_row CHECK (id = 1)
    );
  `);
  // Tabela de contas de anúncio Meta Ads (por expert/tab)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ad_accounts (
      id             SERIAL PRIMARY KEY,
      user_id        INTEGER NOT NULL REFERENCES users(id),
      tab            TEXT NOT NULL,
      ad_account_id  TEXT NOT NULL,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, tab)
    );
  `);
  // Agregação diária do Klarvel (lives Google Meet) — preenchida pelo cron
  await pool.query(`
    CREATE TABLE IF NOT EXISTS klarvel_daily_summary (
      id                     SERIAL PRIMARY KEY,
      user_id                INTEGER NOT NULL REFERENCES users(id),
      expert                 TEXT NOT NULL,
      report_date            DATE NOT NULL,
      total_lives            INTEGER DEFAULT 0,
      duracao_total_minutos  INTEGER DEFAULT 0,
      pico_simultaneos_max   INTEGER DEFAULT 0,
      pico_simultaneos_medio INTEGER DEFAULT 0,
      participantes_unicos   INTEGER DEFAULT 0,
      mensagens_total        INTEGER DEFAULT 0,
      autores_unicos         INTEGER DEFAULT 0,
      engagement_rate_pct    NUMERIC(5,2),
      raw_lives              JSONB,
      created_at             TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, expert, report_date)
    );
    CREATE INDEX IF NOT EXISTS idx_klarvel_summary_user_date ON klarvel_daily_summary(user_id, report_date DESC);
  `);
  // Instagram: mapeamento expert→IG business account + snapshots diários
  await pool.query(`
    CREATE TABLE IF NOT EXISTS instagram_accounts (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id),
      expert          TEXT NOT NULL,
      ig_user_id      TEXT NOT NULL,
      ig_username     TEXT,
      fb_page_id      TEXT,
      fb_page_name    TEXT,
      profile_pic_url TEXT,
      is_active       BOOLEAN NOT NULL DEFAULT true,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, expert),
      UNIQUE(user_id, ig_user_id)
    );
    CREATE TABLE IF NOT EXISTS instagram_daily_snapshots (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id),
      ig_user_id      TEXT NOT NULL,
      expert          TEXT,
      snapshot_date   DATE NOT NULL,
      followers_count INTEGER,
      media_count     INTEGER,
      reach           INTEGER,
      impressions     INTEGER,
      profile_views   INTEGER,
      website_clicks  INTEGER,
      raw             JSONB,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, ig_user_id, snapshot_date)
    );
    ALTER TABLE instagram_daily_snapshots
      ADD COLUMN IF NOT EXISTS new_follows INTEGER,
      ADD COLUMN IF NOT EXISTS unfollows INTEGER;
    CREATE INDEX IF NOT EXISTS idx_ig_snapshots_user_date ON instagram_daily_snapshots(user_id, ig_user_id, snapshot_date DESC);

    -- Stories (somem em 24h, precisamos snapshot diário pra histórico)
    CREATE TABLE IF NOT EXISTS instagram_stories (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id),
      expert          TEXT,
      ig_user_id      TEXT NOT NULL,
      story_id        TEXT NOT NULL,
      media_type      TEXT,
      media_url       TEXT,
      thumbnail_url   TEXT,
      permalink       TEXT,
      timestamp       TIMESTAMPTZ,
      description     TEXT,
      seen_at         TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, story_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ig_stories_user_date ON instagram_stories(user_id, expert, timestamp DESC);

    -- Posts (feed) — histórico completo
    CREATE TABLE IF NOT EXISTS instagram_posts (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id),
      expert          TEXT,
      ig_user_id      TEXT NOT NULL,
      post_id         TEXT NOT NULL,
      caption         TEXT,
      media_type      TEXT,
      media_url       TEXT,
      thumbnail_url   TEXT,
      permalink       TEXT,
      timestamp       TIMESTAMPTZ,
      like_count      INTEGER,
      comments_count  INTEGER,
      reach           INTEGER,
      impressions     INTEGER,
      saved           INTEGER,
      seen_at         TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, post_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ig_posts_user_date ON instagram_posts(user_id, expert, timestamp DESC);
    ALTER TABLE instagram_posts ADD COLUMN IF NOT EXISTS description TEXT;

    -- Comentários dos posts
    CREATE TABLE IF NOT EXISTS instagram_comments (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id),
      expert          TEXT,
      post_id         TEXT NOT NULL,
      comment_id      TEXT NOT NULL,
      autor_username  TEXT,
      texto           TEXT,
      like_count      INTEGER,
      timestamp       TIMESTAMPTZ,
      is_reply        BOOLEAN DEFAULT false,
      parent_id       TEXT,
      seen_at         TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, comment_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ig_comments_post ON instagram_comments(user_id, post_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_ig_comments_expert ON instagram_comments(user_id, expert, timestamp DESC);

    -- DMs (conversas + mensagens)
    CREATE TABLE IF NOT EXISTS instagram_dms (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id),
      expert          TEXT,
      conversation_id TEXT NOT NULL,
      participants    JSONB,
      last_msg_text   TEXT,
      last_msg_at     TIMESTAMPTZ,
      seen_at         TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, conversation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ig_dms_user ON instagram_dms(user_id, expert, last_msg_at DESC);

    CREATE TABLE IF NOT EXISTS instagram_dm_messages (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id),
      conversation_id TEXT NOT NULL,
      message_id      TEXT NOT NULL,
      from_username   TEXT,
      message_text    TEXT,
      timestamp       TIMESTAMPTZ,
      UNIQUE(user_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ig_dm_msgs_conv ON instagram_dm_messages(user_id, conversation_id, timestamp DESC);
  `);
  // Smart Reminders: lembretes inteligentes (pós-live, pós-disparo, etc.)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS smart_reminders (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id),
      tipo            TEXT NOT NULL,
      expert          TEXT,
      trigger_id      TEXT,
      trigger_data    JSONB,
      conteudo        TEXT,
      sugestoes       JSONB,
      enviado_para    TEXT,
      enviado_at      TIMESTAMPTZ,
      status          TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','enviado','erro','ignorado')),
      error_msg       TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tipo, trigger_id)
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_user_created ON smart_reminders(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reminders_status ON smart_reminders(status, created_at);
  `);
  // Apostatudo Admin API: mapeamento expert↔afiliado + eventos webhook
  await pool.query(`
    CREATE TABLE IF NOT EXISTS apostatudo_expert_map (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id),
      expert        TEXT NOT NULL,
      affiliate_id  TEXT,
      aff_link      TEXT,
      utm_source    TEXT,
      label         TEXT,
      is_active     BOOLEAN NOT NULL DEFAULT true,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, affiliate_id, aff_link)
    );
    CREATE INDEX IF NOT EXISTS idx_apo_map_expert ON apostatudo_expert_map(user_id, UPPER(expert));

    CREATE TABLE IF NOT EXISTS apostatudo_events (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id),
      event_type      TEXT NOT NULL,
      apostatudo_user_id  BIGINT,
      expert          TEXT,
      affiliate_id    TEXT,
      aff_link        TEXT,
      utm_source      TEXT,
      amount_cents    INTEGER,
      raw_payload     JSONB NOT NULL,
      delivery_id     TEXT,
      received_at     TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, delivery_id)
    );
    CREATE INDEX IF NOT EXISTS idx_apo_events_type_expert ON apostatudo_events(user_id, event_type, expert, received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_apo_events_apostatudo_user ON apostatudo_events(apostatudo_user_id);
  `);

  // AI Advisor: recomendações geradas + tracking de outcome
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_recommendations (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id),
      generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expert          TEXT NOT NULL,
      categoria       TEXT,
      urgencia        TEXT,
      acao            TEXT NOT NULL,
      justificativa   TEXT,
      impacto_estimado TEXT,
      passos          JSONB,
      raw_data_snapshot JSONB,
      status          TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','aplicado','ignorado','aprovado')),
      status_at       TIMESTAMPTZ,
      outcome_measured_at TIMESTAMPTZ,
      outcome_ftds_delta  INTEGER,
      outcome_netpl_delta NUMERIC(12,2),
      outcome_score   NUMERIC(3,2),
      notes           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ai_rec_user_status ON ai_recommendations(user_id, status, generated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_rec_outcome ON ai_recommendations(user_id, status, outcome_measured_at)
      WHERE status='aplicado' AND outcome_measured_at IS NULL;
  `);
  // Memória persistente do chat (sessões, mensagens, fatos aprendidos)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id                SERIAL PRIMARY KEY,
      user_id           INTEGER NOT NULL REFERENCES users(id),
      title             TEXT,
      bridge_session_id TEXT,
      backend           TEXT DEFAULT 'api',
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id          SERIAL PRIMARY KEY,
      session_id  INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      metadata    JSONB,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created
      ON chat_messages(session_id, created_at);
    CREATE TABLE IF NOT EXISTS chat_facts (
      id                SERIAL PRIMARY KEY,
      user_id           INTEGER NOT NULL REFERENCES users(id),
      type              TEXT NOT NULL,
      fact_key          TEXT NOT NULL,
      fact_value        TEXT NOT NULL,
      source_message_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, type, fact_key)
    );
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
        UPDATE pares SET nome=$2, sendpulse_bot_id=$3, sendpulse_bot_nome=$4, ativo=1, gatilho_texto=$5
        WHERE id=$1
      `, [id, data.nome, data.sendpulse_bot_id, data.sendpulse_bot_nome, data.gatilho_texto || null]);
      return this.getParById(id);
    }
    const res = await pool.query(`
      INSERT INTO pares (user_id, nome, telegram_group_id, sendpulse_bot_id, sendpulse_bot_nome, gatilho_texto)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
    `, [data.user_id, data.nome, data.telegram_group_id, data.sendpulse_bot_id, data.sendpulse_bot_nome, data.gatilho_texto || null]);
    return res.rows[0];
  },

  /** Atualiza dados do par (nome, IDs) */
  async updatePar(id, data) {
    await pool.query(`
      UPDATE pares SET nome=$2, telegram_group_id=$3, sendpulse_bot_id=$4, sendpulse_bot_nome=$5, gatilho_texto=$6
      WHERE id=$1
    `, [id, data.nome, data.telegram_group_id, data.sendpulse_bot_id, data.sendpulse_bot_nome, data.gatilho_texto ?? null]);
    return this.getParById(id);
  },

  /** Atualiza timestamp do ultimo disparo de gatilho */
  async updateGatilhoUltimoDisparo(parId) {
    await pool.query('UPDATE pares SET gatilho_ultimo_disparo = NOW() WHERE id = $1', [parId]);
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

  /** Retorna todos os content_media_url usados em schedules (para limpeza de uploads) */
  async getScheduleMediaFiles() {
    const res = await pool.query("SELECT content_media_url FROM schedules WHERE content_media_url IS NOT NULL");
    return res.rows.map(r => r.content_media_url);
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

  // ── Sheet Months ─────────────────────────────────────
  // Mapeamento mês (YYYY-MM) → Google Sheet ID

  async getSheetMonths(userId) {
    const res = await pool.query('SELECT * FROM sheet_months WHERE user_id=$1 ORDER BY month_key DESC', [userId]);
    return res.rows;
  },

  async upsertSheetMonth(userId, monthKey, sheetId) {
    await pool.query(`
      INSERT INTO sheet_months (user_id, month_key, sheet_id) VALUES ($1, $2, $3)
      ON CONFLICT (user_id, month_key) DO UPDATE SET sheet_id = $3
    `, [userId, monthKey, sheetId]);
  },

  async deleteSheetMonth(userId, monthKey) {
    await pool.query('DELETE FROM sheet_months WHERE user_id=$1 AND month_key=$2', [userId, monthKey]);
  },

  async getSheetIdForMonth(userId, monthKey) {
    const res = await pool.query('SELECT sheet_id FROM sheet_months WHERE user_id=$1 AND month_key=$2', [userId, monthKey]);
    return res.rows[0]?.sheet_id || null;
  },

  async getCurrentSheetId(userId) {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return this.getSheetIdForMonth(userId, monthKey);
  },

  // ── Insights IA ─────────────────────────────────────────

  /** Get Anthropic API key for a user */
  async getAnthropicKey(userId) {
    const res = await pool.query('SELECT anthropic_api_key FROM user_settings WHERE user_id=$1', [userId]);
    return res.rows[0]?.anthropic_api_key || null;
  },

  /** Save/update Anthropic API key */
  async upsertAnthropicKey(userId, key) {
    const existing = await pool.query('SELECT user_id FROM user_settings WHERE user_id=$1', [userId]);
    if (existing.rows.length > 0) {
      await pool.query('UPDATE user_settings SET anthropic_api_key=$2, updated_at=NOW() WHERE user_id=$1', [userId, key]);
    } else {
      await pool.query('INSERT INTO user_settings (user_id, anthropic_api_key) VALUES ($1, $2)', [userId, key]);
    }
  },

  /** Record an insights usage entry */
  async insertInsightsUsage(userId, inputTokens, outputTokens) {
    await pool.query(
      'INSERT INTO insights_usage (user_id, input_tokens, output_tokens) VALUES ($1, $2, $3)',
      [userId, inputTokens, outputTokens]
    );
  },

  /** Get aggregated insights usage for a user */
  async getInsightsUsage(userId) {
    const res = await pool.query(`
      SELECT
        COUNT(*)::int as total_requests,
        COALESCE(SUM(input_tokens), 0)::int as total_input_tokens,
        COALESCE(SUM(output_tokens), 0)::int as total_output_tokens,
        MAX(created_at) as last_used
      FROM insights_usage WHERE user_id=$1
    `, [userId]);
    return res.rows[0];
  },

  // ── Postbacks ─────────────────────────────────────────

  /** Insere postback recebido da Apostatudo */
  async insertPostback(data) {
    const res = await pool.query(`
      INSERT INTO postbacks (user_id, tab, event, deal_id, customer_id, registration_id,
        utm_source, utm_medium, payout, payout_currency, campaign_id, campaign_name,
        link_id, link_name, afp, raw_query)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *
    `, [
      data.user_id, data.tab, data.event, data.deal_id || null, data.customer_id || null,
      data.registration_id || null, data.utm_source || null, data.utm_medium || null,
      parseFloat(data.payout) || 0, data.payout_currency || null,
      data.campaign_id || null, data.campaign_name || null,
      data.link_id || null, data.link_name || null, data.afp || null,
      data.raw_query || null,
    ]);
    return res.rows[0];
  },

  /** Busca postbacks por user, tab, evento e período */
  async getPostbacks(userId, tab, event, startDate, endDate) {
    let sql = 'SELECT * FROM postbacks WHERE user_id=$1 AND tab=$2';
    const params = [userId, tab];
    let idx = 3;
    if (event) { sql += ` AND event=$${idx}`; params.push(event); idx++; }
    if (startDate) { sql += ` AND created_at >= $${idx}`; params.push(startDate); idx++; }
    if (endDate) { sql += ` AND created_at <= $${idx}`; params.push(endDate); idx++; }
    sql += ' ORDER BY created_at DESC';
    const res = await pool.query(sql, params);
    return res.rows;
  },

  /** Retorna FTDs e cadastros agrupados por utm_source + utm_medium */
  async getPostbacksByUtm(userId, tab, startDate, endDate) {
    const res = await pool.query(`
      SELECT
        COALESCE(utm_source, '(direto)') as utm_source,
        COALESCE(utm_medium, '(nenhum)') as utm_medium,
        COUNT(*) FILTER (WHERE event = 'lead')::int as leads,
        COUNT(*) FILTER (WHERE event = 'ftd')::int as ftds,
        COALESCE(SUM(payout) FILTER (WHERE event = 'ftd'), 0)::numeric(12,2) as ftd_payout
      FROM postbacks
      WHERE user_id=$1 AND tab=$2 AND created_at >= $3 AND created_at <= $4
      GROUP BY utm_source, utm_medium
      ORDER BY ftds DESC, leads DESC
    `, [userId, tab, startDate, endDate]);
    return res.rows;
  },

  /** Busca user_id a partir da api_key */
  async getUserByApiKey(apiKey) {
    const res = await pool.query('SELECT user_id FROM user_settings WHERE api_key=$1', [apiKey]);
    return res.rows[0]?.user_id || null;
  },

  // ── Ad Accounts (Meta Ads) ─────────────────────────────

  async getAdAccounts(userId) {
    const res = await pool.query('SELECT * FROM ad_accounts WHERE user_id=$1 ORDER BY tab ASC', [userId]);
    return res.rows;
  },

  async upsertAdAccount(userId, tab, adAccountId) {
    await pool.query(`
      INSERT INTO ad_accounts (user_id, tab, ad_account_id) VALUES ($1, $2, $3)
      ON CONFLICT (user_id, tab) DO UPDATE SET ad_account_id = $3
    `, [userId, tab, adAccountId]);
  },

  async deleteAdAccount(userId, tab) {
    await pool.query('DELETE FROM ad_accounts WHERE user_id=$1 AND tab=$2', [userId, tab]);
  },

  /** Query genérica — usar com cuidado, preferir métodos específicos */
  async query(text, params) {
    const res = await pool.query(text, params);
    return res.rows;
  },

  // ── Anexos do chat (imagens, PDFs, txt, csv) ──────────
  async insertAttachment({ session_id, message_id, filename, mime_type, size_bytes, data, source = 'user' }) {
    const res = await pool.query(
      `INSERT INTO chat_attachments (session_id, message_id, filename, mime_type, size_bytes, data, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, filename, mime_type, size_bytes, source, created_at`,
      [session_id || null, message_id || null, filename, mime_type, size_bytes, data, source]
    );
    return res.rows[0];
  },

  async getAttachment(id) {
    const res = await pool.query(
      `SELECT id, session_id, filename, mime_type, size_bytes, data, source, created_at
       FROM chat_attachments WHERE id=$1`,
      [id]
    );
    return res.rows[0] || null;
  },

  async listAttachmentsBySession(sessionId) {
    const res = await pool.query(
      `SELECT id, filename, mime_type, size_bytes, source, created_at, message_id
       FROM chat_attachments WHERE session_id=$1 ORDER BY created_at ASC`,
      [sessionId]
    );
    return res.rows;
  },

  async updateAttachmentMessageId(id, messageId) {
    await pool.query('UPDATE chat_attachments SET message_id=$2 WHERE id=$1', [id, messageId]);
  },

  // ── Apostatudo ─────────────────────────────────────
  async listApostatudoMap(userId) {
    const r = await pool.query(
      `SELECT * FROM apostatudo_expert_map WHERE user_id=$1 AND is_active=true ORDER BY expert, label`,
      [userId]
    );
    return r.rows;
  },

  async upsertApostatudoMap(userId, m) {
    const r = await pool.query(
      `INSERT INTO apostatudo_expert_map (user_id, expert, affiliate_id, aff_link, utm_source, label)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, affiliate_id, aff_link) DO UPDATE
       SET expert=$2, utm_source=$5, label=$6, is_active=true
       RETURNING *`,
      [userId, m.expert.toUpperCase(), m.affiliate_id || null, m.aff_link || null,
       m.utm_source || null, m.label || null]
    );
    return r.rows[0];
  },

  async getApostatudoMapByAffiliate(userId, affiliateId, affLink) {
    const r = await pool.query(
      `SELECT * FROM apostatudo_expert_map WHERE user_id=$1 AND is_active=true
         AND (affiliate_id=$2 OR aff_link=$3) LIMIT 1`,
      [userId, affiliateId || null, affLink || null]
    );
    return r.rows[0] || null;
  },

  async insertApostatudoEvent(userId, ev) {
    await pool.query(
      `INSERT INTO apostatudo_events
       (user_id, event_type, apostatudo_user_id, expert, affiliate_id, aff_link, utm_source, amount_cents, raw_payload, delivery_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id, delivery_id) DO NOTHING`,
      [userId, ev.event_type, ev.apostatudo_user_id, ev.expert,
       ev.affiliate_id, ev.aff_link, ev.utm_source, ev.amount_cents,
       JSON.stringify(ev.raw_payload || {}), ev.delivery_id]
    );
  },

  async listApostatudoEvents(userId, { expert, eventType, fromDate, toDate, limit = 200 } = {}) {
    const where = ['user_id=$1']; const params = [userId];
    if (expert)    { params.push(expert.toUpperCase()); where.push(`UPPER(expert)=$${params.length}`); }
    if (eventType) { params.push(eventType); where.push(`event_type=$${params.length}`); }
    if (fromDate)  { params.push(fromDate); where.push(`received_at >= $${params.length}`); }
    if (toDate)    { params.push(toDate); where.push(`received_at <= $${params.length}`); }
    params.push(limit);
    const r = await pool.query(
      `SELECT * FROM apostatudo_events WHERE ${where.join(' AND ')} ORDER BY received_at DESC LIMIT $${params.length}`,
      params
    );
    return r.rows;
  },

  // ── Instagram ──────────────────────────────────────
  async listInstagramAccounts(userId) {
    const r = await pool.query(
      `SELECT * FROM instagram_accounts WHERE user_id=$1 AND is_active=true ORDER BY expert`,
      [userId]
    );
    return r.rows;
  },

  async upsertInstagramAccount(userId, account) {
    const r = await pool.query(
      `INSERT INTO instagram_accounts (user_id, expert, ig_user_id, ig_username, fb_page_id, fb_page_name, profile_pic_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, expert) DO UPDATE
       SET ig_user_id=$3, ig_username=$4, fb_page_id=$5, fb_page_name=$6, profile_pic_url=$7, is_active=true
       RETURNING *`,
      [userId, account.expert, account.ig_user_id, account.ig_username,
       account.fb_page_id, account.fb_page_name, account.profile_pic_url]
    );
    return r.rows[0];
  },

  async deleteInstagramAccount(userId, expert) {
    await pool.query(
      `UPDATE instagram_accounts SET is_active=false WHERE user_id=$1 AND expert=$2`,
      [userId, expert]
    );
  },

  async getInstagramAccountByExpert(userId, expert) {
    const r = await pool.query(
      `SELECT * FROM instagram_accounts WHERE user_id=$1 AND UPPER(expert)=$2 AND is_active=true LIMIT 1`,
      [userId, expert.toUpperCase()]
    );
    return r.rows[0] || null;
  },

  async upsertInstagramSnapshot(userId, snap) {
    await pool.query(
      `INSERT INTO instagram_daily_snapshots
       (user_id, ig_user_id, expert, snapshot_date, followers_count, media_count, reach, impressions, profile_views, website_clicks, new_follows, unfollows, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (user_id, ig_user_id, snapshot_date) DO UPDATE
       SET followers_count=$5, media_count=$6, reach=$7, impressions=$8, profile_views=$9, website_clicks=$10, new_follows=$11, unfollows=$12, raw=$13`,
      [userId, snap.ig_user_id, snap.expert, snap.snapshot_date,
       snap.followers_count, snap.media_count, snap.reach, snap.impressions,
       snap.profile_views, snap.website_clicks,
       snap.new_follows, snap.unfollows,
       JSON.stringify(snap.raw || {})]
    );
  },

  async getInstagramSnapshots(userId, igUserId, fromDate, toDate) {
    const r = await pool.query(
      `SELECT * FROM instagram_daily_snapshots
       WHERE user_id=$1 AND ig_user_id=$2 AND snapshot_date BETWEEN $3 AND $4
       ORDER BY snapshot_date ASC`,
      [userId, igUserId, fromDate, toDate]
    );
    return r.rows;
  },

  async upsertInstagramStory(userId, story) {
    await pool.query(
      `INSERT INTO instagram_stories (user_id, expert, ig_user_id, story_id, media_type, media_url, thumbnail_url, permalink, timestamp, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id, story_id) DO UPDATE
       SET media_url=$6, thumbnail_url=$7, permalink=$8, description=COALESCE($10, instagram_stories.description)`,
      [userId, story.expert, story.ig_user_id, story.story_id,
       story.media_type, story.media_url, story.thumbnail_url,
       story.permalink, story.timestamp, story.description]
    );
  },

  async listInstagramStories(userId, { expert, fromDate, toDate, limit = 50 } = {}) {
    const where = ['user_id=$1']; const params = [userId];
    if (expert) { params.push(expert.toUpperCase()); where.push(`UPPER(expert)=$${params.length}`); }
    if (fromDate) { params.push(fromDate); where.push(`timestamp >= $${params.length}`); }
    if (toDate)   { params.push(toDate);   where.push(`timestamp <= $${params.length}`); }
    params.push(limit);
    const r = await pool.query(
      `SELECT * FROM instagram_stories WHERE ${where.join(' AND ')} ORDER BY timestamp DESC LIMIT $${params.length}`,
      params
    );
    return r.rows;
  },

  async upsertInstagramPost(userId, post) {
    await pool.query(
      `INSERT INTO instagram_posts
       (user_id, expert, ig_user_id, post_id, caption, media_type, media_url, thumbnail_url, permalink, timestamp, like_count, comments_count, reach, impressions, saved, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, NOW())
       ON CONFLICT (user_id, post_id) DO UPDATE
       SET caption=$5, like_count=$11, comments_count=$12, reach=$13, impressions=$14, saved=$15, updated_at=NOW()`,
      [userId, post.expert, post.ig_user_id, post.post_id, post.caption,
       post.media_type, post.media_url, post.thumbnail_url, post.permalink,
       post.timestamp, post.like_count, post.comments_count,
       post.reach, post.impressions, post.saved]
    );
  },

  async updateInstagramPostDescription(userId, postId, description) {
    await pool.query(
      `UPDATE instagram_posts SET description=$3 WHERE user_id=$1 AND post_id=$2`,
      [userId, postId, description]
    );
  },

  async updateInstagramStoryDescription(userId, storyId, description) {
    await pool.query(
      `UPDATE instagram_stories SET description=$3 WHERE user_id=$1 AND story_id=$2`,
      [userId, storyId, description]
    );
  },

  async listInstagramItensSemDescription(userId, limit = 10) {
    const stories = await pool.query(
      `SELECT 'story' AS kind, story_id AS id, expert, media_type, media_url, thumbnail_url, permalink, timestamp
       FROM instagram_stories WHERE user_id=$1 AND description IS NULL
         AND (media_url IS NOT NULL OR thumbnail_url IS NOT NULL)
       ORDER BY timestamp DESC LIMIT $2`,
      [userId, limit]
    );
    const posts = await pool.query(
      `SELECT 'post' AS kind, post_id AS id, expert, media_type, media_url, thumbnail_url, permalink, timestamp, caption
       FROM instagram_posts WHERE user_id=$1 AND description IS NULL
         AND (media_url IS NOT NULL OR thumbnail_url IS NOT NULL)
       ORDER BY timestamp DESC LIMIT $2`,
      [userId, limit]
    );
    return { stories: stories.rows, posts: posts.rows };
  },

  async listInstagramPosts(userId, { expert, fromDate, toDate, limit = 30 } = {}) {
    const where = ['user_id=$1']; const params = [userId];
    if (expert) { params.push(expert.toUpperCase()); where.push(`UPPER(expert)=$${params.length}`); }
    if (fromDate) { params.push(fromDate); where.push(`timestamp >= $${params.length}`); }
    if (toDate)   { params.push(toDate);   where.push(`timestamp <= $${params.length}`); }
    params.push(limit);
    const r = await pool.query(
      `SELECT * FROM instagram_posts WHERE ${where.join(' AND ')} ORDER BY timestamp DESC LIMIT $${params.length}`,
      params
    );
    return r.rows;
  },

  async upsertInstagramComment(userId, comment) {
    await pool.query(
      `INSERT INTO instagram_comments (user_id, expert, post_id, comment_id, autor_username, texto, like_count, timestamp, is_reply, parent_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id, comment_id) DO UPDATE
       SET texto=$6, like_count=$7`,
      [userId, comment.expert, comment.post_id, comment.comment_id,
       comment.autor_username, comment.texto, comment.like_count,
       comment.timestamp, comment.is_reply || false, comment.parent_id || null]
    );
  },

  async listInstagramComments(userId, { expert, postId, fromDate, toDate, limit = 100 } = {}) {
    const where = ['user_id=$1']; const params = [userId];
    if (expert) { params.push(expert.toUpperCase()); where.push(`UPPER(expert)=$${params.length}`); }
    if (postId) { params.push(postId); where.push(`post_id=$${params.length}`); }
    if (fromDate) { params.push(fromDate); where.push(`timestamp >= $${params.length}`); }
    if (toDate)   { params.push(toDate);   where.push(`timestamp <= $${params.length}`); }
    params.push(limit);
    const r = await pool.query(
      `SELECT * FROM instagram_comments WHERE ${where.join(' AND ')} ORDER BY timestamp DESC LIMIT $${params.length}`,
      params
    );
    return r.rows;
  },

  async upsertInstagramDM(userId, dm) {
    await pool.query(
      `INSERT INTO instagram_dms (user_id, expert, conversation_id, participants, last_msg_text, last_msg_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, conversation_id) DO UPDATE
       SET last_msg_text=$5, last_msg_at=$6, participants=$4`,
      [userId, dm.expert, dm.conversation_id, JSON.stringify(dm.participants || []),
       dm.last_msg_text, dm.last_msg_at]
    );
  },

  async upsertInstagramDMMessage(userId, msg) {
    await pool.query(
      `INSERT INTO instagram_dm_messages (user_id, conversation_id, message_id, from_username, message_text, timestamp)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, message_id) DO NOTHING`,
      [userId, msg.conversation_id, msg.message_id, msg.from_username, msg.message_text, msg.timestamp]
    );
  },

  async listInstagramDMs(userId, { expert, limit = 20 } = {}) {
    const where = ['user_id=$1']; const params = [userId];
    if (expert) { params.push(expert.toUpperCase()); where.push(`UPPER(expert)=$${params.length}`); }
    params.push(limit);
    const r = await pool.query(
      `SELECT * FROM instagram_dms WHERE ${where.join(' AND ')} ORDER BY last_msg_at DESC NULLS LAST LIMIT $${params.length}`,
      params
    );
    return r.rows;
  },

  /** Resumo da atividade IG do expert no período (lê tudo do DB). */
  async getInstagramAtividadeFromDB(userId, expert, fromDate, toDate) {
    const upper = expert.toUpperCase();
    const fromIso = (fromDate instanceof Date) ? fromDate.toISOString() : fromDate;
    const toIso   = (toDate instanceof Date) ? toDate.toISOString() : toDate;
    const stories = await pool.query(
      `SELECT story_id, media_type, media_url, thumbnail_url, permalink, timestamp, description
       FROM instagram_stories WHERE user_id=$1 AND UPPER(expert)=$2 AND timestamp BETWEEN $3 AND $4
       ORDER BY timestamp DESC`,
      [userId, upper, fromIso, toIso]
    );
    const posts = await pool.query(
      `SELECT post_id, caption, media_type, permalink, thumbnail_url, timestamp, like_count, comments_count, description
       FROM instagram_posts WHERE user_id=$1 AND UPPER(expert)=$2 AND timestamp BETWEEN $3 AND $4
       ORDER BY timestamp DESC`,
      [userId, upper, fromIso, toIso]
    );
    const totalComments = await pool.query(
      `SELECT COUNT(*) AS total, COUNT(DISTINCT autor_username) AS autores_unicos
       FROM instagram_comments WHERE user_id=$1 AND UPPER(expert)=$2 AND timestamp BETWEEN $3 AND $4`,
      [userId, upper, fromIso, toIso]
    );
    const topComments = await pool.query(
      `SELECT autor_username, texto, like_count, timestamp
       FROM instagram_comments WHERE user_id=$1 AND UPPER(expert)=$2 AND timestamp BETWEEN $3 AND $4
       ORDER BY like_count DESC NULLS LAST, timestamp DESC LIMIT 15`,
      [userId, upper, fromIso, toIso]
    );
    const dms = await pool.query(
      `SELECT conversation_id, last_msg_text, last_msg_at
       FROM instagram_dms WHERE user_id=$1 AND UPPER(expert)=$2 AND last_msg_at BETWEEN $3 AND $4
       ORDER BY last_msg_at DESC LIMIT 30`,
      [userId, upper, fromIso, toIso]
    );
    return {
      stories: stories.rows,
      posts: posts.rows,
      total_comments: Number(totalComments.rows[0]?.total || 0),
      autores_unicos_comments: Number(totalComments.rows[0]?.autores_unicos || 0),
      top_comments: topComments.rows,
      dms_recentes: dms.rows,
    };
  },

  // ── Smart Reminders ──────────────────────────────────
  async insertReminder(rem) {
    const res = await pool.query(
      `INSERT INTO smart_reminders (user_id, tipo, expert, trigger_id, trigger_data, conteudo, sugestoes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tipo, trigger_id) DO UPDATE SET conteudo=$6, sugestoes=$7
       RETURNING *`,
      [rem.user_id, rem.tipo, rem.expert, rem.trigger_id,
       JSON.stringify(rem.trigger_data || {}), rem.conteudo,
       JSON.stringify(rem.sugestoes || []), rem.status || 'pendente']
    );
    return res.rows[0];
  },

  async listReminders(userId, { tipo, status, limit = 50 } = {}) {
    const where = ['user_id=$1']; const params = [userId];
    if (tipo)   { params.push(tipo);   where.push(`tipo=$${params.length}`); }
    if (status) { params.push(status); where.push(`status=$${params.length}`); }
    params.push(limit);
    const res = await pool.query(
      `SELECT * FROM smart_reminders WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    return res.rows;
  },

  async markReminderSent(id, group_jid) {
    await pool.query(
      `UPDATE smart_reminders SET status='enviado', enviado_para=$2, enviado_at=NOW() WHERE id=$1`,
      [id, group_jid]
    );
  },

  async markReminderError(id, errorMsg) {
    await pool.query(
      `UPDATE smart_reminders SET status='erro', error_msg=$2 WHERE id=$1`,
      [id, errorMsg]
    );
  },

  async existsReminder(tipo, triggerId) {
    const r = await pool.query('SELECT id FROM smart_reminders WHERE tipo=$1 AND trigger_id=$2', [tipo, triggerId]);
    return r.rows.length > 0;
  },

  // ── AI Advisor ──────────────────────────────────────
  async insertRecommendation(rec) {
    const res = await pool.query(
      `INSERT INTO ai_recommendations
       (user_id, expert, categoria, urgencia, acao, justificativa, impacto_estimado, passos, raw_data_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [rec.user_id, rec.expert, rec.categoria, rec.urgencia, rec.acao,
       rec.justificativa, rec.impacto_estimado, JSON.stringify(rec.passos || []),
       JSON.stringify(rec.raw_data_snapshot || {})]
    );
    return res.rows[0];
  },

  async listRecommendations(userId, { status, limit = 50 } = {}) {
    if (status) {
      const r = await pool.query(
        `SELECT * FROM ai_recommendations WHERE user_id=$1 AND status=$2 ORDER BY generated_at DESC LIMIT $3`,
        [userId, status, limit]
      );
      return r.rows;
    }
    const r = await pool.query(
      `SELECT * FROM ai_recommendations WHERE user_id=$1 ORDER BY generated_at DESC LIMIT $2`,
      [userId, limit]
    );
    return r.rows;
  },

  async updateRecommendationStatus(id, status, notes) {
    const res = await pool.query(
      `UPDATE ai_recommendations SET status=$2, status_at=NOW(), notes=COALESCE($3, notes)
       WHERE id=$1 RETURNING *`,
      [id, status, notes || null]
    );
    return res.rows[0];
  },

  async updateRecommendationOutcome(id, { ftds_delta, netpl_delta, score }) {
    await pool.query(
      `UPDATE ai_recommendations SET outcome_measured_at=NOW(),
         outcome_ftds_delta=$2, outcome_netpl_delta=$3, outcome_score=$4
       WHERE id=$1`,
      [id, ftds_delta, netpl_delta, score]
    );
  },

  // ── Klarvel daily summary (preenchida pelo cron) ─────
  async upsertKlarvelDailySummary(userId, expert, date, data) {
    await pool.query(
      `INSERT INTO klarvel_daily_summary (user_id, expert, report_date, total_lives, duracao_total_minutos,
         pico_simultaneos_max, pico_simultaneos_medio, participantes_unicos, mensagens_total, autores_unicos,
         engagement_rate_pct, raw_lives)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (user_id, expert, report_date) DO UPDATE
       SET total_lives=$4, duracao_total_minutos=$5, pico_simultaneos_max=$6, pico_simultaneos_medio=$7,
           participantes_unicos=$8, mensagens_total=$9, autores_unicos=$10,
           engagement_rate_pct=$11, raw_lives=$12, created_at=NOW()`,
      [userId, expert, date, data.total_lives, data.duracao_total_minutos, data.pico_simultaneos_max,
       data.pico_simultaneos_medio, data.participantes_unicos, data.mensagens_total, data.autores_unicos,
       data.engagement_rate_pct, JSON.stringify(data.raw_lives || [])]
    );
  },

  async getKlarvelSummary(userId, expert, dateFrom, dateTo) {
    const res = await pool.query(
      `SELECT * FROM klarvel_daily_summary
       WHERE user_id=$1 AND expert=$2 AND report_date BETWEEN $3 AND $4
       ORDER BY report_date ASC`,
      [userId, expert, dateFrom, dateTo]
    );
    return res.rows;
  },

  // ── Bridge registry (URL dinâmica do ngrok do Mac) ─────
  async upsertBridgeRegistry(url, version) {
    await pool.query(
      `INSERT INTO bridge_registry (id, url, version, updated_at) VALUES (1, $1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET url=$1, version=$2, updated_at=NOW()`,
      [url, version || null]
    );
  },

  async getBridgeRegistry() {
    const res = await pool.query('SELECT url, version, updated_at FROM bridge_registry WHERE id=1');
    return res.rows[0] || null;
  },

  // ── Chat memory (persistent) ─────────────────────────

  /** Pega a sessão de chat mais recente do user ou cria uma nova */
  async getOrCreateChatSession(userId, { backend = 'api' } = {}) {
    const existing = await pool.query(
      `SELECT * FROM chat_sessions WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 1`,
      [userId]
    );
    if (existing.rows.length > 0) return existing.rows[0];
    const created = await pool.query(
      `INSERT INTO chat_sessions (user_id, backend) VALUES ($1, $2) RETURNING *`,
      [userId, backend]
    );
    return created.rows[0];
  },

  async createChatSession(userId, { title, backend = 'api' } = {}) {
    const res = await pool.query(
      `INSERT INTO chat_sessions (user_id, title, backend) VALUES ($1, $2, $3) RETURNING *`,
      [userId, title || null, backend]
    );
    return res.rows[0];
  },

  async updateChatSessionBridgeId(sessionId, bridgeSessionId) {
    await pool.query(
      `UPDATE chat_sessions SET bridge_session_id=$2, updated_at=NOW() WHERE id=$1`,
      [sessionId, bridgeSessionId]
    );
  },

  async touchChatSession(sessionId) {
    await pool.query(`UPDATE chat_sessions SET updated_at=NOW() WHERE id=$1`, [sessionId]);
  },

  async listChatSessions(userId, limit = 20) {
    const res = await pool.query(
      `SELECT s.*, (SELECT COUNT(*) FROM chat_messages WHERE session_id=s.id) AS message_count
       FROM chat_sessions s WHERE user_id=$1 ORDER BY updated_at DESC LIMIT $2`,
      [userId, limit]
    );
    return res.rows;
  },

  async addChatMessage(sessionId, role, content, metadata = null) {
    const res = await pool.query(
      `INSERT INTO chat_messages (session_id, role, content, metadata) VALUES ($1, $2, $3, $4) RETURNING *`,
      [sessionId, role, content, metadata]
    );
    await this.touchChatSession(sessionId);
    return res.rows[0];
  },

  async getChatMessages(sessionId, limit = 20) {
    const res = await pool.query(
      `SELECT * FROM (
         SELECT * FROM chat_messages WHERE session_id=$1 ORDER BY created_at DESC LIMIT $2
       ) t ORDER BY created_at ASC`,
      [sessionId, limit]
    );
    return res.rows;
  },

  async upsertChatFact(userId, type, key, value, sourceMessageId = null) {
    const res = await pool.query(
      `INSERT INTO chat_facts (user_id, type, fact_key, fact_value, source_message_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, type, fact_key) DO UPDATE
         SET fact_value=$4, source_message_id=COALESCE($5, chat_facts.source_message_id), updated_at=NOW()
       RETURNING *`,
      [userId, type, key, value, sourceMessageId]
    );
    return res.rows[0];
  },

  async getChatFacts(userId, types = null) {
    if (types && types.length > 0) {
      const res = await pool.query(
        `SELECT * FROM chat_facts WHERE user_id=$1 AND type = ANY($2) ORDER BY type, fact_key`,
        [userId, types]
      );
      return res.rows;
    }
    const res = await pool.query(
      `SELECT * FROM chat_facts WHERE user_id=$1 ORDER BY type, fact_key`,
      [userId]
    );
    return res.rows;
  },

  async deleteChatFact(userId, type, key) {
    await pool.query(
      `DELETE FROM chat_facts WHERE user_id=$1 AND type=$2 AND fact_key=$3`,
      [userId, type, key]
    );
  },
};
