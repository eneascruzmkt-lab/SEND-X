const { Router } = require('express');
const multer = require('multer');
const db = require('../db');

const router = Router();

// Memória, max 20MB por arquivo
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const SUPPORTED_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf',
  'text/plain', 'text/csv', 'text/markdown',
  'application/json',
  'text/html',
]);

/** POST /api/attachments — multipart upload com campo "file" (e opcional session_id) */
router.post('/attachments', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'arquivo obrigatório (campo file)' });
    const { originalname, mimetype, buffer, size } = req.file;
    const sessionId = req.body.session_id ? Number(req.body.session_id) : null;

    let detectedMime = mimetype;
    if (!SUPPORTED_MIMES.has(detectedMime)) {
      // tenta inferir pela extensão
      const ext = (originalname.split('.').pop() || '').toLowerCase();
      const extMap = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
        pdf: 'application/pdf',
        txt: 'text/plain', csv: 'text/csv', md: 'text/markdown',
        json: 'application/json', html: 'text/html',
      };
      if (extMap[ext]) detectedMime = extMap[ext];
    }
    if (!SUPPORTED_MIMES.has(detectedMime)) {
      return res.status(400).json({ error: `Tipo não suportado: ${mimetype}. Aceita: imagens, PDF, txt, csv, json, md, html` });
    }

    const att = await db.insertAttachment({
      session_id: sessionId,
      filename: originalname,
      mime_type: detectedMime,
      size_bytes: size,
      data: buffer,
      source: 'user',
    });

    const url = `/api/attachments/${att.id}`;
    res.json({ id: att.id, filename: att.filename, mime_type: att.mime_type, size_bytes: att.size_bytes, url });
  } catch (err) {
    console.error('[attachments] upload err:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/attachments/:id — serve o BLOB com content-type correto */
router.get('/attachments/:id', async (req, res) => {
  try {
    const att = await db.getAttachment(Number(req.params.id));
    if (!att) return res.status(404).send('not found');
    res.setHeader('Content-Type', att.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${att.filename.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(att.data);
  } catch (err) {
    res.status(500).send('error');
  }
});

/** GET /api/attachments/session/:sessionId — lista anexos de uma sessão */
router.get('/attachments/session/:sessionId', async (req, res) => {
  try {
    const list = await db.listAttachmentsBySession(Number(req.params.sessionId));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
