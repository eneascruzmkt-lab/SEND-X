/**
 * Script de migracao SendPulse → Pulp
 *
 * Execucao: node scripts/migrate-sendpulse-to-pulp.js
 *
 * O que faz:
 * 1. Expira schedules avulsos pendentes (sem recorrencia)
 * 2. Atualiza scheduled_at dos recorrentes para proximo horario futuro
 * 3. Mostra pares atuais para atualizar bot_id manualmente
 *
 * IMPORTANTE: Executar ANTES do deploy do codigo novo.
 */

const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function migrate() {
  const client = await pool.connect();
  try {
    // 1. Expirar schedules avulsos pendentes
    const expired = await client.query(
      `UPDATE schedules SET status = 'expirado' WHERE status = 'pendente' AND recurrence IS NULL RETURNING id`
    );
    console.log(`[1/3] ${expired.rowCount} schedules avulsos marcados como expirado`);

    // 2. Atualizar scheduled_at dos recorrentes
    const recorrentes = await client.query(
      `SELECT id, scheduled_at, recurrence FROM schedules WHERE status = 'pendente' AND recurrence IS NOT NULL`
    );
    let updated = 0;
    for (const s of recorrentes.rows) {
      const now = new Date();
      const current = new Date(s.scheduled_at);
      const hours = current.getHours();
      const minutes = current.getMinutes();
      let next = new Date(now);
      next.setDate(next.getDate() + 1);
      next.setHours(hours, minutes, 0, 0);

      if (s.recurrence === 'diasuteis') {
        while (next.getDay() === 0 || next.getDay() === 6) {
          next.setDate(next.getDate() + 1);
        }
      } else if (s.recurrence === 'semanal') {
        const targetDay = current.getDay();
        while (next.getDay() !== targetDay) {
          next.setDate(next.getDate() + 1);
        }
      }

      await client.query(
        `UPDATE schedules SET scheduled_at = $1 WHERE id = $2`,
        [next.toISOString(), s.id]
      );
      console.log(`  Schedule ${s.id} (${s.recurrence}): ${s.scheduled_at} → ${next.toISOString()}`);
      updated++;
    }
    console.log(`[2/3] ${updated} schedules recorrentes atualizados`);

    // 3. Mostrar pares atuais para atualizacao manual do bot_id
    const pares = await client.query(
      `SELECT id, nome, sendpulse_bot_id, sendpulse_bot_nome FROM pares WHERE ativo = 1`
    );
    console.log(`\n[3/3] Pares ativos (atualize sendpulse_bot_id para o bot_id do Pulp):`);
    for (const p of pares.rows) {
      console.log(`  Par ${p.id}: "${p.nome}" — bot_id atual: ${p.sendpulse_bot_id} (${p.sendpulse_bot_nome})`);
    }
    console.log(`\nPara atualizar, rode:`);
    console.log(`  UPDATE pares SET sendpulse_bot_id = '<PULP_BOT_ID>' WHERE id = <PAR_ID>;`);

    console.log('\nMigracao concluida. Agora faca o deploy do codigo novo.');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => { console.error('Erro na migracao:', err); process.exit(1); });
