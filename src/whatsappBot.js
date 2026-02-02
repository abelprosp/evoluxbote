const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.makeWASocket || baileys.default || baileys;
const useMultiFileAuthState = baileys.useMultiFileAuthState;
const DisconnectReason = baileys.DisconnectReason;
const downloadMediaMessage = baileys.downloadMediaMessage;
const getContentType = baileys.getContentType;
const fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
const fetchLatestWaWebVersion = baileys.fetchLatestWaWebVersion;
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');
const { obterContexto, gerarResposta, analisarImagem, conversas, adicionarMensagemAoHistorico } = require('./chatServiceDiamond');
const { saveWhatsappApplication } = require('./services/applicationsService');
const { cfg } = require('./config');

const AUTH_FOLDER = 'auth_info_baileys';

const lastMessageTime = new Map();
const processingMessages = new Map();

function calcularDelayResposta(textoResposta) {
  const minDelay = cfg.RESPONSE_DELAY_MIN_MS || 2000;
  const maxDelay = cfg.RESPONSE_DELAY_MAX_MS || 5000;
  const delayPerChar = cfg.RESPONSE_DELAY_PER_CHAR_MS || 50;
  const delayCalculado = minDelay + (textoResposta.length * delayPerChar);
  return Math.min(delayCalculado, maxDelay);
}

async function aguardarDelayEntreMensagens(chatId) {
  const minDelay = cfg.MIN_DELAY_BETWEEN_MESSAGES_MS || 3000;
  const lastTime = lastMessageTime.get(chatId) || 0;
  const now = Date.now();
  const timeSinceLastMessage = now - lastTime;
  if (timeSinceLastMessage < minDelay) {
    const waitTime = minDelay - timeSinceLastMessage;
    console.log(`[WhatsApp] ⏳ Aguardando ${waitTime}ms antes de processar mensagem de ${chatId}`);
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }
  lastMessageTime.set(chatId, Date.now());
}

async function enviarMensagemSegura(sock, chatId, texto, salvarNoHistorico = true) {
  try {
    console.log(`[WhatsApp] 📤 Enviando mensagem para ${chatId} (${texto.length} chars)`);
    await sock.sendMessage(chatId, { text: texto });
    if (salvarNoHistorico) {
      adicionarMensagemAoHistorico(chatId, 'assistant', texto);
    }
    console.log(`[WhatsApp] ✅ Mensagem enviada para ${chatId}`);
    return { _enviado: true };
  } catch (error) {
    console.error(`[WhatsApp] ❌ Erro ao enviar mensagem para ${chatId}:`, error?.message);
    throw error;
  }
}

/**
 * Cria e inicializa o cliente WhatsApp usando Baileys (WebSocket, sem browser).
 * Retorna uma Promise que resolve com o sock quando a conexão estiver aberta.
 */
