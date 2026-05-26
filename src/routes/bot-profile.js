// POST + GET pra distribuir o profile do Chromium do bot Meet.
// Auth: Bearer BRIDGE_SECRET. Salva em disco efêmero (Railway perde no
// redeploy, mas o bot só busca uma vez por instância — depois vai pro
// volume dele).

const { Router } = require('express');
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

const PROFILE_PATH = '/tmp/bot-google-profile.tar.gz';
const SECRET = process.env.BRIDGE_SECRET;

function checkAuth(req, res) {
  const header = req.header('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!SECRET || token !== SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/** POST /api/bot-profile  multipart file=<arquivo tar.gz>  Bearer BRIDGE_SECRET */
router.post('/bot-profile', upload.single('file'), async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!req.file) return res.status(400).json({ error: 'file (multipart) obrigatório' });
  try {
    await fs.promises.writeFile(PROFILE_PATH, req.file.buffer);
    res.json({ ok: true, size_bytes: req.file.size, path: PROFILE_PATH });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/bot-profile?token=<BRIDGE_SECRET>  ou Authorization: Bearer ... */
router.get('/bot-profile', async (req, res) => {
  const qtoken = req.query.token;
  const header = req.header('authorization') || '';
  const btoken = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!SECRET || (qtoken !== SECRET && btoken !== SECRET)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!fs.existsSync(PROFILE_PATH)) {
    return res.status(404).json({ error: 'profile não foi uploadado ainda' });
  }
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', 'attachment; filename="bot-google-profile.tar.gz"');
  fs.createReadStream(PROFILE_PATH).pipe(res);
});

/** GET /api/bot-profile/info — checa se existe sem precisar baixar */
router.get('/bot-profile/info', async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!fs.existsSync(PROFILE_PATH)) return res.json({ exists: false });
  const stats = await fs.promises.stat(PROFILE_PATH);
  res.json({ exists: true, size_bytes: stats.size, mtime: stats.mtime.toISOString() });
});

module.exports = router;
