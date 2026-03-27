const { google } = require('googleapis');
const { Router } = require('express');
const router = Router();

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  // Support both base64-encoded and raw JSON
  let keyJson;
  if (raw.trim().startsWith('{')) {
    keyJson = JSON.parse(raw);
  } else {
    // Remove any spaces that Railway might inject
    const cleaned = raw.replace(/\s/g, '');
    keyJson = JSON.parse(Buffer.from(cleaned, 'base64').toString());
  }
  return new google.auth.GoogleAuth({
    credentials: keyJson,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

// Column indices in fetched range A:J (0-based)
// A=0(date), B=1(gasto), C=2(ftds), D=3(ftdAmount), E=4(skip), F=5(depositsAmount), G=6(skip), H=7(telegramJoins), I=8(skip), J=9(netPL)
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

router.get('/relatorio', async (req, res) => {
  try {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY || !process.env.GOOGLE_SHEET_ID) {
      console.error('[Relatorio] Missing env vars: GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_SHEET_ID');
      return res.status(500).json({ error: 'Configuração do Google Sheets ausente' });
    }
    const tab = req.query.tab === 'DEIVID' ? 'DEIVID' : 'DANI';
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;

    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const today = now.getDate();

    if (today === 1) {
      return res.json({
        dia: { gasto: 0, ftds: 0, ftdAmount: 0, depositsAmount: 0, telegramJoins: 0, netPL: 0 },
        mes: { gasto: 0, ftds: 0, ftdAmount: 0, depositsAmount: 0, telegramJoins: 0, netPL: 0 },
        dataRef: null,
        mesRef: now.toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo' }),
      });
    }

    const yesterdayDay = today - 1;
    const yesterdayRow = yesterdayDay + 1;

    const range = `${tab}!A2:J${yesterdayRow}`;
    const result = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const rows = result.data.values || [];

    const lastRow = rows.length > 0 ? rows[rows.length - 1] : [];
    const dia = lastRow.length > 0 ? extractRow(lastRow) : { gasto: 0, ftds: 0, ftdAmount: 0, depositsAmount: 0, telegramJoins: 0, netPL: 0 };

    const mes = { gasto: 0, ftds: 0, ftdAmount: 0, depositsAmount: 0, telegramJoins: 0, netPL: 0 };
    for (const row of rows) {
      const r = extractRow(row);
      mes.gasto += r.gasto;
      mes.ftds += r.ftds;
      mes.ftdAmount += r.ftdAmount;
      mes.depositsAmount += r.depositsAmount;
      mes.telegramJoins += r.telegramJoins;
      mes.netPL += r.netPL;
    }
    Object.keys(mes).forEach(k => { mes[k] = Math.round(mes[k] * 100) / 100; });

    const dd = String(yesterdayDay).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dataRef = `${dd}/${mm}/${now.getFullYear()}`;
    const mesRef = now.toLocaleString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo' });

    res.json({ dia, mes, dataRef, mesRef: mesRef.charAt(0).toUpperCase() + mesRef.slice(1) });
  } catch (err) {
    console.error('[Relatorio] Error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar relatório' });
  }
});

module.exports = router;
