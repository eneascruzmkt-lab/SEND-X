const { google } = require('googleapis');
const { Router } = require('express');
const router = Router();

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  let keyJson;
  if (raw.trim().startsWith('{')) {
    keyJson = JSON.parse(raw);
  } else {
    const cleaned = raw.replace(/\s/g, '');
    keyJson = JSON.parse(Buffer.from(cleaned, 'base64').toString());
  }
  return new google.auth.GoogleAuth({
    credentials: keyJson,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

const COL = { gasto: 1, ftds: 2, ftdAmount: 3, depositsAmount: 5, telegramJoins: 7, netPL: 9 };

function parseNum(val) {
  if (!val || val === '' || val === '-') return 0;
  let cleaned = String(val).replace(/R\$\s*/g, '').trim();
  if (/\.\d{3}/.test(cleaned) && cleaned.includes(',')) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (cleaned.includes(',') && !cleaned.includes('.')) {
    cleaned = cleaned.replace(',', '.');
  }
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function extractRow(row) {
  return {
    gasto: parseNum(row[COL.gasto]),
    ftds: parseNum(row[COL.ftds]),
    ftdAmount: parseNum(row[COL.ftdAmount]),
    depositsAmount: parseNum(row[COL.depositsAmount]),
    telegramJoins: parseNum(row[COL.telegramJoins]),
    netPL: parseNum(row[COL.netPL]),
  };
}

const EMPTY = { gasto: 0, ftds: 0, ftdAmount: 0, depositsAmount: 0, telegramJoins: 0, netPL: 0 };

function sumRows(rows) {
  const total = { ...EMPTY };
  for (const row of rows) {
    const r = extractRow(row);
    total.gasto += r.gasto;
    total.ftds += r.ftds;
    total.ftdAmount += r.ftdAmount;
    total.depositsAmount += r.depositsAmount;
    total.telegramJoins += r.telegramJoins;
    total.netPL += r.netPL;
  }
  Object.keys(total).forEach(k => { total[k] = Math.round(total[k] * 100) / 100; });
  return total;
}

/**
 * GET /relatorio?tab=DANI|DEIVID&periodo=ontem|7d|1m|3m|custom&de=DD/MM/YYYY&ate=DD/MM/YYYY
 *
 * periodo:
 *   ontem   — only yesterday (default)
 *   7d      — last 7 days
 *   1m      — current month
 *   3m      — last 3 months (current + 2 previous)
 *   custom  — from 'de' to 'ate' dates
 */
router.get('/relatorio', async (req, res) => {
  try {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY || !process.env.GOOGLE_SHEET_ID) {
      return res.status(500).json({ error: 'Configuração do Google Sheets ausente' });
    }

    const tab = req.query.tab === 'DEIVID' ? 'DEIVID' : 'DANI';
    const periodo = req.query.periodo || 'ontem';
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;

    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const today = now.getDate();
    const month = now.getMonth();
    const year = now.getFullYear();

    // Read all rows of current month (A2:J32 covers days 1-31)
    const allRange = `${tab}!A2:J32`;
    const result = await sheets.spreadsheets.values.get({ spreadsheetId, range: allRange });
    const allRows = result.data.values || [];

    // Parse date from column A (DD/MM/YYYY) and filter rows
    function parseDate(dateStr) {
      if (!dateStr) return null;
      const parts = dateStr.trim().split('/');
      if (parts.length !== 3) return null;
      return new Date(parts[2], parts[1] - 1, parts[0]);
    }

    let filteredRows = [];
    let periodoLabel = '';

    if (periodo === 'ontem') {
      if (today === 1) {
        return res.json({ total: { ...EMPTY }, periodoLabel: 'Sem dados', tab });
      }
      const yesterdayDay = today - 1;
      // Yesterday = row index (yesterdayDay - 1) since rows start at day 1
      const row = allRows[yesterdayDay - 1];
      filteredRows = row ? [row] : [];
      const dd = String(yesterdayDay).padStart(2, '0');
      const mm = String(month + 1).padStart(2, '0');
      periodoLabel = `${dd}/${mm}/${year}`;

    } else if (periodo === '7d') {
      const endDate = new Date(year, month, today - 1); // yesterday
      const startDate = new Date(endDate);
      startDate.setDate(startDate.getDate() - 6); // 7 days back

      for (const row of allRows) {
        const d = parseDate(row[0]);
        if (d && d >= startDate && d <= endDate) filteredRows.push(row);
      }

      // If 7d spans previous month, also read that sheet
      if (startDate.getMonth() !== month) {
        // Need to read previous month's sheet too — but sheets are per-month
        // For now, only show data available in current month's tab
      }

      const fmt = d => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
      periodoLabel = `${fmt(startDate)} — ${fmt(endDate)}/${year}`;

    } else if (periodo === '1m') {
      const lastDay = Math.min(today - 1, 31);
      filteredRows = allRows.slice(0, lastDay);
      const mesNome = now.toLocaleString('pt-BR', { month: 'long', timeZone: 'America/Sao_Paulo' });
      periodoLabel = `${mesNome.charAt(0).toUpperCase() + mesNome.slice(1)} ${year}`;

    } else if (periodo === '3m') {
      // Current month
      const lastDay = Math.min(today - 1, 31);
      filteredRows = allRows.slice(0, lastDay);

      // Read 2 previous months
      for (let i = 1; i <= 2; i++) {
        const prevMonth = new Date(year, month - i, 1);
        const prevMonthName = prevMonth.toLocaleString('pt-BR', { month: 'long', timeZone: 'America/Sao_Paulo' });
        // Previous months would be in different sheet tabs or same tab with different data
        // Since the sheet resets monthly (same tab), we can only show current month
        // TODO: if historical sheets exist, read them here
      }
      periodoLabel = 'Últimos 3 meses (dados do mês atual)';

    } else if (periodo === 'custom') {
      const deStr = req.query.de; // DD/MM/YYYY
      const ateStr = req.query.ate; // DD/MM/YYYY
      if (!deStr || !ateStr) {
        return res.status(400).json({ error: 'Parâmetros de e ate são obrigatórios para período personalizado' });
      }
      const startDate = parseDate(deStr);
      const endDate = parseDate(ateStr);
      if (!startDate || !endDate) {
        return res.status(400).json({ error: 'Formato de data inválido. Use DD/MM/YYYY' });
      }

      for (const row of allRows) {
        const d = parseDate(row[0]);
        if (d && d >= startDate && d <= endDate) filteredRows.push(row);
      }
      periodoLabel = `${deStr} — ${ateStr}`;
    }

    const total = sumRows(filteredRows);

    res.json({ total, periodoLabel, tab });
  } catch (err) {
    console.error('[Relatorio] Error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar relatório' });
  }
});

module.exports = router;
