const { Router } = require('express');
const imgGen = require('../image-generator');

const router = Router();

/**
 * POST /api/img-generator/process
 * Body: { group_jid, prompt, image_urls?: [], sender_name?, expert? }
 * Auth via Bearer BRIDGE_SECRET (usado pelo monitorgrupo webhook)
 */
router.post('/img-generator/process', async (req, res) => {
  // Autenticação por shared secret (não JWT — chamado server-to-server)
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== process.env.BRIDGE_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const result = await imgGen.processarSolicitacao(req.body || {});
    res.json(result);
  } catch (e) {
    console.error('[img-generator]', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
