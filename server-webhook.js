/**
 * Servidor local para receber webhooks da Evolution API.
 * Use quando quiser rodar o bot só via Evolution API (sem Baileys e sem Vercel).
 *
 * 1. Configure .env: EVOLUTION_API_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE
 * 2. Rode: node server-webhook.js
 * 3. Exponha a URL (ex.: ngrok http 3333) e configure na Evolution API como webhook
 * 4. Na Evolution, ative webhookBase64: true para receber imagens/documentos em base64
 */
require('dotenv').config();

const http = require('http');
const { processWebhookBody } = require('./src/webhookMessageHandler');
const { cfg } = require('./src/config');

const PORT = parseInt(process.env.PORT || '3333', 10);

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const isWebhook = url === '/api/webhook' || url === '/webhook' || url === '/';

  if (req.method === 'GET' && isWebhook) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'EvoluxRH Bot',
        mode: 'evolution-webhook',
        message: 'POST body (JSON) from Evolution API MESSAGES_UPSERT to process messages.',
      })
    );
    return;
  }

  if (req.method !== 'POST' || !isWebhook) {
    res.writeHead(405, { Allow: 'GET, POST' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  try {
    const result = await processWebhookBody(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, processed: result.processed, instance: result.instance }));
  } catch (err) {
    console.error('[Webhook] Erro:', err?.message || err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err?.message || 'Internal error' }));
  }
});

function checkConfig() {
  const missing = [];
  if (!cfg.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (!cfg.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!cfg.SUPABASE_KEY) missing.push('SUPABASE_KEY');
  if (!cfg.EVOLUTION_API_URL) missing.push('EVOLUTION_API_URL');
  if (!cfg.EVOLUTION_API_KEY) missing.push('EVOLUTION_API_KEY');
  if (!cfg.EVOLUTION_INSTANCE) missing.push('EVOLUTION_INSTANCE');
  return missing;
}

const missing = checkConfig();
if (missing.length > 0) {
  console.error('❌ Variáveis de ambiente faltando:', missing.join(', '));
  console.error('   Configure no .env e rode novamente.');
  process.exit(1);
}

server.listen(PORT, () => {
  console.log('🚀 EvoluxRH Bot – modo Evolution API (webhook)');
  console.log(`   Webhook: http://localhost:${PORT}/api/webhook (ou /webhook ou /)`);
  console.log('   Configure essa URL na Evolution API (use ngrok se for local).');
  console.log('   Ative webhookBase64: true para currículos em imagem/PDF.');
});
