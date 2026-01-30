const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { obterContexto, gerarResposta, analisarImagem, conversas, adicionarMensagemAoHistorico } = require('./chatServiceDiamond');
const { saveWhatsappApplication } = require('./services/applicationsService');
const { cfg } = require('./config');
const fs = require('fs');
const path = require('path');

// Controle de timing entre mensagens por chat
const lastMessageTime = new Map();
const processingMessages = new Map();

/**
 * Calcula delay baseado no tamanho da resposta (simula tempo de digitação)
 */
function calcularDelayResposta(textoResposta) {
  const minDelay = cfg.RESPONSE_DELAY_MIN_MS || 2000;
  const maxDelay = cfg.RESPONSE_DELAY_MAX_MS || 5000;
  const delayPerChar = cfg.RESPONSE_DELAY_PER_CHAR_MS || 50;
  
  // Delay baseado no tamanho do texto (simula tempo de digitação)
  const delayCalculado = minDelay + (textoResposta.length * delayPerChar);
  
  // Limita ao máximo configurado
  return Math.min(delayCalculado, maxDelay);
}

/**
 * Aguarda delay mínimo entre mensagens do mesmo chat
 */
async function aguardarDelayEntreMensagens(chatId) {
  const minDelay = cfg.MIN_DELAY_BETWEEN_MESSAGES_MS || 3000;
  const lastTime = lastMessageTime.get(chatId) || 0;
  const now = Date.now();
  const timeSinceLastMessage = now - lastTime;
  
  if (timeSinceLastMessage < minDelay) {
    const waitTime = minDelay - timeSinceLastMessage;
    console.log(`[WhatsApp] ⏳ Aguardando ${waitTime}ms antes de processar mensagem de ${chatId} (delay mínimo entre mensagens)`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  
  lastMessageTime.set(chatId, Date.now());
}

// Função helper para enviar mensagem ignorando erro de markedUnread (estilo Diamond)
async function enviarMensagemSegura(client, chatId, texto, salvarNoHistorico = true) {
  return new Promise(async (resolve, reject) => {
    try {
      console.log(`[WhatsApp] 📤 Tentando enviar mensagem para ${chatId} (${texto.length} chars)`);
      const promiseEnvio = client.sendMessage(chatId, texto);
      
      const timeout = setTimeout(() => {
        console.warn(`⚠️  Timeout ao enviar mensagem para ${chatId}, assumindo que foi enviada`);
        if (salvarNoHistorico) {
          adicionarMensagemAoHistorico(chatId, 'assistant', texto);
        }
        resolve({ 
          id: { _serialized: `temp_${Date.now()}` },
          _nota: 'Mensagem enviada (timeout)',
          _enviado: true
        });
      }, 10000);
      
      try {
        const resultado = await promiseEnvio;
        clearTimeout(timeout);
        console.log(`[WhatsApp] ✅ Mensagem enviada com sucesso para ${chatId}`);
        
        // Salva mensagem enviada no histórico
        if (salvarNoHistorico) {
          adicionarMensagemAoHistorico(chatId, 'assistant', texto);
        }
        
        resolve(resultado);
      } catch (error) {
        clearTimeout(timeout);
        const errorMsg = error.message || String(error);
        const errorStack = error.stack || '';
        
        if (errorMsg.includes('markedUnread') || 
            errorMsg.includes('Cannot read properties') ||
            errorStack.includes('sendSeen')) {
          
          console.warn(`⚠️  Erro markedUnread para ${chatId}: ${errorMsg.substring(0, 100)}`);
          console.warn(`   Assumindo que mensagem foi enviada (erro ocorre no sendSeen)`);
          
          // Salva mensagem enviada no histórico mesmo com erro
          if (salvarNoHistorico) {
            adicionarMensagemAoHistorico(chatId, 'assistant', texto);
          }
          
          resolve({ 
            id: { _serialized: `temp_${Date.now()}` },
            _nota: 'Mensagem enviada (erro markedUnread ignorado)',
            _enviado: true
          });
        } else {
          console.error(`[WhatsApp] ❌ Erro ao enviar mensagem para ${chatId}:`, errorMsg);
          reject(error);
        }
      }
    } catch (error) {
      console.error(`[WhatsApp] ❌ Erro geral ao enviar mensagem para ${chatId}:`, error?.message);
      reject(error);
    }
  });
}

function createWhatsAppClient() {
  console.log('[WhatsApp] Criando cliente WhatsApp...');
  const client = new Client({
    authStrategy: new LocalAuth({
      dataPath: './.wwebjs_auth'
    }),
    restartOnAuthFail: true,
    authTimeoutMs: 180000,
    markOnlineOnConnect: false,
    puppeteer: {
      headless: true,
      dumpio: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ],
      timeout: 60000,
      ignoreHTTPSErrors: true,
    },
  });

  // Memória de fluxo de candidatura
  const applicationSessions = new Map();
  const processedMessageIds = new Map();
  const PROCESSED_TTL_MS = 5 * 60 * 1000;
  
  // Controle de pausa por chat (quando #assumir é usado)
  const pausedChats = new Set();

  function getMessageId(msg) {
    if (!msg || !msg.id) return null;
    const id = msg.id._serialized || msg.id.serialized || (typeof msg.id === 'string' ? msg.id : null);
    return id || (msg.from && msg.timestamp ? `fallback_${msg.from}_${msg.timestamp}` : null);
  }

  function wasProcessed(msg) {
    const id = getMessageId(msg);
    if (!id) return false;
    const ts = processedMessageIds.get(id);
    if (!ts) return false;
    if (Date.now() - ts > PROCESSED_TTL_MS) {
      processedMessageIds.delete(id);
      return false;
    }
    return true;
  }

  function markProcessed(msg) {
    const id = getMessageId(msg);
    if (id) processedMessageIds.set(id, Date.now());
    if (processedMessageIds.size > 500) {
      const cutoff = Date.now() - PROCESSED_TTL_MS;
      for (const [k, t] of processedMessageIds.entries()) {
        if (t < cutoff) processedMessageIds.delete(k);
      }
    }
  }

  // Gerar QR Code
  client.on('qr', (qr) => {
    console.log('\n📱 Escaneie o QR Code abaixo com o WhatsApp:\n');
    qrcode.generate(qr, { small: true });
  });

  // Cliente pronto - aplicar patch para desabilitar sendSeen
  client.on('ready', async () => {
    console.log('\n✅ Cliente WhatsApp conectado e pronto!\n');
    
    try {
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      const page = client.pupPage;
      if (page) {
        let patchAplicado = false;
        for (let i = 0; i < 10; i++) {
          try {
            const resultado = await page.evaluate(() => {
              try {
                if (window.WWebJS) {
                  if (window.WWebJS.sendSeen) {
                    window.WWebJS.sendSeen = async function() {
                      return Promise.resolve();
                    };
                  }
                  if (window.Store && window.Store.Msg && window.Store.Msg.sendSeen) {
                    window.Store.Msg.sendSeen = async function() {
                      return Promise.resolve();
                    };
                  }
                  return true;
                }
                return false;
              } catch (e) {
                return false;
              }
            });
            
            if (resultado) {
              patchAplicado = true;
              break;
            }
          } catch (e) {
            // Continuar tentando
          }
          
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        if (patchAplicado) {
          console.log('✅ Patch aplicado: sendSeen desabilitado para evitar erro markedUnread');
        } else {
          console.warn('⚠️  Não foi possível aplicar patch sendSeen completamente');
        }
      }
    } catch (error) {
      console.warn('⚠️  Erro ao aplicar patch sendSeen:', error.message);
    }
  });

  client.on('authenticated', () => {
    console.log('✅ Autenticação realizada com sucesso!');
  });

  client.on('auth_failure', (msg) => {
    console.error('❌ Falha na autenticação:', msg);
    console.error('💡 Tente deletar a pasta .wwebjs_auth e escanear o QR Code novamente');
  });

  client.on('disconnected', (reason) => {
    console.log('⚠️  Cliente desconectado:', reason);
    console.log('🔄 Tentando reconectar...');
  });

  client.on('change_state', (state) => {
    console.log('📡 Estado do cliente:', state);
  });

  // Processar mensagens recebidas (estilo Diamond)
  async function handleIncomingMessage(msg) {
    try {
      const chatId = msg.from;

      if (wasProcessed(msg)) {
        return;
      }

      if (!msg || !chatId) {
        return;
      }

      if (msg.fromMe) {
        return;
      }

      // Verifica se é grupo
      let isGroup = false;
      try {
        if (typeof msg.isGroupMsg === 'boolean') {
          isGroup = msg.isGroupMsg;
        } else {
          // Fallback: verifica pelo JID
          isGroup = typeof msg.from === 'string' && msg.from.endsWith('@g.us');
        }
      } catch (e) {
        // Se der erro, assume que não é grupo
      }
      if (isGroup) {
        return;
      }

      const agora = Date.now();
      const ts = msg.timestamp ? msg.timestamp * 1000 : agora;
      if (agora - ts > 5 * 60 * 1000) {
        return;
      }

      let hasBody = false;
      try {
        hasBody = !!(msg.body && String(msg.body).trim());
      } catch (e) {
        hasBody = false;
      }
      const hasMedia = !!(msg.hasMedia || msg.type === 'document' || msg.type === 'image');
      if (!hasBody && !hasMedia) {
        return;
      }

      const rawText = String(msg.body || '').trim();
      const textNorm = rawText.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
      
      console.log(`[WhatsApp] 📨 Mensagem recebida de ${chatId}: "${rawText.substring(0, 80)}"`);

      // Verifica comandos de controle do bot (antes de qualquer processamento)
      if (textNorm === '#assumir') {
        pausedChats.add(chatId);
        markProcessed(msg);
        console.log(`[WhatsApp] ⏸️  Bot pausado para ${chatId} (conversa assumida manualmente)`);
        try {
          const resposta = '✅ Bot pausado. A conversa foi assumida manualmente.\n\n' +
            'Para reativar o bot, envie: #pausa';
          const delay = calcularDelayResposta(resposta);
          await new Promise(resolve => setTimeout(resolve, delay));
          await enviarMensagemSegura(client, chatId, resposta);
        } catch (error) {
          console.error(`[WhatsApp] ❌ Erro ao enviar confirmação de pausa:`, error?.message);
        }
        return;
      }

      if (textNorm === '#pausa') {
        pausedChats.delete(chatId);
        markProcessed(msg);
        console.log(`[WhatsApp] ▶️  Bot reativado para ${chatId}`);
        try {
          const resposta = '✅ Bot reativado! Voltando a responder automaticamente.';
          const delay = calcularDelayResposta(resposta);
          await new Promise(resolve => setTimeout(resolve, delay));
          await enviarMensagemSegura(client, chatId, resposta);
        } catch (error) {
          console.error(`[WhatsApp] ❌ Erro ao enviar confirmação de reativação:`, error?.message);
        }
        return;
      }

      // Se o chat está pausado, não processa mensagens (exceto os comandos acima)
      if (pausedChats.has(chatId)) {
        console.log(`[WhatsApp] ⏸️  Mensagem de ${chatId} ignorada (bot pausado para este chat)`);
        markProcessed(msg);
        return;
      }

      // Verifica se já está processando uma mensagem deste chat
      if (processingMessages.has(chatId)) {
        console.log(`[WhatsApp] ⏳ Mensagem de ${chatId} aguardando (já há uma mensagem sendo processada)`);
        // Aguarda um pouco e tenta novamente (será processada na próxima iteração)
        return;
      }

      // Marca como processando
      processingMessages.set(chatId, true);

      // Marca mensagem como processada
      markProcessed(msg);

      // Aguarda delay mínimo entre mensagens
      await aguardarDelayEntreMensagens(chatId);

      // Verifica se há sessão de candidatura ativa
      const hasSession = applicationSessions.has(chatId);
      
      if (hasSession) {
        const handled = await handleApplicationStep(chatId, msg, rawText, textNorm);
        if (handled) return;
      }

      // Detecta se quer iniciar candidatura
      const isApplicationTrigger = [
        'quero me candidatar', 'gostaria de me candidatar', 'fazer minha candidatura',
        'enviar meu curriculo', 'enviar currículo', 'quero trabalhar', 'quero uma vaga'
      ].some(k => textNorm.includes(k));

      if (isApplicationTrigger && !hasSession) {
        console.log(`[WhatsApp] 🎯 Iniciando fluxo de candidatura para ${chatId}`);
        await startApplicationFlow(chatId);
        console.log(`[WhatsApp] ✅ Mensagem de candidatura enviada para ${chatId}`);
        return;
      }

      // Detecta se enviou currículo sem estar no fluxo
      const isResumeMedia = msg.type === 'document' || msg.type === 'image';
      if (isResumeMedia && !hasSession) {
        const resposta = 'Olá! Sou a *Iza da EvoluxRH* 😊\n\n' +
          'Vi que você enviou um arquivo! 📄\n\n' +
          'Para registrar sua candidatura, me diga "quero me candidatar" e eu te guio passo a passo!';
        const delay = calcularDelayResposta(resposta);
        await new Promise(resolve => setTimeout(resolve, delay));
        await enviarMensagemSegura(client, chatId, resposta);
        return;
      }

      // Processa mídia (imagem/documento)
      let descricaoImagem = null;
      if (msg.hasMedia && (msg.type === 'image' || msg.type === 'document')) {
        try {
          const media = await msg.downloadMedia();
          if (media) {
            const mediaBuffer = Buffer.from(media.data, 'base64');
            if (msg.type === 'image') {
              descricaoImagem = await analisarImagem(mediaBuffer, rawText);
            }
            // Se for documento (currículo), salva na sessão se houver
            if (msg.type === 'document' && hasSession) {
              const session = applicationSessions.get(chatId);
              session.resume = {
                buffer: mediaBuffer,
                filename: msg.body || 'curriculo.pdf',
                mimetype: media.mimetype || 'application/pdf',
                base64: media.data
              };
            }
          }
        } catch (error) {
          console.error('[WhatsApp] Erro ao processar mídia:', error?.message);
        }
      }

      // Obtém contexto da conversa
      let nomeContato = 'Candidato';
      try {
        const contato = await msg.getContact();
        nomeContato = contato.pushname || contato.number || chatId;
      } catch (e) {
        nomeContato = chatId;
      }

      // Verifica se é a primeira mensagem (contexto novo)
      const isFirstMessage = !conversas.has(chatId);
      const contexto = obterContexto(chatId, nomeContato, chatId);
      
      // Se for a primeira mensagem, envia saudação inicial
      if (isFirstMessage) {
        console.log(`[WhatsApp] 👋 Primeira mensagem de ${chatId}, enviando saudação...`);
        try {
          const resposta = 'Olá! Sou a Iza da EvoluxRH! 😊\n\n' +
            'Como posso ajudar hoje? Há vagas disponíveis no site evoluxrh.com.br. Se quiser se candidatar, posso te orientar.';
          const delay = calcularDelayResposta(resposta);
          await new Promise(resolve => setTimeout(resolve, delay));
          await enviarMensagemSegura(client, chatId, resposta);
          console.log(`[WhatsApp] ✅ Saudação enviada para ${chatId}`);
        } catch (error) {
          console.error(`[WhatsApp] ❌ Erro ao enviar saudação:`, error?.message);
        }
      }
      
      // Salva mensagem do usuário no histórico ANTES de gerar resposta
      // Isso garante que a IA tenha contexto completo incluindo a mensagem atual
      adicionarMensagemAoHistorico(chatId, 'user', rawText);
      
      // Gera resposta com IA (estilo Diamond)
      console.log(`[WhatsApp] 🤖 Gerando resposta com IA para ${chatId}...`);
      console.log(`[WhatsApp] 📚 Contexto completo da conversa será considerado na resposta`);
      try {
        const resposta = await gerarResposta(contexto, rawText, descricaoImagem);
        
        if (resposta && resposta.trim()) {
          // Calcula delay baseado no tamanho da resposta
          const delay = calcularDelayResposta(resposta);
          console.log(`[WhatsApp] ✅ Resposta gerada (${resposta.length} chars), aguardando ${delay}ms antes de enviar...`);
          
          // Aguarda delay antes de enviar (simula tempo de digitação)
          await new Promise(resolve => setTimeout(resolve, delay));
          
          // A função gerarResposta já adiciona ao histórico, mas garantimos aqui também
          await enviarMensagemSegura(client, chatId, resposta, true);
          console.log(`[WhatsApp] ✅ Resposta enviada com sucesso para ${chatId}`);
        } else {
          console.warn(`[WhatsApp] ⚠️  Resposta vazia ou inválida para ${chatId}`);
        }
      } catch (error) {
        console.error(`[WhatsApp] ❌ Erro ao gerar/enviar resposta:`, error?.message || error);
        throw error; // Re-lança para ser capturado pelo catch externo
      }

    } catch (error) {
      console.error('[WhatsApp] ❌ Erro ao processar mensagem:', error?.message || error);
      try {
        const delay = calcularDelayResposta('Desculpe, houve um erro ao processar sua mensagem. Tente novamente, por favor.');
        await new Promise(resolve => setTimeout(resolve, delay));
        
        await enviarMensagemSegura(
          client,
          msg.from,
          'Desculpe, houve um erro ao processar sua mensagem. Tente novamente, por favor.'
        );
      } catch (sendError) {
        console.error('[WhatsApp] ❌ Erro ao enviar mensagem de erro:', sendError?.message);
      }
    } finally {
      // Remove flag de processamento
      processingMessages.delete(msg.from);
    }
  }

  /**
   * Inicia fluxo de candidatura
   */
  async function startApplicationFlow(chatId) {
    console.log(`[WhatsApp] 📝 Criando sessão de candidatura para ${chatId}`);
    applicationSessions.set(chatId, {
      step: 'resume',
      data: {},
      resume: null
    });

    try {
      const resposta = 'Ótimo! Vamos começar sua candidatura! 📝\n\n' +
        'Por favor, envie seu *currículo* (PDF, DOCX ou imagem).';
      const delay = calcularDelayResposta(resposta);
      await new Promise(resolve => setTimeout(resolve, delay));
      await enviarMensagemSegura(client, chatId, resposta);
      console.log(`[WhatsApp] ✅ Mensagem de início de candidatura enviada para ${chatId}`);
    } catch (error) {
      console.error(`[WhatsApp] ❌ Erro ao enviar mensagem de candidatura:`, error?.message);
      // Remove a sessão se falhar
      applicationSessions.delete(chatId);
      throw error;
    }
  }

  /**
   * Processa etapa do fluxo de candidatura
   */
  async function handleApplicationStep(chatId, msg, text, textNorm) {
    const session = applicationSessions.get(chatId);
    if (!session) return false;

    // Etapa: receber currículo
    if (session.step === 'resume') {
      if (msg.type === 'document' || msg.type === 'image') {
        try {
          const media = await msg.downloadMedia();
          if (media) {
            const mediaBuffer = Buffer.from(media.data, 'base64');
            session.resume = {
              buffer: mediaBuffer,
              filename: msg.body || 'curriculo.pdf',
              mimetype: media.mimetype || (msg.type === 'document' ? 'application/pdf' : 'image/jpeg'),
              base64: media.data
            };
            const resposta = 'Currículo recebido! Agora preciso do seu *nome completo*.';
            const delay = calcularDelayResposta(resposta);
            await new Promise(resolve => setTimeout(resolve, delay));
            await enviarMensagemSegura(client, chatId, resposta);
            session.step = 'name';
            return true;
          }
        } catch (error) {
          console.error('[WhatsApp] Erro ao processar currículo:', error);
        }
      }
      return true; // Aguarda currículo
    }

    // Etapa: nome
    if (session.step === 'name') {
      if (text && text.trim().length >= 2) {
        session.data.fullName = text.trim();
        const resposta = 'Ótimo! Agora preciso do seu *e-mail*.';
        const delay = calcularDelayResposta(resposta);
        await new Promise(resolve => setTimeout(resolve, delay));
        await enviarMensagemSegura(client, chatId, resposta);
        session.step = 'email';
        return true;
      }
      const resposta = 'Por favor, informe seu nome completo.';
      const delay = calcularDelayResposta(resposta);
      await new Promise(resolve => setTimeout(resolve, delay));
      await enviarMensagemSegura(client, chatId, resposta);
      return true;
    }

    // Etapa: email
    if (session.step === 'email') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (emailRegex.test(text)) {
        session.data.email = text.trim();
        const resposta = 'Perfeito! Agora preciso da sua *cidade*.';
        const delay = calcularDelayResposta(resposta);
        await new Promise(resolve => setTimeout(resolve, delay));
        await enviarMensagemSegura(client, chatId, resposta);
        session.step = 'city';
        return true;
      }
      const resposta = 'Por favor, informe um e-mail válido.';
      const delay = calcularDelayResposta(resposta);
      await new Promise(resolve => setTimeout(resolve, delay));
      await enviarMensagemSegura(client, chatId, resposta);
      return true;
    }

    // Etapa: cidade
    if (session.step === 'city') {
      if (text && text.trim().length >= 2) {
        session.data.city = text.trim();
        const resposta = 'Excelente! Por último, qual *área de interesse* ou vaga você tem interesse?';
        const delay = calcularDelayResposta(resposta);
        await new Promise(resolve => setTimeout(resolve, delay));
        await enviarMensagemSegura(client, chatId, resposta);
        session.step = 'job';
        return true;
      }
      const resposta = 'Por favor, informe sua cidade.';
      const delay = calcularDelayResposta(resposta);
      await new Promise(resolve => setTimeout(resolve, delay));
      await enviarMensagemSegura(client, chatId, resposta);
      return true;
    }

    // Etapa: vaga/área
    if (session.step === 'job') {
      session.data.jobInterest = text.trim() || 'Não especificado';
      
      const resumo = `✅ *Confirme seus dados:*\n\n` +
        `- Nome: ${session.data.fullName}\n` +
        `- E-mail: ${session.data.email}\n` +
        `- Cidade: ${session.data.city}\n` +
        `- Área de interesse: ${session.data.jobInterest}\n\n` +
        `Está tudo correto? Responda *SIM* para confirmar ou *NÃO* para corrigir.`;
      
      const delay = calcularDelayResposta(resumo);
      await new Promise(resolve => setTimeout(resolve, delay));
      await enviarMensagemSegura(client, chatId, resumo);
      session.step = 'confirm';
      return true;
    }

    // Etapa: confirmação
    if (session.step === 'confirm') {
      if (textNorm.includes('sim') || textNorm.includes('s ') || textNorm === 's') {
        try {
          await saveWhatsappApplication({
            chatId: chatId,
            fullName: session.data.fullName,
            email: session.data.email,
            whatsappNumber: chatId,
            city: session.data.city,
            jobInterest: session.data.jobInterest,
            resumeBase64: session.resume?.base64 || '',
            resumeFilename: session.resume?.filename || 'curriculo.pdf',
            resumeMimetype: session.resume?.mimetype || 'application/pdf'
          });

          const resposta = '🎉 *Candidatura registrada com sucesso!*\n\n' +
            'Seus dados foram salvos e nossa equipe entrará em contato em breve.\n\n' +
            'Obrigada por se candidatar na EvoluxRH! 😊';
          const delay = calcularDelayResposta(resposta);
          await new Promise(resolve => setTimeout(resolve, delay));
          
          await enviarMensagemSegura(client, chatId, resposta);

          applicationSessions.delete(chatId);
          return true;
        } catch (error) {
          console.error('[WhatsApp] Erro ao salvar candidatura:', error);
          const resposta = 'Desculpe, houve um erro ao salvar sua candidatura. Tente novamente mais tarde ou entre em contato conosco.';
          const delay = calcularDelayResposta(resposta);
          await new Promise(resolve => setTimeout(resolve, delay));
          await enviarMensagemSegura(client, chatId, resposta);
          return true;
        }
      } else if (textNorm.includes('não') || textNorm.includes('nao') || textNorm.includes('n ')) {
        const resposta = 'Sem problemas! Qual dado você gostaria de corrigir? (nome, email, cidade ou vaga)';
        const delay = calcularDelayResposta(resposta);
        await new Promise(resolve => setTimeout(resolve, delay));
        await enviarMensagemSegura(client, chatId, resposta);
        session.step = 'correcting';
        return true;
      }
      return true;
    }

    return false;
  }

  // Handler de mensagens (estilo Diamond)
  client.on('message', async (msg) => {
    await handleIncomingMessage(msg);
  });

  // Fallback: message_create para mensagens que não disparam 'message'
  client.on('message_create', async (msg) => {
    if (!msg.fromMe) {
      await handleIncomingMessage(msg);
    }
  });

  return client;
}

module.exports = { createWhatsAppClient };
