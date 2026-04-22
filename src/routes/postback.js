const { Router } = require('express');
const db = require('../db');
const router = Router();

/**
 * GET /api/postback/:key/:tab/:event — Recebe postback S2S da Apostatudo.
 *
 * key, tab e event vão no path (Apostatudo substitui query params com os atributos concatenados).
 *
 * Path params:
 *   :key   — api_key do usuário SEND-X
 *   :tab   — aba da planilha (ex: DANI, DEIVID)
 *   :event — tipo do evento: lead | ftd
 *
 * Query params (variáveis do postback Apostatudo, concatenadas automaticamente):
 *   deal_id, customer_id, registration_id, utm_source, utm_medium,
 *   payout, payout_currency, campaign_id, campaign_name,
 *   link_id, link_name, afp
 */
router.get('/postback/:key/:tab/:event', async (req, res) => {
  try {
    const { key, tab, event } = req.params;

    const validEvents = ['lead', 'ftd'];
    if (!validEvents.includes(event)) {
      return res.status(400).json({ error: `event invalido. Use: ${validEvents.join(', ')}` });
    }

    // Autentica via api_key
    const userId = await db.getUserByApiKey(key);
    if (!userId) {
      return res.status(401).json({ error: 'api_key invalida' });
    }

    // Salva o postback
    const postback = await db.insertPostback({
      user_id: userId,
      tab,
      event,
      deal_id: req.query.deal_id,
      customer_id: req.query.customer_id,
      registration_id: req.query.registration_id,
      utm_source: req.query.utm_source,
      utm_medium: req.query.utm_medium,
      payout: req.query.payout,
      payout_currency: req.query.payout_currency,
      campaign_id: req.query.campaign_id,
      campaign_name: req.query.campaign_name,
      link_id: req.query.link_id,
      link_name: req.query.link_name,
      afp: req.query.afp,
      raw_query: JSON.stringify(req.query),
    });

    console.log(`[Postback] ${event} recebido para tab=${tab} user=${userId} utm_source=${req.query.utm_source || '-'}`);
    res.json({ ok: true, id: postback.id });
  } catch (err) {
    console.error('[Postback] Error:', err.message);
    res.status(500).json({ error: 'Erro ao processar postback' });
  }
});

module.exports = router;
