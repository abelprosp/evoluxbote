/**
 * Rota de webhook para a Evolution API (Vercel Serverless).
 * Configure na Evolution API a URL: https://seu-dominio.vercel.app/api/webhook
 * Eventos recomendados: MESSAGES_UPSERT
 */
if (process.env.NODE_ENV !== 'production') {
  try {
    require('dotenv').config();
  } catch (_) {}
}

const { processWebhookBody } = require('../src/webhookMessageHandler');

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({
      ok: true,
      service: 'EvoluxRH Bot',
      mode: 'evolution-webhook',
      message: 'POST body (JSON) from Evolution API MESSAGES_UPSERT to process messages.',
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body;
  try {
    body = typeof req.body === 'object' && req.body !== null ? req.body : JSON.parse(req.body || '{}');
  } catch (_) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  try {
    const result = await processWebhookBody(body);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ ok: true, processed: result.processed, instance: result.instance });
  } catch (err) {
    console.error('[API Webhook] Erro:', err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || 'Internal error' });
  }
};
