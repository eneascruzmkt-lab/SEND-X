const { Router } = require('express');
const db = require('../db');

const router = Router();

/**
 * GET /api/quiz/stats?periodo=24h|7d|30d|all&campaign=quiz-juh
 *
 * Funil completo do quiz cruzando quiz_visits + quiz_events + apostatudo_events.
 * Returns:
 *  - visits, started, p1..p5_answered, finished, cta_clicked
 *  - na Apostatudo: registered, ftd_detected (atribuídos via utm_source/quiz_sid)
 *  - taxas de conversão entre etapas
 */
router.get('/quiz/stats', async (req, res) => {
  try {
    const periodo = req.query.periodo || '7d';
    const campaign = req.query.campaign || 'quiz-juh';
    let from;
    const now = new Date();
    if (periodo === '24h') from = new Date(now - 24 * 3600 * 1000);
    else if (periodo === '7d') from = new Date(now - 7 * 86400 * 1000);
    else if (periodo === '30d') from = new Date(now - 30 * 86400 * 1000);
    else from = new Date('2026-01-01');
    const fromIso = from.toISOString();

    // ─── Visitas + progresso ──────────────────────────────────────
    const visitsRow = await db.query(
      `SELECT COUNT(*) AS visits,
              COUNT(*) FILTER (WHERE finished_at IS NOT NULL) AS finished,
              COUNT(*) FILTER (WHERE cta_clicked = true) AS cta_clicked,
              AVG(score) FILTER (WHERE score IS NOT NULL)::numeric(4,2) AS score_medio
       FROM quiz_visits WHERE started_at >= $1`,
      [fromIso]
    );

    // ─── Drop-off por pergunta ────────────────────────────────────
    const dropOff = await db.query(
      `SELECT last_question, COUNT(*) AS qtd
       FROM quiz_visits WHERE started_at >= $1
       GROUP BY last_question ORDER BY last_question`,
      [fromIso]
    );

    // ─── Respostas erradas/certas por pergunta ────────────────────
    const respByQ = await db.query(
      `SELECT question_idx, option_wrong, COUNT(*) AS qtd
       FROM quiz_events
       WHERE event_type='question_answered' AND created_at >= $1
       GROUP BY question_idx, option_wrong ORDER BY question_idx`,
      [fromIso]
    );

    // ─── Atribuição Apostatudo (cadastros + FTDs vindo do quiz) ───
    const apoRegistered = await db.query(
      `SELECT COUNT(*) AS n FROM apostatudo_events
       WHERE event_type='register.success' AND received_at >= $1
         AND (raw_payload->'data'->>'utm_source' = $2
              OR raw_payload->'data'->>'utm_campaign' = 'aviator-5-erros'
              OR raw_payload->'data'->>'aff_link' LIKE '%5b4a7q58%')`,
      [fromIso, campaign]
    );
    const apoFtds = await db.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS total_cents
       FROM apostatudo_events
       WHERE event_type='ftd.detected' AND received_at >= $1
         AND (raw_payload->'data'->>'utm_source' = $2
              OR raw_payload->'data'->>'utm_campaign' = 'aviator-5-erros'
              OR raw_payload->'data'->>'aff_link' LIKE '%5b4a7q58%')`,
      [fromIso, campaign]
    );

    const visits = Number(visitsRow[0]?.visits || 0);
    const finished = Number(visitsRow[0]?.finished || 0);
    const ctaClicked = Number(visitsRow[0]?.cta_clicked || 0);
    const registered = Number(apoRegistered[0]?.n || 0);
    const ftds = Number(apoFtds[0]?.n || 0);
    const ftdVolumeCents = Number(apoFtds[0]?.total_cents || 0);

    const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

    res.json({
      periodo, campaign, from: fromIso,
      funil: [
        { etapa: 'Visitas', valor: visits, taxa_pct: 100 },
        { etapa: 'Terminou quiz', valor: finished, taxa_pct: pct(finished, visits) },
        { etapa: 'Clicou CTA app', valor: ctaClicked, taxa_pct: pct(ctaClicked, visits) },
        { etapa: 'Cadastrou na casa', valor: registered, taxa_pct: pct(registered, visits) },
        { etapa: 'Fez primeiro depósito', valor: ftds, taxa_pct: pct(ftds, visits) },
      ],
      conversoes: {
        visit_to_finish_pct: pct(finished, visits),
        finish_to_cta_pct: pct(ctaClicked, finished),
        cta_to_register_pct: pct(registered, ctaClicked),
        register_to_ftd_pct: pct(ftds, registered),
      },
      ftd: {
        quantidade: ftds,
        volume_brl: (ftdVolumeCents / 100).toFixed(2),
        ticket_medio_brl: ftds ? (ftdVolumeCents / ftds / 100).toFixed(2) : '0',
      },
      score_medio: visitsRow[0]?.score_medio,
      drop_off_por_pergunta: dropOff.map(r => ({
        ate_pergunta: Number(r.last_question),
        pessoas: Number(r.qtd),
      })),
      respostas_por_pergunta: respByQ.map(r => ({
        question_idx: Number(r.question_idx),
        erradas: r.option_wrong ? Number(r.qtd) : 0,
        certas: !r.option_wrong ? Number(r.qtd) : 0,
      })),
    });
  } catch (err) {
    console.error('[quiz/stats]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
