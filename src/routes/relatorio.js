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
 * Fetches report data for a given user, tab, and period.
 * Returns { rawRows, total, periodoLabel } where rawRows are raw sheet arrays.
 * Reused by both GET /relatorio and POST /api/insights.
 */
async function fetchRelatorioData(userId, tab, periodo, de, ate) {
  const settings = await db.getUserSettings(userId);
  const serviceAccountKey = settings.google_service_account_key;

  if (!serviceAccountKey) {
    throw new Error('Google Sheets nao configurado. Va em Configuracoes.');
  }

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
    filteredRows = await fetchRowsForRange(sheets, userId, tab, yesterday, yesterday, settings);
    const dd = String(yesterday.getDate()).padStart(2, '0');
    const mm = String(yesterday.getMonth() + 1).padStart(2, '0');
    periodoLabel = `${dd}/${mm}/${yesterday.getFullYear()}`;

  } else if (periodo === 'hoje') {
    const row = today + 1;
    const mk = monthKey(now);
    const sheetId = await db.getSheetIdForMonth(userId, mk) || settings.google_sheet_id;

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
    filteredRows = await fetchRowsForRange(sheets, userId, tab, startDate, endDate, settings);
    const fmt = d => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
    periodoLabel = `${fmt(startDate)} — ${fmt(endDate)}/${year}`;

  } else if (periodo === '1m') {
    const startDate = new Date(year, month, 1);
    const endDate = new Date(year, month, today - 1);
    filteredRows = await fetchRowsForRange(sheets, userId, tab, startDate, endDate, settings);
    const mesNome = now.toLocaleString('pt-BR', { month: 'long', timeZone: 'America/Sao_Paulo' });
    periodoLabel = `${mesNome.charAt(0).toUpperCase() + mesNome.slice(1)} ${year}`;

  } else if (periodo === 'lastm') {
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);
    filteredRows = await fetchRowsForRange(sheets, userId, tab, startDate, endDate, settings);
    const mesNome = startDate.toLocaleString('pt-BR', { month: 'long', timeZone: 'America/Sao_Paulo' });
    periodoLabel = `${mesNome.charAt(0).toUpperCase() + mesNome.slice(1)} ${startDate.getFullYear()}`;

  } else if (periodo === '3m') {
    const startDate = new Date(year, month - 2, 1);
    const endDate = new Date(year, month, today - 1);
    filteredRows = await fetchRowsForRange(sheets, userId, tab, startDate, endDate, settings);
    const fmtMonth = d => d.toLocaleString('pt-BR', { month: 'short', timeZone: 'America/Sao_Paulo' });
    periodoLabel = `${fmtMonth(startDate)}/${startDate.getFullYear()} — ${fmtMonth(endDate)}/${endDate.getFullYear()}`;

  } else if (periodo === 'custom') {
    if (!de || !ate) {
      throw new Error('Parâmetros de e ate são obrigatórios para período personalizado');
    }
    const startDate = parseDate(de);
    const endDate = parseDate(ate);
    if (!startDate || !endDate) {
      throw new Error('Formato de data inválido. Use DD/MM/YYYY');
    }
    filteredRows = await fetchRowsForRange(sheets, userId, tab, startDate, endDate, settings);
    periodoLabel = `${de} — ${ate}`;

  } else {
    throw new Error('Período inválido');
  }

  const total = sumRows(filteredRows);
  return { rawRows: filteredRows, total, periodoLabel };
}

