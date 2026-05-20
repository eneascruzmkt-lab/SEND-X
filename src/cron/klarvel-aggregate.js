const db = require('../db');
const { executeKlarvelTool } = require('../klarvel-tools');

const EXPERTS = ['DANI', 'DEIVID', 'JUH', 'NUCLEAR']; // hardcoded; futuro: ler de ad_accounts

/**
 * Agrega dados do Klarvel pro dia anterior (ou date específico) por expert.
 * Salva em klarvel_daily_summary do SEND-X Postgres.
 */
async function aggregateKlarvelForDate(targetDate) {
  const date = targetDate || (() => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  const results = [];
  for (const expert of EXPERTS) {
    try {
      const resumo = await executeKlarvelTool('get_lives_resumo', {
        expert, periodo: 'custom',
        de: date.split('-').reverse().join('/').replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, '$3/$2/$1') ? formatDateBR(date) : null,
        ate: formatDateBR(date),
      });

      // Se não houver lives no dia
      const total = resumo.total_lives ?? 0;
      if (total === 0) {
        results.push({ expert, date, total_lives: 0, skipped: true });
        continue;
      }

      // Parse engagement_rate (string tipo "44.1%")
      const engagementRate = parseFloat(String(resumo.taxa_engajamento_media || '0').replace('%', '')) || 0;

      await db.upsertKlarvelDailySummary(1, expert, date, {
        total_lives: total,
        duracao_total_minutos: resumo.duracao_total_minutos || 0,
        pico_simultaneos_max: resumo.pico_simultaneos_max || 0,
        pico_simultaneos_medio: resumo.pico_simultaneos_medio || 0,
        participantes_unicos: resumo.participantes_unicos_soma || 0,
        mensagens_total: resumo.mensagens_total || 0,
        autores_unicos: resumo.autores_unicos_soma || 0,
        engagement_rate_pct: engagementRate,
        raw_lives: resumo.lives || [],
      });
      results.push({ expert, date, total_lives: total, agregado: true });
    } catch (err) {
      results.push({ expert, date, error: err.message });
    }
  }
  return results;
}

function formatDateBR(isoDate) {
  // 2026-05-20 → 20/05/2026
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

module.exports = { aggregateKlarvelForDate };