function createWhatsAppClient() {
  console.log('[WhatsApp] Iniciando Baileys (conexão direta, sem browser)...');

  const applicationSessions = new Map();
  const processedMessageIds = new Map();
  const PROCESSED_TTL_MS = 5 * 60 * 1000;
  const pausedChats = new Set();

  function getMessageId(msg) {
    if (!msg?.key?.id) return null;
    return msg.key.id;
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

  let resolveReady;
  let rejectReady;
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    let version;
    try {
      const versionInfo = await fetchLatestWaWebVersion();
      version = versionInfo?.version;
      if (version) console.log('[Baileys] Usando versão WhatsApp Web:', version.join('.'));
    } catch (e) {
      console.warn('[Baileys] fetchLatestWaWebVersion falhou, tentando fetchLatestBaileysVersion:', e?.message);
      try {
        const fallback = await fetchLatestBaileysVersion();
        version = fallback?.version;
        if (version) console.log('[Baileys] Usando versão Baileys:', version.join('.'));
      } catch (e2) {
        console.warn('[Baileys] Usando versão padrão do pacote:', e2?.message);
      }
    }

    const sock = makeWASocket({
      auth: state,
      version,
      getMessage: async () => undefined,
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('\n📱 Escaneie o QR Code abaixo com o WhatsApp:\n');
        console.log('   WhatsApp > Configurações > Aparelhos conectados > Conectar um aparelho\n');
        try {
          qrcodeTerminal.generate(qr, { small: true });
          const qrPath = path.join(process.cwd(), 'qrcode.png');
          await QRCode.toFile(qrPath, qr, { width: 400, margin: 2 });
          console.log('[WhatsApp] QR Code salvo em qrcode.png\n');
        } catch (e) {
          console.warn('[WhatsApp] Não foi possível salvar qrcode.png:', e?.message);
        }
      }

      if (connection === 'open') {
        console.log('\n✅ Cliente WhatsApp (Baileys) conectado e pronto!');
        console.log('📲 Envie uma mensagem de OUTRO número para testar.\n');
        if (resolveReady) resolveReady(sock);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        const isRestartRequired = statusCode === DisconnectReason.restartRequired; // 515 = após escanear QR
        console.log('[Baileys] Conexão fechada. statusCode:', statusCode, 'reconectar:', shouldReconnect);
        if (statusCode === DisconnectReason.loggedOut) {
          console.log('[Baileys] Você foi desconectado. Apague a pasta', AUTH_FOLDER, 'e inicie de novo para escanear o QR.');
          return;
        }
        if (isRestartRequired) {
          console.log('');
          console.log('📱 QR escaneado! Salvando credenciais e reconectando (aguarde 2–3 segundos)...');
          console.log('   Em seguida deve aparecer: "Cliente WhatsApp (Baileys) conectado e pronto!"');
          console.log('');
        }
        if (statusCode === 405) {
          console.log('');
          console.log('[Baileys] Erro 405 (Connection Failure): o WhatsApp pode estar rejeitando a conexão.');
          console.log('   Dicas: 1) Confira sua internet  2) Tente outra rede (ex.: celular como hotspot)');
          console.log('   3) Apague a pasta', AUTH_FOLDER, 'e inicie o bot de novo para gerar novo QR.');
          console.log('');
        }
        if (shouldReconnect) {
          const delayMs = isRestartRequired ? 2000 : 5000;
          console.log('[Baileys] Reconectando em', delayMs / 1000, 's...');
          setTimeout(() => connectToWhatsApp(), delayMs);
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        const chatId = msg.key.remoteJid;
        if (!chatId) continue;
        const fromMe = msg.key.fromMe || false;
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const contentType = (getContentType(msg.message) || getContentType(msg) || '').toString();

        await handleIncomingMessage(sock, {
          chatId,
          fromMe,
          text: (text || '').trim(),
          contentType,
          msg,
          applicationSessions,
          processedMessageIds,
          pausedChats,
          wasProcessed,
          markProcessed,
          aguardarDelayEntreMensagens,
          calcularDelayResposta,
          enviarMensagemSegura,
          processingMessages,
        });
      }
    });

    return sock;
  }

  connectToWhatsApp().catch((err) => {
    console.error('[WhatsApp] Erro ao conectar Baileys:', err?.message || err);
    if (rejectReady) rejectReady(err);
  });

  return readyPromise;
}