router.get('/relatorio', async (req, res) => {
  try {
    const tab = req.query.tab || 'DANI';
    const periodo = req.query.periodo || 'ontem';
    const { total, periodoLabel } = await fetchRelatorioData(req.userId, tab, periodo, req.query.de, req.query.ate);
    res.json({ total, periodoLabel, tab });
  } catch (err) {
    console.error('[Relatorio] Error:', err.message);
    if (err.message.includes('obrigat') || err.message.includes('inválido') || err.message.includes('configurado')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Erro ao carregar relatório' });
  }
});

router.get('/relatorio/diario', async (req, res) => {
  try {
    const tab = req.query.tab || 'DANI';
    const periodo = req.query.periodo || '7d';
    const { rawRows, periodoLabel } = await fetchRelatorioData(req.userId, tab, periodo, req.query.de, req.query.ate);

    const dias = rawRows
      .map(row => {
        const d = parseDate(row[0]);
        if (!d) return null;
        const r = extractRow(row);
        r.custoFTD = r.ftds > 0 ? Math.round((r.gasto / r.ftds) * 100) / 100 : 0;
        r.data = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
        r._sort = d.getTime();
        return r;
      })
      .filter(Boolean)
      .sort((a, b) => a._sort - b._sort)
      .map(({ _sort, ...rest }) => rest);

    res.json({ dias, tab, periodoLabel });
  } catch (err) {
    console.error('[Relatorio] Diario error:', err.message);
    if (err.message.includes('obrigat') || err.message.includes('inválido') || err.message.includes('configurado')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Erro ao carregar dados diários' });
  }
});

/**
 * GET /relatorio/tabs — returns available sheet tab names for the user's spreadsheet.
 */
router.get('/relatorio/tabs', async (req, res) => {
  try {
    const settings = await db.getUserSettings(req.userId);
    const serviceAccountKey = settings.google_service_account_key;
    if (!serviceAccountKey) {
      return res.status(400).json({ error: 'Google Sheets nao configurado' });
    }

    // Resolve sheet id: current month mapping first, then fallback to settings
    const sheetId = (await db.getCurrentSheetId(req.userId)) || settings.google_sheet_id;
    if (!sheetId) {
      return res.status(400).json({ error: 'Nenhuma planilha configurada para o mes atual' });
    }

    const auth = getAuth(serviceAccountKey);
    const sheets = google.sheets({ version: 'v4', auth });
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const tabs = meta.data.sheets.map(s => s.properties.title);
    res.json(tabs);
  } catch (err) {
    console.error('[Relatorio] Tabs error:', err.message);
    res.status(500).json({ error: 'Erro ao listar abas' });
  }
});

/**
 * GET /relatorio/utms — FTDs e cadastros agrupados por UTM source/medium.
 * Usa mesma lógica de período do relatório principal.
 */
router.get('/relatorio/utms', async (req, res) => {
  try {
    const tab = req.query.tab || 'DANI';
    const periodo = req.query.periodo || 'ontem';

    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const today = now.getDate();
    const month = now.getMonth();
    const year = now.getFullYear();

    // Cria Date com fuso de Brasília (UTC-3) para comparar corretamente com TIMESTAMPTZ
    const pad = n => String(n).padStart(2, '0');
    const brDate = (y, m, d, h = 0, min = 0, s = 0) =>
      new Date(`${y}-${pad(m+1)}-${pad(d)}T${pad(h)}:${pad(min)}:${pad(s)}-03:00`);

    let startDate, endDate;

    // Postbacks chegam em tempo real, então períodos incluem hoje
    if (periodo === 'hoje') {
      startDate = brDate(year, month, today);
      endDate = brDate(year, month, today, 23, 59, 59);
    } else if (periodo === 'ontem') {
      startDate = brDate(year, month, today - 1);
      endDate = brDate(year, month, today - 1, 23, 59, 59);
    } else if (periodo === '7d') {
      endDate = brDate(year, month, today, 23, 59, 59);
      startDate = brDate(year, month, today - 6);
    } else if (periodo === '1m') {
      startDate = brDate(year, month, 1);
      endDate = brDate(year, month, today, 23, 59, 59);
    } else if (periodo === 'lastm') {
      startDate = brDate(year, month - 1, 1);
      endDate = new Date(new Date(`${year}-${pad(month+1)}-01T00:00:00-03:00`) - 1);
    } else if (periodo === '3m') {
      startDate = brDate(year, month - 2, 1);
      endDate = brDate(year, month, today, 23, 59, 59);
    } else if (periodo === 'custom') {
      startDate = parseDate(req.query.de);
      endDate = parseDate(req.query.ate);
      if (!startDate || !endDate) {
        return res.status(400).json({ error: 'Parametros de e ate obrigatorios (DD/MM/YYYY)' });
      }
      // Ajusta custom dates para BRT
      startDate = brDate(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
      endDate = brDate(endDate.getFullYear(), endDate.getMonth(), endDate.getDate(), 23, 59, 59);
    } else {
      return res.status(400).json({ error: 'Periodo invalido' });
    }

    const utms = await db.getPostbacksByUtm(req.userId, tab, startDate, endDate);
    res.json({ utms, tab });
  } catch (err) {
    console.error('[Relatorio] UTMs error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar UTMs' });
  }
});

module.exports = router;
module.exports.extractRow = extractRow;
module.exports.parseNum = parseNum;
module.exports.sumRows = sumRows;
module.exports.fetchRelatorioData = fetchRelatorioData;
