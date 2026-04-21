/**
 * Cron da Vercel: GET/POST executados pelo agendamento definido em vercel.json.
 * Proteção: header Authorization: Bearer <CRON_SECRET> (defina CRON_SECRET nas env da Vercel).
 *
 * Variáveis necessárias (mesmas do webhook): EVOLUTION_*, SUPABASE_*, OPENAI_* (extração IA).
 */
const { runDailyResumeInboxSync } = require('../../src/jobs/dailyResumeInboxSync');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';

  if (!secret || bearer !== secret) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const result = await runDailyResumeInboxSync();
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[Cron daily-resume-sync]', err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || 'Internal error' });
  }
};
