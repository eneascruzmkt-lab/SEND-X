const { google } = require('googleapis');
const { Router } = require('express');
const db = require('../db');
const router = Router();

function parseServiceAccountKey(raw) {
  if (raw.trim().startsWith('{')) {
    return JSON.parse(raw);
  }
  const cleaned = raw.replace(/\s/g, '');
  return JSON.parse(Buffer.from(cleaned, 'base64').toString());
}

function getAuth(serviceAccountKey) {
  const keyJson = parseServiceAccountKey(serviceAccountKey);
  return new google.auth.GoogleAuth({
    credentials: keyJson,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

const COL = { gasto: 1, cadastros: 2, cliques: 3, ftds: 4, ftdAmount: 5, depositsAmount: 7, telegramJoins: 9, netPL: 11 };

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
    cadastros: parseNum(row[COL.cadastros]),
    cliques: parseNum(row[COL.cliques]),
    ftds: parseNum(row[COL.ftds]),
    ftdAmount: parseNum(row[COL.ftdAmount]),
    depositsAmount: parseNum(row[COL.depositsAmount]),
    telegramJoins: parseNum(row[COL.telegramJoins]),
    netPL: parseNum(row[COL.netPL]),
  };
}

const EMPTY = { gasto: 0, cadastros: 0, cliques: 0, ftds: 0, ftdAmount: 0, depositsAmount: 0, telegramJoins: 0, netPL: 0 };

function sumRows(rows) {
  const total = { ...EMPTY };
  for (const row of rows) {
    const r = extractRow(row);
    total.gasto += r.gasto;
    total.cadastros += r.cadastros;
    total.cliques += r.cliques;
    total.ftds += r.ftds;
    total.ftdAmount += r.ftdAmount;
    total.depositsAmount += r.depositsAmount;
    total.telegramJoins += r.telegramJoins;
    total.netPL += r.netPL;
  }
  // Custo por FTD = recalcula a partir dos totais (fórmula na planilha, calculamos aqui também)
  total.custoFTD = total.ftds > 0 ? total.gasto / total.ftds : 0;
  Object.keys(total).forEach(k => { total[k] = Math.round(total[k] * 100) / 100; });
  return total;
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.trim().split('/');
  if (parts.length !== 3) return null;
  return new Date(parts[2], parts[1] - 1, parts[0]);
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Returns all months (YYYY-MM) between two dates, inclusive.
 */
function getMonthsBetween(startDate, endDate) {
  const months = [];
  const cur = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  while (cur <= endDate) {
    months.push(monthKey(cur));
    cur.setMonth(cur.getMonth() + 1);
  }
  return months;
}

/**
 * Fetches rows from all sheets that cover startDate..endDate, filtered by date range.
 */
async function fetchRowsForRange(sheets, userId, tab, startDate, endDate, settings) {
  const months = getMonthsBetween(startDate, endDate);
  const allFiltered = [];

  for (const mk of months) {
    const sheetId = await db.getSheetIdForMonth(userId, mk) || settings.google_sheet_id;
    if (!sheetId) continue;

    try {
      const range = `${tab}!A2:L32`;
      const result = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
      const rows = result.data.values || [];

      for (const row of rows) {
        const d = parseDate(row[0]);
        if (d && d >= startDate && d <= endDate) allFiltered.push(row);
      }
    } catch (err) {
      console.warn(`[Relatorio] Could not read sheet for ${mk}: ${err.message}`);
    }
  }

  return allFiltered;
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
    const settings = await db.getUserSettings(req.userId);
    const serviceAccountKey = settings.google_service_account_key;

    if (!serviceAccountKey) {
      return res.status(400).json({ error: 'Google Sheets nao configurado. Va em Configuracoes.' });
    }

    const tab = req.query.tab === 'DEIVID' ? 'DEIVID' : 'DANI';
    const periodo = req.query.periodo || 'ontem';
    const auth = getAuth(serviceAccountKey);
    const sheets = google.sheets({ version: 'v4', auth });

    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const today = now.getDate();
    const month = now.getMonth();
    const year = now.getFullYear();

    let filteredRows = [];
    let periodoLabel = '';

    if (periodo === 'ontem') {
      const yesterday = new Date(year, month, today - 1);
      filteredRows = await fetchRowsForRange(sheets, req.userId, tab, yesterday, yesterday, settings);
      const dd = String(yesterday.getDate()).padStart(2, '0');
      const mm = String(yesterday.getMonth() + 1).padStart(2, '0');
      periodoLabel = `${dd}/${mm}/${yesterday.getFullYear()}`;

    } else if (periodo === 'hoje') {
      const row = today + 1; // day 1 = row 2
      const mk = monthKey(now);
      const sheetId = await db.getSheetIdForMonth(req.userId, mk) || settings.google_sheet_id;

      try {
        const range = `${tab}!A${row}:L${row}`;
        const result = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
        const rows = result.data.values || [];
        if (rows.length > 0) filteredRows = rows;
      } catch (err) {
        console.warn(`[Relatorio] Could not read today's row: ${err.message}`);
      }

      const dd = String(today).padStart(2, '0');
      const mm = String(month + 1).padStart(2, '0');
      periodoLabel = `Hoje (${dd}/${mm}/${year})`;

    } else if (periodo === '7d') {
      const endDate = new Date(year, month, today - 1);
      const startDate = new Date(endDate);
      startDate.setDate(startDate.getDate() - 6);
      filteredRows = await fetchRowsForRange(sheets, req.userId, tab, startDate, endDate, settings);
      const fmt = d => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
      periodoLabel = `${fmt(startDate)} — ${fmt(endDate)}/${year}`;

    } else if (periodo === '1m') {
      const startDate = new Date(year, month, 1);
      const endDate = new Date(year, month, today - 1);
      filteredRows = await fetchRowsForRange(sheets, req.userId, tab, startDate, endDate, settings);
      const mesNome = now.toLocaleString('pt-BR', { month: 'long', timeZone: 'America/Sao_Paulo' });
      periodoLabel = `${mesNome.charAt(0).toUpperCase() + mesNome.slice(1)} ${year}`;

    } else if (periodo === 'lastm') {
      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0); // last day of previous month
      filteredRows = await fetchRowsForRange(sheets, req.userId, tab, startDate, endDate, settings);
      const mesNome = startDate.toLocaleString('pt-BR', { month: 'long', timeZone: 'America/Sao_Paulo' });
      periodoLabel = `${mesNome.charAt(0).toUpperCase() + mesNome.slice(1)} ${startDate.getFullYear()}`;

    } else if (periodo === '3m') {
      const startDate = new Date(year, month - 2, 1);
      const endDate = new Date(year, month, today - 1);
      filteredRows = await fetchRowsForRange(sheets, req.userId, tab, startDate, endDate, settings);
      const fmtMonth = d => d.toLocaleString('pt-BR', { month: 'short', timeZone: 'America/Sao_Paulo' });
      periodoLabel = `${fmtMonth(startDate)}/${startDate.getFullYear()} — ${fmtMonth(endDate)}/${endDate.getFullYear()}`;

    } else if (periodo === 'custom') {
      const deStr = req.query.de;
      const ateStr = req.query.ate;
      if (!deStr || !ateStr) {
        return res.status(400).json({ error: 'Parâmetros de e ate são obrigatórios para período personalizado' });
      }
      const startDate = parseDate(deStr);
      const endDate = parseDate(ateStr);
      if (!startDate || !endDate) {
        return res.status(400).json({ error: 'Formato de data inválido. Use DD/MM/YYYY' });
      }
      filteredRows = await fetchRowsForRange(sheets, req.userId, tab, startDate, endDate, settings);
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
