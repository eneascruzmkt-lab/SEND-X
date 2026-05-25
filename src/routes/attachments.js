const { Router } = require('express');
const multer = require('multer');
const crypto = require('crypto');
const db = require('../db');

const router = Router();         // rotas protegidas por JWT (montadas após router.use(auth))
const publicRouter = Router();   // rota pública assinada — usada pelo bridge pra baixar vídeo/áudio

// ── Assinatura HMAC para download público ──────────────────────────────────
/**
 * HMAC-assina o id de um attachment para que o bridge (sem JWT) consiga baixar.
 * Token: `${expires}.${hex(HMAC-SHA256(BRIDGE_SECRET, `${id}.${expires}`))}`
 * Validade default: 24h — suficiente pra processamento dentro de uma sessão de chat.
 */
function signAttachmentId(id, ttlMs = 24 * 60 * 60 * 1000) {
  const secret = process.env.BRIDGE_SECRET || '';
  const expires = Date.now() + ttlMs;
  const sig = crypto.createHmac('sha256', secret).update(`${id}.${expires}`).digest('hex');
  return `${expires}.${sig}`;
}

function verifyAttachmentToken(id, token) {
  if (!token || typeof token !== 'string') return false;
  const [expiresStr, sig] = token.split('.');
  const expires = Number(expiresStr);
  if (!expires || Date.now() > expires) return false;
  const secret = process.env.BRIDGE_SECRET || '';
  if (!secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${id}.${expires}`).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex')); }
  catch { return false; }
}

// ── Upload settings ────────────────────────────────────────────────────────
// Memória, max 150MB por arquivo (necessário pra vídeos curtos do Telegram/celular)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 },
});

const SUPPORTED_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf',
  'text/plain', 'text/csv', 'text/markdown',
  'application/json',
  'text/html',
  // vídeos — armazenados como BLOB e expostos via /api/attachments/dl/:id pro bridge baixar
  'video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/x-msvideo',
  // áudios — útil pra mensagens de voz / transcrição
  'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm',
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
        // vídeo
        mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
        mkv: 'video/x-matroska', avi: 'video/x-msvideo',
        // áudio
        mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav',
      };
      if (extMap[ext]) detectedMime = extMap[ext];
    }
    if (!SUPPORTED_MIMES.has(detectedMime)) {
      return res.status(400).json({ error: `Tipo não suportado: ${mimetype}. Aceita: imagens, vídeos (mp4/mov/webm), áudios, PDF, txt, csv, json, md, html` });
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

/** GET /api/attachments/:id — serve o BLOB com content-type correto (JWT do user) */
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

// ── Rota PÚBLICA (assinada) — usada pelo bridge pra baixar vídeo/áudio ─────
/**
 * GET /api/attachments/dl/:id?token=<sig>
 * Não requer JWT. Token HMAC com BRIDGE_SECRET, expira em 24h.
 * Acceita Range requests pra streaming de vídeo grande.
 */
publicRouter.get('/attachments/dl/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const token = req.query.token || req.header('x-attachment-token');
    if (!verifyAttachmentToken(id, token)) return res.status(401).send('invalid or expired token');

    const att = await db.getAttachment(id);
    if (!att) return res.status(404).send('not found');

    res.setHeader('Content-Type', att.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${att.filename.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Accept-Ranges', 'bytes');

    // Range support (vídeo grande precisa)
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : att.data.length - 1;
        if (start >= att.data.length || end >= att.data.length) {
          res.status(416).setHeader('Content-Range', `bytes */${att.data.length}`);
          return res.end();
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${att.data.length}`);
        res.setHeader('Content-Length', end - start + 1);
        return res.end(att.data.slice(start, end + 1));
      }
    }
    res.setHeader('Content-Length', att.data.length);
    res.send(att.data);
  } catch (err) {
    console.error('[attachments/dl] err:', err.message);
    res.status(500).send('error');
  }
});

module.exports = router;
module.exports.publicRouter = publicRouter;
module.exports.signAttachmentId = signAttachmentId;
module.exports.verifyAttachmentToken = verifyAttachmentToken;