async function handleIncomingMessage(
  sock,
  {
    chatId,
    fromMe,
    text: rawText,
    contentType,
    msg,
    applicationSessions,
    pausedChats,
    wasProcessed,
    markProcessed,
    aguardarDelayEntreMensagens,
    calcularDelayResposta,
    enviarMensagemSegura,
    processingMessages,
  }
) {
  console.log(`[WhatsApp] 📩 Evento de mensagem recebido de ${chatId}`);

  try {
    if (fromMe) {
      console.log(`[WhatsApp] ⏭️ Ignorado: mensagem enviada por mim`);
      return;
    }
    if (wasProcessed(msg)) {
      console.log(`[WhatsApp] ⏭️ Ignorado: mensagem já processada`);
      return;
    }

    const isGroup = chatId.endsWith('@g.us');
    if (isGroup) {
      console.log(`[WhatsApp] ⏭️ Ignorado: mensagem de grupo`);
      return;
    }

    const maxAgeMs = cfg.MESSAGE_MAX_AGE_MS || 30 * 60 * 1000;
    const ts = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now();
    if (Date.now() - ts > maxAgeMs) {
      console.log(`[WhatsApp] ⏭️ Ignorado: mensagem antiga`);
      return;
    }

    const hasBody = rawText.length > 0;
    const isImage = contentType === 'imageMessage';
    const isDocument = contentType === 'documentMessage';
    const hasMedia = isImage || isDocument;
    if (!hasBody && !hasMedia) {
      console.log(`[WhatsApp] ⏭️ Ignorado: mensagem sem texto e sem mídia`);
      return;
    }

    const textNorm = (rawText || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    console.log(`[WhatsApp] 📨 Mensagem de ${chatId}: "${(rawText || '').substring(0, 80)}"`);

    if (textNorm === '#assumir') {
      pausedChats.add(chatId);
      markProcessed(msg);
      const resposta = '✅ Bot pausado. A conversa foi assumida manualmente.\n\nPara reativar o bot, envie: #pausa';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(sock, chatId, resposta);
      return;
    }
    if (textNorm === '#pausa') {
      pausedChats.delete(chatId);
      markProcessed(msg);
      const resposta = '✅ Bot reativado! Voltando a responder automaticamente.';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(sock, chatId, resposta);
      return;
    }
    if (pausedChats.has(chatId)) {
      markProcessed(msg);
      return;
    }

    if (processingMessages.has(chatId)) {
      console.log(`[WhatsApp] ⏳ Mensagem aguardando (já há uma sendo processada)`);
      return;
    }
    processingMessages.set(chatId, true);
    markProcessed(msg);
    await aguardarDelayEntreMensagens(chatId);

    const hasSession = applicationSessions.has(chatId);

    if (hasSession) {
      const handled = await handleApplicationStepBaileys(
        sock,
        applicationSessions,
        chatId,
        msg,
        rawText,
        textNorm,
        contentType,
        enviarMensagemSegura,
        calcularDelayResposta,
        downloadMediaMessage
      );
      if (handled) {
        processingMessages.delete(chatId);
        return;
      }
    }

    const isApplicationTrigger = [
      'quero me candidatar',
      'gostaria de me candidatar',
      'fazer minha candidatura',
      'enviar meu curriculo',
      'enviar currículo',
      'quero trabalhar',
      'quero uma vaga',
    ].some((k) => textNorm.includes(k));
    if (isApplicationTrigger && !hasSession) {
      await startApplicationFlow(sock, applicationSessions, chatId, enviarMensagemSegura, calcularDelayResposta);
      processingMessages.delete(chatId);
      return;
    }

    const isResumeMedia = isDocument || isImage;
    if (isResumeMedia && !hasSession) {
      const resposta =
        'Olá! Sou a *Iza da EvoluxRH* 😊\n\nVi que você enviou um arquivo! 📄\n\nPara registrar sua candidatura, me diga "quero me candidatar" e eu te guio passo a passo!';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(sock, chatId, resposta);
      processingMessages.delete(chatId);
      return;
    }

    let descricaoImagem = null;
    if (isImage) {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, sock.updateMediaMessage ? { reuploadRequest: sock.updateMediaMessage } : {});
        if (buffer) descricaoImagem = await analisarImagem(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer), rawText);
      } catch (e) {
        console.error('[WhatsApp] Erro ao processar mídia:', e?.message);
      }
    }

    const nomeContato = 'Candidato';
    const contexto = obterContexto(chatId, nomeContato, chatId);

    if (!conversas.has(chatId)) {
      console.log(`[WhatsApp] 👋 Primeira mensagem de ${chatId}, enviando saudação...`);
      const resposta =
        'Olá! Sou a Iza da EvoluxRH! 😊\n\nComo posso ajudar hoje? Há vagas disponíveis no site evoluxrh.com.br. Se quiser se candidatar, posso te orientar.';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(sock, chatId, resposta);
    }

    adicionarMensagemAoHistorico(chatId, 'user', rawText || '(mídia)');
    console.log(`[WhatsApp] 🤖 Gerando resposta com IA para ${chatId}...`);
    try {
      const resposta = await gerarResposta(contexto, rawText || '', descricaoImagem);
      if (resposta && resposta.trim()) {
        const delay = calcularDelayResposta(resposta);
        await new Promise((r) => setTimeout(r, delay));
        await enviarMensagemSegura(sock, chatId, resposta, true);
      }
    } catch (error) {
      console.error(`[WhatsApp] ❌ Erro ao gerar/enviar resposta:`, error?.message);
      await enviarMensagemSegura(sock, chatId, 'Desculpe, houve um erro ao processar sua mensagem. Tente novamente, por favor.');
    }
  } catch (error) {
    console.error('[WhatsApp] ❌ Erro ao processar mensagem:', error?.message);
    try {
      await enviarMensagemSegura(sock, chatId, 'Desculpe, houve um erro ao processar sua mensagem. Tente novamente, por favor.');
    } catch (sendError) {
      console.error('[WhatsApp] ❌ Erro ao enviar mensagem de erro:', sendError?.message);
    }
  } finally {
    processingMessages.delete(chatId);
  }
}

async function startApplicationFlow(sock, applicationSessions, chatId, enviarMensagemSegura, calcularDelayResposta) {
  applicationSessions.set(chatId, { step: 'resume', data: {}, resume: null });
  const resposta = 'Ótimo! Vamos começar sua candidatura! 📝\n\nPor favor, envie seu *currículo* (PDF, DOCX ou imagem).';
  await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
  await enviarMensagemSegura(sock, chatId, resposta);
}

