require('dotenv').config();

const { createWhatsAppClient } = require('./src/whatsappBot');
const { cfg } = require('./src/config');

(async () => {
  console.log('🚀 Iniciando bot EvoluxRH com sistema de chat estilo Diamond');
  console.log('📦 Usando whatsapp-web.js');
  console.log('🤖 Modelo IA:', cfg.OPENAI_MODEL || 'gpt-4o-mini');
  
  // Tratamento de erros globais
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

  // Verifica configuração
  const missing = [];
  if (!cfg.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (!cfg.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!cfg.SUPABASE_KEY) missing.push('SUPABASE_KEY');

  if (missing.length > 0) {
    console.error('❌ ERRO: Variáveis de ambiente não configuradas:');
    missing.forEach(v => console.error(`   - ${v}`));
    console.error('');
    console.error('📖 Configure essas variáveis no arquivo .env');
    process.exit(1);
  }

  // Cria e inicializa cliente WhatsApp
  const client = createWhatsAppClient();

  console.log('[Init] Iniciando WhatsApp client...');
  console.log('[Init] Se já houver sessão salva, não será necessário escanear QR novamente.');
  
  // Verifica se há sessão salva
  const fs = require('fs');
  const path = require('path');
  const authPath = path.join(process.cwd(), '.wwebjs_auth');
  if (fs.existsSync(authPath)) {
    console.log('[Init] Sessão salva encontrada em .wwebjs_auth');
    console.log('[Init] Se houver problemas, delete essa pasta e reinicie.');
  }

  // Função para inicializar com retry
  async function initWithRetries(max = 5) {
    let attempt = 0;
    
    while (attempt < max) {
      try {
        console.log(`[Init] Tentativa ${attempt + 1}/${max} de inicialização...`);
        
        if (attempt > 0) {
          try {
            const { execSync } = require('child_process');
            const isWin = process.platform === 'win32';
            if (isWin) {
              execSync('taskkill /F /IM chrome.exe 2>nul || taskkill /F /IM chromium.exe 2>nul || exit 0', { timeout: 2000 });
            } else {
              execSync('pkill -f chrome 2>/dev/null || true', { timeout: 2000 });
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (cleanError) {}
        }
        
        console.log('[Init] Aguardando inicialização do Puppeteer...');
        
        await client.initialize();
        
        console.log('[Init] ✅ Cliente WhatsApp inicializado com sucesso!');
        return;
        
      } catch (e) {
        const msg = e?.message || String(e);
        console.error(`[Init] Falha na inicialização (tentativa ${attempt + 1}/${max}):`, msg);
        
        const isTimeoutError = /timeout/i.test(msg) || msg.includes('auth timeout');
        const isProtocolError = /Protocol error/i.test(msg) || msg.includes('Network.getResponseBody');
        
        if ((isTimeoutError || isProtocolError) && attempt < max - 1) {
          const waitTime = 5000 * (attempt + 1);
          console.log(`[Init] Aguardando ${waitTime / 1000}s antes de tentar novamente...`);
          
          try {
            await client.destroy().catch(() => {});
          } catch (destroyError) {}
          
          await new Promise((r) => setTimeout(r, waitTime));
          attempt++;
          continue;
        }
        
        if (attempt < max - 1) {
          const waitTime = 5000 * (attempt + 1);
          await new Promise((r) => setTimeout(r, waitTime));
          attempt++;
          continue;
        }
        
        throw e;
      }
    }
  }

  try {
    await initWithRetries(5);
    console.log('[Init] ✅ Inicialização concluída com sucesso!');
  } catch (e) {
    console.error('[Init] ❌ Falha ao inicializar o WhatsApp client após múltiplas tentativas:', e?.message || e);
    console.error('[Init] ⚠️  DIAGNÓSTICO:');
    console.error('[Init] 1. Verifique se o servidor tem conexão com internet');
    console.error('[Init] 2. Se o problema persistir, tente deletar .wwebjs_auth e reiniciar');
    console.error('[Init] 3. Execute: pm2 restart evoluxrh-diamond-bot');
    
    setTimeout(async () => {
      try {
        console.log('[Init] 🔄 Tentativa final de inicialização...');
        
        try {
          const { execSync } = require('child_process');
          const isWin = process.platform === 'win32';
          if (isWin) {
            execSync('taskkill /F /IM chrome.exe 2>nul || taskkill /F /IM chromium.exe 2>nul || exit 0', { timeout: 2000 });
          } else {
            execSync('pkill -f chrome 2>/dev/null || true', { timeout: 2000 });
          }
        } catch {}
        
        await client.destroy().catch(() => {});
        await new Promise(r => setTimeout(r, 10000));
        
        await client.initialize();
        console.log('[Init] ✅ Tentativa final bem-sucedida!');
      } catch (err) {
        const errMsg = err?.message || String(err || '');
        console.error('[Init] ❌ Falha na tentativa final:', errMsg);
        console.error('[Init] 💡 SOLUÇÃO RECOMENDADA:');
        console.error('[Init]    1. Pare o bot: pm2 stop evoluxrh-diamond-bot');
        console.error('[Init]    2. Limpe a sessão: rd /s /q .wwebjs_auth (Windows) ou rm -rf .wwebjs_auth (Linux)');
        console.error('[Init]    3. Limpe processos: taskkill /F /IM chrome.exe (Windows) ou pkill -f chrome (Linux)');
        console.error('[Init]    4. Reinicie: pm2 start evoluxrh-diamond-bot');
        console.error('[Init]    Isso gerará um novo QR code para escanear.');
      }
    }, 30000);
  }
})();
