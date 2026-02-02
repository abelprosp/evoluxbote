require('dotenv').config();

const { createWhatsAppClient } = require('./src/whatsappBot');
const { cfg } = require('./src/config');

(async () => {
  console.log('🚀 Iniciando bot EvoluxRH com sistema de chat estilo Diamond');
  console.log('📦 Usando Baileys (conexão direta, sem browser)');
  console.log('🤖 Modelo IA:', cfg.OPENAI_MODEL || 'gpt-4o-mini');

  process.on('uncaughtException', (err) => {
    const errMsg = err?.message || String(err || '');
    const errStack = err?.stack || '';
    const isExpectedError =
      /Target closed|Protocol error|Session closed|Execution context was destroyed|No data found for resource/i.test(errMsg) ||
      errMsg.includes('Network.getResponseBody') ||
      errStack.includes('Network.getResponseBody') ||
      errStack.includes('Protocol error');
    if (!isExpectedError) {
      console.error('[UncaughtException] Erro não tratado:', errMsg);
      console.error('[UncaughtException] Stack:', errStack.substring(0, 500));
    }
  });

  process.on('unhandledRejection', (reason) => {
    const errMsg = reason?.message || String(reason || '');
    const errStack = reason?.stack || String(reason || '');
    const errorName = reason?.constructor?.name || '';
    const isExpectedError =
      /Target closed|Protocol error|Session closed|Execution context was destroyed|No data found for resource/i.test(errMsg) ||
      errMsg.includes('Network.getResponseBody') ||
      errMsg.includes('Protocol error') ||
      errStack.includes('Network.getResponseBody') ||
      errStack.includes('Protocol error') ||
      errStack.includes('ProtocolError') ||
      errorName === 'ProtocolError' ||
      errMsg.includes('ERR_NETWORK_CHANGED') ||
      errMsg.includes('ERR_INTERNET_DISCONNECTED');
    if (!isExpectedError) {
      console.error('[UnhandledRejection] Erro não tratado:', errMsg);
      if (errStack && !errStack.includes('Network.getResponseBody') && !errStack.includes('Protocol error')) {
        console.error('[UnhandledRejection] Stack:', errStack.substring(0, 500));
      }
    }
  });

  const missing = [];
  if (!cfg.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (!cfg.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!cfg.SUPABASE_KEY) missing.push('SUPABASE_KEY');
  if (missing.length > 0) {
    console.error('❌ ERRO: Variáveis de ambiente não configuradas:');
    missing.forEach((v) => console.error('   -', v));
    console.error('\n📖 Configure essas variáveis no arquivo .env');
    process.exit(1);
  }

  const fs = require('fs');
  const path = require('path');
  const authPath = path.join(process.cwd(), 'auth_info_baileys');
  if (fs.existsSync(authPath)) {
    console.log('[Init] Sessão salva encontrada em ./auth_info_baileys');
    console.log('[Init] Se precisar escanear de novo, execute limpar-sessao.bat (ou .sh) e reinicie.\n');
  } else {
    console.log('[Init] Primeira execução: escaneie o QR Code que aparecerá em seguida.\n');
  }

  try {
    const client = await createWhatsAppClient();
    console.log('[Init] ✅ Bot EvoluxRH (Baileys) em execução.');
  } catch (e) {
    console.error('[Init] ❌ Falha ao iniciar o bot:', e?.message || e);
    console.error('[Init] 💡 Se precisar de novo QR: execute limpar-sessao.bat (ou .sh), reinicie e escaneie o QR.');
    process.exit(1);
  }
})();