async function handleApplicationStepBaileys(
  sock,
  applicationSessions,
  chatId,
  msg,
  text,
  textNorm,
  contentType,
  enviarMensagemSegura,
  calcularDelayResposta,
  downloadMediaMessage
) {
  const session = applicationSessions.get(chatId);
  if (!session) return false;
  const isImage = contentType === 'imageMessage';
  const isDocument = contentType === 'documentMessage';

  if (session.step === 'resume') {
    if (isDocument || isImage) {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, sock.updateMediaMessage ? { reuploadRequest: sock.updateMediaMessage } : {});
        if (buffer) {
          const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
          const filename = msg.message?.documentMessage?.fileName || msg.message?.imageMessage?.caption || 'curriculo.pdf';
          const mimetype = msg.message?.documentMessage?.mimetype || msg.message?.imageMessage?.mimetype || 'application/pdf';
          session.resume = {
            buffer: buf,
            filename,
            mimetype,
            base64: buf.toString('base64'),
          };
          const resposta = 'Currículo recebido! Agora preciso do seu *nome completo*.';
          await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
          await enviarMensagemSegura(sock, chatId, resposta);
          session.step = 'name';
          return true;
        }
      } catch (e) {
        console.error('[WhatsApp] Erro ao processar currículo:', e?.message);
      }
    }
    return true;
  }

  if (session.step === 'name') {
    if (text && text.trim().length >= 2) {
      session.data.fullName = text.trim();
      const resposta = 'Ótimo! Agora preciso do seu *e-mail*.';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(sock, chatId, resposta);
      session.step = 'email';
      return true;
    }
    const resposta = 'Por favor, informe seu nome completo.';
    await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
    await enviarMensagemSegura(sock, chatId, resposta);
    return true;
  }

  if (session.step === 'email') {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (emailRegex.test(text)) {
      session.data.email = text.trim();
      const resposta = 'Perfeito! Agora preciso da sua *cidade*.';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(sock, chatId, resposta);
      session.step = 'city';
      return true;
    }
    const resposta = 'Por favor, informe um e-mail válido.';
    await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
    await enviarMensagemSegura(sock, chatId, resposta);
    return true;
  }

  if (session.step === 'city') {
    if (text && text.trim().length >= 2) {
      session.data.city = text.trim();
      const resposta = 'Excelente! Por último, qual *área de interesse* ou vaga você tem interesse?';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(sock, chatId, resposta);
      session.step = 'job';
      return true;
    }
    const resposta = 'Por favor, informe sua cidade.';
    await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
    await enviarMensagemSegura(sock, chatId, resposta);
    return true;
  }

  if (session.step === 'job') {
    session.data.jobInterest = (text || '').trim() || 'Não especificado';
    const resumo =
      `✅ *Confirme seus dados:*\n\n` +
      `- Nome: ${session.data.fullName}\n` +
      `- E-mail: ${session.data.email}\n` +
      `- Cidade: ${session.data.city}\n` +
      `- Área de interesse: ${session.data.jobInterest}\n\n` +
      `Está tudo correto? Responda *SIM* para confirmar ou *NÃO* para corrigir.`;
    await new Promise((r) => setTimeout(r, calcularDelayResposta(resumo)));
    await enviarMensagemSegura(sock, chatId, resumo);
    session.step = 'confirm';
    return true;
  }

  if (session.step === 'confirm') {
    if (textNorm.includes('sim') || textNorm.includes('s ') || textNorm === 's') {
      try {
        await saveWhatsappApplication({
          chatId,
          fullName: session.data.fullName,
          email: session.data.email,
          whatsappNumber: chatId,
          city: session.data.city,
          jobInterest: session.data.jobInterest,
          resumeBase64: session.resume?.base64 || '',
          resumeFilename: session.resume?.filename || 'curriculo.pdf',
          resumeMimetype: session.resume?.mimetype || 'application/pdf',
        });
        const resposta =
          '🎉 *Candidatura registrada com sucesso!*\n\nSeus dados foram salvos e nossa equipe entrará em contato em breve.\n\nObrigada por se candidatar na EvoluxRH! 😊';
        await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
        await enviarMensagemSegura(sock, chatId, resposta);
        applicationSessions.delete(chatId);
        return true;
      } catch (error) {
        console.error('[WhatsApp] Erro ao salvar candidatura:', error);
        const resposta = 'Desculpe, houve um erro ao salvar sua candidatura. Tente novamente mais tarde ou entre em contato conosco.';
        await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
        await enviarMensagemSegura(sock, chatId, resposta);
        return true;
      }
    }
    if (textNorm.includes('não') || textNorm.includes('nao')) {
      const resposta = 'Sem problemas! Qual dado você gostaria de corrigir? (nome, email, cidade ou vaga)';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(sock, chatId, resposta);
      session.step = 'correcting';
      return true;
    }
    return true;
  }

  return false;
}

module.exports = { createWhatsAppClient };
