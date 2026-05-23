const { Router } = require('express');
const crypto = require('crypto');
const db = require('../db');
const { resolveExpertFromLead } = require('../apostatudo-tools');

const router = Router();

/**
 * POST /api/apostatudo-webhook
 * Recebe eventos da Apostatudo:
 *   - register.success
 *   - ftd.detected
 *   - login.success
 *
 * Headers:
 *   X-Webhook-Signature: sha256=<hmac>
 *   X-Webhook-Event: <event_type>
 *   X-Webhook-Delivery: <id>
 */
router.post('/apostatudo-webhook', async (req, res) => {
  try {
    const secret = process.env.APO_WEBHOOK_SECRET;
    const sig = req.headers['x-webhook-signature'] || '';
    const delivery = req.headers['x-webhook-delivery'] || '';
    const eventHeader = req.headers['x-webhook-event'] || '';

    // Express já parseou body como JSON. Pra validar HMAC, re-serializa idêntico.
    // (Apostatudo assina JSON.stringify do payload.)
    const bodyStr = JSON.stringify(req.body);
    if (secret) {
      const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');
      if (sig !== expected) {
        console.warn('[apo-webhook] HMAC inválido, ignorando');
        return res.status(401).json({ error: 'bad signature' });
      }
    }

    const payload = req.body || {};
    const event_type = payload.event || eventHeader;
    const data = payload.data || {};

    // Mapeia evento → expert via lead.recommended_by ou aff_link
    let expert = null;
    try {
      expert = await resolveExpertFromLead(1, {
        recommended_by: data.affiliation_code || data.recommended_by,
        reg_aff_link: data.aff_link,
      });
    } catch { /* ignora */ }

    await db.insertApostatudoEvent(1, {
      event_type,
      apostatudo_user_id: data.user_id || null,
      expert,
      affiliate_id: data.affiliation_code || data.recommended_by || null,
      aff_link: data.aff_link || null,
      utm_source: data.utm_source || null,
      amount_cents: data.amount_cents || null,
      raw_payload: payload,
      delivery_id: delivery || `auto-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    });

    console.log(`[apo-webhook] ${event_type} apo_user=${data.user_id} expert=${expert || '?'} delivery=${delivery}`);
    res.json({ ok: true, event_id: delivery });
  } catch (e) {
    console.error('[apo-webhook]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
