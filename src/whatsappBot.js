const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { obterContexto, gerarResposta, analisarImagem, conversas } = require('./chatServiceDiamond');
const { saveWhatsappApplication } = require('./services/applicationsService');
const { cfg } = require('./config');
const fs = require('fs');
const path = require('path');

// Função helper para enviar mensagem ignorando erro de markedUnread (estilo Diamond)
async function enviarMensagemSegura(client, chatId, texto) {
  return new Promise(async (resolve, reject) => {
    try {
      console.log(`[WhatsApp] 📤 Tentando enviar mensagem para ${chatId} (${texto.length} chars)`);
      const promiseEnvio = client.sendMessage(chatId, texto);
      
      const timeout = setTimeout(() => {
        console.warn(`⚠️  Timeout ao enviar mensagem para ${chatId}, assumindo que foi enviada`);
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

      markProcessed(msg);

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
      const textNorm = rawText.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      
      console.log(`[WhatsApp] 📨 Mensagem recebida de ${chatId}: "${rawText.substring(0, 80)}"`);

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
        await enviarMensagemSegura(
          client,
          chatId,
          'Olá! Sou a *Iza da EvoluxRH* 😊\n\n' +
          'Vi que você enviou um arquivo! 📄\n\n' +
          'Para registrar sua candidatura, me diga "quero me candidatar" e eu te guio passo a passo!'
        );
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
          await enviarMensagemSegura(
            client,
            chatId,
            'Olá! Sou a Iza da EvoluxRH! 😊\n\n' +
            'Como posso ajudar hoje? Se quiser analisar vagas ou se candidatar, posso te orientar.'
          );
          console.log(`[WhatsApp] ✅ Saudação enviada para ${chatId}`);
        } catch (error) {
          console.error(`[WhatsApp] ❌ Erro ao enviar saudação:`, error?.message);
        }
      }
      
      // Gera resposta com IA (estilo Diamond)
      console.log(`[WhatsApp] 🤖 Gerando resposta com IA para ${chatId}...`);
      try {
        const resposta = await gerarResposta(contexto, rawText, descricaoImagem);
        
        if (resposta && resposta.trim()) {
          console.log(`[WhatsApp] ✅ Resposta gerada (${resposta.length} chars), enviando...`);
          await enviarMensagemSegura(client, chatId, resposta);
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
        await enviarMensagemSegura(
          client,
          msg.from,
          'Desculpe, houve um erro ao processar sua mensagem. Tente novamente, por favor.'
        );
      } catch (sendError) {
        console.error('[WhatsApp] ❌ Erro ao enviar mensagem de erro:', sendError?.message);
      }
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
      await enviarMensagemSegura(
        client,
        chatId,
        'Ótimo! Vamos começar sua candidatura! 📝\n\n' +
        'Por favor, envie seu *currículo* (PDF, DOCX ou imagem).'
      );
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
            await enviarMensagemSegura(client, chatId, 'Currículo recebido! Agora preciso do seu *nome completo*.');
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
        await enviarMensagemSegura(client, chatId, 'Ótimo! Agora preciso do seu *e-mail*.');
        session.step = 'email';
        return true;
      }
      await enviarMensagemSegura(client, chatId, 'Por favor, informe seu nome completo.');
      return true;
    }

    // Etapa: email
    if (session.step === 'email') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (emailRegex.test(text)) {
        session.data.email = text.trim();
        await enviarMensagemSegura(client, chatId, 'Perfeito! Agora preciso da sua *cidade*.');
        session.step = 'city';
        return true;
      }
      await enviarMensagemSegura(client, chatId, 'Por favor, informe um e-mail válido.');
      return true;
    }

    // Etapa: cidade
    if (session.step === 'city') {
      if (text && text.trim().length >= 2) {
        session.data.city = text.trim();
        await enviarMensagemSegura(client, chatId, 'Excelente! Por último, qual *área de interesse* ou vaga você tem interesse?');
        session.step = 'job';
        return true;
      }
      await enviarMensagemSegura(client, chatId, 'Por favor, informe sua cidade.');
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

          await enviarMensagemSegura(
            client,
            chatId,
            '🎉 *Candidatura registrada com sucesso!*\n\n' +
            'Seus dados foram salvos e nossa equipe entrará em contato em breve.\n\n' +
            'Obrigada por se candidatar na EvoluxRH! 😊'
          );

          applicationSessions.delete(chatId);
          return true;
        } catch (error) {
          console.error('[WhatsApp] Erro ao salvar candidatura:', error);
          await enviarMensagemSegura(
            client,
            chatId,
            'Desculpe, houve um erro ao salvar sua candidatura. Tente novamente mais tarde ou entre em contato conosco.'
          );
          return true;
        }
      } else if (textNorm.includes('não') || textNorm.includes('nao') || textNorm.includes('n ')) {
        await enviarMensagemSegura(client, chatId, 'Sem problemas! Qual dado você gostaria de corrigir? (nome, email, cidade ou vaga)');
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
